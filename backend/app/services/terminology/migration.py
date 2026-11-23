import json
import logging
import uuid
from typing import Any

from app.core.models import Language
from app.services.db import table_columns
from app.services.terminology import changes, rows
from app.services.terminology.model import (
    Action,
    Actor,
    Origin,
    ProcessStatus,
    SectionInput,
    TermInput,
    UsageStatus,
)

logger = logging.getLogger(__name__)

LEGACY_TERMS_DDL = """CREATE TABLE terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    language TEXT NOT NULL,
    preferred TEXT NOT NULL,
    forbidden_variants TEXT NOT NULL DEFAULT '[]',
    definition TEXT NOT NULL DEFAULT '',
    case_sensitive INTEGER NOT NULL DEFAULT 0
)"""


def _terms(row: Any) -> list[TermInput]:
    preferred = row["preferred"]
    case_sensitive = bool(row["case_sensitive"])

    def term(text: str, usage: UsageStatus) -> TermInput:
        return TermInput(
            text=text,
            usage_status=usage,
            process_status=ProcessStatus.ACTIVE,
            case_sensitive=case_sensitive,
        )

    variants = json.loads(row["forbidden_variants"])
    if not isinstance(variants, list) or not all(isinstance(v, str) for v in variants):
        raise ValueError("forbidden_variants is not a list of strings")
    terms = [term(preferred, UsageStatus.PREFERRED)] if preferred.strip() else []
    seen: set[str] = set()
    for variant in variants:
        if not variant.strip() or variant in seen:
            continue
        seen.add(variant)
        if variant == preferred:
            logger.warning(
                "domain %r: forbidden variant %r equals its preferred wording; not carried over",
                row["domain_name"], variant,
            )
            continue
        terms.append(term(variant, UsageStatus.FORBIDDEN))
    return terms


def _reserve_legacy_ids(conn: Any) -> None:
    """Move the id allocator of `concept_languages` past every id the old
    table ever gave out. A section must never get the id of an old row that
    was skipped here or deleted earlier: a request still addressing that old
    term would reach an unrelated entry."""
    (legacy_max,) = conn.execute("SELECT max(id) FROM terms").fetchone()
    (section_max,) = conn.execute("SELECT max(id) FROM concept_languages").fetchone()
    if conn.dialect == "postgres":
        (allocated,) = conn.execute(
            "SELECT pg_sequence_last_value(pg_get_serial_sequence('terms', 'id')::regclass)"
        ).fetchone()
    else:
        row = conn.execute("SELECT seq FROM sqlite_sequence WHERE name = 'terms'").fetchone()
        allocated = row[0] if row else None
    high = max(legacy_max or 0, section_max or 0, allocated or 0)
    if not high:
        return
    if conn.dialect == "postgres":
        # RESTART (unlike setval) rolls back with the transaction.
        conn.execute(f"ALTER TABLE concept_languages ALTER COLUMN id RESTART WITH {int(high) + 1}")
    else:
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'concept_languages'")
        conn.execute(
            "INSERT INTO sqlite_sequence (name, seq) VALUES ('concept_languages', ?)", (high,)
        )


def migrate_legacy_terms(conn: Any, *, now: str) -> int:
    """Carry the rows of the old `terms` table over into concepts, then rename
    the table to `terms_legacy`. The rename is the last statement: on SQLite a
    DDL statement issued before the first insert would run outside the
    transaction and survive a failure."""
    if not table_columns(conn, "terms"):
        return 0
    if table_columns(conn, "terms_legacy"):
        raise RuntimeError(
            "tables 'terms' and 'terms_legacy' both exist; the old terms cannot be"
            " migrated. Remove 'terms_legacy' once its data is no longer needed."
        )
    if conn.dialect == "postgres":
        # A write by a still-running previous release would otherwise commit
        # between the read below and the rename and stay in terms_legacy only.
        conn.execute("LOCK TABLE terms IN ACCESS EXCLUSIVE MODE")
    (orphans,) = conn.execute(
        "SELECT count(*) FROM terms WHERE domain_id NOT IN (SELECT id FROM domains)"
    ).fetchone()
    if orphans:
        logger.warning(
            "not migrating %d row(s) of the table 'terms' whose domain no longer exists",
            orphans,
        )
    legacy_rows = conn.execute(
        "SELECT t.*, d.name AS domain_name, d.owner_id FROM terms t"
        " JOIN domains d ON d.id = t.domain_id ORDER BY t.id"
    ).fetchall()
    actor = Actor.system(Origin.MIGRATION)
    created = 0
    for row in legacy_rows:
        try:
            language = Language(row["language"])
            terms = _terms(row)
        except ValueError as exc:
            raise RuntimeError(
                f"term row {row['id']} in domain {row['domain_name']!r} cannot be migrated: {exc}"
            ) from exc
        if not terms:
            logger.warning(
                "domain %r: term row %d has no usable wording; not migrated",
                row["domain_name"], row["id"],
            )
            continue
        concept_id = rows.insert_concept(conn, owner_id=row["owner_id"], now=None, user_id=None)
        rows.set_links(conn, concept_id, [row["domain_id"]])
        rows.apply_sections(
            conn,
            concept_id,
            None,
            [SectionInput(language=language, definition=row["definition"], terms=terms)],
            now=None,
            user_id=None,
            new_section_ids={language: row["id"]},
        )
        concept = rows.load_concept(conn, concept_id)
        entries = changes.diff(
            None,
            concept,
            domain_names={row["domain_id"]: row["domain_name"]},
            initial_action=Action.CARRIED_OVER,
        )
        changes.write(conn, entries, batch=uuid.uuid4().hex, at=now, actor=actor)
        created += 1
    _reserve_legacy_ids(conn)
    conn.execute("ALTER TABLE terms RENAME TO terms_legacy")
    return created
