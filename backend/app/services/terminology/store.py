import uuid
from collections.abc import Callable, Sequence
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
    Actor,
    Concept,
    Domain,
    DomainRef,
    DroppedTerm,
    LanguageSection,
    MovedTerm,
    SectionInput,
    TerminologyConflictError,
    TerminologyRuleError,
    TransferBasis,
    TransferOutcome,
    TransferOutdatedError,
    UsageStatus,
    is_enforced,
)
from app.services.terminology.transfer import (
    TransferPlan,
    basis_matches,
    basis_of,
    plan_transfer,
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


_OUTDATED = "This concept was changed since the preview. Preview again."


class _Rollback(Exception):
    def __init__(self, outcome: TransferOutcome) -> None:
        super().__init__()
        self.outcome = outcome


def _check_transfer(
    source: Concept, target: Concept, basis: TransferBasis | None, *, preview: bool, actor: Actor
) -> None:
    require_writable(source.owner_id, is_admin=actor.is_admin)
    require_writable(target.owner_id, is_admin=actor.is_admin)
    if source.id == target.id:
        raise TerminologyRuleError("same_concept", "Source and target are the same concept.")
    if source.owner_id != target.owner_id:
        raise TerminologyRuleError(
            "owner_mismatch",
            "Terms can only move between concepts with the same owner: own or built-in.",
        )
    if preview:
        return
    if basis is None or not basis_matches(basis.source, source):
        raise TransferOutdatedError(source.id, _OUTDATED)
    if basis.target is None or not basis_matches(basis.target, target):
        raise TransferOutdatedError(target.id, _OUTDATED)


def _apply_transfer(
    conn: Any,
    source: Concept,
    target: Concept,
    plan: TransferPlan,
    *,
    now: str,
    user_id: int | None,
) -> None:
    # Order matters: terms cascade with their section, sections with their concept.
    section_ids = {s.language: s.id for s in target.sections}
    receiving = {m.language for m in plan.moves} | set(plan.adopted_definitions)
    created = [lang for lang in Language if lang in receiving and lang not in section_ids]
    for language in created:
        section_ids[language] = rows.insert_section(
            conn, target.id, language, plan.adopted_definitions.get(language, ""),
            now=now, user_id=user_id,
        )
    for move in plan.moves:
        rows.move_term(
            conn, move.term.id, section_ids[move.language], move.usage_after,
            now=now, user_id=user_id,
        )
    for existing in target.sections:
        if existing.language in receiving:
            rows.update_section(
                conn, existing.id,
                plan.adopted_definitions.get(existing.language, existing.definition),
                now=now, user_id=user_id,
            )
    for _, dropped in plan.dropped:
        conn.execute("DELETE FROM concept_terms WHERE id = ?", (dropped.id,))

    removed = set(plan.removed_languages)
    if plan.source_deleted:
        conn.execute("DELETE FROM concepts WHERE id = ?", (source.id,))
    else:
        for old in source.sections:
            if old.language in removed:
                rows.delete_section(conn, old.id)
        leaving = {m.term.id for m in plan.moves} | {t.id for _, t in plan.dropped}
        for old in source.sections:
            if old.language not in removed and any(t.id in leaving for t in old.terms):
                rows.update_section(conn, old.id, old.definition, now=now, user_id=user_id)
        if removed:
            rows.touch_concept(conn, source.id, now=now, user_id=user_id)
    if created:
        rows.touch_concept(conn, target.id, now=now, user_id=user_id)


def _outcome(
    source: Concept,
    source_after: Concept | None,
    target: Concept,
    target_after: Concept,
    plan: TransferPlan,
    names: dict[int, str],
) -> TransferOutcome:
    def refs(domain_ids: set[int]) -> list[DomainRef]:
        found = [DomainRef(id=d, name=names.get(d, "")) for d in domain_ids]
        return sorted(found, key=lambda r: (r.name, r.id))

    return TransferOutcome(
        target=target_after,
        source=source_after,
        moved=[
            MovedTerm(
                id=m.term.id, text=m.term.text, language=m.language,
                usage_before=m.term.usage_status, usage_after=m.usage_after,
            )
            for m in plan.moves
        ],
        dropped_terms=[
            DroppedTerm(text=t.text, language=language, usage_status=t.usage_status)
            for language, t in plan.dropped
        ],
        dropped_definitions=plan.dropped_definitions,
        removed_languages=plan.removed_languages if source_after is not None else [],
        dropped_domains=refs(set(source.domain_ids) - set(target.domain_ids)),
        added_domains=refs(set(target.domain_ids) - set(source.domain_ids)),
        basis=TransferBasis(source=basis_of(source), target=basis_of(target)),
    )


def _transfer(
    conn: Any,
    *,
    term_id: int,
    target_id: int,
    basis: TransferBasis | None,
    preview: bool,
    actor: Actor,
    comment: str,
) -> TransferOutcome | None:
    source_id = rows.term_concept_id(conn, term_id)
    if source_id is None:
        return None
    _lock(conn, concept_ids={source_id, target_id})
    source = rows.load_concept(conn, source_id)
    target = rows.load_concept(conn, target_id)
    if source is None or target is None:
        return None
    if not is_visible(source.owner_id, user_id=actor.user_id) or not is_visible(
        target.owner_id, user_id=actor.user_id
    ):
        return None
    if not any(t.id == term_id for s in source.sections for t in s.terms):
        raise TransferOutdatedError(source.id, _OUTDATED)
    _check_transfer(source, target, basis, preview=preview, actor=actor)
    plan = plan_transfer(source, [term_id], target, merge=False)

    now = _utcnow()
    _apply_transfer(conn, source, target, plan, now=now, user_id=actor.user_id)
    source_after = None if plan.source_deleted else rows.load_concept(conn, source.id)
    target_after = rows.load_concept(conn, target.id)
    assert target_after is not None
    names = rows.domain_names(conn, sorted(set(source.domain_ids) | set(target.domain_ids)))
    entries = changes.transfer_entries(
        source, source_after, target, target_after, domain_names=names
    )
    changes.write(conn, entries, batch=uuid.uuid4().hex, at=now, actor=actor, comment=comment)
    return _outcome(source, source_after, target, target_after, plan, names)


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
                migration.drop_legacy_terms(conn)
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

    def list_sections(
        self, domain_id: int, *, owner_id: int, language: Language
    ) -> list[LanguageSection] | None:
        with self._connect() as conn:
            if self._visible_domain_row(conn, domain_id, owner_id) is None:
                return None
            return rows.load_domain_sections(
                conn, domain_id, user_id=owner_id, language=language
            )

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

    # -- moving terms ----------------------------------------------------

    def _transferring(
        self, run: Callable[[Any], TransferOutcome | None], *, preview: bool
    ) -> TransferOutcome | None:
        try:
            with self._connect() as conn:
                outcome = run(conn)
                if preview and outcome is not None:
                    raise _Rollback(outcome)
                return outcome
        except _Rollback as rolled_back:
            return rolled_back.outcome

    def move_term(
        self,
        term_id: int,
        target_id: int | None,
        *,
        basis: TransferBasis | None,
        preview: bool = False,
        actor: Actor,
        comment: str = "",
    ) -> TransferOutcome | None:
        if target_id is None:
            raise NotImplementedError("moving a term to a new concept")
        return self._transferring(
            lambda conn: _transfer(
                conn, term_id=term_id, target_id=target_id, basis=basis,
                preview=preview, actor=actor, comment=comment,
            ),
            preview=preview,
        )
