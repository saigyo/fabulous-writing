import json
import re
from pathlib import Path

from app.core.models import Language
from app.services.terminology import (
    Action,
    Actor,
    Concept,
    ConceptTerm,
    LanguageSection,
    ProcessStatus,
    TerminologyStore,
    UsageStatus,
)
from app.services.terminology import changes
from app.services.terminology.changes import diff, write

NAMES = {3: "Cloud", 4: "Legal"}


def _term(id, text, usage=UsageStatus.PREFERRED, **kw):
    return ConceptTerm(
        id=id, uid=f"t{id}", text=text, usage_status=usage,
        process_status=ProcessStatus.ACTIVE, **kw,
    )


def concept(**overrides) -> Concept:
    values = dict(
        id=7, uid="c7", domain_ids=[3],
        sections=[
            LanguageSection(
                id=1, language=Language.EN, definition="d",
                terms=[_term(11, "sign in"), _term(12, "login", UsageStatus.FORBIDDEN)],
            ),
            LanguageSection(
                id=2, language=Language.DE, definition="a", terms=[_term(13, "anmelden")],
            ),
        ],
    )
    values.update(overrides)
    return Concept(**values)


def _en(c: Concept) -> LanguageSection:
    return c.sections[0]


def test_created_lists_every_initial_value():
    entries = diff(None, concept(), domain_names=NAMES)
    assert len(entries) == 4
    first = entries[0]
    assert first.action is Action.CREATED
    assert first.term_id is None
    assert first.changes == [
        {"field": "definition", "language": "en", "old": None, "new": "d"},
        {"field": "definition", "language": "de", "old": None, "new": "a"},
        {"field": "domain", "old": None, "new": {"id": 3, "name": "Cloud"}},
    ]
    second = entries[1]
    assert second.term_text == "sign in"
    assert second.term_language == "en"
    assert len(second.changes) == 8
    assert all(c["old"] is None for c in second.changes)
    assert {"field": "case_sensitive", "old": None, "new": False} in second.changes
    assert {"field": "part_of_speech", "old": None, "new": ""} in second.changes
    assert {"field": "usage_status", "old": None, "new": "preferred"} in second.changes


def test_carried_over_uses_the_given_action():
    entries = diff(None, concept(), domain_names=NAMES, initial_action=Action.CARRIED_OVER)
    assert [e.action for e in entries] == [Action.CARRIED_OVER] * 4


def test_deleted_lists_the_last_state_as_old_values():
    entries = diff(concept(), None, domain_names=NAMES)
    assert [e.action for e in entries] == [Action.DELETED] * 4
    assert entries[0].changes[0] == {"field": "definition", "language": "en", "old": "d", "new": None}
    assert entries[0].changes[2] == {"field": "domain", "old": {"id": 3, "name": "Cloud"}, "new": None}
    assert entries[3].term_language == "de"
    assert all(c["new"] is None for e in entries for c in e.changes)
    assert all(e.concept_labels == {"en": "sign in", "de": "anmelden"} for e in entries)


def test_no_difference_gives_no_entries():
    before = concept()
    after = concept(revision=9, modified_at="2030-01-01")
    after.sections[0].revision = 4
    after.sections[0].terms[0].modified_at = "x"
    assert diff(before, after, domain_names=NAMES) == []
    assert diff(concept(), concept(), domain_names=NAMES) == []


def test_several_fields_of_one_term_are_one_entry():
    after = concept()
    term = _en(after).terms[1]
    term.usage_status = UsageStatus.DEPRECATED
    term.status_reason = "old"
    entries = diff(concept(), after, domain_names=NAMES)
    assert len(entries) == 1
    assert entries[0].action is Action.EDITED
    assert entries[0].term_id == 12
    assert entries[0].changes == [
        {"field": "usage_status", "old": "forbidden", "new": "deprecated"},
        {"field": "status_reason", "old": "", "new": "old"},
    ]


