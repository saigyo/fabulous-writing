from unittest.mock import patch

import pytest

from app.core.models import Language
from app.services.ownership import GlobalReadOnlyError
from app.services.terminology import (
    Actor,
    Concept,
    PartOfSpeech,
    ProcessStatus,
    SectionInput,
    TerminologyRuleError,
    TerminologyStore,
    TermInput,
    UsageStatus,
)
from app.services.terminology.model import (
    DomainRef,
    DroppedDefinition,
    MovedTerm,
    TransferBasis,
    TransferOutcome,
    TransferOutdatedError,
)
from app.services.terminology.transfer import basis_of
from tests.terminology_helpers import changes

ME = Actor(user_id=1, is_admin=False)
ADMIN = Actor(user_id=1, is_admin=True)
THEM = Actor(user_id=2, is_admin=False)

_GENERATED_TIMES = {"created_at", "modified_at"}


@pytest.fixture
def store(db) -> TerminologyStore:
    return TerminologyStore(db)


def term(text, usage=UsageStatus.PREFERRED, process=ProcessStatus.ACTIVE, **kw):
    return TermInput(text=text, usage_status=usage, process_status=process, **kw)


def section(language, *terms, definition=""):
    return SectionInput(language=language, definition=definition, terms=list(terms))


def concept(store, domain_ids, *sections, actor=ME) -> Concept:
    created = store.create_concept(domain_ids[0], list(sections), actor=actor)
    assert created is not None
    if len(domain_ids) > 1:
        created = store.save_concept(
            created.id, domain_ids=domain_ids, revision=created.revision, actor=actor
        )
    return created


def find(c: Concept, text: str):
    return next(t for s in c.sections for t in s.terms if t.text == text)


def part(c: Concept, language: Language):
    return next((s for s in c.sections if s.language == language), None)


def preview(store, term_id, target_id, *, actor=ME) -> TransferOutcome:
    outcome = store.move_term(term_id, target_id, basis=None, preview=True, actor=actor)
    assert outcome is not None
    return outcome


def move(store, term_id, target_id, *, actor=ME, comment="") -> TransferOutcome:
    basis = preview(store, term_id, target_id, actor=actor).basis
    outcome = store.move_term(term_id, target_id, basis=basis, actor=actor, comment=comment)
    assert outcome is not None
    return outcome


def stored(store, db, *concepts):
    return [store.get_concept(c.id, owner_id=1) for c in concepts], len(changes(db))


def comparable(outcome: TransferOutcome) -> dict:
    """The outcome without what a run generates for itself (Reading 12)."""
    def strip_times(value):
        if isinstance(value, dict):
            return {k: strip_times(v) for k, v in value.items() if k not in _GENERATED_TIMES}
        if isinstance(value, list):
            return [strip_times(v) for v in value]
        return value

    bases = [b for b in (outcome.basis.source, outcome.basis.target) if b is not None]
    known_sections = {s.id for b in bases for s in b.sections}
    data = strip_times(outcome.model_dump())
    for c in (data["target"], data["source"]):
        for s in c["sections"] if c else []:
            if s["id"] not in known_sections:
                del s["id"]
    if outcome.basis.target is None:
        del data["target"]["id"], data["target"]["uid"]
    return data


def test_moved_term_keeps_id_uid_and_fields(store):
    d = store.create_domain("Cloud", owner_id=1)
    source = concept(store, [d.id], section(
        Language.EN,
        term("login"),
        term(
            "log in", UsageStatus.ADMITTED, ProcessStatus.CANDIDATE, status_reason="why",
            context="ctx", source="style guide", part_of_speech=PartOfSpeech.VERB,
            case_sensitive=True,
        ),
    ))
    target = concept(store, [d.id], section(Language.EN, term("sign-in")))
    before = find(source, "log in")

    outcome = move(store, before.id, target.id)

    after = find(outcome.target, "log in")
    unchanged = {"revision", "modified_at", "modified_by"}
    assert after.model_dump(exclude=unchanged) == before.model_dump(exclude=unchanged)
    assert after.revision == before.revision + 1
    assert after.modified_by == 1
    assert [t.text for t in part(outcome.source, Language.EN).terms] == ["login"]


