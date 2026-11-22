import logging
from typing import Any

from app.services.db import DATABASE_URL_ENV, table_columns, verify_schema

logger = logging.getLogger(__name__)

# The literal lives here (not in seed.py) because seed.py imports
# TerminologyStore; importing back would be a cycle. Tied to seed.DOMAIN_NAME
# by test_seed_domain_name_constant_matches_the_seeder.
SEED_DOMAIN_NAME = "Product docs"

SCHEMA = """
CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_id INTEGER
);
CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    owner_id INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT, created_by INTEGER, modified_at TEXT, modified_by INTEGER
);
CREATE TABLE IF NOT EXISTS concept_domains (
    concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    PRIMARY KEY (concept_id, domain_id)
);
CREATE INDEX IF NOT EXISTS idx_concept_domains_domain ON concept_domains(domain_id);
CREATE TABLE IF NOT EXISTS concept_languages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    definition TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT, created_by INTEGER, modified_at TEXT, modified_by INTEGER,
    UNIQUE (concept_id, language)
);
CREATE TABLE IF NOT EXISTS concept_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    section_id INTEGER NOT NULL REFERENCES concept_languages(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    usage_status TEXT NOT NULL,
    process_status TEXT NOT NULL,
    status_reason TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    part_of_speech TEXT NOT NULL DEFAULT '',
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT, created_by INTEGER, modified_at TEXT, modified_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_concept_terms_section ON concept_terms(section_id);
CREATE TABLE IF NOT EXISTS terminology_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch TEXT NOT NULL,
    at TEXT NOT NULL,
    user_id INTEGER,
    origin TEXT NOT NULL,
    action TEXT NOT NULL,
    concept_id INTEGER NOT NULL,
    concept_uid TEXT NOT NULL,
    term_id INTEGER, term_uid TEXT, term_text TEXT, term_language TEXT,
    concept_labels TEXT NOT NULL DEFAULT '{}',
    changes TEXT NOT NULL DEFAULT '[]',
    comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_terminology_changes_concept ON terminology_changes(concept_id);
CREATE INDEX IF NOT EXISTS idx_terminology_changes_term ON terminology_changes(term_id);
"""

# Tables (and post-release columns) this store needs; checked instead of
# created when the app runs without schema management (B36 spec R3).
REQUIRED_SCHEMA: dict[str, list[tuple[str, str]]] = {
    "domains": [("owner_id", "INTEGER")],
    "concepts": [],
    "concept_domains": [],
    "concept_languages": [],
    "concept_terms": [],
    "terminology_changes": [],
}


def verify(conn: Any) -> None:
    verify_schema(conn, REQUIRED_SCHEMA)
    if table_columns(conn, "terms"):
        raise RuntimeError(
            "legacy table 'terms' has not been migrated. Run the 'init-db' manage command"
            f" with an admin {DATABASE_URL_ENV} first."
        )


def migrate_domains(conn: Any) -> None:
    columns = table_columns(conn, "domains")
    if "owner_id" not in columns:
        # One-shot backfill (spec §9 step 3): the seed domain (matched
        # by name — seed.DOMAIN_NAME, asserted equal by a test) becomes
        # global; every other pre-auth row belongs to the admin (id 1).
        conn.execute("ALTER TABLE domains ADD COLUMN owner_id INTEGER")
        conn.execute(
            "UPDATE domains SET owner_id = 1 WHERE name <> ?",
            (SEED_DOMAIN_NAME,),
        )
    # domains never had a uniqueness guarantee, so legal duplicates may
    # exist: pre-scan and skip-with-warning before each partial index.
    owner_dupes = conn.execute(
        "SELECT owner_id, MIN(name) AS name FROM domains WHERE owner_id IS NOT NULL"
        " GROUP BY owner_id, lower(name) HAVING count(*) > 1"
    ).fetchall()
    if owner_dupes:
        logger.warning(
            "domains has per-owner duplicates %s; skipping owner index",
            [tuple(row) for row in owner_dupes],
        )
    else:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_owner_name"
            " ON domains(owner_id, LOWER(name)) WHERE owner_id IS NOT NULL"
        )
    global_dupes = conn.execute(
        "SELECT MIN(name) AS name FROM domains WHERE owner_id IS NULL"
        " GROUP BY lower(name) HAVING count(*) > 1"
    ).fetchall()
    if global_dupes:
        logger.warning(
            "domains has global duplicates %s; skipping global index",
            [tuple(row) for row in global_dupes],
        )
    else:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_global_name"
            " ON domains(LOWER(name)) WHERE owner_id IS NULL"
        )
