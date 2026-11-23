import uuid
from unittest.mock import patch

import pytest

from app.core.models import Language
from app.services.db import UniqueViolationError, table_columns
from app.services.ownership import GlobalReadOnlyError
from app.services.terminology import (
    Actor,
    Origin,
    ProcessStatus,
    SectionInput,
    TermInput,
    TerminologyConflictError,
    TerminologyRuleError,
    TerminologyStore,
    UsageStatus,
)
from app.services.terminology.store import _validate
from tests.conftest import DocumentClock
from tests.terminology_helpers import add_term, changes

ME = Actor(user_id=1, is_admin=False)
ADMIN = Actor(user_id=1, is_admin=True)


@pytest.fixture
def store(db) -> TerminologyStore:
    return TerminologyStore(db)


def term(text, usage=UsageStatus.PREFERRED, process=ProcessStatus.ACTIVE, **kw):
    return TermInput(text=text, usage_status=usage, process_status=process, **kw)


def section(language, *terms, definition=""):
    return SectionInput(language=language, definition=definition, terms=list(terms))


def concept_count(db):
    with db.connect() as conn:
        return conn.execute("SELECT count(*) AS n FROM concepts").fetchone()["n"]

_AUDIT = {"created_at", "created_by", "modified_at", "modified_by"}


def test_schema_creates_the_concept_tables(db):
    TerminologyStore(db)
    with db.connect() as conn:
        assert table_columns(conn, "concepts") == {"id", "uid", "owner_id", "revision"} | _AUDIT
        assert table_columns(conn, "concept_domains") == {"concept_id", "domain_id"}
        assert table_columns(conn, "concept_languages") == {
            "id", "concept_id", "language", "definition", "revision",
        } | _AUDIT
        assert table_columns(conn, "concept_terms") == {
            "id", "uid", "section_id", "text", "usage_status", "process_status", "status_reason",
            "context", "source", "part_of_speech", "case_sensitive", "revision",
        } | _AUDIT
        assert table_columns(conn, "terminology_changes") == {
            "id", "batch", "at", "user_id", "origin", "action", "concept_id", "concept_uid",
            "term_id", "term_uid", "term_text", "term_language", "concept_labels", "changes", "comment",
        }


def test_constructing_the_store_twice_is_idempotent(db):
    TerminologyStore(db)
    TerminologyStore(db)


def _insert_concept_tree(conn):
    domain_id = conn.execute(
        "INSERT INTO domains (name, owner_id) VALUES ('d', NULL) RETURNING id"
    ).fetchone()["id"]
    concept_id = conn.execute(
        "INSERT INTO concepts (uid) VALUES ('c1') RETURNING id"
    ).fetchone()["id"]
    conn.execute("INSERT INTO concept_domains (concept_id, domain_id) VALUES (?, ?)", (concept_id, domain_id))
    section_id = conn.execute(
        "INSERT INTO concept_languages (concept_id, language) VALUES (?, 'en') RETURNING id", (concept_id,)
    ).fetchone()["id"]
    conn.execute(
        "INSERT INTO concept_terms (uid, section_id, text, usage_status, process_status)"
        " VALUES ('t1', ?, 'login', 'preferred', 'active')",
        (section_id,),
    )
    return concept_id


def test_section_language_is_unique_per_concept(db):
    TerminologyStore(db)
    with pytest.raises(UniqueViolationError):
        with db.connect() as conn:
            concept_id = _insert_concept_tree(conn)
            conn.execute(
                "INSERT INTO concept_languages (concept_id, language) VALUES (?, 'en')", (concept_id,)
            )


def test_deleting_a_concept_row_cascades(db):
    TerminologyStore(db)
    with db.connect() as conn:
        concept_id = _insert_concept_tree(conn)
    with db.connect() as conn:
        conn.execute("DELETE FROM concepts WHERE id = ?", (concept_id,))
    with db.connect() as conn:
        for table in ("concept_domains", "concept_languages", "concept_terms"):
            assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0


def test_create_concept_returns_the_stored_shape(store):
    d = store.create_domain("Cloud", owner_id=1)
    concept = store.create_concept(
        d.id,
        [
            section(Language.DE, term("Anmeldung"), definition="de def"),
            section(
                Language.EN,
                term("login"),
                term("log-in", UsageStatus.FORBIDDEN),
                definition="en def",
            ),
        ],
        actor=ME,
    )
    assert concept is not None
    assert [s.language for s in concept.sections] == [Language.EN, Language.DE]
    assert [t.text for t in concept.sections[0].terms] == ["login", "log-in"]
    assert concept.domain_ids == [d.id]
    assert concept.owner_id == 1
    rows = [concept, *concept.sections, *[t for s in concept.sections for t in s.terms]]
    assert all(r.created_by == 1 and r.modified_by == 1 and r.revision == 1 for r in rows)
    assert all(r.created_at and r.created_at == r.modified_at for r in rows)
    uids = [concept.uid] + [t.uid for s in concept.sections for t in s.terms]
    assert len(set(uids)) == len(uids)
    for uid in uids:
        uuid.UUID(uid)
    assert store.get_concept(concept.id, owner_id=1) == concept


