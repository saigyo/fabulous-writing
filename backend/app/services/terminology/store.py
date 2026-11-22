import json
from typing import Any

from pydantic import BaseModel, Field

from app.core.models import Language
from app.services.db import Database, Row, UniqueViolationError, verify_schema
from app.services.ownership import GlobalReadOnlyError, require_writable, visible_clause
from app.services.terminology.model import Domain
from app.services.terminology.schema import REQUIRED_SCHEMA, SCHEMA, migrate_domains


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
                conn.executescript(SCHEMA)
                migrate_domains(conn)
            else:
                verify_schema(conn, REQUIRED_SCHEMA)

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return self.db.connect()

    # -- domains ---------------------------------------------------------

    def list_domains(self, *, owner_id: int) -> list[Domain]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM domains WHERE " + visible_clause() + " ORDER BY name",
                (owner_id,),
            ).fetchall()
        return [_row_to_domain(row) for row in rows]

    def get_domain(self, domain_id: int, *, owner_id: int) -> Domain | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM domains WHERE id = ? AND " + visible_clause(),
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
        require_writable(current.owner_id, is_admin=is_admin)
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
        require_writable(current.owner_id, is_admin=is_admin)
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM domains WHERE id = ?", (domain_id,))
        return cursor.rowcount > 0

    # -- terms -----------------------------------------------------------

    def _visible_domain_row(
        self, conn: Any, domain_id: int, owner_id: int
    ) -> Row | None:
        return conn.execute(
            "SELECT * FROM domains WHERE id = ? AND " + visible_clause(),
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
