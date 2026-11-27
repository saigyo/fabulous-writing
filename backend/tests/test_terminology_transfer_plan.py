import itertools

import pytest

from app.core.models import Language
from app.services.terminology import (
    Concept,
    ConceptTerm,
    LanguageSection,
    ProcessStatus,
    TerminologyRuleError,
    UsageStatus,
)
from app.services.terminology.transfer import basis_matches, basis_of, plan_transfer

_ids = itertools.count(1)
P, A, D = UsageStatus.PREFERRED, UsageStatus.ADMITTED, UsageStatus.DEPRECATED


def term(text, usage=A, process=ProcessStatus.ACTIVE):
    n = next(_ids)
    return ConceptTerm(id=n, uid=f"t{n}", text=text, usage_status=usage, process_status=process)


def section(language, *terms, definition="", revision=1):
    return LanguageSection(
        id=next(_ids), language=language, definition=definition, revision=revision,
        terms=list(terms),
    )


def concept(*sections, revision=1):
    n = next(_ids)
    return Concept(
        id=n, uid=f"c{n}", domain_ids=[1], sections=list(sections), revision=revision
    )


EN, DE = Language.EN, Language.DE


def test_term_keeps_its_usage_status_when_the_target_has_no_active_preferred():
    moving = term("seat", P)
    source = concept(section(EN, moving, term("chair")))
    target = concept(section(EN, term("place", A)))
    plan = plan_transfer(source, [moving.id], target, merge=False)
    assert [(m.term.id, m.usage_after) for m in plan.moves] == [(moving.id, P)]


def test_active_preferred_becomes_admitted_next_to_an_active_preferred():
    moving = term("seat", P)
    existing = term("place", P)
    source = concept(section(EN, moving, term("chair")))
    target = concept(section(EN, existing))
    plan = plan_transfer(source, [moving.id], target, merge=False)
    assert [(m.term.id, m.usage_after) for m in plan.moves] == [(moving.id, A)]


def test_candidate_preferred_is_not_demoted():
    moving = term("seat", P, ProcessStatus.CANDIDATE)
    source = concept(section(EN, moving, term("chair")))
    target = concept(section(EN, term("place", P)))
    plan = plan_transfer(source, [moving.id], target, merge=False)
    assert plan.moves[0].usage_after == P


def test_preferred_stays_next_to_a_candidate_preferred():
    moving = term("seat", P)
    source = concept(section(EN, moving, term("chair")))
    target = concept(section(EN, term("place", P, ProcessStatus.CANDIDATE)))
    plan = plan_transfer(source, [moving.id], target, merge=False)
    assert plan.moves[0].usage_after == P


def test_move_onto_the_same_wording_is_refused():
    moving = term("seat", P)
    source = concept(section(EN, moving, term("chair")))
    target = concept(section(EN, term("seat", D)))
    with pytest.raises(TerminologyRuleError) as caught:
        plan_transfer(source, [moving.id], target, merge=False)
    assert caught.value.rule == "duplicate_text"


def test_wording_that_differs_only_in_case_is_not_a_duplicate():
    moving = term("Workspace")
    source = concept(section(EN, moving, term("chair")))
    target = concept(section(EN, term("workspace")))
    plan = plan_transfer(source, [moving.id], target, merge=False)
    assert [m.term.text for m in plan.moves] == ["Workspace"]
    assert plan.dropped == []


def test_last_term_of_a_language_removes_the_section():
    moving = term("Platz")
    source = concept(section(EN, term("seat")), section(DE, moving))
    plan = plan_transfer(source, [moving.id], concept(section(EN, term("x"))), merge=False)
    assert plan.removed_languages == [DE]
    assert not plan.source_deleted


def test_last_term_of_the_concept_deletes_it():
    moving = term("seat")
    source = concept(section(EN, moving))
    plan = plan_transfer(source, [moving.id], concept(section(EN, term("x"))), merge=False)
    assert plan.removed_languages == [EN]
    assert plan.source_deleted


