import json
import logging
from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.core.models import Language
from app.services.db import (
    Database,
    Row,
    UniqueViolationError,
    migrate_columns,
    table_columns,
)
from app.services.ownership import GlobalReadOnlyError

logger = logging.getLogger(__name__)

# The single source for both the migration's name-match backfill and the
# seeder's example set (app/services/seed_profiles.py imports this — the
# reverse import direction would be a cycle).
SEED_EXAMPLE_NAMES: tuple[str, ...] = ("Marketing", "Technical Documentation", "Blog")

_SCHEMA_TABLE = """
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language TEXT NOT NULL,
    name TEXT NOT NULL,
    is_standard INTEGER NOT NULL DEFAULT 0,
    categories_off TEXT NOT NULL DEFAULT '[]',
    rule_exceptions TEXT NOT NULL DEFAULT '[]',
    packs_on TEXT NOT NULL DEFAULT '[]',
    domain_ids TEXT NOT NULL DEFAULT '[]',
    llm_provider TEXT,
    llm_model TEXT,
    llm_tier TEXT,
    llm_instructions TEXT NOT NULL DEFAULT '',
    example_text TEXT NOT NULL DEFAULT '',
    owner_id INTEGER
);
"""

_SCHEMA = (
    _SCHEMA_TABLE
    + """
CREATE TABLE IF NOT EXISTS profile_seed_markers (
    language TEXT PRIMARY KEY
);
"""
)


class Profile(BaseModel):
    id: int
    language: Language
    name: str
    is_standard: bool = False
    categories_off: list[str] = Field(default_factory=list)
    rule_exceptions: list[str] = Field(default_factory=list)
    packs_on: list[str] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_tier: str | None = None
    llm_instructions: str = ""
    example_text: str = ""
    owner_id: int | None = Field(default=None, exclude=True)

    @computed_field  # appears in every API response; owner_id itself does not
    @property
    def is_global(self) -> bool:
        return self.owner_id is None


def _row_to_profile(row: Row) -> Profile:
    return Profile(
        id=row["id"],
        language=Language(row["language"]),
        name=row["name"],
        is_standard=bool(row["is_standard"]),
        categories_off=json.loads(row["categories_off"]),
        rule_exceptions=json.loads(row["rule_exceptions"]),
        packs_on=json.loads(row["packs_on"]),
        domain_ids=json.loads(row["domain_ids"]),
        llm_provider=row["llm_provider"],
        llm_model=row["llm_model"],
        llm_tier=row["llm_tier"],
        llm_instructions=row["llm_instructions"],
        example_text=row["example_text"],
        owner_id=row["owner_id"],
    )


