import json
import sqlite3
from pathlib import Path

from pydantic import BaseModel, Field

from app.core.models import Language

_SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language TEXT NOT NULL,
    name TEXT NOT NULL,
    is_standard INTEGER NOT NULL DEFAULT 0,
    categories_off TEXT NOT NULL DEFAULT '[]',
    rule_exceptions TEXT NOT NULL DEFAULT '[]',
    domain_ids TEXT NOT NULL DEFAULT '[]',
    llm_provider TEXT,
    llm_model TEXT,
    llm_tier TEXT,
    llm_instructions TEXT NOT NULL DEFAULT '',
    example_text TEXT NOT NULL DEFAULT '',
    UNIQUE(language, name)
);
CREATE TABLE IF NOT EXISTS profile_seed_markers (
    language TEXT PRIMARY KEY
);
"""


class Profile(BaseModel):
    id: int
    language: Language
    name: str
    is_standard: bool = False
    categories_off: list[str] = Field(default_factory=list)
    rule_exceptions: list[str] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_tier: str | None = None
    llm_instructions: str = ""
    example_text: str = ""


def _row_to_profile(row: sqlite3.Row) -> Profile:
    return Profile(
        id=row["id"],
        language=Language(row["language"]),
        name=row["name"],
        is_standard=bool(row["is_standard"]),
        categories_off=json.loads(row["categories_off"]),
        rule_exceptions=json.loads(row["rule_exceptions"]),
        domain_ids=json.loads(row["domain_ids"]),
        llm_provider=row["llm_provider"],
        llm_model=row["llm_model"],
        llm_tier=row["llm_tier"],
        llm_instructions=row["llm_instructions"],
        example_text=row["example_text"],
    )


class ProfileStore:
    """Checking profiles, stored beside domains/terms in the same SQLite DB."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(profiles)")}
        if "llm_tier" not in columns:
            conn.execute("ALTER TABLE profiles ADD COLUMN llm_tier TEXT")

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def list_profiles(self, language: Language) -> list[Profile]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM profiles WHERE language = ?"
                " ORDER BY is_standard DESC, name",
                (language.value,),
            ).fetchall()
        return [_row_to_profile(row) for row in rows]

    def get_profile(self, profile_id: int) -> Profile | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM profiles WHERE id = ?", (profile_id,)
            ).fetchone()
        return _row_to_profile(row) if row else None

    def create_profile(
        self,
        language: Language,
        name: str,
        *,
        is_standard: bool = False,
        categories_off: list[str] | None = None,
        rule_exceptions: list[str] | None = None,
        domain_ids: list[int] | None = None,
        llm_provider: str | None = None,
        llm_model: str | None = None,
        llm_tier: str | None = None,
        llm_instructions: str = "",
        example_text: str = "",
    ) -> Profile:
        try:
            with self._connect() as conn:
                cursor = conn.execute(
                    """INSERT INTO profiles
                       (language, name, is_standard, categories_off, rule_exceptions,
                        domain_ids, llm_provider, llm_model, llm_tier, llm_instructions,
                        example_text)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        language.value,
                        name,
                        int(is_standard),
                        json.dumps(categories_off or []),
                        json.dumps(rule_exceptions or []),
                        json.dumps(domain_ids or []),
                        llm_provider,
                        llm_model,
                        llm_tier,
                        llm_instructions,
                        example_text,
                    ),
                )
                profile_id = cursor.lastrowid
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Profile '{name}' already exists for {language.value}") from exc
        assert profile_id is not None
        profile = self.get_profile(profile_id)
        assert profile is not None
        return profile

    _UPDATABLE = (
        "name",
        "categories_off",
        "rule_exceptions",
        "domain_ids",
        "llm_provider",
        "llm_model",
        "llm_tier",
        "llm_instructions",
        "example_text",
    )

    def update_profile(self, profile_id: int, **fields: object) -> Profile | None:
        current = self.get_profile(profile_id)
        if current is None:
            return None
        unknown = set(fields) - set(self._UPDATABLE)
        assert not unknown, f"not updatable: {unknown}"
        merged = current.model_copy(update=fields)
        try:
            with self._connect() as conn:
                conn.execute(
                    """UPDATE profiles SET name = ?, categories_off = ?,
                       rule_exceptions = ?, domain_ids = ?, llm_provider = ?,
                       llm_model = ?, llm_tier = ?, llm_instructions = ?, example_text = ?
                       WHERE id = ?""",
                    (
                        merged.name,
                        json.dumps(merged.categories_off),
                        json.dumps(merged.rule_exceptions),
                        json.dumps(merged.domain_ids),
                        merged.llm_provider,
                        merged.llm_model,
                        merged.llm_tier,
                        merged.llm_instructions,
                        merged.example_text,
                        profile_id,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError(
                f"Profile '{merged.name}' already exists for {merged.language.value}"
            ) from exc
        return merged

    def delete_profile(self, profile_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        return cursor.rowcount > 0

    def remove_domain_everywhere(self, domain_id: int) -> None:
        """Drop a deleted terminology domain from every profile."""
        with self._connect() as conn:
            rows = conn.execute("SELECT id, domain_ids FROM profiles").fetchall()
            for row in rows:
                ids = json.loads(row["domain_ids"])
                if domain_id in ids:
                    conn.execute(
                        "UPDATE profiles SET domain_ids = ? WHERE id = ?",
                        (json.dumps([d for d in ids if d != domain_id]), row["id"]),
                    )

    # -- seed markers ------------------------------------------------------

    def is_example_seeded(self, language: Language) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM profile_seed_markers WHERE language = ?",
                (language.value,),
            ).fetchone()
        return row is not None

    def mark_example_seeded(self, language: Language) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO profile_seed_markers (language) VALUES (?)",
                (language.value,),
            )

    def standard_profile(self, language: Language) -> Profile | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM profiles WHERE language = ? AND is_standard = 1",
                (language.value,),
            ).fetchone()
        return _row_to_profile(row) if row else None
