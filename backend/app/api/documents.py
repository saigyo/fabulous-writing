import asyncio
import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, get_current_user
from app.api.llm_gate import get_effective_provider
from app.api.validation import validate_name
from app.checkers.llm.prompts import build_title_prompt
from app.core.models import Language
from app.core.permissions import RequestedLLM
from app.services.documents import (
    Document,
    DocumentStore,
    DocumentSummary,
    RevisionConflictError,
)
from app.services.naming import clean_title, fallback_name

router = APIRouter(prefix="/api", tags=["documents"])

logger = logging.getLogger(__name__)

Tier = Literal["quality", "balanced", "cheap", "local"]


class DocumentCreate(BaseModel):
    name: str
    language: Language
    # 'llm' is server-assigned only; recovered copies are created as 'user'.
    name_source: Literal["fallback", "user"] = "fallback"
    text: str = ""
    profile_id: int | None = None
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_tier: Tier | None = None
    llm_auto: bool = True
    findings: list[dict[str, Any]] = Field(default_factory=list)
    scorecard: dict[str, Any] | None = None
    folder_id: int | None = None


class MoveRequest(BaseModel):
    folder_id: int | None


class DocumentContent(BaseModel):
    # Text and its check-state snapshot travel together by construction, so
    # the stored findings can never describe a different text.
    text: str
    findings: list[dict[str, Any]] = Field(default_factory=list)
    scorecard: dict[str, Any] | None = None


class DocumentSettings(BaseModel):
    language: Language
    profile_id: int | None
    domain_ids: list[int]
    llm_provider: str | None
    llm_model: str | None
    llm_tier: Tier | None
    llm_auto: bool


class DocumentUpdate(BaseModel):
    revision: int
    name: str | None = None
    content: DocumentContent | None = None
    settings: DocumentSettings | None = None


def _store(request: Request) -> DocumentStore:
    return request.app.state.document_store


@router.get("/documents")
def list_documents(
    request: Request, user: CurrentUser = Depends(get_current_user)
) -> list[DocumentSummary]:
    return _store(request).list_documents(owner_id=user.id)


@router.post("/documents", status_code=201)
def create_document(
    request: Request,
    body: DocumentCreate,
    user: CurrentUser = Depends(get_current_user),
) -> Document:
    name = validate_name(body.name, message="Document name must not be empty")
    if body.folder_id is not None:
        if (
            request.app.state.folder_store.get_folder(
                body.folder_id, owner_id=user.id
            )
            is None
        ):
            raise HTTPException(422, "Unknown folder")
    return _store(request).create_document(
        name,
        body.language,
        owner_id=user.id,
        name_source=body.name_source,
        text=body.text,
        profile_id=body.profile_id,
        domain_ids=body.domain_ids,
        llm_provider=body.llm_provider,
        llm_model=body.llm_model,
        llm_tier=body.llm_tier,
        llm_auto=body.llm_auto,
        last_findings=body.findings,
        scorecard=body.scorecard,
        folder_id=body.folder_id,
    )