def test_version_numbers_after_a_move(store):
    d = store.create_domain("Cloud", owner_id=1)
    source = concept(
        store, [d.id], section(Language.EN, term("login"), term("logon", UsageStatus.ADMITTED))
    )
    target = concept(store, [d.id], section(Language.EN, term("sign-in")))
    moving = find(source, "logon")

    outcome = move(store, moving.id, target.id)

    assert part(outcome.target, Language.EN).revision == part(target, Language.EN).revision + 1
    assert part(outcome.source, Language.EN).revision == part(source, Language.EN).revision + 1
    assert find(outcome.target, "logon").revision == moving.revision + 1
    assert outcome.target.revision == target.revision
    assert outcome.source.revision == source.revision

    split = concept(
        store, [d.id],
        section(Language.EN, term("signup")), section(Language.DE, term("Registrierung")),
    )
    receiver = concept(store, [d.id], section(Language.DE, term("Anmeldung")))

    outcome = move(store, find(split, "signup").id, receiver.id)

    assert part(outcome.target, Language.EN).revision == 1
    assert part(outcome.target, Language.DE).revision == part(receiver, Language.DE).revision
    assert part(outcome.source, Language.EN) is None
    assert part(outcome.source, Language.DE).revision == part(split, Language.DE).revision
    assert outcome.target.revision == receiver.revision + 1
    assert outcome.source.revision == split.revision + 1


def test_outcome_reports_moves_definitions_languages_and_domains(store):
    zeta = store.create_domain("Zeta", owner_id=1)
    shared = store.create_domain("Shared", owner_id=1)
    alpha = store.create_domain("Alpha", owner_id=1)
    source = concept(
        store, [zeta.id, shared.id],
        section(Language.EN, term("login"), definition="Source text"),
        section(Language.DE, term("Anmeldung"), definition="Quelle"),
    )
    target = concept(
        store, [shared.id, alpha.id],
        section(Language.EN, term("sign-in"), definition="Target text"),
        section(Language.DE, term("Login-Vorgang"), definition="Ziel"),
    )
    login = find(source, "login")

    outcome = move(store, login.id, target.id)

    assert outcome.moved == [MovedTerm(
        id=login.id, text="login", language=Language.EN,
        usage_before=UsageStatus.PREFERRED, usage_after=UsageStatus.ADMITTED,
    )]
    assert outcome.dropped_terms == []
    assert outcome.dropped_definitions == [
        DroppedDefinition(language=Language.EN, definition="Source text")
    ]
    assert outcome.removed_languages == [Language.EN]
    assert outcome.dropped_domains == [DomainRef(id=zeta.id, name="Zeta")]
    assert outcome.added_domains == [DomainRef(id=alpha.id, name="Alpha")]
    assert outcome.basis == TransferBasis(source=basis_of(source), target=basis_of(target))
    assert outcome.source == store.get_concept(source.id, owner_id=1)
    assert outcome.target == store.get_concept(target.id, owner_id=1)
    assert part(outcome.target, Language.EN).definition == "Target text"

    outcome = move(store, find(source, "Anmeldung").id, target.id)

    assert outcome.source is None
    assert outcome.removed_languages == []
    assert outcome.dropped_definitions == [
        DroppedDefinition(language=Language.DE, definition="Quelle")
    ]
    assert outcome.dropped_domains == [DomainRef(id=zeta.id, name="Zeta")]
    assert outcome.added_domains == [DomainRef(id=alpha.id, name="Alpha")]


def _pair(store):
    d = store.create_domain("Cloud", owner_id=1)
    source = concept(
        store, [d.id], section(Language.EN, term("login"), term("logon", UsageStatus.ADMITTED))
    )
    target = concept(store, [d.id], section(Language.EN, term("sign-in")))
    return d, source, target


def _edit_definition(store, c: Concept, text: str) -> None:
    current = store.get_concept(c.id, owner_id=1)
    edited = SectionInput.from_section(current.sections[0]).model_copy(update={"definition": text})
    assert store.save_concept(c.id, sections=[edited], actor=ME) is not None


def test_real_run_needs_the_basis_of_the_preview(store, db):
    _, source, target = _pair(store)
    logon = find(source, "logon")
    basis = preview(store, logon.id, target.id).basis
    _edit_definition(store, target, "changed")
    before = stored(store, db, source, target)

    with pytest.raises(TransferOutdatedError) as refused:
        store.move_term(logon.id, target.id, basis=basis, actor=ME)

    assert refused.value.rule == "outdated"
    assert refused.value.concept_id == target.id
    assert stored(store, db, source, target) == before


