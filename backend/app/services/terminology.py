import json
import sqlite3
from pathlib import Path

from pydantic import BaseModel, Field

from app.core.models import Language
from app.services._sqlite import connect

_SCHEMA = """
CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
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


class Domain(BaseModel):
    id: int
    name: str
    description: str = ""


class Term(BaseModel):
    id: int
    domain_id: int
    language: Language
    preferred: str
    forbidden_variants: list[str] = Field(default_factory=list)
    definition: str = ""
    case_sensitive: bool = False


def _row_to_term(row: sqlite3.Row) -> Term:
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
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return connect(self.db_path)

    # -- domains ---------------------------------------------------------

    def list_domains(self) -> list[Domain]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM domains ORDER BY name").fetchall()
        return [Domain(**dict(row)) for row in rows]

    def get_domain(self, domain_id: int) -> Domain | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM domains WHERE id = ?", (domain_id,)
            ).fetchone()
        return Domain(**dict(row)) if row else None

    def create_domain(self, name: str, description: str = "") -> Domain:
        with self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO domains (name, description) VALUES (?, ?)",
                (name, description),
            )
            domain_id = cursor.lastrowid
        assert domain_id is not None
        return Domain(id=domain_id, name=name, description=description)

    def update_domain(
        self, domain_id: int, name: str | None = None, description: str | None = None
    ) -> Domain | None:
        current = self.get_domain(domain_id)
        if current is None:
            return None
        new_name = name if name is not None else current.name
        new_description = description if description is not None else current.description
        with self._connect() as conn:
            conn.execute(
                "UPDATE domains SET name = ?, description = ? WHERE id = ?",
                (new_name, new_description, domain_id),
            )
        return Domain(id=domain_id, name=new_name, description=new_description)

    def delete_domain(self, domain_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM domains WHERE id = ?", (domain_id,))
        return cursor.rowcount > 0

    # -- terms -----------------------------------------------------------

    def list_terms(
        self, domain_id: int, language: Language | None = None
    ) -> list[Term]:
        query = "SELECT * FROM terms WHERE domain_id = ?"
        params: list[object] = [domain_id]
        if language is not None:
            query += " AND language = ?"
            params.append(language.value)
        with self._connect() as conn:
            rows = conn.execute(query + " ORDER BY preferred", params).fetchall()
        return [_row_to_term(row) for row in rows]

    def get_term(self, term_id: int) -> Term | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM terms WHERE id = ?", (term_id,)).fetchone()
        return _row_to_term(row) if row else None

    def create_term(
        self,
        domain_id: int,
        *,
        language: Language,
        preferred: str,
        forbidden_variants: list[str] | None = None,
        definition: str = "",
        case_sensitive: bool = False,
    ) -> Term:
        variants = forbidden_variants or []
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO terms
                   (domain_id, language, preferred, forbidden_variants, definition, case_sensitive)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    domain_id,
                    language.value,
                    preferred,
                    json.dumps(variants),
                    definition,
                    int(case_sensitive),
                ),
            )
            term_id = cursor.lastrowid
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
        language: Language | None = None,
        preferred: str | None = None,
        forbidden_variants: list[str] | None = None,
        definition: str | None = None,
        case_sensitive: bool | None = None,
    ) -> Term | None:
        current = self.get_term(term_id)
        if current is None:
            return None
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
        with self._connect() as conn:
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

    def delete_term(self, term_id: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM terms WHERE id = ?", (term_id,))
        return cursor.rowcount > 0
