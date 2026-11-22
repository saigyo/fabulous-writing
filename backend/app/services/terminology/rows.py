import uuid
from typing import Any

from app.core.models import Language
from app.services.terminology.model import (
    Concept,
    ConceptTerm,
    LanguageSection,
    PartOfSpeech,
    ProcessStatus,
    SectionInput,
    TermInput,
    UsageStatus,
)

_LANGUAGE_ORDER = {language: position for position, language in enumerate(Language)}


def _marks(count: int) -> str:
    return ", ".join("?" for _ in range(count))


def _term_from_row(row: Any) -> ConceptTerm:
    return ConceptTerm(
        id=row["id"],
        uid=row["uid"],
        text=row["text"],
        usage_status=UsageStatus(row["usage_status"]),
        process_status=ProcessStatus(row["process_status"]),
        status_reason=row["status_reason"],
        context=row["context"],
        source=row["source"],
        part_of_speech=PartOfSpeech(row["part_of_speech"]) if row["part_of_speech"] else None,
        case_sensitive=bool(row["case_sensitive"]),
        revision=row["revision"],
        created_at=row["created_at"],
        created_by=row["created_by"],
        modified_at=row["modified_at"],
        modified_by=row["modified_by"],
    )


def load_concepts(conn: Any, concept_ids: list[int]) -> list[Concept]:
    if not concept_ids:
        return []
    marks = _marks(len(concept_ids))
    concept_rows = conn.execute(
        f"SELECT * FROM concepts WHERE id IN ({marks}) ORDER BY id", tuple(concept_ids)
    ).fetchall()
    link_rows = conn.execute(
        f"SELECT concept_id, domain_id FROM concept_domains WHERE concept_id IN ({marks})"
        " ORDER BY domain_id",
        tuple(concept_ids),
    ).fetchall()
    section_rows = conn.execute(
        f"SELECT * FROM concept_languages WHERE concept_id IN ({marks}) ORDER BY id",
        tuple(concept_ids),
    ).fetchall()
    term_rows = conn.execute(
        "SELECT t.* FROM concept_terms t JOIN concept_languages s ON s.id = t.section_id"
        f" WHERE s.concept_id IN ({marks}) ORDER BY t.id",
        tuple(concept_ids),
    ).fetchall()

    terms_by_section: dict[int, list[ConceptTerm]] = {}
    for row in term_rows:
        terms_by_section.setdefault(row["section_id"], []).append(_term_from_row(row))
    sections_by_concept: dict[int, list[LanguageSection]] = {}
    for row in section_rows:
        sections_by_concept.setdefault(row["concept_id"], []).append(
            LanguageSection(
                id=row["id"],
                language=Language(row["language"]),
                definition=row["definition"],
                revision=row["revision"],
                created_at=row["created_at"],
                created_by=row["created_by"],
                modified_at=row["modified_at"],
                modified_by=row["modified_by"],
                terms=terms_by_section.get(row["id"], []),
            )
        )
    links_by_concept: dict[int, list[int]] = {}
    for row in link_rows:
        links_by_concept.setdefault(row["concept_id"], []).append(row["domain_id"])

    return [
        Concept(
            id=row["id"],
            uid=row["uid"],
            owner_id=row["owner_id"],
            domain_ids=links_by_concept.get(row["id"], []),
            sections=sorted(
                sections_by_concept.get(row["id"], []),
                key=lambda s: _LANGUAGE_ORDER[s.language],
            ),
            revision=row["revision"],
            created_at=row["created_at"],
            created_by=row["created_by"],
            modified_at=row["modified_at"],
            modified_by=row["modified_by"],
        )
        for row in concept_rows
    ]


def load_concept(conn: Any, concept_id: int) -> Concept | None:
    loaded = load_concepts(conn, [concept_id])
    return loaded[0] if loaded else None


def insert_concept(conn: Any, *, owner_id: int | None, now: str | None, user_id: int | None) -> int:
    cursor = conn.execute(
        "INSERT INTO concepts (uid, owner_id, created_at, created_by, modified_at, modified_by)"
        " VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        (str(uuid.uuid4()), owner_id, now, user_id, now, user_id),
    )
    return cursor.fetchone()["id"]


