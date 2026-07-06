from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.core.models import Language
from app.services.profiles import Profile, ProfileStore
from app.services.seed_profiles import standard_defaults

router = APIRouter(prefix="/api", tags=["profiles"])


class ProfileCreate(BaseModel):
    language: Language
    name: str
    categories_off: list[str] = Field(default_factory=list)
    rule_exceptions: list[str] = Field(default_factory=list)
    domain_ids: list[int] = Field(default_factory=list)
    llm_provider: str | None = None
    llm_model: str | None = None
    llm_tier: Literal["quality", "balanced", "cheap", "local"] | None = None
    llm_instructions: str = ""
    example_text: str = ""


class ProfileUpdate(BaseModel):
    name: str
    categories_off: list[str]
    rule_exceptions: list[str]
    domain_ids: list[int]
    llm_provider: str | None
    llm_model: str | None
    llm_tier: Literal["quality", "balanced", "cheap", "local"] | None
    llm_instructions: str
    example_text: str


def _store(request: Request) -> ProfileStore:
    return request.app.state.profile_store


def _pruned(request: Request, language: Language,
            rule_exceptions: list[str], domain_ids: list[int]) -> tuple[list[str], list[int]]:
    known_rules = {
        r.rule_id
        for r in request.app.state.rule_engine.list_rules()
        if r.language == language
    }
    known_domains = {d.id for d in request.app.state.terminology_store.list_domains()}
    return (
        [r for r in rule_exceptions if r in known_rules],
        [d for d in domain_ids if d in known_domains],
    )


@router.get("/profiles")
def list_profiles(request: Request, language: Language) -> list[Profile]:
    return _store(request).list_profiles(language)


@router.post("/profiles", status_code=201)
def create_profile(request: Request, body: ProfileCreate) -> Profile:
    if not body.name.strip():
        raise HTTPException(422, "Profile name must not be empty")
    exceptions, domains = _pruned(
        request, body.language, body.rule_exceptions, body.domain_ids
    )
    try:
        return _store(request).create_profile(
            body.language,
            body.name.strip(),
            categories_off=body.categories_off,
            rule_exceptions=exceptions,
            domain_ids=domains,
            llm_provider=body.llm_provider,
            llm_model=body.llm_model,
            llm_tier=body.llm_tier,
            llm_instructions=body.llm_instructions,
            example_text=body.example_text,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.put("/profiles/{profile_id}")
def update_profile(request: Request, profile_id: int, body: ProfileUpdate) -> Profile:
    store = _store(request)
    current = store.get_profile(profile_id)
    if current is None:
        raise HTTPException(404, "Profile not found")
    if not body.name.strip():
        raise HTTPException(422, "Profile name must not be empty")
    if current.is_standard and body.name.strip() != current.name:
        raise HTTPException(409, "The Standard profile cannot be renamed")
    exceptions, domains = _pruned(
        request, current.language, body.rule_exceptions, body.domain_ids
    )
    try:
        updated = store.update_profile(
            profile_id,
            name=body.name.strip(),
            categories_off=body.categories_off,
            rule_exceptions=exceptions,
            domain_ids=domains,
            llm_provider=body.llm_provider,
            llm_model=body.llm_model,
            llm_tier=body.llm_tier,
            llm_instructions=body.llm_instructions,
            example_text=body.example_text,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    assert updated is not None
    return updated


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(request: Request, profile_id: int) -> Response:
    store = _store(request)
    profile = store.get_profile(profile_id)
    if profile is None:
        raise HTTPException(404, "Profile not found")
    if profile.is_standard:
        raise HTTPException(409, "The Standard profile cannot be deleted")
    store.delete_profile(profile_id)
    return Response(status_code=204)


@router.post("/profiles/{profile_id}/reset")
def reset_profile(request: Request, profile_id: int) -> Profile:
    store = _store(request)
    profile = store.get_profile(profile_id)
    if profile is None:
        raise HTTPException(404, "Profile not found")
    if not profile.is_standard:
        raise HTTPException(409, "Only the Standard profile can be reset")
    settings = request.app.state.settings
    defaults = standard_defaults(profile.language, settings.demos_dir)
    updated = store.update_profile(profile_id, **defaults)
    assert updated is not None
    return updated