def test_concept_takes_the_owner_of_its_domain(store):
    g = store.create_domain("Global", owner_id=None)
    own = store.create_domain("Own", owner_id=1)
    in_global = add_term(store, g.id, language=Language.EN, preferred="a")
    in_own = add_term(store, own.id, language=Language.EN, preferred="b")
    assert in_global.is_global is True
    assert in_own.is_global is False


def test_create_in_an_invisible_domain_returns_none(store, db):
    d = store.create_domain("Theirs", owner_id=2)
    assert store.create_concept(d.id, [section(Language.EN, term("a"))], actor=ME) is None
    assert concept_count(db) == 0
    assert changes(db) == []


def test_create_in_a_global_domain_needs_admin(store, db):
    d = store.create_domain("Global", owner_id=None)
    with pytest.raises(GlobalReadOnlyError):
        store.create_concept(d.id, [section(Language.EN, term("a"))], actor=ME)
    assert concept_count(db) == 0


def test_get_and_list_respect_visibility(store, db):
    mine = store.create_domain("Mine", owner_id=1)
    g = store.create_domain("Global", owner_id=None)
    private = add_term(store, mine.id, language=Language.EN, preferred="a")
    shared = add_term(store, g.id, language=Language.EN, preferred="b")
    assert store.get_concept(private.id, owner_id=2) is None
    assert store.list_concepts(mine.id, owner_id=2) is None
    assert store.get_concept(private.id, owner_id=1) == private
    assert store.get_concept(shared.id, owner_id=2) == shared
    assert store.list_concepts(g.id, owner_id=2) == [shared]
    assert store.list_sections(mine.id, owner_id=2, language=Language.EN) is None
    assert store.list_sections(999999, owner_id=1, language=Language.EN) is None
    assert store.list_sections(g.id, owner_id=2, language=Language.EN) == shared.sections
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO concept_domains (concept_id, domain_id) VALUES (?, ?)", (private.id, g.id)
        )
    assert store.list_sections(g.id, owner_id=2, language=Language.EN) == shared.sections
    assert len(store.list_sections(g.id, owner_id=1, language=Language.EN)) == 2


def test_list_concepts_is_ordered_by_id(store):
    d = store.create_domain("Cloud", owner_id=1)
    first = add_term(store, d.id, language=Language.EN, preferred="b")
    second = add_term(store, d.id, language=Language.EN, preferred="a")
    assert [c.id for c in store.list_concepts(d.id, owner_id=1)] == [first.id, second.id]


def test_list_sections_returns_one_language(store):
    d = store.create_domain("Cloud", owner_id=1)
    first = store.create_concept(
        d.id,
        [
            section(
                Language.EN,
                term("login", case_sensitive=True),
                term("signin", UsageStatus.ADMITTED, ProcessStatus.CANDIDATE, status_reason="why"),
            ),
        ],
        actor=ME,
    )
    second = add_term(store, d.id, language=Language.EN, preferred="logout")
    third = add_term(store, d.id, language=Language.DE, preferred="Abmeldung")
    store.save_section(first.id, section(Language.DE, term("Anmeldung")), actor=ME)
    first = store.get_concept(first.id, owner_id=1)
    en = store.list_sections(d.id, owner_id=1, language=Language.EN)
    assert en == [first.sections[0], second.sections[0]]
    assert store.list_sections(d.id, owner_id=1, language=Language.DE) == [
        first.sections[1],
        third.sections[0],
    ]
    login, signin = en[0].terms
    assert (login.usage_status, login.process_status, login.case_sensitive) == (
        UsageStatus.PREFERRED,
        ProcessStatus.ACTIVE,
        True,
    )
    assert (signin.usage_status, signin.process_status, signin.status_reason) == (
        UsageStatus.ADMITTED,
        ProcessStatus.CANDIDATE,
        "why",
    )
    assert login.uid and signin.uid and login.uid != signin.uid


@pytest.mark.parametrize(
    ("sections", "rule"),
    [
        ([], "no_section"),
        ([section(Language.EN)], "no_section"),
        ([section(Language.EN, term("a")), section(Language.EN, term("b"))], "duplicate_language"),
        ([section(Language.EN, term("login"), term("login", UsageStatus.FORBIDDEN))], "duplicate_text"),
        ([section(Language.EN, term("a"), term("b"))], "second_preferred"),
    ],
)
def test_rules_on_create(store, db, sections, rule):
    d = store.create_domain("Cloud", owner_id=1)
    with pytest.raises(TerminologyRuleError) as exc:
        store.create_concept(d.id, sections, actor=ME)
    assert exc.value.rule == rule
    assert concept_count(db) == 0


