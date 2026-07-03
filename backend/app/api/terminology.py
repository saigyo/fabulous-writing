from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.core.models import Language
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
def list_domains(request: Request) -> list[Domain]:
    return _store(request).list_domains()


@router.post("/domains", status_code=201)
def create_domain(request: Request, body: DomainCreate) -> Domain:
    return _store(request).create_domain(body.name, body.description)


@router.put("/domains/{domain_id}")
def update_domain(request: Request, domain_id: int, body: DomainUpdate) -> Domain:
    domain = _store(request).update_domain(domain_id, body.name, body.description)
    if domain is None:
        raise HTTPException(404, "Domain not found")
    return domain


@router.delete("/domains/{domain_id}", status_code=204)
def delete_domain(request: Request, domain_id: int) -> Response:
    if not _store(request).delete_domain(domain_id):
        raise HTTPException(404, "Domain not found")
    return Response(status_code=204)


@router.get("/domains/{domain_id}/terms")
def list_terms(
    request: Request, domain_id: int, language: Language | None = None
) -> list[Term]:
    return _store(request).list_terms(domain_id, language=language)


@router.post("/domains/{domain_id}/terms", status_code=201)
def create_term(request: Request, domain_id: int, body: TermCreate) -> Term:
    store = _store(request)
    if store.get_domain(domain_id) is None:
        raise HTTPException(404, "Domain not found")
    return store.create_term(
        domain_id,
        language=body.language,
        preferred=body.preferred,
        forbidden_variants=body.forbidden_variants,
        definition=body.definition,
        case_sensitive=body.case_sensitive,
    )


@router.put("/terms/{term_id}")
def update_term(request: Request, term_id: int, body: TermUpdate) -> Term:
    term = _store(request).update_term(
        term_id,
        language=body.language,
        preferred=body.preferred,
        forbidden_variants=body.forbidden_variants,
        definition=body.definition,
        case_sensitive=body.case_sensitive,
    )
    if term is None:
        raise HTTPException(404, "Term not found")
    return term


@router.delete("/terms/{term_id}", status_code=204)
def delete_term(request: Request, term_id: int) -> Response:
    if not _store(request).delete_term(term_id):
        raise HTTPException(404, "Term not found")
    return Response(status_code=204)
