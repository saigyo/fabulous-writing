from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.core.models import Language
from app.services.documents import (
    Document,
    DocumentStore,
    DocumentSummary,
    RevisionConflictError,
)

router = APIRouter(prefix="/api", tags=["documents"])

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
def list_documents(request: Request) -> list[DocumentSummary]:
    return _store(request).list_documents()


@router.post("/documents", status_code=201)
def create_document(request: Request, body: DocumentCreate) -> Document:
    if not body.name.strip():
        raise HTTPException(422, "Document name must not be empty")
    return _store(request).create_document(
        body.name.strip(),
        body.language,
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
    )


@router.get("/documents/{document_id}")
def get_document(request: Request, document_id: int) -> Document:
    document = _store(request).get_document(document_id)
    if document is None:
        raise HTTPException(404, "Document not found")
    return document


@router.put("/documents/{document_id}")
def update_document(
    request: Request, document_id: int, body: DocumentUpdate
) -> Document:
    fields: dict[str, object] = {}
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(422, "Document name must not be empty")
        fields["name"] = body.name.strip()
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
            document_id, body.revision, **fields
        )
    except RevisionConflictError as exc:
        raise HTTPException(
            409, f"Stale revision; server is at {exc.current_revision}"
        ) from exc
    if updated is None:
        raise HTTPException(404, "Document not found")
    return updated


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(request: Request, document_id: int) -> Response:
    if not _store(request).delete_document(document_id):
        raise HTTPException(404, "Document not found")
    return Response(status_code=204)
