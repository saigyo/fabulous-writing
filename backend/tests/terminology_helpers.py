import json
from collections.abc import Sequence

from httpx import Response

from app.core.models import Language
from app.services.terminology import (
    Actor,
    Concept,
    ProcessStatus,
    SectionInput,
    TermInput,
    TerminologyStore,
    UsageStatus,
)

_ADMIN = Actor(user_id=1, is_admin=True)


def add_term(
    store: TerminologyStore,
    domain_id: int,
    *,
    language: Language,
    preferred: str,
    forbidden_variants: Sequence[str] = (),
    definition: str = "",
    case_sensitive: bool = False,
    actor: Actor = _ADMIN,
) -> Concept:
    terms = [
        TermInput(
            text=preferred,
            usage_status=UsageStatus.PREFERRED,
            process_status=ProcessStatus.ACTIVE,
            case_sensitive=case_sensitive,
        )
    ] + [
        TermInput(
            text=variant,
            usage_status=UsageStatus.FORBIDDEN,
            process_status=ProcessStatus.ACTIVE,
            case_sensitive=case_sensitive,
        )
        for variant in forbidden_variants
    ]
    concept = store.create_concept(
        domain_id,
        [SectionInput(language=language, definition=definition, terms=terms)],
        actor=actor,
    )
    assert concept is not None
    return concept


def add_concept(
    store: TerminologyStore,
    domain_id: int,
    *,
    language: Language,
    terms: Sequence[tuple[str, UsageStatus, ProcessStatus] | TermInput],
    definition: str = "",
    actor: Actor = _ADMIN,
) -> Concept:
    inputs = [
        entry
        if isinstance(entry, TermInput)
        else TermInput(text=entry[0], usage_status=entry[1], process_status=entry[2])
        for entry in terms
    ]
    concept = store.create_concept(
        domain_id,
        [SectionInput(language=language, definition=definition, terms=inputs)],
        actor=actor,
    )
    assert concept is not None
    return concept


_CHANGE_COLUMNS = (
    "id, batch, at, user_id, origin, action, concept_id, concept_uid, term_id, term_uid,"
    " term_text, term_language, concept_labels, changes, comment"
)


def changes(db) -> list[dict]:
    with db.connect() as conn:
        rows = conn.execute(
            f"SELECT {_CHANGE_COLUMNS} FROM terminology_changes ORDER BY id"
        ).fetchall()
    names = [name.strip() for name in _CHANGE_COLUMNS.split(",")]
    result = []
    for row in rows:
        entry = {name: row[name] for name in names}
        entry["concept_labels"] = json.loads(entry["concept_labels"])
        entry["changes"] = json.loads(entry["changes"])
        result.append(entry)
    return result


def post_concept(
    client,
    domain_id: int,
    *,
    language: str = "en",
    preferred: str | None = None,
    forbidden: Sequence[str] = (),
    definition: str = "",
    case_sensitive: bool = False,
    headers: dict | None = None,
) -> Response:
    terms = ([_term_body(preferred, "preferred", case_sensitive)] if preferred else []) + [
        _term_body(text, "forbidden", case_sensitive) for text in forbidden
    ]
    section = {"language": language, "definition": definition, "terms": terms}
    return client.post(
        f"/api/domains/{domain_id}/concepts", json={"sections": [section]}, headers=headers
    )


def _term_body(text: str, usage_status: str, case_sensitive: bool) -> dict:
    return {
        "text": text,
        "usage_status": usage_status,
        "process_status": "active",
        "case_sensitive": case_sensitive,
    }
