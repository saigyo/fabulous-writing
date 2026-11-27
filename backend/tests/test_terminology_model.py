import pytest
from pydantic import ValidationError

from app.core.models import Language
from app.services.terminology import (
    PROCESS_STATUS_ENFORCED,
    Action,
    Concept,
    ConceptTerm,
    LanguageSection,
    Origin,
    PartOfSpeech,
    ProcessStatus,
    SectionInput,
    TermInput,
    TerminologyConflictError,
    TerminologyRuleError,
    UsageStatus,
    is_enforced,
    section_label,
)


def _term(id: int, text: str, usage: UsageStatus, process: ProcessStatus = ProcessStatus.ACTIVE) -> ConceptTerm:
    return ConceptTerm(id=id, uid=f"t{id}", text=text, usage_status=usage, process_status=process)


def _section(*terms: ConceptTerm) -> LanguageSection:
    return LanguageSection(id=1, language=Language.EN, terms=list(terms))


def test_every_process_status_declares_whether_it_is_enforced():
    assert set(PROCESS_STATUS_ENFORCED) == set(ProcessStatus)
    assert is_enforced(ProcessStatus.ACTIVE) is True
    assert is_enforced(ProcessStatus.CANDIDATE) is False


def test_pick_list_values():
    assert [m.value for m in UsageStatus] == ["preferred", "admitted", "deprecated", "forbidden"]
    assert [m.value for m in ProcessStatus] == ["candidate", "active"]
    assert [m.value for m in PartOfSpeech] == ["noun", "verb", "adjective", "adverb", "proper_noun", "other"]
    assert [m.value for m in Origin] == ["manual", "extraction", "import", "migration", "seed"]
    assert [m.value for m in Action] == [
        "created", "edited", "deleted", "added_to_domain", "removed_from_domain", "carried_over",
        "moved", "merged",
    ]


def test_term_text_must_contain_a_visible_character():
    with pytest.raises(ValidationError):
        TermInput(text="  ", usage_status="preferred")
    assert TermInput(text=" login ", usage_status="preferred").text == " login "


@pytest.mark.parametrize(
    "field, value",
    [("usage_status", "banned"), ("process_status", "trial"), ("part_of_speech", "article")],
)
def test_unknown_pick_list_value_is_rejected(field, value):
    data = {"text": "login", "usage_status": "preferred", field: value}
    with pytest.raises(ValidationError):
        TermInput(**data)


def test_concept_hides_owner_id_and_reports_is_global():
    dumped = Concept(id=1, uid="c", owner_id=None, domain_ids=[], sections=[]).model_dump()
    assert dumped["is_global"] is True
    assert "owner_id" not in dumped
    assert Concept(id=1, uid="c", owner_id=3, domain_ids=[], sections=[]).model_dump()["is_global"] is False


@pytest.mark.parametrize(
    "terms, expected",
    [
        (
            [_term(1, "zebra", UsageStatus.PREFERRED), _term(2, "apple", UsageStatus.ADMITTED)],
            "zebra",
        ),
        (
            [
                _term(1, "login", UsageStatus.PREFERRED, ProcessStatus.CANDIDATE),
                _term(2, "beta", UsageStatus.ADMITTED),
                _term(3, "Alpha", UsageStatus.ADMITTED),
            ],
            "Alpha",
        ),
        (
            [_term(1, "zeta", UsageStatus.FORBIDDEN), _term(2, "eta", UsageStatus.FORBIDDEN)],
            "eta",
        ),
        (
            [_term(1, "Banana", UsageStatus.ADMITTED), _term(2, "apple", UsageStatus.ADMITTED)],
            "apple",
        ),
    ],
)
def test_section_label_order(terms, expected):
    assert section_label(_section(*terms)) == expected


def test_input_from_model_round_trip():
    term = ConceptTerm(
        id=7, uid="u7", text="Login", usage_status=UsageStatus.ADMITTED,
        process_status=ProcessStatus.CANDIDATE, status_reason="r", context="c", source="s",
        part_of_speech=PartOfSpeech.NOUN, case_sensitive=True, revision=4,
    )
    section = LanguageSection(id=5, language=Language.DE, definition="d", revision=3, terms=[term])
    data = SectionInput.from_section(section)
    assert (data.language, data.id, data.revision, data.definition) == (Language.DE, 5, 3, "d")
    (out,) = data.terms
    assert out.model_dump() == {
        "id": 7, "text": "Login", "usage_status": "admitted", "process_status": "candidate",
        "status_reason": "r", "context": "c", "source": "s", "part_of_speech": "noun",
        "case_sensitive": True,
    }


def test_conflict_error_is_a_rule_error():
    with pytest.raises(TerminologyRuleError) as caught:
        raise TerminologyConflictError("en", "stale")
    assert caught.value.rule == "conflict"
    assert isinstance(caught.value, TerminologyConflictError)
    assert caught.value.part == "en"
