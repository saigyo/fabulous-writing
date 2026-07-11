from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.services.folders import Folder, FolderStore

router = APIRouter(prefix="/api", tags=["folders"])

_MAX_NAME = 100


class FolderPayload(BaseModel):
    name: str


def _store(request: Request) -> FolderStore:
    return request.app.state.folder_store


def _validated_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(422, "Folder name must not be empty")
    if len(name) > _MAX_NAME:
        raise HTTPException(422, f"Folder name must be at most {_MAX_NAME} characters")
    return name


@router.get("/folders")
def list_folders(request: Request) -> list[Folder]:
    return _store(request).list_folders()


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


@router.delete("/folders/{folder_id}", status_code=204)
def delete_folder(request: Request, folder_id: int) -> Response:
    if not _store(request).delete_folder(folder_id):
        raise HTTPException(404, "Folder not found")
    return Response(status_code=204)
