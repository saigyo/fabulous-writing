import pytest

from app.services.db import UniqueViolationError, table_columns
from app.services.terminology import TerminologyStore

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