@router.get("/documents/{document_id}")
def get_document(
    request: Request,
    document_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Document:
    document = _store(request).get_document(document_id, owner_id=user.id)
    if document is None:
        raise HTTPException(404, "Document not found")
    if document.profile_id is not None:
        profile_store = request.app.state.profile_store
        if profile_store.get_profile(document.profile_id, owner_id=user.id) is None:
            # The referenced profile was deleted: present a read-time view
            # with no profile rather than a dangling id. This is not
            # persisted — the DB keeps the raw value.
            return document.model_copy(update={"profile_id": None})
    return document


@router.put("/documents/{document_id}")
def update_document(
    request: Request,
    document_id: int,
    body: DocumentUpdate,
    user: CurrentUser = Depends(get_current_user),
) -> Document:
    fields: dict[str, object] = {}
    if body.name is not None:
        fields["name"] = validate_name(
            body.name, message="Document name must not be empty"
        )
        fields["name_source"] = "user"
    if body.content is not None:
        fields["text"] = body.content.text
        fields["last_findings"] = body.content.findings
        fields["scorecard"] = body.content.scorecard
    if body.settings is not None:
        fields["language"] = body.settings.language
        fields["profile_id"] = body.settings.profile_id
        fields["domain_ids"] = body.settings.domain_ids
        fields["llm_provider"] = body.settings.llm_provider
        fields["llm_model"] = body.settings.llm_model
        fields["llm_tier"] = body.settings.llm_tier
        fields["llm_auto"] = body.settings.llm_auto
    try:
        updated = _store(request).update_document(
            document_id, body.revision, owner_id=user.id, **fields
        )
    except RevisionConflictError as exc:
        raise HTTPException(
            409, f"Stale revision; server is at {exc.current_revision}"
        ) from exc
    if updated is None:
        raise HTTPException(404, "Document not found")
    return updated


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(
    request: Request,
    document_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    if not _store(request).delete_document(document_id, owner_id=user.id):
        raise HTTPException(404, "Document not found")
    return Response(status_code=204)


@router.post("/documents/{document_id}/move")
def move_document(
    request: Request,
    document_id: int,
    body: MoveRequest,
    user: CurrentUser = Depends(get_current_user),
) -> Document:
    if body.folder_id is not None:
        if (
            request.app.state.folder_store.get_folder(
                body.folder_id, owner_id=user.id
            )
            is None
        ):
            raise HTTPException(422, "Unknown folder")
    moved = _store(request).set_folder(document_id, body.folder_id, owner_id=user.id)
    if moved is None:
        raise HTTPException(404, "Document not found")
    return moved


@router.post("/documents/{document_id}/generate-name")
async def generate_name(
    request: Request,
    document_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Document:
    owner_id = user.id
    store = _store(request)
    document = store.get_document(document_id, owner_id=owner_id)
    if document is None:
        raise HTTPException(404, "Document not found")
    if document.name_source != "fallback":
        return document  # titled or user-named: never auto-touched again

    title: str | None = None
    # Empty text never reaches the gate: no provider gets constructed for a
    # document that will not generate -- and once M5 adds reservation to the
    # gate, an empty document must not consume quota either.
    if document.text.strip():
        try:
            # Acquisition sits INSIDE the fallback try: naming is silent-
            # fallback for any failure (spec §7.2), including a provider
            # constructor raising something get_effective_provider does not
            # translate (a tier-only request cannot produce its 422).
            requested = RequestedLLM(tier="cheap")  # naming hard-selects the cheap route
            _effective, provider, reservation = await get_effective_provider(
                request.app, user, requested, document.language.value,
                text_chars=len(document.text), source="name", run_id=str(uuid.uuid4()),
            )
            if provider is not None:
                assert reservation is not None
                name_status = "completed"
                try:
                    system, prompt = build_title_prompt(document.text, document.language)
                    title = clean_title(await provider.generate(system, prompt))
                except asyncio.CancelledError:
                    name_status = "cancelled"
                    raise
                except Exception:
                    name_status = "failed"
                    raise
                finally:
                    reservation.finish(name_status)
        except HTTPException:
            # The gate's own 429 (concurrency cap) applies to every LLM-
            # invoking endpoint alike (spec §7.2) and must propagate, not be
            # swallowed by naming's silent-fallback behavior below.
            raise
        except Exception:
            logger.warning(
                "auto-title generation failed for document %s",
                document_id,
                exc_info=True,
            )
            title = None  # silent per spec; the fallback below still applies

    if title:
        named = store.set_name(
            document_id, title, "llm", owner_id=owner_id, only_if_source="fallback"
        )
    else:
        fallback = fallback_name(document.text)
        if fallback is None:
            return document  # empty text: keep the localized Untitled
        named = store.set_name(
            document_id,
            fallback,
            "fallback",
            owner_id=owner_id,
            only_if_source="fallback",
        )
    assert named is not None
    return named