def test_outdated_names_the_source_first(store):
    _, source, target = _pair(store)
    logon = find(source, "logon")
    basis = preview(store, logon.id, target.id).basis
    _edit_definition(store, target, "changed")
    _edit_definition(store, source, "changed too")

    with pytest.raises(TransferOutdatedError) as refused:
        store.move_term(logon.id, target.id, basis=basis, actor=ME)

    assert refused.value.concept_id == source.id


def test_basis_for_another_target_is_outdated(store):
    d, source, target = _pair(store)
    other = concept(store, [d.id], section(Language.EN, term("sign on")))
    logon = find(source, "logon")
    basis = preview(store, logon.id, target.id).basis

    for wrong in (basis, basis.model_copy(update={"target": None})):
        with pytest.raises(TransferOutdatedError) as refused:
            store.move_term(logon.id, other.id, basis=wrong, actor=ME)
        assert refused.value.concept_id == other.id


def test_term_that_left_the_source_after_the_read_is_outdated(store, db):
    d, source, target = _pair(store)
    stale = concept(store, [d.id], section(Language.EN, term("sign on")))
    before = stored(store, db, source, target, stale)
    with patch("app.services.terminology.rows.term_concept_id", return_value=stale.id):
        for is_preview in (True, False):
            with pytest.raises(TransferOutdatedError) as refused:
                store.move_term(
                    find(source, "logon").id, target.id, basis=None, preview=is_preview, actor=ME
                )
            assert refused.value.concept_id == stale.id
    assert stored(store, db, source, target, stale) == before


def test_preview_writes_nothing_and_matches_the_real_run(store, db):
    d = store.create_domain("Cloud", owner_id=1)
    source = concept(
        store, [d.id],
        section(Language.EN, term("login"), definition="Sign in."),
        section(Language.DE, term("Anmeldung")),
    )
    target = concept(store, [d.id], section(Language.DE, term("Login-Vorgang")))
    login = find(source, "login")
    before = stored(store, db, source, target)

    seen = preview(store, login.id, target.id)

    assert stored(store, db, source, target) == before
    assert part(seen.target, Language.EN).definition == "Sign in."
    real = store.move_term(login.id, target.id, basis=seen.basis, actor=ME)
    assert comparable(real) == comparable(seen)
    assert real.target.revision == target.revision + 1


def test_same_concept_and_other_owner_are_refused(store):
    _, source, _ = _pair(store)
    logon = find(source, "logon")
    for is_preview in (True, False):
        with pytest.raises(TerminologyRuleError) as refused:
            store.move_term(logon.id, source.id, basis=None, preview=is_preview, actor=ME)
        assert refused.value.rule == "same_concept"

    g = store.create_domain("Global", owner_id=None)
    global_target = concept(store, [g.id], section(Language.EN, term("sign-in")), actor=ADMIN)
    with pytest.raises(TerminologyRuleError) as refused:
        store.move_term(logon.id, global_target.id, basis=None, preview=True, actor=ADMIN)
    assert refused.value.rule == "owner_mismatch"


def test_invisible_or_missing_is_not_found(store):
    _, source, target = _pair(store)
    theirs = store.create_domain("Theirs", owner_id=2)
    foreign = concept(store, [theirs.id], section(Language.EN, term("hidden")), actor=THEM)
    logon = find(source, "logon").id
    for term_id, target_id in (
        (find(foreign, "hidden").id, target.id),
        (logon, foreign.id),
        (999999, target.id),
        (logon, 999999),
    ):
        for is_preview in (True, False):
            assert store.move_term(
                term_id, target_id, basis=None, preview=is_preview, actor=ME
            ) is None


def test_non_admin_cannot_move_between_global_concepts(store, db):
    g = store.create_domain("Global", owner_id=None)
    source = concept(
        store, [g.id], section(Language.EN, term("login"), term("logon", UsageStatus.ADMITTED)),
        actor=ADMIN,
    )
    target = concept(store, [g.id], section(Language.EN, term("sign-in")), actor=ADMIN)
    basis = preview(store, find(source, "logon").id, target.id, actor=ADMIN).basis
    before = stored(store, db, source, target)
    for is_preview, given in ((True, None), (False, basis)):
        with pytest.raises(GlobalReadOnlyError):
            store.move_term(
                find(source, "logon").id, target.id, basis=given, preview=is_preview, actor=ME
            )
    assert stored(store, db, source, target) == before


