import json
import logging
from typing import Any

from pydantic import BaseModel, Field, computed_field

from app.core.models import Language
from app.services.db import Database, Row, UniqueViolationError, table_columns, verify_schema
from app.services.ownership import GlobalReadOnlyError

logger = logging.getLogger(__name__)

# The literal lives here (not in seed.py) because seed.py imports
# TerminologyStore; importing back would be a cycle. Tied to seed.DOMAIN_NAME
# by test_seed_domain_name_constant_matches_the_seeder.
_SEED_DOMAIN_NAME = "Product docs"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER
);
CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    preferred TEXT NOT NULL,
    forbidden_variants TEXT NOT NULL DEFAULT '[]',
    definition TEXT NOT NULL DEFAULT '',
    case_sensitive INTEGER NOT NULL DEFAULT 0
);
"""

# Tables (and post-release columns) this store needs; checked instead of
# created when the app runs without schema management (B36 spec R3).
_REQUIRED_SCHEMA = {"domains": [("owner_id", "INTEGER")], "terms": []}


class Domain(BaseModel):
    id: int
    name: str
    description: str = ""
    owner_id: int | None = Field(default=None, exclude=True)

    @computed_field  # appears in every API response; owner_id itself does not
    @property
    def is_global(self) -> bool:
        return self.owner_id is None


class Term(BaseModel):
    id: int
    domain_id: int
    language: Language
    preferred: str
    forbidden_variants: list[str] = Field(default_factory=list)
    definition: str = ""
    case_sensitive: bool = False


def _row_to_domain(row: Row) -> Domain:
    return Domain(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        owner_id=row["owner_id"],
    )


def _row_to_term(row: Row) -> Term:
    return Term(
        id=row["id"],
        domain_id=row["domain_id"],
        language=Language(row["language"]),
        preferred=row["preferred"],
        forbidden_variants=json.loads(row["forbidden_variants"]),
        definition=row["definition"],
        case_sensitive=bool(row["case_sensitive"]),
    )


class TerminologyStore:
    def __init__(self, db: Database, *, manage_schema: bool = True) -> None:
        self.db = db
        with self._connect() as conn:
            if manage_schema:
                conn.executescript(_SCHEMA)
                self._migrate(conn)
            else:
                verify_schema(conn, _REQUIRED_SCHEMA)

    def _migrate(self, conn: Any) -> None:
        columns = table_columns(conn, "domains")
        if "owner_id" not in columns:
            # One-shot backfill (spec §9 step 3): the seed domain (matched
            # by name — seed.DOMAIN_NAME, asserted equal by a test) becomes
            # global; every other pre-auth row belongs to the admin (id 1).
            conn.execute("ALTER TABLE domains ADD COLUMN owner_id INTEGER")
            conn.execute(
                "UPDATE domains SET owner_id = 1 WHERE name <> ?",
                (_SEED_DOMAIN_NAME,),
            )
        # domains never had a uniqueness guarantee, so legal duplicates may
        # exist: pre-scan and skip-with-warning before each partial index.
        owner_dupes = conn.execute(
            "SELECT owner_id, MIN(name) AS name FROM domains WHERE owner_id IS NOT NULL"
            " GROUP BY owner_id, lower(name) HAVING count(*) > 1"
        ).fetchall()
        if owner_dupes:
            logger.warning(
                "domains has per-owner duplicates %s; skipping owner index",
                [tuple(row) for row in owner_dupes],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_owner_name"
                " ON domains(owner_id, LOWER(name)) WHERE owner_id IS NOT NULL"
            )
        global_dupes = conn.execute(
            "SELECT MIN(name) AS name FROM domains WHERE owner_id IS NULL"
            " GROUP BY lower(name) HAVING count(*) > 1"
        ).fetchall()
        if global_dupes:
            logger.warning(
                "domains has global duplicates %s; skipping global index",
                [tuple(row) for row in global_dupes],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_global_name"
                " ON domains(LOWER(name)) WHERE owner_id IS NULL"
            )

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return self.db.connect()

    # -- domains ---------------------------------------------------------

    def list_domains(self, *, owner_id: int) -> list[Domain]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM domains"
                " WHERE (owner_id IS NULL OR owner_id = ?) ORDER BY name",
                (owner_id,),
            ).fetchall()
        return [_row_to_domain(row) for row in rows]

    def get_domain(self, domain_id: int, *, owner_id: int) -> Domain | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM domains WHERE id = ?"
                " AND (owner_id IS NULL OR owner_id = ?)",
                (domain_id, owner_id),
            ).fetchone()
        return _row_to_domain(row) if row else None

    def create_domain(
        self, name: str, description: str = "", *, owner_id: int | None
    ) -> Domain:
        try:
            with self._connect() as conn:
                cursor = conn.execute(
                    "INSERT INTO domains (name, description, owner_id)"
                    " VALUES (?, ?, ?) RETURNING id",
                    (name, description, owner_id),
                )
                domain_id = cursor.fetchone()["id"]
        except UniqueViolationError as exc:
            raise ValueError(f"Domain '{name}' already exists") from exc
        assert domain_id is not None
        return Domain(id=domain_id, name=name, description=description, owner_id=owner_id)

    def has_global_domains(self) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM domains WHERE owner_id IS NULL LIMIT 1"
            ).fetchone()
        return row is not None

    def update_domain(
        self,
        domain_id: int,
        *,
        owner_id: int,
        is_admin: bool,
        name: str | None = None,
        description: str | None = None,
    ) -> Domain | None:
        current = self.get_domain(domain_id, owner_id=owner_id)
        if current is None:
            return None
        if current.is_global and not is_admin:
            raise GlobalReadOnlyError("Only admins can change built-in items")
        new_name = name if name is not None else current.name
        new_description = description if description is not None else current.description
        try:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE domains SET name = ?, description = ? WHERE id = ?",
                    (new_name, new_description, domain_id),
                )
        except UniqueViolationError as exc:
            raise ValueError(f"Domain '{new_name}' already exists") from exc
        return current.model_copy(update={"name": new_name, "description": new_description})

    def delete_domain(self, domain_id: int, *, owner_id: int, is_admin: bool) -> bool:
        current = self.get_domain(domain_id, owner_id=owner_id)
        if current is None:
            return False
        if current.is_global and not is_admin:
            raise GlobalReadOnlyError("Only admins can change built-in items")
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM domains WHERE id = ?", (domain_id,))
        return cursor.rowcount > 0

    # -- terms -----------------------------------------------------------

    def _visible_domain_row(
        self, conn: Any, domain_id: int, owner_id: int
    ) -> Row | None:
        return conn.execute(
            "SELECT * FROM domains WHERE id = ?"
            " AND (owner_id IS NULL OR owner_id = ?)",
            (domain_id, owner_id),
        ).fetchone()

    def list_terms(
        self, domain_id: int, *, owner_id: int, language: Language | None = None
    ) -> list[Term] | None:
        with self._connect() as conn:
            if self._visible_domain_row(conn, domain_id, owner_id) is None:
                return None
            query = "SELECT * FROM terms WHERE domain_id = ?"
            params: list[object] = [domain_id]
            if language is not None:
                query += " AND language = ?"
                params.append(language.value)
            rows = conn.execute(query + " ORDER BY preferred", params).fetchall()
        return [_row_to_term(row) for row in rows]

    def get_term(self, term_id: int, *, owner_id: int) -> Term | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT t.* FROM terms t JOIN domains d ON d.id = t.domain_id"
                " WHERE t.id = ? AND (d.owner_id IS NULL OR d.owner_id = ?)",
                (term_id, owner_id),
            ).fetchone()
        return _row_to_term(row) if row else None

    def create_term(
        self,
        domain_id: int,
        *,
        owner_id: int,
        is_admin: bool,
        language: Language,
        preferred: str,
        forbidden_variants: list[str] | None = None,
        definition: str = "",
        case_sensitive: bool = False,
    ) -> Term | None:
        with self._connect() as conn:
            domain_row = self._visible_domain_row(conn, domain_id, owner_id)
            if domain_row is None:
                return None
            if domain_row["owner_id"] is None and not is_admin:
                raise GlobalReadOnlyError("Only admins can change built-in items")
            variants = forbidden_variants or []
            cursor = conn.execute(
                """INSERT INTO terms
                   (domain_id, language, preferred, forbidden_variants, definition, case_sensitive)
                   VALUES (?, ?, ?, ?, ?, ?) RETURNING id""",
                (
                    domain_id,
                    language.value,
                    preferred,
                    json.dumps(variants),
                    definition,
                    int(case_sensitive),
                ),
            )
            term_id = cursor.fetchone()["id"]
        assert term_id is not None
        return Term(
            id=term_id,
            domain_id=domain_id,
            language=language,
            preferred=preferred,
            forbidden_variants=variants,
            definition=definition,
            case_sensitive=case_sensitive,
        )

    def update_term(
        self,
        term_id: int,
        *,
        owner_id: int,
        is_admin: bool,
        language: Language | None = None,
        preferred: str | None = None,
        forbidden_variants: list[str] | None = None,
        definition: str | None = None,
        case_sensitive: bool | None = None,
    ) -> Term | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT t.*, d.owner_id AS domain_owner_id FROM terms t"
                " JOIN domains d ON d.id = t.domain_id WHERE t.id = ?",
                (term_id,),
            ).fetchone()
            if row is None:
                return None
            domain_owner_id = row["domain_owner_id"]
            if not (domain_owner_id is None or domain_owner_id == owner_id):
                return None
            if domain_owner_id is None and not is_admin:
                raise GlobalReadOnlyError("Only admins can change built-in items")
            current = _row_to_term(row)
            updated = current.model_copy(
                update={
                    key: value
                    for key, value in {
                        "language": language,
                        "preferred": preferred,
                        "forbidden_variants": forbidden_variants,
                        "definition": definition,
                        "case_sensitive": case_sensitive,
                    }.items()
                    if value is not None
                }
            )
            conn.execute(
                """UPDATE terms SET language = ?, preferred = ?, forbidden_variants = ?,
                   definition = ?, case_sensitive = ? WHERE id = ?""",
                (
                    updated.language.value,
                    updated.preferred,
                    json.dumps(updated.forbidden_variants),
                    updated.definition,
                    int(updated.case_sensitive),
                    term_id,
                ),
            )
        return updated

    def delete_term(self, term_id: int, *, owner_id: int, is_admin: bool) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT d.owner_id AS domain_owner_id FROM terms t"
                " JOIN domains d ON d.id = t.domain_id WHERE t.id = ?",
                (term_id,),
            ).fetchone()
            if row is None:
                return False
            domain_owner_id = row["domain_owner_id"]
            if not (domain_owner_id is None or domain_owner_id == owner_id):
                return False
            if domain_owner_id is None and not is_admin:
                raise GlobalReadOnlyError("Only admins can change built-in items")
            cursor = conn.execute("DELETE FROM terms WHERE id = ?", (term_id,))
        return cursor.rowcount > 0
