import json
from dataclasses import dataclass
from enum import Enum
from typing import Any

from app.services.terminology.model import (
    Action,
    Actor,
    Concept,
    ConceptTerm,
    LanguageSection,
    section_label,
)

TERM_FIELDS = (
    "text", "usage_status", "process_status", "status_reason",
    "context", "source", "part_of_speech", "case_sensitive",
)


@dataclass(frozen=True)
class Entry:
    action: Action
    concept_id: int
    concept_uid: str
    term_id: int | None
    term_uid: str | None
    term_text: str | None
    term_language: str | None
    concept_labels: dict[str, str]
    changes: list[dict]


def _value(term: ConceptTerm, field: str) -> Any:
    value = getattr(term, field)
    if field == "part_of_speech" and value is None:
        return ""
    return value.value if isinstance(value, Enum) else value


def _labels(concept: Concept) -> dict[str, str]:
    return {
        s.language.value: section_label(s) for s in concept.sections if s.terms
    }


def _domain(domain_id: int, names: dict[int, str]) -> dict:
    return {"id": domain_id, "name": names.get(domain_id, "")}


def _whole(
    concept: Concept, action: Action, names: dict[int, str], labels: dict[str, str], *, gone: bool
) -> list[Entry]:
    def change(field: str, value: Any, **extra: Any) -> dict:
        old, new = (value, None) if gone else (None, value)
        return {"field": field, **extra, "old": old, "new": new}

    head = [
        change("definition", s.definition, language=s.language.value) for s in concept.sections
    ] + [change("domain", _domain(d, names)) for d in concept.domain_ids]
    entries = [
        Entry(action, concept.id, concept.uid, None, None, None, None, labels, head)
    ]
    for section in concept.sections:
        for term in sorted(section.terms, key=lambda t: t.id):
            entries.append(Entry(
                action, concept.id, concept.uid, term.id, term.uid, term.text,
                section.language.value, labels,
                [change(f, _value(term, f)) for f in TERM_FIELDS],
            ))
    return entries


def diff(
    before: Concept | None,
    after: Concept | None,
    *,
    domain_names: dict[int, str],
    initial_action: Action = Action.CREATED,
) -> list[Entry]:
    if before is None and after is None:
        return []
    if before is None:
        assert after is not None
        return _whole(after, initial_action, domain_names, _labels(after), gone=False)
    if after is None:
        return _whole(before, Action.DELETED, domain_names, _labels(before), gone=True)

    labels = _labels(after)
    before_sections = {s.language: s for s in before.sections}
    after_sections = {s.language: s for s in after.sections}
    languages = list(after_sections) + [lang for lang in before_sections if lang not in after_sections]

    def entry(action: Action, changes: list[dict], term: ConceptTerm | None = None,
              language: str | None = None) -> Entry:
        return Entry(
            action, after.id, after.uid,
            term.id if term else None, term.uid if term else None,
            term.text if term else None, language, labels, changes,
        )

    entries: list[Entry] = []
    definition_changes = []
    for language in languages:
        old = before_sections[language].definition if language in before_sections else ""
        new = after_sections[language].definition if language in after_sections else ""
        if old != new:
            definition_changes.append(
                {"field": "definition", "language": language.value, "old": old, "new": new}
            )
    if definition_changes:
        entries.append(entry(Action.EDITED, definition_changes))

    for domain_id in sorted(set(before.domain_ids) - set(after.domain_ids)):
        entries.append(entry(Action.REMOVED_FROM_DOMAIN, [
            {"field": "domain", "old": _domain(domain_id, domain_names), "new": None}
        ]))
    for domain_id in sorted(set(after.domain_ids) - set(before.domain_ids)):
        entries.append(entry(Action.ADDED_TO_DOMAIN, [
            {"field": "domain", "old": None, "new": _domain(domain_id, domain_names)}
        ]))

    for language in languages:
        old_section: LanguageSection | None = before_sections.get(language)
        new_section: LanguageSection | None = after_sections.get(language)
        old_terms = {t.id: t for t in old_section.terms} if old_section else {}
        new_terms = {t.id: t for t in new_section.terms} if new_section else {}
        for term_id in sorted(set(old_terms) | set(new_terms)):
            old, new = old_terms.get(term_id), new_terms.get(term_id)
            if old is None:
                entries.append(entry(Action.CREATED, [
                    {"field": f, "old": None, "new": _value(new, f)} for f in TERM_FIELDS
                ], new, language.value))
            elif new is None:
                entries.append(entry(Action.DELETED, [
                    {"field": f, "old": _value(old, f), "new": None} for f in TERM_FIELDS
                ], old, language.value))
            else:
                edits = [
                    {"field": f, "old": _value(old, f), "new": _value(new, f)}
                    for f in TERM_FIELDS if _value(old, f) != _value(new, f)
                ]
                if edits:
                    entries.append(entry(Action.EDITED, edits, new, language.value))
    return entries


def write(
    conn: Any, entries: list[Entry], *, batch: str, at: str, actor: Actor, comment: str = ""
) -> None:
    for e in entries:
        conn.execute(
            "INSERT INTO terminology_changes (batch, at, user_id, origin, action, concept_id,"
            " concept_uid, term_id, term_uid, term_text, term_language, concept_labels, changes,"
            " comment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                batch, at, actor.user_id, actor.origin.value, e.action.value, e.concept_id,
                e.concept_uid, e.term_id, e.term_uid, e.term_text, e.term_language,
                json.dumps(e.concept_labels, ensure_ascii=False),
                json.dumps(e.changes, ensure_ascii=False), comment,
            ),
        )