class ProfileStore:
    """Checking profiles, stored beside domains/terms in the same SQLite DB."""

    def __init__(self, db: Database) -> None:
        self.db = db
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    def _migrate(self, conn: Any) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        migrate_columns(
            conn,
            "profiles",
            [("llm_tier", "TEXT"), ("packs_on", "TEXT NOT NULL DEFAULT '[]'")],
        )
        columns = table_columns(conn, "profiles")
        if "owner_id" not in columns:
            # One-shot backfill against the pre-auth single-owner DB (spec
            # §9 step 3): seed rows (name-matched, since there are no
            # per-row seed markers) become global, everything else belongs
            # to the admin (id 1). Never re-run: a later rename onto a seed
            # name must not re-globalize a private row.
            conn.execute("ALTER TABLE profiles ADD COLUMN owner_id INTEGER")
            placeholders = ", ".join("?" for _ in SEED_EXAMPLE_NAMES)
            conn.execute(
                f"""UPDATE profiles SET owner_id = 1
                    WHERE is_standard = 0
                      AND NOT (name IN ({placeholders})
                               AND language IN
                                   (SELECT language FROM profile_seed_markers))""",
                SEED_EXAMPLE_NAMES,
            )
            # is_standard rows and marker-matched seed names keep NULL.
        # Rebuild, guarded by shape: the legacy table-level
        # UNIQUE(language, name) enforces global cross-owner uniqueness and
        # SQLite cannot drop it without the documented table rebuild.
        # Legacy rebuild reads sqlite_master; pre-B15 databases are SQLite
        # by definition — Postgres only ever sees fresh schemas.
        if self.db.dialect == "sqlite":
            sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='profiles'"
            ).fetchone()[0]
            if "UNIQUE" in sql.upper():
                cols = (
                    "id, language, name, is_standard, categories_off,"
                    " rule_exceptions, packs_on, domain_ids, llm_provider,"
                    " llm_model, llm_tier, llm_instructions, example_text, owner_id"
                )
                conn.execute(
                    _SCHEMA_TABLE.replace("IF NOT EXISTS profiles", "profiles_new")
                )
                conn.execute(
                    f"INSERT INTO profiles_new ({cols}) SELECT {cols} FROM profiles"
                )
                conn.execute("DROP TABLE profiles")
                conn.execute("ALTER TABLE profiles_new RENAME TO profiles")
        # Two partial unique indexes (SQLite treats NULLs as distinct, so a
        # single composite index would let duplicate global names pass),
        # each preceded by the house duplicate pre-scan.
        user_dupes = conn.execute(
            "SELECT owner_id, language, MIN(name) AS name FROM profiles"
            " WHERE owner_id IS NOT NULL"
            " GROUP BY owner_id, language, lower(name) HAVING count(*) > 1"
        ).fetchall()
        if user_dupes:
            logger.warning(
                "profiles has per-owner duplicates %s; skipping owner index",
                [tuple(row) for row in user_dupes],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_owner_lang_name"
                " ON profiles(owner_id, language, LOWER(name))"
                " WHERE owner_id IS NOT NULL"
            )
        global_dupes = conn.execute(
            "SELECT language, MIN(name) AS name FROM profiles WHERE owner_id IS NULL"
            " GROUP BY language, lower(name) HAVING count(*) > 1"
        ).fetchall()
        if global_dupes:
            logger.warning(
                "profiles has global duplicates %s; skipping global index",
                [tuple(row) for row in global_dupes],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_global_lang_name"
                " ON profiles(language, LOWER(name))"
                " WHERE owner_id IS NULL"
            )

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return self.db.connect()

    def list_profiles(self, language: Language, *, owner_id: int) -> list[Profile]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM profiles WHERE language = ?"
                " AND (owner_id IS NULL OR owner_id = ?)"
                " ORDER BY is_standard DESC, name",
                (language.value, owner_id),
            ).fetchall()
        return [_row_to_profile(row) for row in rows]

    def get_profile(self, profile_id: int, *, owner_id: int) -> Profile | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM profiles WHERE id = ?"
                " AND (owner_id IS NULL OR owner_id = ?)",
                (profile_id, owner_id),
            ).fetchone()
        return _row_to_profile(row) if row else None

    def create_profile(
        self,
        language: Language,
        name: str,
        *,
        owner_id: int | None,
        is_standard: bool = False,
        categories_off: list[str] | None = None,
        rule_exceptions: list[str] | None = None,
        packs_on: list[str] | None = None,
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
                        packs_on, domain_ids, llm_provider, llm_model, llm_tier,
                        llm_instructions, example_text, owner_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""",
                    (
                        language.value,
                        name,
                        int(is_standard),
                        json.dumps(categories_off or []),
                        json.dumps(rule_exceptions or []),
                        json.dumps(packs_on or []),
                        json.dumps(domain_ids or []),
                        llm_provider,
                        llm_model,
                        llm_tier,
                        llm_instructions,
                        example_text,
                        owner_id,
                    ),
                )
                profile_id = cursor.fetchone()["id"]
        except UniqueViolationError as exc:
            raise ValueError(f"Profile '{name}' already exists for {language.value}") from exc
        assert profile_id is not None
        # owner_id may be None (a global create): the scoped query's
        # "owner_id IS NULL OR owner_id = ?" still matches such a row
        # regardless of the bound parameter.
        profile = self.get_profile(profile_id, owner_id=owner_id)
        assert profile is not None
        return profile

    _UPDATABLE = (
        "name",
        "categories_off",
        "rule_exceptions",
        "packs_on",
        "domain_ids",
        "llm_provider",
        "llm_model",
        "llm_tier",
        "llm_instructions",
        "example_text",
    )

    def update_profile(
        self, profile_id: int, *, owner_id: int, is_admin: bool, **fields: object
    ) -> Profile | None:
        current = self.get_profile(profile_id, owner_id=owner_id)
        if current is None:
            return None
        if current.is_global and not is_admin:
            raise GlobalReadOnlyError("Only admins can change built-in items")
        unknown = set(fields) - set(self._UPDATABLE)
        assert not unknown, f"not updatable: {unknown}"
        merged = current.model_copy(update=fields)
        try:
            with self._connect() as conn:
                conn.execute(
                    """UPDATE profiles SET name = ?, categories_off = ?,
                       rule_exceptions = ?, packs_on = ?, domain_ids = ?,
                       llm_provider = ?, llm_model = ?, llm_tier = ?,
                       llm_instructions = ?, example_text = ?
                       WHERE id = ?""",
                    (
                        merged.name,
                        json.dumps(merged.categories_off),
                        json.dumps(merged.rule_exceptions),
                        json.dumps(merged.packs_on),
                        json.dumps(merged.domain_ids),
                        merged.llm_provider,
                        merged.llm_model,
                        merged.llm_tier,
                        merged.llm_instructions,
                        merged.example_text,
                        profile_id,
                    ),
                )
        except UniqueViolationError as exc:
            raise ValueError(
                f"Profile '{merged.name}' already exists for {merged.language.value}"
            ) from exc
        return merged

    def delete_profile(self, profile_id: int, *, owner_id: int, is_admin: bool) -> bool:
        current = self.get_profile(profile_id, owner_id=owner_id)
        if current is None:
            return False
        if current.is_global and not is_admin:
            raise GlobalReadOnlyError("Only admins can change built-in items")
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
        return cursor.rowcount > 0

    def remove_domain_everywhere(self, domain_id: int) -> None:
        """Drop a deleted terminology domain from every profile.

        Deliberately unscoped by owner: a domain deletion must drop the id
        from every owner's profiles — it removes a dangling integer,
        reveals nothing, and leaving foreign references would resurrect
        meaning if ids are ever reused.
        """
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
                "INSERT INTO profile_seed_markers (language) VALUES (?)"
                " ON CONFLICT DO NOTHING",
                (language.value,),
            )

    def standard_profile(self, language: Language) -> Profile | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM profiles WHERE language = ?"
                " AND is_standard = 1 AND owner_id IS NULL",
                (language.value,),
            ).fetchone()
        return _row_to_profile(row) if row else None
