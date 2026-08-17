import json
import logging
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from app.core.models import Language
from app.services.db import Database, Row, UniqueViolationError, migrate_columns, verify_schema

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    default_language TEXT,
    default_profile_id INTEGER,
    default_domain_ids TEXT,
    default_llm_provider TEXT,
    default_llm_model TEXT,
    default_llm_tier TEXT,
    default_llm_auto INTEGER
);
"""

_MIGRATED_COLUMNS = [
    ("default_language", "TEXT"),
    ("default_profile_id", "INTEGER"),
    ("default_domain_ids", "TEXT"),
    ("default_llm_provider", "TEXT"),
    ("default_llm_model", "TEXT"),
    ("default_llm_tier", "TEXT"),
    ("default_llm_auto", "INTEGER"),
]

# Tables (and post-release columns) this store needs; checked instead of
# created when the app runs without schema management (B36 spec R3).
_REQUIRED_SCHEMA = {"folders": _MIGRATED_COLUMNS}


class FolderDefaults(BaseModel):
    """Optional per-folder settings applied to documents created inside.

    NULL/None means "no default" (fall back to the header state at creation
    time). default_domain_ids distinguishes None (unset) from [] (a set
    default of "no domains").
    """

    default_language: Language | None = None
    default_profile_id: int | None = None
    default_domain_ids: list[int] | None = None
    default_llm_provider: str | None = None
    default_llm_model: str | None = None
    default_llm_tier: str | None = None
    default_llm_auto: bool | None = None


class Folder(FolderDefaults):
    id: int
    owner_id: int
    name: str
    created_at: str


def _utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_folder(row: Row) -> Folder:
    return Folder(
        id=row["id"],
        owner_id=row["owner_id"],
        name=row["name"],
        created_at=row["created_at"],
        default_language=(
            Language(row["default_language"]) if row["default_language"] else None
        ),
        default_profile_id=row["default_profile_id"],
        default_domain_ids=(
            json.loads(row["default_domain_ids"])
            if row["default_domain_ids"] is not None
            else None
        ),
        default_llm_provider=row["default_llm_provider"],
        default_llm_model=row["default_llm_model"],
        default_llm_tier=row["default_llm_tier"],
        default_llm_auto=(
            None if row["default_llm_auto"] is None else bool(row["default_llm_auto"])
        ),
    )


class FolderStore:
    """Project folders grouping documents; name-only in this phase.

    Phase 3 (per-folder defaults) adds columns via an idempotent _migrate,
    like the profiles/documents stores.
    """

    def __init__(self, db: Database, *, manage_schema: bool = True) -> None:
        self.db = db
        with self._connect() as conn:
            if manage_schema:
                conn.executescript(_SCHEMA)
                self._migrate(conn)
            else:
                verify_schema(conn, _REQUIRED_SCHEMA)

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return self.db.connect()

    def _migrate(self, conn: Any) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        migrate_columns(conn, "folders", _MIGRATED_COLUMNS)
        # M3 rebuild, guarded by shape: the legacy table carries an inline
        # UNIQUE on name (global uniqueness — wrong once folders are
        # per-user) and a DEFAULT 1 on owner_id (would let an INSERT that
        # forgets the owner silently file under the admin). SQLite cannot
        # drop either without the documented table rebuild.
        # Legacy rebuild reads sqlite_master; pre-B15 databases are SQLite
        # by definition — Postgres only ever sees fresh schemas.
        if self.db.dialect == "sqlite":
            sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='folders'"
            ).fetchone()[0]
            if "UNIQUE" in sql.upper() or "DEFAULT 1" in sql:
                columns = (
                    "id, owner_id, name, created_at, default_language,"
                    " default_profile_id, default_domain_ids, default_llm_provider,"
                    " default_llm_model, default_llm_tier, default_llm_auto"
                )
                conn.execute(_SCHEMA.replace("IF NOT EXISTS folders", "folders_new"))
                conn.execute(
                    f"INSERT INTO folders_new ({columns}) SELECT {columns} FROM folders"
                )
                conn.execute("DROP TABLE folders")
                conn.execute("ALTER TABLE folders_new RENAME TO folders")
        # Per-owner LOWER(name) uniqueness, with the house duplicate pre-scan.
        duplicates = conn.execute(
            "SELECT owner_id, MIN(name) AS name FROM folders"
            " GROUP BY owner_id, lower(name) HAVING count(*) > 1"
        ).fetchall()
        if duplicates:
            logger.warning(
                "folders table has per-owner case-duplicate names %s; "
                "skipping unique index",
                [(row[0], row[1]) for row in duplicates],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_owner_name "
                "ON folders(owner_id, LOWER(name))"
            )

    def set_defaults(
        self, folder_id: int, defaults: FolderDefaults, *, owner_id: int
    ) -> Folder | None:
        """Full replace of the folder's defaults; None = unknown folder."""
        if self.get_folder(folder_id, owner_id=owner_id) is None:
            return None
        with self._connect() as conn:
            conn.execute(
                """UPDATE folders SET default_language = ?, default_profile_id = ?,
                   default_domain_ids = ?, default_llm_provider = ?,
                   default_llm_model = ?, default_llm_tier = ?, default_llm_auto = ?
                   WHERE id = ? AND owner_id = ?""",
                (
                    defaults.default_language.value
                    if defaults.default_language
                    else None,
                    defaults.default_profile_id,
                    json.dumps(defaults.default_domain_ids)
                    if defaults.default_domain_ids is not None
                    else None,
                    defaults.default_llm_provider,
                    defaults.default_llm_model,
                    defaults.default_llm_tier,
                    None
                    if defaults.default_llm_auto is None
                    else int(defaults.default_llm_auto),
                    folder_id,
                    owner_id,
                ),
            )
        return self.get_folder(folder_id, owner_id=owner_id)

    def list_folders(self, *, owner_id: int) -> list[Folder]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM folders WHERE owner_id = ?"
                " ORDER BY LOWER(name), id",
                (owner_id,),
            ).fetchall()
        return [_row_to_folder(row) for row in rows]

    def get_folder(self, folder_id: int, *, owner_id: int) -> Folder | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM folders WHERE id = ? AND owner_id = ?",
                (folder_id, owner_id),
            ).fetchone()
        return _row_to_folder(row) if row else None

    def create_folder(self, name: str, *, owner_id: int) -> Folder:
        try:
            with self._connect() as conn:
                cursor = conn.execute(
                    "INSERT INTO folders (owner_id, name, created_at) VALUES (?, ?, ?)"
                    " RETURNING id",
                    (owner_id, name, _utcnow()),
                )
                folder_id = cursor.fetchone()["id"]
        except UniqueViolationError as exc:
            raise ValueError(f"Folder '{name}' already exists") from exc
        assert folder_id is not None
        folder = self.get_folder(folder_id, owner_id=owner_id)
        assert folder is not None
        return folder

    def rename_folder(
        self, folder_id: int, name: str, *, owner_id: int
    ) -> Folder | None:
        if self.get_folder(folder_id, owner_id=owner_id) is None:
            return None
        try:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE folders SET name = ? WHERE id = ? AND owner_id = ?",
                    (name, folder_id, owner_id),
                )
        except UniqueViolationError as exc:
            raise ValueError(f"Folder '{name}' already exists") from exc
        return self.get_folder(folder_id, owner_id=owner_id)

    def delete_folder(self, folder_id: int, *, owner_id: int) -> bool:
        """Folders never take documents with them: members drop back to the
        ungrouped list in the same transaction as the folder row's removal.
        Both statements carry the owner: folder ids are just integers, so
        without the scope a caller could unfile another owner's documents."""
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM folders WHERE id = ? AND owner_id = ?",
                (folder_id, owner_id),
            )
            if cursor.rowcount:
                conn.execute(
                    "UPDATE documents SET folder_id = NULL"
                    " WHERE folder_id = ? AND owner_id = ?",
                    (folder_id, owner_id),
                )
        return cursor.rowcount > 0
