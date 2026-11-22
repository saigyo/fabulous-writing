import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from app.core.models import Language
from app.services.db import Database, Row, UniqueViolationError
from app.services.ownership import (
    is_visible,
    require_writable,
    visible_clause,
)
from app.services.terminology import changes, migration, rows, schema
from app.services.terminology.model import (
    PROCESS_STATUS_ENFORCED,
    Actor,
    Concept,
    Domain,
    LanguageSection,
    SectionInput,
    TerminologyConflictError,
    TerminologyRuleError,
    UsageStatus,
    is_enforced,
)


def _row_to_domain(row: Row) -> Domain:
    return Domain(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        owner_id=row["owner_id"],
    )


def _utcnow() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _lock(conn: Any, *, domain_ids: Any = (), concept_ids: Any = ()) -> None:
    for domain_id in sorted(domain_ids):
        conn.execute("UPDATE domains SET name = name WHERE id = ?", (domain_id,))
    for concept_id in sorted(concept_ids):
        conn.execute("UPDATE concepts SET uid = uid WHERE id = ?", (concept_id,))


def _validate(sections: list[SectionInput], current: Concept | None) -> None:
    languages = [s.language for s in sections]
    if len(set(languages)) != len(languages):
        raise TerminologyRuleError(
            "duplicate_language", "A concept can have only one section per language."
        )
    given = set(languages)
    remaining = {s.language for s in current.sections} - given if current else set()
    remaining |= {s.language for s in sections if s.terms}
    if not remaining:
        raise TerminologyRuleError("no_section", "A concept needs at least one language with a term.")
    current_terms = (
        {s.language: {t.id for t in s.terms} for s in current.sections} if current else {}
    )
    for given_section in sections:
        known = current_terms.get(given_section.language, set())
        seen_ids: set[int] = set()
        for term in given_section.terms:
            if term.id is None:
                continue
            if term.id not in known:
                raise TerminologyRuleError(
                    "unknown_term", "A term id must belong to this language section of the concept."
                )
            if term.id in seen_ids:
                raise TerminologyRuleError(
                    "duplicate_term", "A term can appear only once in a section."
                )
            seen_ids.add(term.id)
        texts = [t.text for t in given_section.terms]
        if len(set(texts)) != len(texts):
            raise TerminologyRuleError(
                "duplicate_text", "A language section cannot contain the same term text twice."
            )
        preferred = [
            t for t in given_section.terms
            if t.usage_status == UsageStatus.PREFERRED and is_enforced(t.process_status)
        ]
        if len(preferred) > 1:
            raise TerminologyRuleError(
                "second_preferred", "A language can have only one active preferred term."
            )


def _check_versions(
    current: Concept, sections: list[SectionInput], domain_ids: list[int] | None, revision: int | None
) -> None:
    stored = {s.language: s for s in current.sections}
    for given in sections:
        found = stored.get(given.language)
        expected = (found.id, found.revision) if found else (None, None)
        if (given.id, given.revision) != expected:
            raise TerminologyConflictError(
                given.language.value,
                "This language section was changed since it was read. Reload and try again.",
            )
    if domain_ids is not None and revision != current.revision:
        raise TerminologyConflictError(
            "links", "The domains of this concept were changed since they were read."
            " Reload and try again.",
        )


def _check_domains(conn: Any, domain_ids: list[int], current: Concept, actor: Actor) -> None:
    if not domain_ids:
        raise TerminologyRuleError("no_domain", "A concept belongs to at least one domain.")
    owners = rows.domain_owners(conn, sorted(set(domain_ids)))
    for domain_id in domain_ids:
        if domain_id not in owners or not is_visible(owners[domain_id], user_id=actor.user_id):
            raise TerminologyRuleError("unknown_domain", "A domain does not exist.")
        if owners[domain_id] != current.owner_id:
            raise TerminologyRuleError(
                "domain_owner_mismatch",
                "A concept can only be in domains with the same owner: own or built-in.",
            )


def _record(
    conn: Any,
    concept_id: int,
    before: Concept | None,
    *,
    actor: Actor,
    comment: str,
    now: str,
    batch: str | None = None,
) -> Concept:
    after = rows.load_concept(conn, concept_id)
    assert after is not None
    names = rows.domain_names(conn, sorted(set(after.domain_ids) | set(before.domain_ids if before else [])))
    entries = changes.diff(before, after, domain_names=names)
    if entries:
        changes.write(
            conn, entries, batch=batch or uuid.uuid4().hex, at=now, actor=actor, comment=comment
        )
    if before is not None and (
        before.domain_ids != after.domain_ids
        or {s.language for s in before.sections} != {s.language for s in after.sections}
    ):
        rows.touch_concept(conn, concept_id, now=now, user_id=actor.user_id)
    final = rows.load_concept(conn, concept_id)
    assert final is not None
    return final


