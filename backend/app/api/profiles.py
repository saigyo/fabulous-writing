from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser, get_current_user
from app.api.validation import validate_name
from app.core.models import Language
from app.core.permissions import features_for
from app.services.ownership import GlobalReadOnlyError
from app.services.profiles import Profile, ProfileStore
from app.services.seed_profiles import standard_defaults

router = APIRouter(prefix="/api", tags=["profiles"])


class ProfileCreate(BaseModel):
    language: Language
    name: str
    categories_off: list[str] = Field(default_factory=list)
    rule_exceptions: list[str] = Field(default_factory=list)
    packs_on: list[str] = Field(default_factory=list)
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
    packs_on: list[str]
    domain_ids: list[int]
    llm_provider: str | None
    llm_model: str | None
    llm_tier: Literal["quality", "balanced", "cheap", "local"] | None
    llm_instructions: str
    example_text: str


def _store(request: Request) -> ProfileStore:
    return request.app.state.profile_store


def _pruned(request: Request, language: Language,
            rule_exceptions: list[str], domain_ids: list[int],
            *, owner_id: int) -> tuple[list[str], list[int]]:
    known_rules = {
        r.rule_id
        for r in request.app.state.rule_engine.list_rules()
        if r.language == language
    }
    known_domains = {
        d.id
        for d in request.app.state.terminology_store.list_domains(owner_id=owner_id)
    }
    return (
        [r for r in rule_exceptions if r in known_rules],
        [d for d in domain_ids if d in known_domains],
    )


@router.get("/profiles")
def list_profiles(
    request: Request,
    language: Language,
    user: CurrentUser = Depends(get_current_user),
) -> list[Profile]:
    return _store(request).list_profiles(language, owner_id=user.id)


@router.post("/profiles", status_code=201)
def create_profile(
    request: Request,
    body: ProfileCreate,
    user: CurrentUser = Depends(get_current_user),
) -> Profile:
    if "custom_profiles" not in features_for(
        tier=user.tier, is_admin=user.is_admin, settings=request.app.state.settings
    ):
        raise HTTPException(403, "Your plan does not include custom profiles")
    name = validate_name(body.name, message="Profile name must not be empty")
    exceptions, domains = _pruned(
        request, body.language, body.rule_exceptions, body.domain_ids,
        owner_id=user.id,
    )
    try:
        return _store(request).create_profile(
            body.language,
            name,
            owner_id=user.id,
            categories_off=body.categories_off,
            rule_exceptions=exceptions,
            packs_on=body.packs_on,
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
def update_profile(
    request: Request,
    profile_id: int,
    body: ProfileUpdate,
    user: CurrentUser = Depends(get_current_user),
) -> Profile:
    store = _store(request)
    current = store.get_profile(profile_id, owner_id=user.id)
    if current is None:
        raise HTTPException(404, "Profile not found")
    # As in delete: the rename-guard 409 only fires for callers who may
    # mutate the row at all — a non-admin blocked from a global row gets
    # 403 first, not a business-rule 409 about the rename itself.
    if current.is_global and not user.is_admin:
        raise HTTPException(403, "Only admins can change built-in items")
    name = validate_name(body.name, message="Profile name must not be empty")
    if current.is_standard and name != current.name:
        raise HTTPException(409, "The Standard profile cannot be renamed")
    exceptions, domains = _pruned(
        request, current.language, body.rule_exceptions, body.domain_ids,
        owner_id=user.id,
    )
    try:
        updated = store.update_profile(
            profile_id,
            owner_id=user.id,
            is_admin=user.is_admin,
            name=name,
            categories_off=body.categories_off,
            rule_exceptions=exceptions,
            packs_on=body.packs_on,
            domain_ids=domains,
            llm_provider=body.llm_provider,
            llm_model=body.llm_model,
            llm_tier=body.llm_tier,
            llm_instructions=body.llm_instructions,
            example_text=body.example_text,
        )
    # Unreachable given the pre-check above; a safety net in case a future
    # refactor removes it, matching the other routers' guard idiom.
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    assert updated is not None
    return updated


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(
    request: Request,
    profile_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Response:
    store = _store(request)
    profile = store.get_profile(profile_id, owner_id=user.id)
    if profile is None:
        raise HTTPException(404, "Profile not found")
    # The is_standard 409 only fires for callers who may mutate the row at
    # all: a non-admin blocked from touching a global row gets 403, not a
    # business-rule 409 about a mutation they were never going to make.
    if profile.is_global and not user.is_admin:
        raise HTTPException(403, "Only admins can change built-in items")
    if profile.is_standard:
        raise HTTPException(409, "The Standard profile cannot be deleted")
    try:
        store.delete_profile(profile_id, owner_id=user.id, is_admin=user.is_admin)
    # Unreachable given the pre-check above; a safety net in case a future
    # refactor removes it, matching the other routers' guard idiom.
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    return Response(status_code=204)


@router.post("/profiles/{profile_id}/reset")
def reset_profile(
    request: Request,
    profile_id: int,
    user: CurrentUser = Depends(get_current_user),
) -> Profile:
    store = _store(request)
    profile = store.get_profile(profile_id, owner_id=user.id)
    if profile is None:
        raise HTTPException(404, "Profile not found")
    # As in update/delete: the global-mutation guard fires before the
    # is-Standard business rule, so a non-admin resetting any global profile
    # (Standard or not) gets 403, never a 409 about a reset they were never
    # going to be allowed to make.
    if profile.is_global and not user.is_admin:
        raise HTTPException(403, "Only admins can change built-in items")
    if not profile.is_standard:
        raise HTTPException(409, "Only the Standard profile can be reset")
    settings = request.app.state.settings
    defaults = standard_defaults(profile.language, settings.demos_dir)
    try:
        updated = store.update_profile(
            profile_id, owner_id=user.id, is_admin=user.is_admin, **defaults
        )
    # Unreachable given the pre-check above; a safety net in case a future
    # refactor removes it, matching the other routers' guard idiom.
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
    assert updated is not None
    return updated
