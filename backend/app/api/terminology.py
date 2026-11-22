from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, get_current_user
from app.api.validation import validate_name
from app.core.models import Language
from app.core.permissions import features_for
from app.services.ownership import GlobalReadOnlyError
from app.services.terminology import (
    Actor,
    Concept,
    ConceptTerm,
    Domain,
    LanguageSection,
    ProcessStatus,
    SectionInput,
    TermInput,
    TerminologyRuleError,
    TerminologyStore,
    UsageStatus,
    is_enforced,
)

router = APIRouter(prefix="/api", tags=["terminology"])


class DomainCreate(BaseModel):
    name: str
    description: str = ""


class DomainUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class TermCreate(BaseModel):
    language: Language
    preferred: str
    forbidden_variants: list[str] = Field(default_factory=list)
    definition: str = ""
    case_sensitive: bool = False


class TermUpdate(BaseModel):
    language: Language | None = None
    preferred: str | None = None
    forbidden_variants: list[str] | None = None
    definition: str | None = None
    case_sensitive: bool | None = None


class Term(BaseModel):
    """One language section seen through one domain (spec 9.1); `id` is the section's id."""

    id: int
    domain_id: int
    language: Language
    preferred: str
    forbidden_variants: list[str] = Field(default_factory=list)
    definition: str = ""
    case_sensitive: bool = False


def _store(request: Request) -> TerminologyStore:
    return request.app.state.terminology_store


def _actor(user: CurrentUser) -> Actor:
    return Actor(user_id=user.id, is_admin=user.is_admin)


@contextmanager
def _store_errors() -> Iterator[None]:
    try:
        yield
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    except TerminologyRuleError as exc:
        raise HTTPException(409, str(exc)) from exc


def _clean(variants: list[str], preferred: str) -> list[str]:
    cleaned: list[str] = []
    for variant in variants:
        if variant.strip() and variant != preferred and variant not in cleaned:
            cleaned.append(variant)
    return cleaned


def _new_term(text: str, usage: UsageStatus, case_sensitive: bool) -> TermInput:
    return TermInput(
        text=text,
        usage_status=usage,
        process_status=ProcessStatus.ACTIVE,
        case_sensitive=case_sensitive,
    )


def _preferred_term(section: LanguageSection) -> ConceptTerm | None:
    return next(
        (
            t
            for t in section.terms
            if t.usage_status == UsageStatus.PREFERRED and is_enforced(t.process_status)
        ),
        None,
    )


def _forbidden_texts(section: LanguageSection) -> list[str]:
    return [t.text for t in section.terms if t.usage_status == UsageStatus.FORBIDDEN]


def _as_term(section: LanguageSection, domain_id: int) -> Term | None:
    preferred = _preferred_term(section)
    if preferred is None:
        return None
    return Term(
        id=section.id,
        domain_id=domain_id,
        language=section.language,
        preferred=preferred.text,
        forbidden_variants=_forbidden_texts(section),
        definition=section.definition,
        case_sensitive=preferred.case_sensitive,
    )


def _section(concept: Concept | None, section_id: int) -> LanguageSection | None:
    if concept is None:
        return None
    return next((s for s in concept.sections if s.id == section_id), None)


def _term_in(concept: Concept, language: Language) -> Term:
    section = next(s for s in concept.sections if s.language == language)
    term = _as_term(section, concept.domain_ids[0])
    assert term is not None
    return term


def _updated_terms(
    section: LanguageSection, preferred: ConceptTerm, body: TermUpdate, new_preferred: str
) -> list[TermInput]:
    variants = _clean(
        body.forbidden_variants
        if body.forbidden_variants is not None
        else _forbidden_texts(section),
        new_preferred,
    )
    terms: list[TermInput] = []
    for term in SectionInput.from_section(section).terms:
        is_preferred = term.id == preferred.id
        if (
            not is_preferred
            and term.usage_status == UsageStatus.FORBIDDEN
            and term.text not in variants
        ):
            continue
        update: dict[str, object] = {}
        if is_preferred:
            update["text"] = new_preferred
        if body.case_sensitive is not None:
            update["case_sensitive"] = body.case_sensitive
        terms.append(term.model_copy(update=update))
    kept = {t.text for t in terms if t.usage_status == UsageStatus.FORBIDDEN}
    case_sensitive = (
        body.case_sensitive if body.case_sensitive is not None else preferred.case_sensitive
    )
    return terms + [
        _new_term(variant, UsageStatus.FORBIDDEN, case_sensitive)
        for variant in variants
        if variant not in kept
    ]


@router.get("/domains")
def list_domains(
    request: Request, user: CurrentUser = Depends(get_current_user)
) -> list[Domain]:
    return _store(request).list_domains(owner_id=user.id)


