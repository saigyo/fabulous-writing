from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator

from app.api.deps import CurrentUser, get_current_user
from app.core.models import Language
from app.core.permissions import features_for
from app.services.ownership import GlobalReadOnlyError
from app.services.terminology import (
    Actor,
    Concept,
    Domain,
    SectionInput,
    TermInput,
    TerminologyConflictError,
    TerminologyRuleError,
    TerminologyStore,
)
from app.services.terminology.model import (
    TransferBasis,
    TransferOutcome,
    TransferOutdatedError,
)

router = APIRouter(prefix="/api", tags=["terminology"])


class DomainCreate(BaseModel):
    name: str
    description: str = ""
    shared: bool = False


class DomainUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ConceptCreate(BaseModel):
    sections: list[SectionInput]
    comment: str = ""


class ConceptSave(BaseModel):
    sections: list[SectionInput] = Field(default_factory=list)
    domain_ids: list[int] | None = None
    revision: int | None = None
    comment: str = ""

    @model_validator(mode="after")
    def _links_need_a_revision(self) -> "ConceptSave":
        if self.domain_ids is not None and self.revision is None:
            raise ValueError("domain_ids needs the revision that was read")
        return self


class SectionSave(BaseModel):
    id: int | None = None
    revision: int | None = None
    definition: str = ""
    terms: list[TermInput]
    comment: str = ""


class MergeRequest(BaseModel):
    target_id: int
    preview: bool = False
    basis: TransferBasis | None = None
    comment: str = ""

    @model_validator(mode="after")
    def _run_needs_a_basis(self) -> "MergeRequest":
        if not self.preview and self.basis is None:
            raise ValueError("a real run needs the basis of its preview")
        return self


class MoveRequest(MergeRequest):
    target_id: int | None


def _store(request: Request) -> TerminologyStore:
    return request.app.state.terminology_store


def _actor(user: CurrentUser) -> Actor:
    return Actor(user_id=user.id, is_admin=user.is_admin)


@contextmanager
def _concept_errors() -> Iterator[None]:
    try:
        yield
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    except TerminologyRuleError as exc:
        detail = {"code": exc.rule, "message": str(exc)}
        if isinstance(exc, TerminologyConflictError):
            detail["part"] = exc.part
        if isinstance(exc, TransferOutdatedError):
            detail["concept_id"] = exc.concept_id
        raise HTTPException(409, detail) from exc


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
    if body.shared and not user.is_admin:
        raise HTTPException(403, "Only admins can create shared domains")
    try:
        return _store(request).create_domain(
            body.name, body.description, owner_id=None if body.shared else user.id
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


def _require_custom_domains(request: Request, user: CurrentUser) -> None:
    if "custom_domains" not in features_for(
        tier=user.tier, is_admin=user.is_admin, settings=request.app.state.settings
    ):
        raise HTTPException(403, "Your plan does not include custom terminology domains")


@router.get("/domains/{domain_id}/concepts")
def list_concepts(
    request: Request, domain_id: int, user: CurrentUser = Depends(get_current_user)
) -> list[Concept]:
    concepts = _store(request).list_concepts(domain_id, owner_id=user.id)
    if concepts is None:
        raise HTTPException(404, "Domain not found")
    return concepts


@router.post("/domains/{domain_id}/concepts", status_code=201)
def create_concept(
    request: Request,
    domain_id: int,
    body: ConceptCreate,
    user: CurrentUser = Depends(get_current_user),
) -> Concept:
    _require_custom_domains(request, user)
    with _concept_errors():
        concept = _store(request).create_concept(
            domain_id, body.sections, actor=_actor(user), comment=body.comment
        )
    if concept is None:
        raise HTTPException(404, "Domain not found")
    return concept


@router.get("/concepts/{concept_id}")
def get_concept(
    request: Request, concept_id: int, user: CurrentUser = Depends(get_current_user)
) -> Concept:
    concept = _store(request).get_concept(concept_id, owner_id=user.id)
    if concept is None:
        raise HTTPException(404, "Concept not found")
    return concept


@router.put("/concepts/{concept_id}")
def save_concept(
    request: Request,
    concept_id: int,
    body: ConceptSave,
    user: CurrentUser = Depends(get_current_user),
) -> Concept:
    with _concept_errors():
        concept = _store(request).save_concept(
            concept_id,
            sections=body.sections,
            domain_ids=body.domain_ids,
            revision=body.revision,
            actor=_actor(user),
            comment=body.comment,
        )
    if concept is None:
        raise HTTPException(404, "Concept not found")
    return concept


@router.put("/concepts/{concept_id}/languages/{language}")
def save_language(
    request: Request,
    concept_id: int,
    language: Language,
    body: SectionSave,
    user: CurrentUser = Depends(get_current_user),
) -> Concept:
    section = SectionInput(
        language=language,
        id=body.id,
        revision=body.revision,
        definition=body.definition,
        terms=body.terms,
    )
    with _concept_errors():
        concept = _store(request).save_section(
            concept_id, section, actor=_actor(user), comment=body.comment
        )
    if concept is None:
        raise HTTPException(404, "Concept not found")
    return concept


@router.delete("/concepts/{concept_id}", status_code=204)
def delete_concept(
    request: Request, concept_id: int, user: CurrentUser = Depends(get_current_user)
) -> Response:
    with _concept_errors():
        deleted = _store(request).delete_concept(concept_id, actor=_actor(user))
    if not deleted:
        raise HTTPException(404, "Concept not found")
    return Response(status_code=204)


@router.delete("/domains/{domain_id}/concepts/{concept_id}", status_code=204)
def remove_concept_from_domain(
    request: Request,
    domain_id: int,
    concept_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    with _concept_errors():
        removed = _store(request).remove_concept_from_domain(
            concept_id, domain_id, actor=_actor(user)
        )
    if not removed:
        raise HTTPException(404, "Concept not found")
    return Response(status_code=204)


@router.post("/concepts/{concept_id}/merge")
def merge_concept(
    request: Request,
    concept_id: int,
    body: MergeRequest,
    user: CurrentUser = Depends(get_current_user),
) -> TransferOutcome:
    with _concept_errors():
        outcome = _store(request).merge_concept(
            concept_id,
            body.target_id,
            basis=body.basis,
            preview=body.preview,
            actor=_actor(user),
            comment=body.comment,
        )
    if outcome is None:
        raise HTTPException(404, "Concept not found")
    return outcome


@router.post("/terms/{term_id}/move")
def move_term(
    request: Request,
    term_id: int,
    body: MoveRequest,
    user: CurrentUser = Depends(get_current_user),
) -> TransferOutcome:
    if body.target_id is None:
        _require_custom_domains(request, user)
    with _concept_errors():
        outcome = _store(request).move_term(
            term_id,
            body.target_id,
            basis=body.basis,
            preview=body.preview,
            actor=_actor(user),
            comment=body.comment,
        )
    if outcome is None:
        raise HTTPException(404, "Term or target concept not found")
    return outcome
