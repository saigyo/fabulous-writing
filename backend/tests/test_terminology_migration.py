import json
import logging
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from app.checkers.terminology import TerminologyChecker
from app.core.config import NlpSettings
from app.core.models import Language
from app.nlp.registry import NlpRegistry
from app.services.db import table_columns
from app.services.db.sqlite import SqliteDatabase
from app.services.terminology import (
    Action,
    Concept,
    Origin,
    ProcessStatus,
    TerminologyStore,
    UsageStatus,
    changes,
)
from app.services.terminology.migration import LEGACY_TERMS_DDL
from tests.terminology_baseline import BASELINE_DOMAINS, BASELINE_TEXTS, load_golden, normalise
from tests.terminology_helpers import add_term
from tests.terminology_helpers import changes as logged_changes

L = Language
_MIGRATION_LOGGER = "app.services.terminology.migration"
_NEW_TABLES = ("concepts", "concept_domains", "concept_languages", "concept_terms", "terminology_changes")

_DOMAINS_DDL = """CREATE TABLE domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER
)"""

_DOMAINS = (("Shared", None), ("Mine", 1))


@dataclass(frozen=True)
class Old:
    domain: str
    language: Language
    preferred: str
    variants: Sequence[str] = field(default_factory=list)
    definition: str = ""
    case_sensitive: bool = False
    id: int | None = None


def _insert_term(conn, row_id: int, domain_id: int, old: Old) -> None:
    conn.execute(
        "INSERT INTO terms (id, domain_id, language, preferred, forbidden_variants, definition,"
        " case_sensitive) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            row_id, domain_id, old.language.value, old.preferred, json.dumps(list(old.variants)),
            old.definition, int(old.case_sensitive),
        ),
    )


def legacy(db, rows: Sequence[Old], domains=_DOMAINS) -> dict[str, int]:
    """A database as it was before the concept model: `domains` and `terms`."""
    with db.connect() as conn:
        conn.executescript(_DOMAINS_DDL + ";\n" + LEGACY_TERMS_DDL + ";")
        ids = {
            name: conn.execute(
                "INSERT INTO domains (name, owner_id) VALUES (?, ?) RETURNING id", (name, owner_id)
            ).fetchone()["id"]
            for name, owner_id in domains
        }
        for position, old in enumerate(rows, start=1):
            _insert_term(conn, old.id or position, ids[old.domain], old)
    return ids


def count(db, table: str) -> int:
    with db.connect() as conn:
        return conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]


def columns(db, table: str) -> set[str]:
    with db.connect() as conn:
        return table_columns(conn, table)


def concepts_in(store: TerminologyStore, domain_id: int) -> list[Concept]:
    found = store.list_concepts(domain_id, owner_id=1)
    assert found is not None
    return found


def term_shape(concept: Concept) -> list[tuple]:
    (section,) = concept.sections
    return [(t.text, t.usage_status, t.process_status, t.case_sensitive) for t in section.terms]


def warnings(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage() for r in caplog.records
        if r.name == _MIGRATION_LOGGER and r.levelno == logging.WARNING
    ]


@pytest.fixture
def sqlite_db(tmp_path: Path) -> SqliteDatabase:
    return SqliteDatabase(tmp_path / "legacy.db")