@router.post("/domains", status_code=201)
def create_domain(
    request: Request,
    body: DomainCreate,
    user: CurrentUser = Depends(get_current_user),
) -> Domain:
    if "custom_domains" not in features_for(
        tier=user.tier, is_admin=user.is_admin, settings=request.app.state.settings
    ):
        raise HTTPException(403, "Your plan does not include custom terminology domains")
    try:
        return _store(request).create_domain(
            body.name, body.description, owner_id=user.id
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.put("/domains/{domain_id}")
def update_domain(
    request: Request,
    domain_id: int,
    body: DomainUpdate,
    user: CurrentUser = Depends(get_current_user),
) -> Domain:
    try:
        domain = _store(request).update_domain(
            domain_id,
            owner_id=user.id,
            is_admin=user.is_admin,
            name=body.name,
            description=body.description,
        )
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if domain is None:
        raise HTTPException(404, "Domain not found")
    return domain


@router.delete("/domains/{domain_id}", status_code=204)
def delete_domain(
    request: Request,
    domain_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    try:
        deleted = _store(request).delete_domain(
            domain_id, actor=Actor(user_id=user.id, is_admin=user.is_admin)
        )
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    if not deleted:
        raise HTTPException(404, "Domain not found")
    request.app.state.profile_store.remove_domain_everywhere(domain_id)
    return Response(status_code=204)


@router.get("/domains/{domain_id}/terms")
def list_terms(
    request: Request,
    domain_id: int,
    language: Language | None = None,
    user: CurrentUser = Depends(get_current_user),
) -> list[Term]:
    store = _store(request)
    concepts = store.list_concepts(domain_id, owner_id=user.id)
    order = store.section_ids_by_preferred(domain_id, owner_id=user.id)
    if concepts is None or order is None:
        raise HTTPException(404, "Domain not found")
    terms = {
        section.id: term
        for concept in concepts
        for section in concept.sections
        if language is None or section.language == language
        if (term := _as_term(section, domain_id)) is not None
    }
    return [terms[section_id] for section_id in order if section_id in terms]


@router.post("/domains/{domain_id}/terms", status_code=201)
def create_term(
    request: Request,
    domain_id: int,
    body: TermCreate,
    user: CurrentUser = Depends(get_current_user),
) -> Term:
    if "custom_domains" not in features_for(
        tier=user.tier, is_admin=user.is_admin, settings=request.app.state.settings
    ):
        raise HTTPException(403, "Your plan does not include custom terminology domains")
    store = _store(request)
    preferred = validate_name(body.preferred, message="Preferred term must not be empty")
    terms = [_new_term(preferred, UsageStatus.PREFERRED, body.case_sensitive)] + [
        _new_term(variant, UsageStatus.FORBIDDEN, body.case_sensitive)
        for variant in _clean(body.forbidden_variants, preferred)
    ]
    section = SectionInput(language=body.language, definition=body.definition, terms=terms)
    with _store_errors():
        concept = store.create_concept(domain_id, [section], actor=_actor(user))
    if concept is None:
        raise HTTPException(404, "Domain not found")
    return _term_in(concept, body.language)


@router.put("/terms/{term_id}")
def update_term(
    request: Request,
    term_id: int,
    body: TermUpdate,
    user: CurrentUser = Depends(get_current_user),
) -> Term:
    preferred = body.preferred
    if preferred is not None:
        preferred = validate_name(preferred, message="Preferred term must not be empty")
    store = _store(request)
    concept = store.get_concept_by_section(term_id, owner_id=user.id)
    section = _section(concept, term_id)
    current = _preferred_term(section) if section else None
    if concept is None or section is None or current is None:
        raise HTTPException(404, "Term not found")
    new_preferred = preferred if preferred is not None else current.text
    terms = _updated_terms(section, current, body, new_preferred)
    definition = body.definition if body.definition is not None else section.definition
    language = body.language or section.language
    actor = _actor(user)
    with _store_errors():
        if language == section.language:
            saved = store.save_section(
                concept.id,
                SectionInput(
                    language=language,
                    id=section.id,
                    revision=section.revision,
                    definition=definition,
                    terms=terms,
                ),
                actor=actor,
            )
        else:
            saved = store.save_concept(
                concept.id,
                sections=[
                    SectionInput(
                        language=section.language,
                        id=section.id,
                        revision=section.revision,
                        terms=[],
                    ),
                    SectionInput(
                        language=language,
                        definition=definition,
                        terms=[t.model_copy(update={"id": None}) for t in terms],
                    ),
                ],
                actor=actor,
            )
    if saved is None:
        raise HTTPException(404, "Term not found")
    return _term_in(saved, language)


@router.delete("/terms/{term_id}", status_code=204)
def delete_term(
    request: Request,
    term_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    store = _store(request)
    concept = store.get_concept_by_section(term_id, owner_id=user.id)
    section = _section(concept, term_id)
    if concept is None or section is None:
        raise HTTPException(404, "Term not found")
    actor = _actor(user)
    with _store_errors():
        if len(concept.sections) == 1:
            deleted = store.delete_concept(concept.id, actor=actor)
        else:
            deleted = (
                store.save_section(
                    concept.id,
                    SectionInput(
                        language=section.language,
                        id=section.id,
                        revision=section.revision,
                        terms=[],
                    ),
                    actor=actor,
                )
                is not None
            )
    if not deleted:
        raise HTTPException(404, "Term not found")
    return Response(status_code=204)