def test_a_term_id_on_create_is_unknown(store):
    d = store.create_domain("Cloud", owner_id=1)
    with pytest.raises(TerminologyRuleError) as exc:
        store.create_concept(d.id, [section(Language.EN, term("a", id=5))], actor=ME)
    assert exc.value.rule == "unknown_term"


def test_validate_rejects_the_same_term_id_twice(store):
    d = store.create_domain("Cloud", owner_id=1)
    current = add_term(store, d.id, language=Language.EN, preferred="a")
    known = current.sections[0].terms[0].id
    given = [section(Language.EN, term("a", id=known), term("b", UsageStatus.FORBIDDEN, id=known))]
    with pytest.raises(TerminologyRuleError) as exc:
        _validate(given, current)
    assert exc.value.rule == "duplicate_term"


def test_a_candidate_preferred_term_does_not_count(store):
    d = store.create_domain("Cloud", owner_id=1)
    concept = store.create_concept(
        d.id,
        [section(Language.EN, term("a"), term("b", process=ProcessStatus.CANDIDATE))],
        actor=ME,
    )
    assert concept is not None


def test_text_differing_only_in_case_is_a_different_term(store):
    d = store.create_domain("Cloud", owner_id=1)
    concept = store.create_concept(
        d.id,
        [section(Language.EN, term("Login"), term("login", UsageStatus.FORBIDDEN))],
        actor=ME,
    )
    assert concept is not None


def test_create_writes_one_batch(store, db):
    d = store.create_domain("Cloud", owner_id=1)
    concept = store.create_concept(
        d.id,
        [section(Language.EN, term("login"), term("log-in", UsageStatus.FORBIDDEN), definition="x")],
        actor=ME,
        comment="why",
    )
    entries = changes(db)
    assert [e["term_text"] for e in entries] == [None, "login", "log-in"]
    assert len({e["batch"] for e in entries}) == 1
    assert {e["origin"] for e in entries} == {"manual"}
    assert {e["user_id"] for e in entries} == {1}
    assert {e["action"] for e in entries} == {"created"}
    assert {e["comment"] for e in entries} == {"why"}
    assert {e["concept_id"] for e in entries} == {concept.id}


def test_system_actor_logs_no_user(store, db):
    d = store.create_domain("Global", owner_id=None)
    concept = add_term(
        store, d.id, language=Language.EN, preferred="a", actor=Actor.system(Origin.SEED)
    )
    assert concept.created_by is None
    entries = changes(db)
    assert {e["user_id"] for e in entries} == {None}
    assert {e["origin"] for e in entries} == {"seed"}


def test_delete_concept_removes_everything_and_logs_the_last_state(store, db):
    d = store.create_domain("Cloud", owner_id=1)
    concept = add_term(store, d.id, language=Language.EN, preferred="login", definition="d")
    before = len(changes(db))
    assert store.delete_concept(concept.id, actor=ME, comment="gone") is True
    with db.connect() as conn:
        for table in ("concepts", "concept_domains", "concept_languages", "concept_terms"):
            assert conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0
    deleted = changes(db)[before:]
    assert [e["action"] for e in deleted] == ["deleted", "deleted"]
    assert deleted[1]["term_text"] == "login"
    assert all(e["concept_labels"] == {"en": "login"} for e in deleted)
    assert {e["comment"] for e in deleted} == {"gone"}
    assert store.delete_concept(concept.id, actor=ME) is False


def test_delete_of_a_global_concept_needs_admin(store):
    d = store.create_domain("Global", owner_id=None)
    concept = add_term(store, d.id, language=Language.EN, preferred="a")
    with pytest.raises(GlobalReadOnlyError):
        store.delete_concept(concept.id, actor=ME)
    assert store.get_concept(concept.id, owner_id=1) is not None
    assert store.delete_concept(concept.id, actor=ADMIN) is True


def test_delete_of_a_foreign_concept_returns_false(store):
    d = store.create_domain("Theirs", owner_id=2)
    concept = add_term(
        store, d.id, language=Language.EN, preferred="a", actor=Actor(user_id=2, is_admin=False)
    )
    assert store.delete_concept(concept.id, actor=ME) is False
    assert store.get_concept(concept.id, owner_id=2) is not None


def test_a_failing_log_write_rolls_the_concept_back(store, db):
    d = store.create_domain("Cloud", owner_id=1)
    with patch("app.services.terminology.changes.write", side_effect=RuntimeError("boom")):
        with pytest.raises(RuntimeError):
            add_term(store, d.id, language=Language.EN, preferred="a")
    assert concept_count(db) == 0


# -- saving ---------------------------------------------------------------


@pytest.fixture
def clock(monkeypatch) -> DocumentClock:
    clock = DocumentClock()
    monkeypatch.setattr("app.services.terminology.store._utcnow", clock.now_iso)
    return clock


