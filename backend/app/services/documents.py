import json
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

from app.core.models import Language
from app.services.db import Database, Row, migrate_columns, table_columns

_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    name_source TEXT NOT NULL DEFAULT 'fallback',
    text TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL,
    profile_id INTEGER,
    domain_ids TEXT NOT NULL DEFAULT '[]',
    llm_provider TEXT,
    llm_model TEXT,
    llm_tier TEXT,
    llm_auto INTEGER NOT NULL DEFAULT 1,
    last_findings TEXT NOT NULL DEFAULT '[]',
    scorecard TEXT,
    folder_id INTEGER,
    edited_at TEXT NOT NULL,
    checked_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


class Document(BaseModel):
    id: int
    owner_id: int
    name: str
    name_source: str = "fallback"
    text: str = ""
    language: Language
    profile_id: int | None = None
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_tier: str | None = None
    llm_auto: bool = True
    last_findings: list[dict[str, Any]] = Field(default_factory=list)
    scorecard: dict[str, Any] | None = None
    folder_id: int | None = None
    edited_at: str
    checked_at: str | None = None
    revision: int = 0
    created_at: str
    updated_at: str


class DocumentSummary(BaseModel):
    id: int
    name: str
    language: Language
    folder_id: int | None = None
    created_at: str
    edited_at: str
    checked_at: str | None = None
    updated_at: str


class RevisionConflictError(Exception):
    """The client's base revision is stale; the document changed elsewhere."""

    def __init__(self, current_revision: int) -> None:
        super().__init__(f"stale revision; server is at {current_revision}")
        self.current_revision = current_revision