@pytest.fixture
def failing_write(monkeypatch: pytest.MonkeyPatch):
    def install(on_call: int) -> None:
        real = changes.write
        calls = {"n": 0}

        def write(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == on_call:
                raise RuntimeError("boom")
            return real(*args, **kwargs)

        monkeypatch.setattr(changes, "write", write)

    return install


P, F, A = UsageStatus.PREFERRED, UsageStatus.FORBIDDEN, ProcessStatus.ACTIVE


def test_rows_become_concepts_sections_and_terms(db):
    ids = legacy(db, [
        Old("Shared", L.EN, "sign in", ["login", "", "  ", "login", "log-in", "sign in"], "Enter.", True),
        Old("Mine", L.DE, "Anmeldung", ["Login"], "Vorgang."),
        Old("Shared", L.JA, "ログイン", ["サインイン"]),
    ])
    store = TerminologyStore(db)

    shared = concepts_in(store, ids["Shared"])
    mine = concepts_in(store, ids["Mine"])
    assert len(shared) == 2 and len(mine) == 1
    assert {c.owner_id for c in shared} == {None}
    assert mine[0].owner_id == 1
    assert {tuple(c.domain_ids) for c in shared} == {(ids["Shared"],)}
    assert mine[0].domain_ids == [ids["Mine"]]

    sign_in = next(c for c in shared if c.sections[0].language == L.EN)
    assert sign_in.sections[0].definition == "Enter."
    assert term_shape(sign_in) == [
        ("sign in", P, A, True), ("login", F, A, True), ("log-in", F, A, True),
    ]
    assert term_shape(mine[0]) == [("Anmeldung", P, A, False), ("Login", F, A, False)]
    assert mine[0].sections[0].definition == "Vorgang."

    for concept in shared + mine:
        levels = [concept, *concept.sections, *(t for s in concept.sections for t in s.terms)]
        for item in levels:
            assert item.created_at is None and item.modified_at is None
            assert item.created_by is None and item.modified_by is None
            assert item.revision == 1


def test_sections_keep_the_old_term_ids(db):
    ids = legacy(db, [
        Old("Shared", L.EN, "sign in", id=1),
        Old("Shared", L.DE, "Anmeldung", id=3),
        Old("Mine", L.FR, "connexion", id=4),
    ])
    store = TerminologyStore(db)

    for section_id, wording in ((1, "sign in"), (3, "Anmeldung"), (4, "connexion")):
        concept = store.get_concept_by_section(section_id, owner_id=1)
        assert concept is not None
        assert concept.sections[0].id == section_id
        assert concept.sections[0].terms[0].text == wording

    later = add_term(store, ids["Shared"], language=L.IT, preferred="accesso")
    assert later.sections[0].id > 4


def test_migration_logs_carried_over_entries(db, monkeypatch):
    monkeypatch.setattr(
        "app.services.terminology.store._utcnow", lambda: "2026-11-22T10:00:00+00:00"
    )
    legacy(db, [
        Old("Shared", L.EN, "sign in", ["login"]),
        Old("Mine", L.DE, "Anmeldung", ["Login", "Log-in"]),
    ])
    store = TerminologyStore(db)

    entries = logged_changes(db)
    assert len(entries) == 2 + 2 + 3
    assert {e["action"] for e in entries} == {Action.CARRIED_OVER.value}
    assert {e["origin"] for e in entries} == {Origin.MIGRATION.value}
    assert {e["user_id"] for e in entries} == {None}
    assert {e["at"] for e in entries} == {"2026-11-22T10:00:00+00:00"}

    by_concept: dict[int, list[dict]] = {}
    for e in entries:
        by_concept.setdefault(e["concept_id"], []).append(e)
    assert len(by_concept) == 2
    assert len({e["batch"] for e in entries}) == 2
    for concept_id, group in by_concept.items():
        assert len({e["batch"] for e in group}) == 1
        concept = store.get_concept(concept_id, owner_id=1)
        assert concept is not None
        (section,) = concept.sections
        texts = {t.id: t.text for t in section.terms}
        term_entries = [e for e in group if e["term_id"] is not None]
        assert {e["term_id"]: e["term_text"] for e in term_entries} == texts
        assert {e["term_language"] for e in term_entries} == {section.language.value}
        (head,) = [e for e in group if e["term_id"] is None]
        assert head["term_text"] is None


def test_variant_equal_to_preferred_is_skipped_with_a_warning(sqlite_db, caplog):
    ids = legacy(sqlite_db, [Old("Shared", L.EN, "sign in", ["sign in", "login"])])
    with caplog.at_level(logging.WARNING, logger=_MIGRATION_LOGGER):
        store = TerminologyStore(sqlite_db)

    (concept,) = concepts_in(store, ids["Shared"])
    assert term_shape(concept) == [("sign in", P, A, False), ("login", F, A, False)]
    assert any("Shared" in m and "sign in" in m for m in warnings(caplog))


def test_variant_differing_only_in_case_is_carried_over(sqlite_db):
    ids = legacy(sqlite_db, [Old("Shared", L.EN, "GitHub", ["Github"], case_sensitive=True)])
    store = TerminologyStore(sqlite_db)

    (concept,) = concepts_in(store, ids["Shared"])
    assert term_shape(concept) == [("GitHub", P, A, True), ("Github", F, A, True)]


def test_old_table_is_renamed_and_a_second_start_changes_nothing(db):
    legacy(db, [
        Old("Shared", L.EN, "sign in", ["login"]),
        Old("Mine", L.DE, "Anmeldung", ["Login"], "Vorgang.", True),
    ])
    with db.connect() as conn:
        original = [tuple(r) for r in conn.execute("SELECT * FROM terms ORDER BY id").fetchall()]

    TerminologyStore(db)
    assert columns(db, "terms") == set()
    with db.connect() as conn:
        kept = [tuple(r) for r in conn.execute("SELECT * FROM terms_legacy ORDER BY id").fetchall()]
    assert kept == original
    counts = {table: count(db, table) for table in _NEW_TABLES}
    assert counts["concepts"] == 2

    TerminologyStore(db)
    assert {table: count(db, table) for table in _NEW_TABLES} == counts


def test_failed_migration_leaves_everything_as_it_was(db, failing_write, monkeypatch):
    legacy(db, [
        Old("Shared", L.EN, "sign in", ["login"]),
        Old("Shared", L.DE, "Anmeldung"),
        Old("Mine", L.FR, "connexion"),
    ])
    failing_write(on_call=3)
    with pytest.raises(RuntimeError, match="boom"):
        TerminologyStore(db)

    assert count(db, "terms") == 3
    assert columns(db, "terms_legacy") == set()
    assert count(db, "concepts") == 0
    assert count(db, "concept_languages") == 0
    assert count(db, "terminology_changes") == 0

    monkeypatch.undo()
    TerminologyStore(db)
    assert count(db, "concepts") == 3
    assert columns(db, "terms") == set()


def test_failed_term_migration_keeps_the_domain_backfill(sqlite_db, failing_write, monkeypatch):
    with sqlite_db.connect() as conn:
        conn.executescript(
            "CREATE TABLE domains (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,"
            " description TEXT NOT NULL DEFAULT '');\n" + LEGACY_TERMS_DDL + ";"
        )
        domain_id = conn.execute(
            "INSERT INTO domains (name) VALUES ('My own domain') RETURNING id"
        ).fetchone()["id"]
        _insert_term(conn, 1, domain_id, Old("My own domain", L.EN, "sign in"))
    failing_write(on_call=1)
    with pytest.raises(RuntimeError, match="boom"):
        TerminologyStore(sqlite_db)

    monkeypatch.undo()
    store = TerminologyStore(sqlite_db)
    (domain,) = store.list_domains(owner_id=1)
    assert domain.name == "My own domain"
    assert domain.is_global is False
    assert count(sqlite_db, "concepts") == 1


def test_both_tables_present_stops_startup(sqlite_db):
    legacy(sqlite_db, [Old("Shared", L.EN, "sign in")])
    with sqlite_db.connect() as conn:
        conn.executescript(LEGACY_TERMS_DDL.replace("TABLE terms", "TABLE terms_legacy") + ";")

    with pytest.raises(RuntimeError) as raised:
        TerminologyStore(sqlite_db)
    assert "'terms'" in str(raised.value)
    assert "'terms_legacy'" in str(raised.value)
    assert count(sqlite_db, "terms") == 1
    assert count(sqlite_db, "concepts") == 0


def test_row_with_empty_preferred_keeps_its_forbidden_terms(sqlite_db):
    ids = legacy(sqlite_db, [Old("Shared", L.EN, "", ["login", "log in"], "Enter.")])
    store = TerminologyStore(sqlite_db)

    (concept,) = concepts_in(store, ids["Shared"])
    assert concept.sections[0].definition == "Enter."
    assert term_shape(concept) == [("login", F, A, False), ("log in", F, A, False)]


def test_row_without_any_usable_wording_is_skipped_with_a_warning(sqlite_db, caplog):
    ids = legacy(sqlite_db, [
        Old("Shared", L.EN, " ", ["", "  "], id=7),
        Old("Shared", L.DE, "Anmeldung"),
    ])
    with caplog.at_level(logging.WARNING, logger=_MIGRATION_LOGGER):
        store = TerminologyStore(sqlite_db)

    (concept,) = concepts_in(store, ids["Shared"])
    assert concept.sections[0].language == L.DE
    assert any("7" in m and "Shared" in m for m in warnings(caplog))
    assert count(sqlite_db, "terms_legacy") == 2


def test_row_of_a_deleted_domain_is_not_migrated(sqlite_db, caplog):
    legacy(sqlite_db, [Old("Shared", L.EN, "sign in")])
    raw = sqlite_db.raw_connect()
    try:
        _insert_term(raw, 2, 99, Old("gone", L.EN, "orphan"))
        raw.commit()
    finally:
        raw.close()

    with caplog.at_level(logging.WARNING, logger=_MIGRATION_LOGGER):
        TerminologyStore(sqlite_db)

    assert count(sqlite_db, "concepts") == 1
    assert warnings(caplog) == [
        "not migrating 1 row(s) of the table 'terms' whose domain no longer exists"
    ]


def test_check_results_after_migration_match_the_baseline(db):
    ids = legacy(
        db,
        [
            Old(d.name, t.language, t.preferred, t.forbidden_variants, t.definition, t.case_sensitive)
            for d in BASELINE_DOMAINS
            for t in d.terms
        ],
        domains=[(d.name, None if d.is_global else 1) for d in BASELINE_DOMAINS],
    )
    store = TerminologyStore(db)
    checker = TerminologyChecker(store, nlp=NlpRegistry(NlpSettings().models))
    golden = load_golden()

    for domain in BASELINE_DOMAINS:
        for language in Language:
            findings = checker.check(
                BASELINE_TEXTS[language], language, ids[domain.name], owner_id=1
            )
            actual = normalise([f.model_dump(mode="json") for f in findings])
            assert actual == golden[f"{domain.name}/{language.value}"], (domain.name, language)


def test_migration_waits_for_a_write_of_the_previous_release_and_carries_it_over(pg_database):
    # Without the table lock the migration reads the old value and only waits
    # at the rename, so the updated definition would stay in terms_legacy.
    ids = legacy(pg_database, [Old("Shared", L.EN, "sign in", ["login"], "Old.")])
    outcome: dict = {}

    def start() -> None:
        try:
            outcome["store"] = TerminologyStore(pg_database)
        except Exception as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=start, daemon=True)
    conn = pg_database.raw_connect()
    try:
        conn.execute("UPDATE terms SET definition = ? WHERE id = 1", ("Updated.",))
        worker.start()
        worker.join(timeout=1.0)
        assert worker.is_alive()
        conn.commit()
    finally:
        conn.close()
        if worker.is_alive():
            worker.join(timeout=10)
    assert not worker.is_alive()
    assert "error" not in outcome, outcome
    (concept,) = concepts_in(outcome["store"], ids["Shared"])
    assert concept.sections[0].definition == "Updated."


def test_row_with_an_unknown_language_stops_the_migration_naming_the_row(db):
    legacy(db, [Old("Shared", L.EN, "sign in"), Old("Shared", L.DE, "Anmeldung")])
    with db.connect() as conn:
        conn.execute("UPDATE terms SET language = 'xx' WHERE id = 2")

    with pytest.raises(RuntimeError, match="term row 2 in domain 'Shared'") as raised:
        TerminologyStore(db)
    assert isinstance(raised.value.__cause__, ValueError)
    assert count(db, "terms") == 2
    assert count(db, "concepts") == 0


def test_row_with_a_variant_that_is_not_a_string_stops_the_migration_naming_the_row(db):
    legacy(db, [Old("Shared", L.EN, "sign in"), Old("Mine", L.DE, "Anmeldung", ["Login", 5])])

    with pytest.raises(RuntimeError, match="term row 2 in domain 'Mine'") as raised:
        TerminologyStore(db)
    assert isinstance(raised.value.__cause__, ValueError)
    assert count(db, "terms") == 2
    assert count(db, "concepts") == 0