def test_moved_term_survives_the_removal_of_its_old_section_and_concept(store, db):
    d = store.create_domain("Cloud", owner_id=1)
    source = concept(store, [d.id], section(Language.EN, term("login")))
    target = concept(store, [d.id], section(Language.DE, term("Anmeldung")))
    login = find(source, "login")

    outcome = move(store, login.id, target.id)

    assert outcome.source is None
    assert store.get_concept(source.id, owner_id=1) is None
    with db.connect() as conn:
        row = conn.execute(
            "SELECT t.uid, s.concept_id FROM concept_terms t"
            " JOIN concept_languages s ON s.id = t.section_id WHERE t.id = ?",
            (login.id,),
        ).fetchone()
    assert row is not None
    assert (row["uid"], row["concept_id"]) == (login.uid, target.id)


def _concept_entry(entries, concept_id):
    found = [e for e in entries if e["concept_id"] == concept_id and e["term_id"] is None]
    assert len(found) == 1
    return found[0]


def test_change_log_of_a_move(store, db):
    d = store.create_domain("Cloud", owner_id=1)

    def logged(term_id, target_id):
        start = len(changes(db))
        move(store, term_id, target_id, comment="tidy up")
        entries = changes(db)[start:]
        assert len({e["batch"] for e in entries}) == 1
        assert all(e["comment"] == "tidy up" for e in entries)
        assert not [e for e in entries if e["term_id"] == term_id and e["action"] != "moved"]
        return entries

    # Demoted, and the definition is adopted; the source survives.
    source = concept(
        store, [d.id],
        section(Language.EN, term("login"), definition="Sign in."),
        section(Language.DE, term("Anmeldung")),
    )
    target = concept(store, [d.id], section(Language.EN, term("sign-in")))
    login = find(source, "login")
    entries = logged(login.id, target.id)
    assert len(entries) == 3
    [moved] = [e for e in entries if e["action"] == "moved"]
    assert moved["concept_id"] == target.id
    assert moved["concept_uid"] == target.uid
    assert (moved["term_id"], moved["term_uid"], moved["term_text"], moved["term_language"]) == (
        login.id, login.uid, "login", "en"
    )
    assert moved["concept_labels"] == {"en": "sign-in"}
    assert moved["changes"] == [
        {"field": "concept", "old": source.uid, "new": target.uid},
        {"field": "usage_status", "old": "preferred", "new": "admitted"},
    ]
    adopted = _concept_entry(entries, target.id)
    assert adopted["action"] == "edited"
    assert adopted["changes"] == [
        {"field": "definition", "language": "en", "old": "", "new": "Sign in."}
    ]
    lost = _concept_entry(entries, source.id)
    assert lost["action"] == "edited"
    assert lost["changes"] == [
        {"field": "definition", "language": "en", "old": "Sign in.", "new": ""}
    ]

    # Not demoted, and the definition is dropped.
    source = concept(
        store, [d.id],
        section(Language.EN, term("logon", UsageStatus.ADMITTED), definition="Mine"),
        section(Language.DE, term("Abmeldung")),
    )
    target = concept(store, [d.id], section(Language.EN, term("log-on"), definition="Theirs"))
    entries = logged(find(source, "logon").id, target.id)
    assert len(entries) == 2
    [moved] = [e for e in entries if e["action"] == "moved"]
    assert moved["changes"] == [{"field": "concept", "old": source.uid, "new": target.uid}]
    assert _concept_entry(entries, source.id)["changes"] == [
        {"field": "definition", "language": "en", "old": "Mine", "new": ""}
    ]

    # The source is emptied and deleted.
    source = concept(store, [d.id], section(Language.EN, term("signup")))
    target = concept(store, [d.id], section(Language.DE, term("Registrierung")))
    entries = logged(find(source, "signup").id, target.id)
    assert len(entries) == 2
    assert [e["action"] for e in entries if e["term_id"] is not None] == ["moved"]
    deleted = _concept_entry(entries, source.id)
    assert deleted["action"] == "deleted"
    assert deleted["concept_labels"] == {"en": "signup"}