def _utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_document(row: Row) -> Document:
    return Document(
        id=row["id"],
        owner_id=row["owner_id"],
        name=row["name"],
        name_source=row["name_source"],
        text=row["text"],
        language=Language(row["language"]),
        profile_id=row["profile_id"],
        domain_ids=json.loads(row["domain_ids"]),
        llm_provider=row["llm_provider"],
        llm_model=row["llm_model"],
        llm_tier=row["llm_tier"],
        llm_auto=bool(row["llm_auto"]),
        last_findings=json.loads(row["last_findings"]),
        scorecard=json.loads(row["scorecard"]) if row["scorecard"] else None,
        folder_id=row["folder_id"],
        edited_at=row["edited_at"],
        checked_at=row["checked_at"],
        revision=row["revision"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class DocumentStore:
    """User documents with per-document settings and check-state snapshots."""

    def __init__(self, db: Database) -> None:
        self.db = db
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return self.db.connect()

    def _migrate(self, conn: Any) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        columns = table_columns(conn, "documents")
        missing = {"folder_id", "edited_at", "checked_at"} - columns
        migrate_columns(
            conn,
            "documents",
            [
                ("folder_id", "INTEGER"),
                ("edited_at", "TEXT"),
                ("checked_at", "TEXT"),
            ],
        )
        if "edited_at" in missing:
            conn.execute("UPDATE documents SET edited_at = updated_at")
        if "checked_at" in missing:
            conn.execute("UPDATE documents SET checked_at = updated_at")

    def create_document(
        self,
        name: str,
        language: Language,
        *,
        owner_id: int,
        name_source: str = "fallback",
        text: str = "",
        profile_id: int | None = None,
        domain_ids: list[int] | None = None,
        llm_provider: str | None = None,
        llm_model: str | None = None,
        llm_tier: str | None = None,
        llm_auto: bool = True,
        last_findings: list[dict[str, Any]] | None = None,
        scorecard: dict[str, Any] | None = None,
        folder_id: int | None = None,
    ) -> Document:
        now = _utcnow()
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO documents
                   (owner_id, name, name_source, text, language, profile_id, domain_ids,
                    llm_provider, llm_model, llm_tier, llm_auto, last_findings,
                    scorecard, folder_id, edited_at, checked_at, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   RETURNING id""",
                (
                    owner_id,
                    name,
                    name_source,
                    text,
                    language.value,
                    profile_id,
                    json.dumps(domain_ids or []),
                    llm_provider,
                    llm_model,
                    llm_tier,
                    int(llm_auto),
                    json.dumps(last_findings or []),
                    json.dumps(scorecard) if scorecard is not None else None,
                    folder_id,
                    now,
                    now if (last_findings or scorecard is not None) else None,
                    now,
                    now,
                ),
            )
            document_id = cursor.fetchone()["id"]
        assert document_id is not None
        document = self.get_document(document_id, owner_id=owner_id)
        assert document is not None
        return document

    def list_documents(self, *, owner_id: int) -> list[DocumentSummary]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, name, language, folder_id, created_at, edited_at, checked_at, updated_at FROM documents"
                " WHERE owner_id = ? ORDER BY edited_at DESC, id DESC",
                (owner_id,),
            ).fetchall()
        return [
            DocumentSummary(
                id=row["id"],
                name=row["name"],
                language=Language(row["language"]),
                folder_id=row["folder_id"],
                created_at=row["created_at"],
                edited_at=row["edited_at"],
                checked_at=row["checked_at"],
                updated_at=row["updated_at"],
            )
            for row in rows
        ]

    def get_document(self, document_id: int, *, owner_id: int) -> Document | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE id = ? AND owner_id = ?",
                (document_id, owner_id),
            ).fetchone()
        return _row_to_document(row) if row else None

    _UPDATABLE = (
        "name",
        "name_source",
        "text",
        "language",
        "profile_id",
        "domain_ids",
        "llm_provider",
        "llm_model",
        "llm_tier",
        "llm_auto",
        "last_findings",
        "scorecard",
    )

    def update_document(
        self,
        document_id: int,
        base_revision: int,
        *,
        owner_id: int,
        **fields: object,
    ) -> Document | None:
        """Optimistic update: applies only if base_revision is current.

        Returns None for a missing document; raises RevisionConflictError
        when the document moved past base_revision.
        """
        current = self.get_document(document_id, owner_id=owner_id)
        if current is None:
            return None
        unknown = set(fields) - set(self._UPDATABLE)
        assert not unknown, f"not updatable: {unknown}"
        merged = current.model_copy(update=fields)
        now = _utcnow()
        text_changed = "text" in fields and fields["text"] != current.text
        name_changed = "name" in fields and fields["name"] != current.name
        edited_at = now if (text_changed or name_changed) else current.edited_at
        carries_check_state = "last_findings" in fields or "scorecard" in fields
        checked_at = now if carries_check_state else current.checked_at
        with self._connect() as conn:
            cursor = conn.execute(
                """UPDATE documents SET name = ?, name_source = ?, text = ?,
                   language = ?, profile_id = ?, domain_ids = ?, llm_provider = ?,
                   llm_model = ?, llm_tier = ?, llm_auto = ?, last_findings = ?,
                   scorecard = ?, edited_at = ?, checked_at = ?, revision = revision + 1, updated_at = ?
                   WHERE id = ? AND revision = ? AND owner_id = ?""",
                (
                    merged.name,
                    merged.name_source,
                    merged.text,
                    merged.language.value,
                    merged.profile_id,
                    json.dumps(merged.domain_ids),
                    merged.llm_provider,
                    merged.llm_model,
                    merged.llm_tier,
                    int(merged.llm_auto),
                    json.dumps(merged.last_findings),
                    json.dumps(merged.scorecard)
                    if merged.scorecard is not None
                    else None,
                    edited_at,
                    checked_at,
                    now,
                    document_id,
                    base_revision,
                    owner_id,
                ),
            )
        if cursor.rowcount == 0:
            latest = self.get_document(document_id, owner_id=owner_id)
            if latest is None:
                return None
            raise RevisionConflictError(latest.revision)
        return merged.model_copy(
            update={
                "revision": base_revision + 1,
                "updated_at": now,
                "edited_at": edited_at,
                "checked_at": checked_at,
            }
        )

    def set_name(
        self,
        document_id: int,
        name: str,
        name_source: str,
        *,
        owner_id: int,
        only_if_source: str | None = None,
    ) -> Document | None:
        """Server-side naming; deliberately no revision bump, so it can never
        409 the client's in-flight autosaves.

        When `only_if_source` is given, the update is guarded by the
        document's current name_source: if the document has since been
        renamed away from that source (e.g. the user typed a name while an
        LLM titling call was in flight), the write is skipped and the
        document is returned unchanged instead of clobbering the newer name.
        """
        query = (
            "UPDATE documents SET name = ?, name_source = ?, updated_at = ?"
            " WHERE id = ? AND owner_id = ?"
        )
        params: tuple[object, ...] = (name, name_source, _utcnow(), document_id, owner_id)
        if only_if_source is not None:
            query += " AND name_source = ?"
            params += (only_if_source,)
        with self._connect() as conn:
            cursor = conn.execute(query, params)
        if cursor.rowcount == 0:
            # Either no such document, or (when guarded) it was renamed away
            # from `only_if_source` in the meantime: leave it as-is.
            return self.get_document(document_id, owner_id=owner_id)
        return self.get_document(document_id, owner_id=owner_id)

    def set_folder(
        self, document_id: int, folder_id: int | None, *, owner_id: int
    ) -> Document | None:
        """Organizational move; like set_name it never bumps revision, so a
        sidebar move can never 409 an in-flight autosave. Last move wins."""
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE documents SET folder_id = ?, updated_at = ?"
                " WHERE id = ? AND owner_id = ?",
                (folder_id, _utcnow(), document_id, owner_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get_document(document_id, owner_id=owner_id)

    def delete_document(self, document_id: int, *, owner_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM documents WHERE id = ? AND owner_id = ?",
                (document_id, owner_id),
            )
        return cursor.rowcount > 0
