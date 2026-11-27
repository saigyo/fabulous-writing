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
    DroppedTerm,
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
    # A basis that matches the stale concept, so only the membership check can refuse.
    basis = preview(store, find(stale, "sign on").id, target.id).basis
    with patch("app.services.terminology.rows.term_concept_id", return_value=stale.id):
        for is_preview in (True, False):
            with pytest.raises(TransferOutdatedError) as refused:
                store.move_term(
                    find(source, "logon").id, target.id,
                    basis=None if is_preview else basis, preview=is_preview, actor=ME,
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
    own = find(target, "sign-in")
    entries = logged(login.id, target.id)
    assert len(entries) == 3
    own_after = find(store.get_concept(target.id, owner_id=1), "sign-in")
    assert (own_after.id, own_after.usage_status, own_after.revision) == (
        own.id, own.usage_status, own.revision
    )
    assert own_after.usage_status == UsageStatus.PREFERRED
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


def merge_preview(store, source_id, target_id, *, actor=ME) -> TransferOutcome:
    outcome = store.merge_concept(source_id, target_id, basis=None, preview=True, actor=actor)
    assert outcome is not None
    return outcome


def merge(store, source_id, target_id, *, actor=ME, comment="") -> TransferOutcome:
    basis = merge_preview(store, source_id, target_id, actor=actor).basis
    outcome = store.merge_concept(
        source_id, target_id, basis=basis, actor=actor, comment=comment
    )
    assert outcome is not None
    return outcome


def _everything_at_once(store):
    support = store.create_domain("Support", owner_id=1)
    shared = store.create_domain("Shared", owner_id=1)
    marketing = store.create_domain("Marketing", owner_id=1)
    source = concept(
        store, [support.id, shared.id],
        section(
            Language.EN,
            term("work space"),
            term("team space", UsageStatus.ADMITTED, ProcessStatus.CANDIDATE),
            term("work area", UsageStatus.ADMITTED),
            definition="Where work happens.",
        ),
        section(
            Language.DE, term("Arbeitsraum"), definition="Bereich, in dem ein Team arbeitet."
        ),
        section(Language.FR, term("espace de travail")),
    )
    target = concept(
        store, [shared.id, marketing.id],
        section(
            Language.EN,
            term("workspace"),
            term("work area", UsageStatus.ADMITTED),
            term("team room", UsageStatus.FORBIDDEN),
        ),
        section(Language.DE, term("Arbeitsbereich"), definition="Eigene Definition."),
    )
    return support, marketing, source, target


def test_merge_outcome(store):
    support, marketing, source, target = _everything_at_once(store)
    work_space, team_space = find(source, "work space"), find(source, "team space")
    arbeitsraum, french = find(source, "Arbeitsraum"), find(source, "espace de travail")
    duplicate, kept = find(source, "work area"), find(target, "work area")

    outcome = merge(store, source.id, target.id)

    assert outcome.source is None
    assert store.get_concept(source.id, owner_id=1) is None
    assert outcome.target == store.get_concept(target.id, owner_id=1)
    assert outcome.moved == [
        MovedTerm(id=work_space.id, text="work space", language=Language.EN,
                  usage_before=UsageStatus.PREFERRED, usage_after=UsageStatus.ADMITTED),
        MovedTerm(id=team_space.id, text="team space", language=Language.EN,
                  usage_before=UsageStatus.ADMITTED, usage_after=UsageStatus.ADMITTED),
        MovedTerm(id=arbeitsraum.id, text="Arbeitsraum", language=Language.DE,
                  usage_before=UsageStatus.PREFERRED, usage_after=UsageStatus.ADMITTED),
        MovedTerm(id=french.id, text="espace de travail", language=Language.FR,
                  usage_before=UsageStatus.PREFERRED, usage_after=UsageStatus.PREFERRED),
    ]
    assert outcome.dropped_terms == [
        DroppedTerm(text="work area", language=Language.EN, usage_status=UsageStatus.ADMITTED)
    ]
    assert outcome.dropped_definitions == [
        DroppedDefinition(language=Language.DE, definition="Bereich, in dem ein Team arbeitet.")
    ]
    assert outcome.removed_languages == []
    assert outcome.dropped_domains == [DomainRef(id=support.id, name="Support")]
    assert outcome.added_domains == [DomainRef(id=marketing.id, name="Marketing")]
    assert outcome.basis == TransferBasis(source=basis_of(source), target=basis_of(target))

    assert part(outcome.target, Language.EN).definition == "Where work happens."
    assert part(outcome.target, Language.DE).definition == "Eigene Definition."
    assert part(outcome.target, Language.FR).revision == 1
    assert part(outcome.target, Language.EN).revision == part(target, Language.EN).revision + 1
    assert part(outcome.target, Language.DE).revision == part(target, Language.DE).revision + 1
    assert outcome.target.revision == target.revision + 1
    # The duplicate went with the source; the target's own term is untouched.
    after = find(outcome.target, "work area")
    assert (after.id, after.revision) == (kept.id, kept.revision)
    assert after.id != duplicate.id
    assert duplicate.id not in {t.id for s in outcome.target.sections for t in s.terms}


def test_merge_raises_the_target_concept_by_one_for_several_new_languages(store):
    d = store.create_domain("Cloud", owner_id=1)
    source = concept(
        store, [d.id],
        section(Language.DE, term("Arbeitsraum")), section(Language.FR, term("espace")),
        section(Language.IT, term("spazio")),
    )
    target = concept(store, [d.id], section(Language.EN, term("workspace")))

    outcome = merge(store, source.id, target.id)

    assert len(outcome.target.sections) == 4
    assert outcome.target.revision == target.revision + 1
    assert part(outcome.target, Language.EN).revision == part(target, Language.EN).revision


def test_change_log_of_a_merge(store, db):
    _, _, source, target = _everything_at_once(store)
    moved_ids = {find(source, t).id for t in ("work space", "team space", "Arbeitsraum")}
    moved_ids.add(find(source, "espace de travail").id)
    duplicate = find(source, "work area")
    start = len(changes(db))

    merge(store, source.id, target.id, comment="tidy up")

    entries = changes(db)[start:]
    assert len({e["batch"] for e in entries}) == 1
    assert all(e["comment"] == "tidy up" for e in entries)

    [merged] = [e for e in entries if e["action"] == "merged"]
    assert (merged["concept_id"], merged["concept_uid"], merged["term_id"]) == (
        source.id, source.uid, None
    )
    assert merged["concept_labels"] == {"en": "work space", "de": "Arbeitsraum", "fr": "espace de travail"}
    assert merged["changes"][0] == {"field": "merged_into", "old": None, "new": target.uid}

    [deleted] = [e for e in entries if e["action"] == "deleted"]
    assert deleted["term_id"] == duplicate.id
    assert deleted["concept_id"] == source.id

    moved = [e for e in entries if e["action"] == "moved"]
    assert {e["term_id"] for e in moved} == moved_ids
    assert all(e["concept_id"] == target.id for e in moved)
    # The labels are those of the target after the run, French included.
    assert {e["term_language"] for e in moved} >= {"fr"}
    assert all(
        e["concept_labels"]
        == {"en": "workspace", "de": "Arbeitsbereich", "fr": "espace de travail"}
        for e in moved
    )
    assert not [e for e in entries if e["term_id"] in moved_ids and e["action"] != "moved"]
    assert not [
        e for e in entries
        if e["concept_id"] == source.id and e["action"] == "edited"
    ]
    assert not [e for e in entries if e["action"] == "created"]
    assert len(entries) == 1 + 1 + len(moved) + len(
        [e for e in entries if e["concept_id"] == target.id and e["action"] == "edited"]
    )


def test_merge_preview_writes_nothing_and_matches_the_real_run(store, db):
    _, _, source, target = _everything_at_once(store)
    before = stored(store, db, source, target)

    seen = merge_preview(store, source.id, target.id)

    assert stored(store, db, source, target) == before
    real = store.merge_concept(source.id, target.id, basis=seen.basis, actor=ME)
    assert comparable(real) == comparable(seen)


def test_merge_is_refused_for_the_same_concept_and_a_stale_basis(store, db):
    _, source, target = _pair(store)
    for is_preview in (True, False):
        with pytest.raises(TerminologyRuleError) as refused:
            store.merge_concept(source.id, source.id, basis=None, preview=is_preview, actor=ME)
        assert refused.value.rule == "same_concept"
    basis = merge_preview(store, source.id, target.id).basis
    _edit_definition(store, source, "changed")
    before = stored(store, db, source, target)
    with pytest.raises(TransferOutdatedError) as refused:
        store.merge_concept(source.id, target.id, basis=basis, actor=ME)
    assert refused.value.concept_id == source.id
    assert stored(store, db, source, target) == before
    assert store.merge_concept(999999, target.id, basis=None, preview=True, actor=ME) is None


def _new_concept_setup(store):
    a = store.create_domain("Alpha", owner_id=1)
    b = store.create_domain("Beta", owner_id=1)
    source = concept(
        store, [a.id, b.id],
        section(
            Language.EN, term("login"), term("logon", UsageStatus.ADMITTED),
            definition="Sign in.",
        ),
        section(Language.DE, term("Anmeldung"), definition="Anmelden."),
    )
    return a, b, source


def test_move_to_a_new_concept(store, db):
    a, b, source = _new_concept_setup(store)
    login, logon = find(source, "login"), find(source, "logon")
    concepts_before = _count_concepts(db)

    outcome = move(store, login.id, None)

    assert _count_concepts(db) == concepts_before + 1
    new = outcome.target
    assert new.id not in (source.id,)
    assert new.owner_id == source.owner_id
    assert sorted(new.domain_ids) == sorted([a.id, b.id])
    assert new.revision == 1
    assert [s.language for s in new.sections] == [Language.EN]
    en = part(new, Language.EN)
    assert en.revision == 1
    assert en.definition == ""
    moved = find(new, "login")
    assert (moved.id, moved.uid) == (login.id, login.uid)
    assert moved.usage_status == UsageStatus.PREFERRED
    assert outcome.moved == [MovedTerm(
        id=login.id, text="login", language=Language.EN,
        usage_before=UsageStatus.PREFERRED, usage_after=UsageStatus.PREFERRED,
    )]
    assert outcome.dropped_domains == [] and outcome.added_domains == []
    assert outcome.basis.target is None
    assert outcome.basis.source == basis_of(source)
    assert outcome.source is not None
    assert part(outcome.source, Language.EN).definition == "Sign in."
    assert [t.text for t in part(outcome.source, Language.EN).terms] == ["logon"]
    assert outcome.target == store.get_concept(new.id, owner_id=1)
    assert logon.id in {t.id for t in part(outcome.source, Language.EN).terms}

    # Removing the source section gives the definition to the new section.
    outcome = move(store, find(outcome.source, "Anmeldung").id, None)
    de = part(outcome.target, Language.DE)
    assert de.definition == "Anmelden."
    assert de.revision == 1
    assert outcome.dropped_definitions == []
    assert sorted(outcome.target.domain_ids) == sorted([a.id, b.id])


def _count_concepts(db) -> int:
    with db.connect() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM concepts").fetchone()["n"]


def test_change_log_of_a_split(store, db):
    _, _, source = _new_concept_setup(store)
    login = find(source, "login")
    start = len(changes(db))

    outcome = move(store, login.id, None, comment="split")

    entries = changes(db)[start:]
    new = outcome.target
    created = [e for e in entries if e["action"] == "created"]
    assert len(created) == 1
    assert (created[0]["concept_id"], created[0]["term_id"]) == (new.id, None)
    assert created[0]["concept_labels"] == {"en": "login"}
    moved = [e for e in entries if e["action"] == "moved"]
    assert len(moved) == 1
    assert (moved[0]["concept_id"], moved[0]["term_id"]) == (new.id, login.id)
    assert moved[0]["changes"] == [{"field": "concept", "old": source.uid, "new": new.uid}]
    assert not [e for e in entries if e["term_id"] == login.id and e["action"] != "moved"]
    assert len({e["batch"] for e in entries}) == 1


def test_preview_of_a_new_concept_leaves_no_concept(store, db):
    _, _, source = _new_concept_setup(store)
    login = find(source, "login")
    before = stored(store, db, source)
    count = _count_concepts(db)

    seen = preview(store, login.id, None)

    assert _count_concepts(db) == count
    assert stored(store, db, source) == before
    assert seen.basis.target is None
    assert find(seen.target, "login").id == login.id
    real = store.move_term(login.id, None, basis=seen.basis, actor=ME)
    assert comparable(real) == comparable(seen)


def test_new_concept_needs_a_basis_without_target(store):
    _, source, target = _pair(store)
    logon = find(source, "logon")
    with_target = preview(store, logon.id, target.id).basis
    with pytest.raises(TransferOutdatedError):
        store.move_term(logon.id, None, basis=with_target, actor=ME)
    with pytest.raises(TransferOutdatedError):
        store.move_term(logon.id, None, basis=None, actor=ME)


def test_source_whose_domains_changed_after_the_read_is_outdated(store, db):
    a, _, source = _new_concept_setup(store)
    login = find(source, "login")
    before = stored(store, db, source)
    count = _count_concepts(db)
    basis = preview(store, login.id, None).basis
    with patch("app.services.terminology.rows.concept_domain_ids", return_value=[a.id]):
        for is_preview in (True, False):
            with pytest.raises(TransferOutdatedError) as refused:
                store.move_term(
                    login.id, None, basis=None if is_preview else basis,
                    preview=is_preview, actor=ME,
                )
            assert refused.value.concept_id == source.id
    assert stored(store, db, source) == before
    assert _count_concepts(db) == count


def _counts(db) -> dict[str, int]:
    tables = ("concepts", "concept_domains", "concept_languages", "concept_terms",
              "terminology_changes")
    with db.connect() as conn:
        return {
            t: conn.execute(f"SELECT COUNT(*) AS n FROM {t}").fetchone()["n"] for t in tables
        }


def test_preview_that_fails_midway_leaves_nothing_behind(store, db):
    _, _, source = _new_concept_setup(store)
    login = find(source, "login")
    basis = preview(store, login.id, None).basis
    before = _counts(db)
    for is_preview in (True, False):
        with patch(
            "app.services.terminology.changes.write", side_effect=RuntimeError("boom")
        ):
            with pytest.raises(RuntimeError, match="boom"):
                store.move_term(
                    login.id, None, basis=None if is_preview else basis,
                    preview=is_preview, actor=ME,
                )
        assert _counts(db) == before


def test_section_that_only_adopts_a_definition_is_raised_once(store):
    d = store.create_domain("Cloud", owner_id=1)
    source = concept(
        store, [d.id],
        section(Language.EN, term("login"), definition="Sign in."),
        section(Language.DE, term("Anmeldung")),
    )
    target = concept(
        store, [d.id],
        section(Language.EN, term("login")),
        section(Language.DE, term("Anmeldung")),
    )
    assert part(target, Language.EN).definition == ""

    outcome = merge(store, source.id, target.id)

    # The English incoming term is a duplicate and is dropped; only the definition arrives.
    assert [d.language for d in outcome.dropped_terms] == [Language.EN, Language.DE]
    assert outcome.moved == []
    after = part(outcome.target, Language.EN)
    assert after.definition == "Sign in."
    assert after.revision == part(target, Language.EN).revision + 1
    assert outcome.target.revision == target.revision
