from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, get_current_user
from app.api.validation import validate_name
from app.core.models import Language
from app.services.ownership import GlobalReadOnlyError
from app.services.terminology import Domain, Term, TerminologyStore

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


def _store(request: Request) -> TerminologyStore:
    return request.app.state.terminology_store


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
            domain_id, owner_id=user.id, is_admin=user.is_admin
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
    terms = _store(request).list_terms(domain_id, owner_id=user.id, language=language)
    if terms is None:
        raise HTTPException(404, "Domain not found")
    return terms


@router.post("/domains/{domain_id}/terms", status_code=201)
def create_term(
    request: Request,
    domain_id: int,
    body: TermCreate,
    user: CurrentUser = Depends(get_current_user),
) -> Term:
    store = _store(request)
    preferred = validate_name(body.preferred, message="Preferred term must not be empty")
    try:
        term = store.create_term(
            domain_id,
            owner_id=user.id,
            is_admin=user.is_admin,
            language=body.language,
            preferred=preferred,
            forbidden_variants=body.forbidden_variants,
            definition=body.definition,
            case_sensitive=body.case_sensitive,
        )
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    if term is None:
        raise HTTPException(404, "Domain not found")
    return term


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
    try:
        term = _store(request).update_term(
            term_id,
            owner_id=user.id,
            is_admin=user.is_admin,
            language=body.language,
            preferred=preferred,
            forbidden_variants=body.forbidden_variants,
            definition=body.definition,
            case_sensitive=body.case_sensitive,
        )
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    if term is None:
        raise HTTPException(404, "Term not found")
    return term


@router.delete("/terms/{term_id}", status_code=204)
def delete_term(
    request: Request,
    term_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    try:
        deleted = _store(request).delete_term(
            term_id, owner_id=user.id, is_admin=user.is_admin
        )
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    if not deleted:
        raise HTTPException(404, "Term not found")
    return Response(status_code=204)