@pytest.fixture
def d(store):
    return store.create_domain("Cloud", owner_id=1)


@pytest.fixture
def c(store, d, clock):
    concept = add_term(
        store, d.id, language=Language.EN, preferred="sign in", forbidden_variants=["login"],
        definition="d",
    )
    clock.advance()
    return concept


def part(concept, language) -> SectionInput:
    return SectionInput.from_section(next(s for s in concept.sections if s.language == language))


def en(concept) -> SectionInput:
    return part(concept, Language.EN)


def stored_section(concept, language):
    return next(s for s in concept.sections if s.language == language)


def stored_term(concept, text):
    return next(t for s in concept.sections for t in s.terms if t.text == text)


def with_term(given: SectionInput, current_text: str, /, **fields) -> SectionInput:
    return given.model_copy(update={
        "terms": [
            t.model_copy(update=fields) if t.text == current_text else t for t in given.terms
        ]
    })


def removal(concept, language) -> SectionInput:
    return part(concept, language).model_copy(update={"terms": []})


def add_de(store, concept, clock):
    saved = store.save_section(
        concept.id, section(Language.DE, term("Anmeldung"), definition="a"), actor=ME
    )
    clock.advance()
    return saved


def test_save_section_edits_a_term_and_logs_one_entry(store, db, c, clock):
    log = len(changes(db))
    saved = store.save_section(
        c.id,
        with_term(en(c), "login", usage_status=UsageStatus.DEPRECATED, status_reason="old"),
        actor=ME,
    )
    new = changes(db)[log:]
    assert [e["action"] for e in new] == ["edited"]
    assert [ch["field"] for ch in new[0]["changes"]] == ["usage_status", "status_reason"]
    old_login, old_sign_in = stored_term(c, "login"), stored_term(c, "sign in")
    assert new[0]["at"] == clock.now_iso()
    assert new[0]["term_uid"] == old_login.uid
    assert new[0]["term_language"] == "en"
    for concept in (saved, store.get_concept(c.id, owner_id=1)):
        login, sign_in = stored_term(concept, "login"), stored_term(concept, "sign in")
        assert login.revision == 2
        assert login.modified_at == clock.now_iso()
        assert login.created_at == old_login.created_at
        assert sign_in.revision == 1
        assert sign_in.modified_at == old_sign_in.modified_at
        assert concept.sections[0].revision == 2
        assert concept.sections[0].modified_at == clock.now_iso()
        assert concept.revision == 1
        assert concept.modified_at == c.modified_at


def test_definition_change_increases_the_section_only(store, c, clock):
    saved = store.save_section(c.id, en(c).model_copy(update={"definition": "new"}), actor=ME)
    assert saved.sections[0].definition == "new"
    assert saved.sections[0].revision == 2
    assert saved.sections[0].modified_at == clock.now_iso()
    assert saved.sections[0].terms == c.sections[0].terms
    assert (saved.revision, saved.modified_at) == (c.revision, c.modified_at)


def test_saving_the_current_state_changes_nothing(store, db, d, c, clock):
    log = changes(db)
    store.save_section(c.id, en(c), actor=ME)
    assert changes(db) == log
    assert store.get_concept(c.id, owner_id=1) == c
    clock.advance()
    store.save_concept(
        c.id, sections=[en(c)], domain_ids=[d.id], revision=c.revision, actor=ME
    )
    assert changes(db) == log
    assert store.get_concept(c.id, owner_id=1) == c


def test_out_of_date_section_is_refused(store, db, c, clock):
    first = en(c)
    saved = store.save_section(
        c.id, with_term(first, "login", usage_status=UsageStatus.DEPRECATED), actor=ME
    )
    clock.advance()
    log = changes(db)
    with pytest.raises(TerminologyConflictError) as exc:
        store.save_section(c.id, first.model_copy(update={"definition": "other"}), actor=ME)
    assert exc.value.rule == "conflict"
    assert exc.value.part == "en"
    assert changes(db) == log
    assert store.get_concept(c.id, owner_id=1) == saved


def test_two_languages_saved_from_the_same_read_both_succeed(store, c, clock):
    read = add_de(store, c, clock)
    store.save_section(read.id, en(read).model_copy(update={"definition": "en new"}), actor=ME)
    saved = store.save_section(
        read.id, part(read, Language.DE).model_copy(update={"definition": "de new"}), actor=ME
    )
    assert [s.definition for s in saved.sections] == ["en new", "de new"]


def test_adding_a_language_needs_no_number_and_increases_the_concept(store, c, clock):
    saved = store.save_section(c.id, section(Language.DE, term("Anmeldung")), actor=ME)
    de = stored_section(saved, Language.DE)
    assert (de.revision, de.created_by) == (1, 1)
    assert saved.revision == 2
    assert saved.modified_at == clock.now_iso()
    assert stored_section(saved, Language.EN) == stored_section(c, Language.EN)