def test_definition_change_is_logged_on_the_concept_with_its_language():
    after = concept()
    after.sections[1].definition = "b"
    entries = diff(concept(), after, domain_names=NAMES)
    assert len(entries) == 1
    assert entries[0].action is Action.EDITED
    assert entries[0].term_id is None
    assert entries[0].changes == [{"field": "definition", "language": "de", "old": "a", "new": "b"}]


def test_new_section_with_empty_definition_logs_only_its_terms():
    after = concept()
    after.sections.append(
        LanguageSection(id=3, language=Language.FR, terms=[_term(14, "connexion")])
    )
    entries = diff(concept(), after, domain_names=NAMES)
    assert len(entries) == 1
    assert entries[0].action is Action.CREATED
    assert entries[0].term_id == 14
    assert entries[0].term_language == "fr"


def test_removed_section_logs_its_definition_and_its_terms():
    after = concept(sections=[concept().sections[0]])
    entries = diff(concept(), after, domain_names=NAMES)
    assert [e.action for e in entries] == [Action.EDITED, Action.DELETED]
    assert entries[0].changes == [{"field": "definition", "language": "de", "old": "a", "new": ""}]
    assert entries[1].term_id == 13
    assert entries[1].term_language == "de"
    assert entries[1].term_text == "anmelden"


def test_domain_changes_are_not_part_of_the_edited_entry():
    after = concept(domain_ids=[4])
    after.sections[0].definition = "e"
    entries = diff(concept(), after, domain_names=NAMES)
    assert [e.action for e in entries] == [
        Action.EDITED, Action.REMOVED_FROM_DOMAIN, Action.ADDED_TO_DOMAIN,
    ]
    assert [c["field"] for c in entries[0].changes] == ["definition"]


def test_domain_links_are_one_entry_each():
    entries = diff(concept(), concept(domain_ids=[4]), domain_names=NAMES)
    assert [e.action for e in entries] == [Action.REMOVED_FROM_DOMAIN, Action.ADDED_TO_DOMAIN]
    assert entries[0].changes == [{"field": "domain", "old": {"id": 3, "name": "Cloud"}, "new": None}]
    assert entries[1].changes == [{"field": "domain", "old": None, "new": {"id": 4, "name": "Legal"}}]


def test_labels_describe_the_state_after_the_change():
    after = concept()
    _en(after).terms[0].text = "log in"
    entries = diff(concept(), after, domain_names=NAMES)
    assert len(entries) == 1
    assert entries[0].term_text == "log in"
    assert entries[0].concept_labels == {"en": "log in", "de": "anmelden"}


def test_no_statement_updates_or_deletes_log_entries():
    package = Path(changes.__file__).parent
    pattern = re.compile(r"(UPDATE|DELETE\s+FROM)\s+terminology_changes", re.IGNORECASE)
    inserting = []
    for path in package.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert not pattern.search(text), path.name
        if "INSERT INTO terminology_changes" in text:
            inserting.append(path.name)
    assert inserting == ["changes.py"]


def test_write_inserts_one_row_per_entry(db):
    TerminologyStore(db)
    entries = diff(None, concept(), domain_names=NAMES)
    with db.connect() as conn:
        write(
            conn, entries, batch="b1", at="2026-01-01T00:00:00+00:00",
            actor=Actor(user_id=5, is_admin=False), comment="why",
        )
        rows = conn.execute("SELECT * FROM terminology_changes ORDER BY id").fetchall()
    assert len(rows) == 4
    for row, entry in zip(rows, entries, strict=True):
        assert row["batch"] == "b1"
        assert row["user_id"] == 5
        assert row["origin"] == "manual"
        assert row["comment"] == "why"
        assert row["action"] == entry.action.value
        assert json.loads(row["changes"]) == entry.changes
        assert json.loads(row["concept_labels"]) == {"en": "sign in", "de": "anmelden"}
