from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.core.models import Language
from app.services.folders import Folder, FolderDefaults, FolderStore

router = APIRouter(prefix="/api", tags=["folders"])

_MAX_NAME = 100


class FolderPayload(BaseModel):
    name: str


class FolderDefaultsPayload(BaseModel):
    """Complete new defaults state — a full replace, not a merge."""

    default_language: Language | None = None
    default_profile_id: int | None = None
    default_domain_ids: list[int] | None = None
    default_llm_provider: str | None = None
    default_llm_model: str | None = None
    default_llm_tier: Literal["quality", "balanced", "cheap", "local"] | None = None
    default_llm_auto: bool | None = None


def _store(request: Request) -> FolderStore:
    return request.app.state.folder_store


def _validated_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(422, "Folder name must not be empty")
    if len(name) > _MAX_NAME:
        raise HTTPException(422, f"Folder name must be at most {_MAX_NAME} characters")
    return name


def _pruned(request: Request, folder: Folder) -> Folder:
    """Read-time view without dead references (the row keeps its raw values,
    exactly like the documents GET prunes deleted profiles)."""
    update: dict[str, object] = {}
    if folder.default_profile_id is not None:
        profile_store = request.app.state.profile_store
        if profile_store.get_profile(folder.default_profile_id) is None:
            update["default_profile_id"] = None
    if folder.default_domain_ids:
        known = {d.id for d in request.app.state.terminology_store.list_domains()}
        kept = [i for i in folder.default_domain_ids if i in known]
        if len(kept) != len(folder.default_domain_ids):
            update["default_domain_ids"] = kept
    return folder.model_copy(update=update) if update else folder


@router.get("/folders")
def list_folders(request: Request) -> list[Folder]:
    return [_pruned(request, f) for f in _store(request).list_folders()]


@router.post("/folders", status_code=201)
def create_folder(request: Request, body: FolderPayload) -> Folder:
    try:
        return _store(request).create_folder(_validated_name(body.name))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.put("/folders/{folder_id}")
def rename_folder(request: Request, folder_id: int, body: FolderPayload) -> Folder:
    try:
        renamed = _store(request).rename_folder(folder_id, _validated_name(body.name))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if renamed is None:
        raise HTTPException(404, "Folder not found")
    return renamed


@router.put("/folders/{folder_id}/defaults")
def set_folder_defaults(
    request: Request, folder_id: int, body: FolderDefaultsPayload
) -> Folder:
    if body.default_profile_id is not None:
        if body.default_language is None:
            raise HTTPException(
                422, "A profile default requires a language default"
            )
        profile = request.app.state.profile_store.get_profile(
            body.default_profile_id
        )
        if profile is None:
            raise HTTPException(422, "Unknown profile")
        if profile.language != body.default_language:
            raise HTTPException(
                422, "The profile belongs to a different language"
            )
    if body.default_domain_ids:
        known = {d.id for d in request.app.state.terminology_store.list_domains()}
        unknown = [i for i in body.default_domain_ids if i not in known]
        if unknown:
            raise HTTPException(422, f"Unknown domain ids: {unknown}")
    updated = _store(request).set_defaults(
        folder_id, FolderDefaults(**body.model_dump())
    )
    if updated is None:
        raise HTTPException(404, "Folder not found")
    return updated


@router.delete("/folders/{folder_id}", status_code=204)
def delete_folder(request: Request, folder_id: int) -> Response:
    if not _store(request).delete_folder(folder_id):
        raise HTTPException(404, "Folder not found")
    return Response(status_code=204)