def test_two_different_languages_can_be_added_from_the_same_read(store, c):
    store.save_section(c.id, section(Language.DE, term("Anmeldung")), actor=ME)
    saved = store.save_section(c.id, section(Language.FR, term("connexion")), actor=ME)
    assert [s.language for s in saved.sections] == [Language.EN, Language.DE, Language.FR]


def test_adding_a_language_that_exists_meanwhile_is_refused(store, db, c):
    store.save_section(c.id, section(Language.DE, term("Anmeldung")), actor=ME)
    log = changes(db)
    with pytest.raises(TerminologyConflictError) as exc:
        store.save_section(c.id, section(Language.DE, term("Login")), actor=ME)
    assert exc.value.part == "de"
    assert changes(db) == log
    assert [t.text for t in store.get_concept(c.id, owner_id=1).sections[1].terms] == ["Anmeldung"]


def test_saving_a_language_removed_meanwhile_is_refused(store, c, clock):
    read = add_de(store, c, clock)
    store.save_section(read.id, removal(read, Language.DE), actor=ME)
    with pytest.raises(TerminologyConflictError) as exc:
        store.save_section(
            read.id, part(read, Language.DE).model_copy(update={"definition": "b"}), actor=ME
        )
    assert exc.value.part == "de"
    assert [s.language for s in store.get_concept(c.id, owner_id=1).sections] == [Language.EN]


def test_a_language_removed_and_added_again_refuses_the_old_copy(store, c, clock):
    read = add_de(store, c, clock)
    store.save_section(read.id, removal(read, Language.DE), actor=ME)
    again = store.save_section(read.id, section(Language.DE, term("Anmeldung")), actor=ME)
    de = stored_section(again, Language.DE)
    assert de.revision == 1
    assert de.id != stored_section(read, Language.DE).id
    for stale in (part(read, Language.DE).model_copy(update={"definition": "b"}),
                  removal(read, Language.DE)):
        with pytest.raises(TerminologyConflictError) as exc:
            store.save_section(read.id, stale, actor=ME)
        assert exc.value.part == "de"
    assert store.get_concept(c.id, owner_id=1) == again


def test_removing_the_last_term_removes_the_section(store, db, c, clock):
    with_de = add_de(store, c, clock)
    log = len(changes(db))
    saved = store.save_section(c.id, removal(with_de, Language.DE), actor=ME)
    assert [s.language for s in saved.sections] == [Language.EN]
    new = changes(db)[log:]
    assert [(e["action"], e["term_text"]) for e in new] == [
        ("edited", None), ("deleted", "Anmeldung"),
    ]
    assert new[0]["changes"] == [{"field": "definition", "language": "de", "old": "a", "new": ""}]
    assert new[1]["term_language"] == "de"
    assert saved.revision == with_de.revision + 1
    assert saved.modified_at == clock.now_iso()


def test_removing_a_section_with_an_out_of_date_number_is_refused(store, c, clock):
    with_de = add_de(store, c, clock)
    edited = store.save_section(
        c.id, part(with_de, Language.DE).model_copy(update={"definition": "b"}), actor=ME
    )
    with pytest.raises(TerminologyConflictError) as exc:
        store.save_section(c.id, removal(with_de, Language.DE), actor=ME)
    assert exc.value.part == "de"
    assert store.get_concept(c.id, owner_id=1) == edited


def test_removing_the_last_section_is_refused(store, db, c):
    log = changes(db)
    with pytest.raises(TerminologyRuleError) as exc:
        store.save_section(c.id, removal(c, Language.EN), actor=ME)
    assert exc.value.rule == "no_section"
    assert changes(db) == log
    assert store.get_concept(c.id, owner_id=1) == c


def test_missing_term_is_deleted_and_new_term_is_created(store, db, c):
    log = len(changes(db))
    given = en(c)
    given = given.model_copy(update={
        "terms": [given.terms[0], term("log in", UsageStatus.FORBIDDEN)]
    })
    saved = store.save_section(c.id, given, actor=ME)
    new = changes(db)[log:]
    assert [(e["action"], e["term_text"]) for e in new] == [
        ("deleted", "login"), ("created", "log in"),
    ]
    assert len({e["batch"] for e in new}) == 1
    assert stored_term(saved, "log in").revision == 1
    assert saved.sections[0].revision == 2


def test_term_ids_survive_a_save(store, c):
    saved = store.save_section(c.id, with_term(en(c), "login", source="style guide"), actor=ME)
    before, after = stored_term(c, "sign in"), stored_term(saved, "sign in")
    assert (after.id, after.uid, after.revision) == (before.id, before.uid, before.revision)
    login = stored_term(saved, "login")
    assert (login.id, login.uid) == (stored_term(c, "login").id, stored_term(c, "login").uid)


