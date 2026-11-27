from dataclasses import dataclass

from app.core.models import Language
from app.services.terminology.model import (
    Concept,
    ConceptBasis,
    ConceptTerm,
    DroppedDefinition,
    SectionBasis,
    TerminologyRuleError,
    UsageStatus,
    is_enforced,
)


def basis_of(concept: Concept) -> ConceptBasis:
    return ConceptBasis(
        concept_id=concept.id,
        revision=concept.revision,
        sections=[SectionBasis(id=s.id, revision=s.revision) for s in concept.sections],
    )


def basis_matches(basis: ConceptBasis, concept: Concept) -> bool:
    return (
        basis.concept_id == concept.id
        and basis.revision == concept.revision
        and {(s.id, s.revision) for s in basis.sections}
        == {(s.id, s.revision) for s in concept.sections}
    )


@dataclass(frozen=True)
class PlannedMove:
    term: ConceptTerm
    language: Language
    usage_after: UsageStatus


@dataclass(frozen=True)
class TransferPlan:
    moves: list[PlannedMove]
    dropped: list[tuple[Language, ConceptTerm]]
    removed_languages: list[Language]
    adopted_definitions: dict[Language, str]
    dropped_definitions: list[DroppedDefinition]
    source_deleted: bool


def _active_preferred(term: ConceptTerm) -> bool:
    return term.usage_status == UsageStatus.PREFERRED and is_enforced(term.process_status)


def plan_transfer(
    source: Concept, term_ids: list[int], target: Concept | None, *, merge: bool
) -> TransferPlan:
    target_sections = {s.language: s for s in target.sections} if target else {}
    chosen = set(term_ids)
    moves: list[PlannedMove] = []
    dropped: list[tuple[Language, ConceptTerm]] = []
    removed: list[Language] = []
    adopted: dict[Language, str] = {}
    dropped_definitions: list[DroppedDefinition] = []

    for section in source.sections:
        existing = target_sections.get(section.language)
        existing_terms = existing.terms if existing else []
        texts = {t.text for t in existing_terms}
        has_preferred = any(_active_preferred(t) for t in existing_terms)
        leaving = [t for t in section.terms if merge or t.id in chosen]
        for term in leaving:
            if term.text in texts:
                if not merge:
                    raise TerminologyRuleError(
                        "duplicate_text", "The target already has a term with this wording."
                    )
                dropped.append((section.language, term))
                continue
            demote = has_preferred and _active_preferred(term)
            moves.append(
                PlannedMove(
                    term, section.language, UsageStatus.ADMITTED if demote else term.usage_status
                )
            )
        if len(leaving) < len(section.terms):
            continue
        removed.append(section.language)
        if section.definition.strip():
            if existing is None or not existing.definition.strip():
                adopted[section.language] = section.definition
            else:
                dropped_definitions.append(DroppedDefinition(
                    language=section.language, definition=section.definition
                ))

    return TransferPlan(
        moves=moves,
        dropped=dropped,
        removed_languages=removed,
        adopted_definitions=adopted,
        dropped_definitions=dropped_definitions,
        source_deleted=len(removed) == len(source.sections),
    )
