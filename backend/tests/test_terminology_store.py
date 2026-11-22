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
    TerminologyRuleError,
    TerminologyStore,
    UsageStatus,
)
from app.services.terminology.store import _validate
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


def test_get_and_list_respect_visibility(store):
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


def test_list_concepts_is_ordered_by_id(store):
    d = store.create_domain("Cloud", owner_id=1)
    first = add_term(store, d.id, language=Language.EN, preferred="b")
    second = add_term(store, d.id, language=Language.EN, preferred="a")
    assert [c.id for c in store.list_concepts(d.id, owner_id=1)] == [first.id, second.id]


def test_list_sections_returns_one_language(store):
    d = store.create_domain("Cloud", owner_id=1)
    store.create_concept(
        d.id,
        [
            section(Language.EN, term("login"), term("signin", process=ProcessStatus.CANDIDATE)),
            section(Language.DE, term("Anmeldung")),
        ],
        actor=ME,
    )
    add_term(store, d.id, language=Language.EN, preferred="logout")
    add_term(store, d.id, language=Language.DE, preferred="Abmeldung")
    sections = store.list_sections(d.id, owner_id=1, language=Language.EN)
    assert len(sections) == 2
    assert {s.language for s in sections} == {Language.EN}
    assert [t.text for t in sections[0].terms] == ["login", "signin"]
    assert [t.text for t in sections[1].terms] == ["logout"]


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