def test_two_terms_can_swap_their_wording_in_one_save(store, c):
    given = en(c)
    sign_in, login = given.terms
    given = given.model_copy(update={"terms": [
        sign_in.model_copy(update={"text": "login"}), login.model_copy(update={"text": "sign in"}),
    ]})
    saved = store.save_section(c.id, given, actor=ME)
    preferred = stored_term(saved, "login")
    assert preferred.id == stored_term(c, "sign in").id
    assert preferred.usage_status == UsageStatus.PREFERRED
    assert stored_term(saved, "sign in").id == stored_term(c, "login").id


def test_unknown_term_id_is_refused(store, d, c, clock):
    with_de = add_de(store, c, clock)
    other = add_term(store, d.id, language=Language.EN, preferred="logout")
    for foreign in (stored_term(with_de, "Anmeldung").id, other.sections[0].terms[0].id):
        given = en(with_de)
        given = given.model_copy(update={"terms": [*given.terms, term("x", UsageStatus.FORBIDDEN, id=foreign)]})
        with pytest.raises(TerminologyRuleError) as exc:
            store.save_section(c.id, given, actor=ME)
        assert exc.value.rule == "unknown_term"


def test_second_active_preferred_term_is_refused_on_save(store, c):
    with pytest.raises(TerminologyRuleError) as exc:
        store.save_section(c.id, with_term(en(c), "login", usage_status=UsageStatus.PREFERRED), actor=ME)
    assert exc.value.rule == "second_preferred"


def test_the_same_term_id_twice_is_refused(store, db, c):
    log = changes(db)
    given = en(c)
    login = next(t for t in given.terms if t.text == "login")
    given = given.model_copy(update={
        "terms": [*given.terms, login.model_copy(update={"text": "log in"})]
    })
    with pytest.raises(TerminologyRuleError) as exc:
        store.save_section(c.id, given, actor=ME)
    assert exc.value.rule == "duplicate_term"
    assert changes(db) == log
    assert store.get_concept(c.id, owner_id=1) == c


def test_save_concept_leaves_unlisted_sections_alone(store, c, clock):
    with_de = add_de(store, c, clock)
    saved = store.save_concept(
        c.id, sections=[with_term(en(with_de), "login", source="x")], actor=ME
    )
    assert stored_term(saved, "login").source == "x"
    assert stored_section(saved, Language.DE) == stored_section(with_de, Language.DE)
    assert saved.domain_ids == with_de.domain_ids
    assert saved.revision == with_de.revision