@pytest.mark.parametrize("target_definition", [None, "  "])
def test_definition_of_a_removed_section_is_adopted_by_a_target_without_one(target_definition):
    moving = term("seat")
    source = concept(section(EN, moving, definition="Where one sits."))
    target = (
        concept(section(DE, term("Platz")))
        if target_definition is None
        else concept(section(EN, term("place"), definition=target_definition))
    )
    plan = plan_transfer(source, [moving.id], target, merge=False)
    assert plan.adopted_definitions == {EN: "Where one sits."}
    assert plan.dropped_definitions == []


def test_definition_of_a_new_concept_target_is_adopted():
    moving = term("seat")
    source = concept(section(EN, moving, term("chair"), definition="x"), section(DE, term("Platz")))
    plan = plan_transfer(source, [moving.id], None, merge=False)
    assert plan.adopted_definitions == {}
    only = concept(section(EN, moving, definition="Where one sits."))
    plan = plan_transfer(only, [moving.id], None, merge=False)
    assert plan.adopted_definitions == {EN: "Where one sits."}


def test_definition_of_a_removed_section_is_dropped_when_the_target_has_one():
    moving = term("seat")
    source = concept(section(EN, moving, definition="Where one sits."))
    target = concept(section(EN, term("place"), definition="A location."))
    plan = plan_transfer(source, [moving.id], target, merge=False)
    assert plan.adopted_definitions == {}
    assert [(d.language, d.definition) for d in plan.dropped_definitions] == [
        (EN, "Where one sits.")
    ]
    assert plan.source_deleted


def test_definition_stays_with_a_section_that_keeps_a_term():
    moving = term("seat")
    source = concept(section(EN, moving, term("chair"), definition="Where one sits."))
    plan = plan_transfer(source, [moving.id], concept(section(EN, term("x"))), merge=False)
    assert plan.adopted_definitions == {}
    assert plan.dropped_definitions == []
    assert plan.removed_languages == []


def test_merge_moves_every_term_and_deletes_the_source():
    source = concept(section(EN, term("seat"), term("chair")), section(DE, term("Platz")))
    target = concept(section(EN, term("place")))
    plan = plan_transfer(source, [], target, merge=True)
    assert [m.term.text for m in plan.moves] == ["seat", "chair", "Platz"]
    assert plan.source_deleted
    assert plan.removed_languages == [EN, DE]


def test_merge_drops_an_incoming_duplicate_and_keeps_the_target_term():
    incoming = term("seat")
    source = concept(section(EN, incoming, term("chair")))
    target = concept(section(EN, term("seat", D)))
    plan = plan_transfer(source, [], target, merge=True)
    assert [(lang, t.id) for lang, t in plan.dropped] == [(EN, incoming.id)]
    assert [m.term.text for m in plan.moves] == ["chair"]


def test_merge_drops_a_preferred_duplicate_without_promoting_the_target_term():
    incoming = term("seat", P)
    source = concept(section(EN, incoming))
    existing = term("seat", D)
    target = concept(section(EN, existing))
    plan = plan_transfer(source, [], target, merge=True)
    assert plan.moves == []
    assert plan.dropped[0][1].usage_status == P


def test_basis_matches_ignores_order_and_sees_every_difference():
    s1, s2 = section(EN, term("a"), revision=3), section(DE, term("b"), revision=4)
    c = concept(s1, s2, revision=2)
    basis = basis_of(c)
    assert basis_matches(basis, concept_with(c, sections=[s2, s1]))
    assert not basis_matches(basis, concept_with(c, revision=3))
    assert not basis_matches(basis, concept_with(c, sections=[s1, s2.model_copy(update={"revision": 5})]))
    assert not basis_matches(basis, concept_with(c, sections=[s1, s2.model_copy(update={"id": 0})]))
    assert not basis_matches(basis, concept_with(c, sections=[s1, s2, section(Language.FR, term("c"))]))
    assert not basis_matches(basis, concept_with(c, id=c.id + 1))


def concept_with(c, **changes):
    return c.model_copy(update=changes)