def _delete(
    conn: Any, before: Concept, *, actor: Actor, comment: str, now: str, batch: str
) -> None:
    entries = changes.diff(before, None, domain_names=rows.domain_names(conn, before.domain_ids))
    changes.write(conn, entries, batch=batch, at=now, actor=actor, comment=comment)
    conn.execute("DELETE FROM concepts WHERE id = ?", (before.id,))


class TerminologyStore:
    def __init__(self, db: Database, *, manage_schema: bool = True) -> None:
        self.db = db
        with self._connect() as conn:
            if manage_schema:
                conn.executescript(schema.SCHEMA)
                schema.migrate_domains(conn)
                # Without this commit a failed term migration would roll back the
                # domain backfill on SQLite but keep its added column, so the next
                # start would skip the backfill; on Postgres the new tables would go.
                conn.commit()
                migration.migrate_legacy_terms(conn, now=_utcnow())
            else:
                schema.verify(conn)

    def _connect(self):  # thin delegate; the shared helper carries the docs
        return self.db.connect()

    # -- domains ---------------------------------------------------------

    def list_domains(self, *, owner_id: int) -> list[Domain]:
        with self._connect() as conn:
            found = conn.execute(
                "SELECT * FROM domains WHERE " + visible_clause() + " ORDER BY name",
                (owner_id,),
            ).fetchall()
        return [_row_to_domain(row) for row in found]

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

    def delete_domain(self, domain_id: int, *, actor: Actor, comment: str = "") -> bool:
        with self._connect() as conn:
            _lock(conn, domain_ids=[domain_id])
            domain = conn.execute(
                "SELECT owner_id FROM domains WHERE id = ?", (domain_id,)
            ).fetchone()
            if domain is None or not is_visible(domain["owner_id"], user_id=actor.user_id):
                return False
            require_writable(domain["owner_id"], is_admin=actor.is_admin)
            linked = [
                row["concept_id"]
                for row in conn.execute(
                    "SELECT concept_id FROM concept_domains WHERE domain_id = ?", (domain_id,)
                ).fetchall()
            ]
            _lock(conn, concept_ids=linked)
            batch = uuid.uuid4().hex
            now = _utcnow()
            for before in rows.load_linked_concepts(conn, domain_id):
                if before.domain_ids == [domain_id]:
                    _delete(conn, before, actor=actor, comment=comment, now=now, batch=batch)
                else:
                    rows.set_links(
                        conn, before.id, [d for d in before.domain_ids if d != domain_id]
                    )
                    _record(
                        conn, before.id, before, actor=actor, comment=comment, now=now, batch=batch
                    )
            conn.execute("DELETE FROM domains WHERE id = ?", (domain_id,))
            return True

    # -- concepts --------------------------------------------------------

    def _visible_domain_row(
        self, conn: Any, domain_id: int, owner_id: int
    ) -> Row | None:
        return conn.execute(
            "SELECT * FROM domains WHERE id = ? AND " + visible_clause(),
            (domain_id, owner_id),
        ).fetchone()

    def list_concepts(self, domain_id: int, *, owner_id: int) -> list[Concept] | None:
        with self._connect() as conn:
            if self._visible_domain_row(conn, domain_id, owner_id) is None:
                return None
            return rows.load_domain_concepts(conn, domain_id, user_id=owner_id)

    def get_concept(self, concept_id: int, *, owner_id: int) -> Concept | None:
        with self._connect() as conn:
            concept = rows.load_concept(conn, concept_id)
        if concept is None or not is_visible(concept.owner_id, user_id=owner_id):
            return None
        return concept

    def get_concept_by_section(self, section_id: int, *, owner_id: int) -> Concept | None:
        """The concept a language section belongs to, for the old term endpoints,
        whose term id is a section id. Removed again in the third pull request,
        together with those endpoints."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT concept_id FROM concept_languages WHERE id = ?", (section_id,)
            ).fetchone()
            concept = rows.load_concept(conn, row["concept_id"]) if row else None
        if concept is None or not is_visible(concept.owner_id, user_id=owner_id):
            return None
        return concept

    def section_ids_by_preferred(self, domain_id: int, *, owner_id: int) -> list[int] | None:
        """Ids of the domain's language sections that have an enforced preferred
        term, ordered by its text in SQL, so that the database's collation decides
        the order of the old term list as it did before. Removed again in the third
        pull request, together with `get_concept_by_section`."""
        enforced = [status.value for status, on in PROCESS_STATUS_ENFORCED.items() if on]
        with self._connect() as conn:
            if self._visible_domain_row(conn, domain_id, owner_id) is None:
                return None
            found = conn.execute(
                "SELECT s.id FROM concept_languages s"
                " JOIN concepts c ON c.id = s.concept_id"
                " JOIN concept_domains cd ON cd.concept_id = s.concept_id"
                " JOIN concept_terms t ON t.section_id = s.id"
                " WHERE cd.domain_id = ? AND " + visible_clause("c.owner_id")
                + " AND t.usage_status = ?"
                f" AND t.process_status IN ({', '.join('?' for _ in enforced)})"
                " ORDER BY t.text, s.id",
                (domain_id, owner_id, UsageStatus.PREFERRED.value, *enforced),
            ).fetchall()
        return [row["id"] for row in found]

    def list_sections(
        self, domain_id: int, *, owner_id: int, language: Language
    ) -> list[LanguageSection] | None:
        concepts = self.list_concepts(domain_id, owner_id=owner_id)
        if concepts is None:
            return None
        return [s for c in concepts for s in c.sections if s.language == language]

    def create_concept(
        self, domain_id: int, sections: list[SectionInput], *, actor: Actor, comment: str = ""
    ) -> Concept | None:
        with self._connect() as conn:
            _lock(conn, domain_ids=[domain_id])
            domain = conn.execute(
                "SELECT owner_id FROM domains WHERE id = ?", (domain_id,)
            ).fetchone()
            if domain is None or not is_visible(domain["owner_id"], user_id=actor.user_id):
                return None
            require_writable(domain["owner_id"], is_admin=actor.is_admin)
            _validate(sections, None)
            now = _utcnow()
            concept_id = rows.insert_concept(
                conn, owner_id=domain["owner_id"], now=now, user_id=actor.user_id
            )
            rows.set_links(conn, concept_id, [domain_id])
            rows.apply_sections(
                conn, concept_id, None, sections, now=now, user_id=actor.user_id
            )
            return _record(conn, concept_id, None, actor=actor, comment=comment, now=now)

    def save_section(
        self, concept_id: int, section: SectionInput, *, actor: Actor, comment: str = ""
    ) -> Concept | None:
        return self.save_concept(concept_id, sections=[section], actor=actor, comment=comment)

    def save_concept(
        self,
        concept_id: int,
        *,
        sections: Sequence[SectionInput] = (),
        domain_ids: list[int] | None = None,
        revision: int | None = None,
        actor: Actor,
        comment: str = "",
    ) -> Concept | None:
        sections = list(sections)
        with self._connect() as conn:
            _lock(conn, domain_ids=set(domain_ids or ()), concept_ids=[concept_id])
            before = rows.load_concept(conn, concept_id)
            if before is None or not is_visible(before.owner_id, user_id=actor.user_id):
                return None
            require_writable(before.owner_id, is_admin=actor.is_admin)
            _check_versions(before, sections, domain_ids, revision)
            _validate(sections, before)
            if domain_ids is not None:
                _check_domains(conn, domain_ids, before, actor)
                rows.set_links(conn, concept_id, domain_ids)
            now = _utcnow()
            rows.apply_sections(conn, concept_id, before, sections, now=now, user_id=actor.user_id)
            return _record(conn, concept_id, before, actor=actor, comment=comment, now=now)

    def delete_concept(self, concept_id: int, *, actor: Actor, comment: str = "") -> bool:
        with self._connect() as conn:
            _lock(conn, concept_ids=[concept_id])
            before = rows.load_concept(conn, concept_id)
            if before is None or not is_visible(before.owner_id, user_id=actor.user_id):
                return False
            require_writable(before.owner_id, is_admin=actor.is_admin)
            _delete(
                conn, before, actor=actor, comment=comment, now=_utcnow(), batch=uuid.uuid4().hex
            )
            return True

    def remove_concept_from_domain(
        self, concept_id: int, domain_id: int, *, actor: Actor, comment: str = ""
    ) -> bool:
        with self._connect() as conn:
            _lock(conn, domain_ids=[domain_id], concept_ids=[concept_id])
            before = rows.load_concept(conn, concept_id)
            if before is None or not is_visible(before.owner_id, user_id=actor.user_id):
                return False
            if domain_id not in before.domain_ids:
                return False
            require_writable(before.owner_id, is_admin=actor.is_admin)
            if before.domain_ids == [domain_id]:
                raise TerminologyRuleError("no_domain", "A concept belongs to at least one domain.")
            rows.set_links(conn, concept_id, [d for d in before.domain_ids if d != domain_id])
            _record(conn, concept_id, before, actor=actor, comment=comment, now=_utcnow())
            return True