def test_save_concept_writes_several_parts_in_one_batch(store, db, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    log = len(changes(db))
    saved = store.save_concept(
        c.id,
        sections=[with_term(en(c), "login", source="x"), section(Language.FR, term("connexion"))],
        domain_ids=[d.id, d2.id],
        revision=c.revision,
        actor=ME,
    )
    new = changes(db)[log:]
    assert [(e["action"], e["term_text"]) for e in new] == [
        ("added_to_domain", None), ("edited", "login"), ("created", "connexion"),
    ]
    assert len({e["batch"] for e in new}) == 1
    assert saved.domain_ids == [d.id, d2.id]
    assert saved.revision == 2


def test_changing_links_increases_the_concept_only(store, db, d, c, clock):
    d2 = store.create_domain("Docs", owner_id=1)
    log = len(changes(db))
    saved = store.save_concept(c.id, domain_ids=[d2.id], revision=c.revision, actor=ME)
    assert [e["action"] for e in changes(db)[log:]] == ["removed_from_domain", "added_to_domain"]
    assert saved.revision == 2
    assert saved.modified_at == clock.now_iso()
    assert saved.sections == c.sections
    assert store.list_concepts(d.id, owner_id=1) == []
    assert [x.id for x in store.list_concepts(d2.id, owner_id=1)] == [c.id]


def test_out_of_date_links_are_refused(store, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    saved = store.save_concept(c.id, domain_ids=[d.id, d2.id], revision=c.revision, actor=ME)
    for stale in (c.revision, None):
        with pytest.raises(TerminologyConflictError) as exc:
            store.save_concept(c.id, domain_ids=[d2.id], revision=stale, actor=ME)
        assert exc.value.part == "links"
    assert store.get_concept(c.id, owner_id=1) == saved


def test_a_refused_part_refuses_the_whole_save(store, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    linked = store.save_concept(c.id, domain_ids=[d.id, d2.id], revision=c.revision, actor=ME)
    with pytest.raises(TerminologyConflictError) as exc:
        store.save_concept(
            c.id, sections=[with_term(en(c), "login", source="x")], domain_ids=[d.id],
            revision=c.revision, actor=ME,
        )
    assert exc.value.part == "links"
    assert store.get_concept(c.id, owner_id=1) == linked


_DOMAIN_CASES = {
    "empty": lambda store: [],
    "foreign": lambda store: [store.create_domain("Theirs", owner_id=2).id],
    "missing": lambda store: [9999],
    "global_for_own": lambda store: [store.create_domain("Global", owner_id=None).id],
}


@pytest.mark.parametrize(
    ("case", "rule"),
    [
        ("empty", "no_domain"),
        ("foreign", "unknown_domain"),
        ("missing", "unknown_domain"),
        ("global_for_own", "domain_owner_mismatch"),
        ("own_for_global", "domain_owner_mismatch"),
    ],
)
def test_domain_rules(store, db, d, c, case, rule):
    if case == "own_for_global":
        g = store.create_domain("Global", owner_id=None)
        target, actor, ids = add_term(store, g.id, language=Language.EN, preferred="x"), ADMIN, [d.id]
    else:
        target, actor, ids = c, ME, _DOMAIN_CASES[case](store)
    log = changes(db)
    with pytest.raises(TerminologyRuleError) as exc:
        store.save_concept(target.id, domain_ids=ids, revision=target.revision, actor=actor)
    assert exc.value.rule == rule
    assert changes(db) == log
    assert store.get_concept(target.id, owner_id=1) == target


def test_shared_concept_is_one_row_seen_from_both_domains(store, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    store.save_concept(c.id, domain_ids=[d.id, d2.id], revision=c.revision, actor=ME)
    [via_d] = store.list_concepts(d.id, owner_id=1)
    [via_d2] = store.list_concepts(d2.id, owner_id=1)
    assert via_d.id == via_d2.id == c.id
    store.save_section(via_d.id, with_term(en(via_d), "login", source="x"), actor=ME)
    [via_d2] = store.list_concepts(d2.id, owner_id=1)
    assert stored_term(via_d2, "login").source == "x"


def test_non_admin_cannot_save_a_global_concept_even_without_changes(store):
    g = store.create_domain("Global", owner_id=None)
    gc = add_term(store, g.id, language=Language.EN, preferred="a")
    attempts = [
        lambda: store.save_section(gc.id, en(gc), actor=ME),
        lambda: store.save_section(gc.id, en(gc).model_copy(update={"revision": 99}), actor=ME),
        lambda: store.save_concept(gc.id, domain_ids=[g.id], revision=99, actor=ME),
    ]
    for attempt in attempts:
        with pytest.raises(GlobalReadOnlyError):
            attempt()
    assert store.get_concept(gc.id, owner_id=1) == gc


def test_saving_an_invisible_concept_returns_none(store, c):
    theirs = store.create_domain("Theirs", owner_id=2)
    foreign = add_term(
        store, theirs.id, language=Language.EN, preferred="a", actor=Actor(user_id=2, is_admin=False)
    )
    assert store.save_section(foreign.id, en(foreign), actor=ME) is None
    assert store.save_concept(foreign.id, sections=[en(foreign)], actor=ME) is None
    assert store.save_section(9999, en(c), actor=ME) is None
    assert store.get_concept(foreign.id, owner_id=2) == foreign


def test_failed_save_leaves_no_partial_write(store, db, c):
    log = changes(db)
    with patch("app.services.terminology.changes.write", side_effect=RuntimeError("boom")):
        with pytest.raises(RuntimeError):
            store.save_concept(
                c.id,
                sections=[
                    with_term(en(c), "login", source="x"),
                    section(Language.DE, term("Anmeldung")),
                ],
                actor=ME,
            )
    assert store.get_concept(c.id, owner_id=1) == c
    assert changes(db) == log


def test_comment_is_stored_on_every_entry_of_the_batch(store, db, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    log = len(changes(db))
    store.save_concept(
        c.id,
        sections=[with_term(en(c), "login", source="x"), section(Language.FR, term("connexion"))],
        domain_ids=[d.id, d2.id],
        revision=c.revision,
        actor=ME,
        comment="merge",
    )
    new = changes(db)[log:]
    assert len(new) == 3
    assert {e["comment"] for e in new} == {"merge"}
    assert len({e["batch"] for e in new}) == 1


def in_two_domains(store, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    two = store.save_concept(c.id, domain_ids=[d.id, d2.id], revision=c.revision, actor=ME)
    assert two is not None
    return d2, two


def test_remove_from_domain_deletes_the_link_only(store, db, d, c):
    d2, two = in_two_domains(store, d, c)
    log = len(changes(db))
    assert store.remove_concept_from_domain(c.id, d2.id, actor=ME, comment="x") is True
    after = store.get_concept(c.id, owner_id=1)
    assert after.domain_ids == [d.id]
    assert after.revision == two.revision + 1
    assert [s.revision for s in after.sections] == [s.revision for s in two.sections]
    new = changes(db)[log:]
    assert [e["action"] for e in new] == ["removed_from_domain"]
    assert new[0]["changes"] == [
        {"field": "domain", "old": {"id": d2.id, "name": "Docs"}, "new": None}
    ]


def test_remove_from_the_last_domain_is_refused(store, db, d, c):
    log = changes(db)
    with pytest.raises(TerminologyRuleError) as caught:
        store.remove_concept_from_domain(c.id, d.id, actor=ME)
    assert caught.value.rule == "no_domain"
    assert store.get_concept(c.id, owner_id=1) == c
    assert changes(db) == log


def test_remove_returns_false_when_not_linked(store, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    foreign = store.create_domain("Theirs", owner_id=2)
    assert store.remove_concept_from_domain(c.id, d2.id, actor=ME) is False
    assert store.remove_concept_from_domain(c.id, foreign.id, actor=ME) is False
    assert store.remove_concept_from_domain(9999, d.id, actor=ME) is False
    assert store.remove_concept_from_domain(c.id, 9999, actor=ME) is False


def test_delete_domain_deletes_concepts_that_are_in_no_other_domain(store, db, d, c):
    d2, two = in_two_domains(store, d, c)
    a = add_term(store, d.id, language=Language.EN, preferred="alpha")
    log = len(changes(db))
    assert store.delete_domain(d.id, actor=ME) is True
    assert store.get_domain(d.id, owner_id=1) is None
    assert store.get_concept(a.id, owner_id=1) is None
    b = store.get_concept(c.id, owner_id=1)
    assert b.domain_ids == [d2.id]
    assert b.revision == two.revision + 1
    new = changes(db)[log:]
    assert len({e["batch"] for e in new}) == 1
    assert [(e["action"], e["concept_id"]) for e in new] == [
        ("removed_from_domain", c.id), ("deleted", a.id), ("deleted", a.id),
    ]
    assert new[0]["changes"] == [
        {"field": "domain", "old": {"id": d.id, "name": "Cloud"}, "new": None}
    ]


def test_delete_domain_as_non_admin_on_a_global_domain_is_refused(store, db):
    g = store.create_domain("Global", owner_id=None)
    add_term(store, g.id, language=Language.EN, preferred="a")
    log = changes(db)
    with pytest.raises(GlobalReadOnlyError):
        store.delete_domain(g.id, actor=ME)
    assert store.get_domain(g.id, owner_id=1) is not None
    assert concept_count(db) == 1
    assert changes(db) == log


def test_delete_domain_that_is_not_visible_returns_false(store):
    theirs = store.create_domain("Theirs", owner_id=2)
    assert store.delete_domain(theirs.id, actor=ME) is False
    assert store.delete_domain(9999, actor=ME) is False


def test_delete_empty_domain_writes_no_entry(store, db, d):
    assert store.delete_domain(d.id, actor=ME) is True
    assert store.get_domain(d.id, owner_id=1) is None
    assert changes(db) == []


def test_remove_from_domain_of_a_global_concept_needs_admin(store, db):
    g1 = store.create_domain("G1", owner_id=None)
    g2 = store.create_domain("G2", owner_id=None)
    first = add_term(store, g1.id, language=Language.EN, preferred="a")
    linked = store.save_concept(
        first.id, domain_ids=[g1.id, g2.id], revision=first.revision, actor=ADMIN
    )
    log = changes(db)
    with pytest.raises(GlobalReadOnlyError):
        store.remove_concept_from_domain(first.id, g2.id, actor=ME)
    assert store.get_concept(first.id, owner_id=1) == linked
    assert changes(db) == log


def test_links_are_refused_after_a_language_was_added(store, db, d, c):
    d2 = store.create_domain("Docs", owner_id=1)
    store.save_concept(c.id, sections=[section(Language.DE, term("Anmeldung"))], actor=ME)
    log = changes(db)
    state = store.get_concept(c.id, owner_id=1)
    with pytest.raises(TerminologyConflictError) as caught:
        store.save_concept(
            c.id, domain_ids=[d.id, d2.id], revision=c.revision, actor=ME
        )
    assert caught.value.part == "links"
    assert store.get_concept(c.id, owner_id=1) == state
    assert changes(db) == log


def test_audit_fields_follow_the_acting_user(store):
    g = store.create_domain("Global", owner_id=None)
    g2 = store.create_domain("Global2", owner_id=None)
    c = add_term(store, g.id, language=Language.EN, preferred="login")
    other = Actor(user_id=2, is_admin=True)
    edited = store.save_concept(
        c.id, sections=[with_term(en(c), "login", source="x")], actor=other
    )
    sec = stored_section(edited, Language.EN)
    tm = stored_term(edited, "login")
    assert (tm.modified_by, tm.created_by) == (2, 1)
    assert (sec.modified_by, sec.created_by) == (2, 1)
    assert edited.modified_by == 1
    linked = store.save_concept(
        c.id, domain_ids=[g.id, g2.id], revision=edited.revision, actor=other
    )
    assert linked.modified_by == 2
