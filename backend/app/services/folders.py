import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel

from app.core.models import Language

_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL UNIQUE,
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
    owner_id: int = 1
    name: str
    created_at: str


def _utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_folder(row: sqlite3.Row) -> Folder:
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

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # sqlite3's own context manager only wraps a transaction (commit or
        # rollback); this wrapper also closes the connection afterwards, so
        # `with self._connect() as conn:` cannot leak connections.
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(folders)")}
        for name, decl in (
            ("default_language", "TEXT"),
            ("default_profile_id", "INTEGER"),
            ("default_domain_ids", "TEXT"),
            ("default_llm_provider", "TEXT"),
            ("default_llm_model", "TEXT"),
            ("default_llm_tier", "TEXT"),
            ("default_llm_auto", "INTEGER"),
        ):
            if name not in columns:
                conn.execute(f"ALTER TABLE folders ADD COLUMN {name} {decl}")

    def set_defaults(
        self, folder_id: int, defaults: FolderDefaults
    ) -> Folder | None:
        """Full replace of the folder's defaults; None = unknown folder."""
        if self.get_folder(folder_id) is None:
            return None
        with self._connect() as conn:
            conn.execute(
                """UPDATE folders SET default_language = ?, default_profile_id = ?,
                   default_domain_ids = ?, default_llm_provider = ?,
                   default_llm_model = ?, default_llm_tier = ?, default_llm_auto = ?
                   WHERE id = ?""",
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
                ),
            )
        return self.get_folder(folder_id)

    def list_folders(self) -> list[Folder]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM folders ORDER BY name COLLATE NOCASE, id"
            ).fetchall()
        return [_row_to_folder(row) for row in rows]

    def get_folder(self, folder_id: int) -> Folder | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM folders WHERE id = ?", (folder_id,)
            ).fetchone()
        return _row_to_folder(row) if row else None

    def create_folder(self, name: str) -> Folder:
        try:
            with self._connect() as conn:
                cursor = conn.execute(
                    "INSERT INTO folders (name, created_at) VALUES (?, ?)",
                    (name, _utcnow()),
                )
                folder_id = cursor.lastrowid
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Folder '{name}' already exists") from exc
        assert folder_id is not None
        folder = self.get_folder(folder_id)
        assert folder is not None
        return folder

    def rename_folder(self, folder_id: int, name: str) -> Folder | None:
        if self.get_folder(folder_id) is None:
            return None
        try:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE folders SET name = ? WHERE id = ?",
                    (name, folder_id),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Folder '{name}' already exists") from exc
        return self.get_folder(folder_id)

    def delete_folder(self, folder_id: int) -> bool:
        """Folders never take documents with them: members drop back to the
        ungrouped list in the same transaction as the folder row's removal."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE documents SET folder_id = NULL WHERE folder_id = ?",
                (folder_id,),
            )
            cursor = conn.execute(
                "DELETE FROM folders WHERE id = ?", (folder_id,)
            )
        return cursor.rowcount > 0