def set_links(conn: Any, concept_id: int, domain_ids: list[int]) -> None:
    existing = {
        row["domain_id"]
        for row in conn.execute(
            "SELECT domain_id FROM concept_domains WHERE concept_id = ?", (concept_id,)
        ).fetchall()
    }
    wanted = set(domain_ids)
    for domain_id in sorted(existing - wanted):
        conn.execute(
            "DELETE FROM concept_domains WHERE concept_id = ? AND domain_id = ?",
            (concept_id, domain_id),
        )
    for domain_id in sorted(wanted - existing):
        conn.execute(
            "INSERT INTO concept_domains (concept_id, domain_id) VALUES (?, ?)",
            (concept_id, domain_id),
        )


def _term_values(term: TermInput) -> tuple:
    return (
        term.text,
        term.usage_status.value,
        term.process_status.value,
        term.status_reason,
        term.context,
        term.source,
        term.part_of_speech.value if term.part_of_speech else "",
        int(term.case_sensitive),
    )


def _current_values(term: ConceptTerm) -> tuple:
    return _term_values(TermInput.from_term(term))


def _insert_term(conn: Any, section_id: int, term: TermInput, now: str | None, user_id: int | None) -> None:
    conn.execute(
        "INSERT INTO concept_terms (uid, section_id, text, usage_status, process_status,"
        " status_reason, context, source, part_of_speech, case_sensitive,"
        " created_at, created_by, modified_at, modified_by)"
        f" VALUES ({_marks(14)})",
        (str(uuid.uuid4()), section_id, *_term_values(term), now, user_id, now, user_id),
    )


def apply_sections(
    conn: Any,
    concept_id: int,
    current: Concept | None,
    sections: list[SectionInput],
    *,
    now: str | None,
    user_id: int | None,
    new_section_ids: dict[Language, int] | None = None,
) -> None:
    current_sections = {s.language: s for s in current.sections} if current else {}
    for given in sections:
        existing = current_sections.get(given.language)
        if not given.terms:
            if existing is not None:
                conn.execute("DELETE FROM concept_languages WHERE id = ?", (existing.id,))
            continue

        if existing is None:
            explicit = (new_section_ids or {}).get(given.language)
            columns = "concept_id, language, definition, created_at, created_by, modified_at, modified_by"
            values: tuple = (
                concept_id, given.language.value, given.definition, now, user_id, now, user_id,
            )
            if explicit is not None:
                columns = "id, " + columns
                values = (explicit, *values)
            section_id = conn.execute(
                f"INSERT INTO concept_languages ({columns}) VALUES ({_marks(len(values))})"
                " RETURNING id",
                values,
            ).fetchone()["id"]
            for term in given.terms:
                _insert_term(conn, section_id, term, now, user_id)
            continue

        current_terms = {t.id: t for t in existing.terms}
        kept_ids = {t.id for t in given.terms if t.id is not None}
        changed = given.definition != existing.definition
        for term_id in sorted(set(current_terms) - kept_ids):
            conn.execute("DELETE FROM concept_terms WHERE id = ?", (term_id,))
            changed = True
        for term in given.terms:
            if term.id is None:
                _insert_term(conn, existing.id, term, now, user_id)
                changed = True
            elif _term_values(term) != _current_values(current_terms[term.id]):
                conn.execute(
                    "UPDATE concept_terms SET text = ?, usage_status = ?, process_status = ?,"
                    " status_reason = ?, context = ?, source = ?, part_of_speech = ?,"
                    " case_sensitive = ?, revision = revision + 1, modified_at = ?, modified_by = ?"
                    " WHERE id = ?",
                    (*_term_values(term), now, user_id, term.id),
                )
                changed = True
        if changed:
            conn.execute(
                "UPDATE concept_languages SET definition = ?, revision = revision + 1,"
                " modified_at = ?, modified_by = ? WHERE id = ?",
                (given.definition, now, user_id, existing.id),
            )


def touch_concept(conn: Any, concept_id: int, *, now: str, user_id: int | None) -> None:
    conn.execute(
        "UPDATE concepts SET revision = revision + 1, modified_at = ?, modified_by = ?"
        " WHERE id = ?",
        (now, user_id, concept_id),
    )


def domain_names(conn: Any, domain_ids: list[int]) -> dict[int, str]:
    if not domain_ids:
        return {}
    rows = conn.execute(
        f"SELECT id, name FROM domains WHERE id IN ({_marks(len(domain_ids))})",
        tuple(domain_ids),
    ).fetchall()
    return {row["id"]: row["name"] for row in rows}
