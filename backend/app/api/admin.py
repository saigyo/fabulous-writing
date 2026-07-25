"""Admin user management.

`require_admin` is attached to the ROUTER, not to individual endpoints, so
an admin endpoint added later inherits the check by construction and cannot
be shipped without it.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator

from app.api.deps import CurrentUser, require_admin
from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, validate_password
from app.services.users import DuplicateEmailError, User

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

logger = logging.getLogger(__name__)


# Validated here rather than with a DB CHECK constraint: tiers are policy
# data (M4 moves their definition into config.yaml), and SQLite cannot alter
# a CHECK without a full table rebuild — so a constraint would make adding a
# tier a migration. M4 replaces this Literal with validation against the
# configured tier names.
TierName = Literal["basic", "premium"]


class UserCreate(BaseModel):
    email: str
    password: str
    display_name: str | None = None
    tier: TierName = "basic"
    is_admin: bool = False


class UserPatch(BaseModel):
    # display_name is the one field here with a meaningful null (it clears
    # the name), so it alone keeps a plain `| None = None`. The handler
    # tells "explicitly cleared" apart from "omitted" via
    # `model_fields_set`, not by whether the value is None.
    display_name: str | None = None
    tier: TierName | None = None
    is_admin: bool | None = None
    is_active: bool | None = None
    # None means "don't change the password" whether the field was omitted
    # or explicitly sent as null — there is no "clear the password" action.
    password: str | None = None

    @field_validator("tier", "is_admin", "is_active")
    @classmethod
    def _reject_explicit_null(cls, value: object, info) -> object:
        # This only fires when the field was submitted explicitly: Pydantic
        # skips validators for an omitted field's default entirely
        # (validate_default=False, the library default), so `value is None`
        # here can only mean the caller sent `"<field>": null` in the body.
        # Unlike display_name, none of these three has a meaningful
        # "cleared" state — an explicit null is malformed input, not a
        # silent no-op, so it is rejected here (422) rather than in the
        # handler, symmetric with how an unrecognised tier is already
        # rejected by the Literal type at the same layer.
        if value is None:
            raise ValueError(f"{info.field_name} must not be null")
        return value


def _store(request: Request):
    return request.app.state.user_store


def _check_password_strength(password: str) -> None:
    try:
        validate_password(password, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _guard_admin_creation(request: Request, actor: CurrentUser, target_email: str) -> None:
    """With the switch off, no API call may mint an admin.

    A stolen admin session can do damage until the account is deactivated or
    its password rotated — but it must not be able to create a *second*
    admin that survives that response. The switch is config-only for exactly
    that reason.
    """
    if request.app.state.settings.auth.allow_additional_admins:
        return
    logger.warning(
        "Denied admin grant for %s by user %s: auth.allow_additional_admins is off",
        target_email,
        actor.id,
    )
    raise HTTPException(403, "Creating additional admins is disabled")


@router.get("/users")
def list_users(request: Request) -> list[User]:
    return _store(request).list_users()


@router.post("/users", status_code=201)
def create_user(
    request: Request, body: UserCreate, actor: CurrentUser = Depends(require_admin)
) -> User:
    _check_password_strength(body.password)
    if body.is_admin:
        _guard_admin_creation(request, actor, body.email)
    store = _store(request)
    try:
        user = store.create_user(
            body.email,
            body.password,
            display_name=body.display_name,
            tier=body.tier,
            is_admin=body.is_admin,
        )
    except DuplicateEmailError as exc:
        raise HTTPException(422, str(exc)) from exc
    store.record_audit(actor_id=actor.id, target_id=user.id, field="created",
                       new_value=user.email)
    return user


@router.patch("/users/{user_id}")
def patch_user(
    request: Request,
    user_id: int,
    body: UserPatch,
    actor: CurrentUser = Depends(require_admin),
) -> User:
    store = _store(request)
    existing = store.get_user(user_id)
    if existing is None:
        raise HTTPException(404, "User not found")

    if user_id == actor.id and (body.is_admin is False or body.is_active is False):
        # Prevents an ordinary mistake from bricking the deployment. The
        # deliberate version of this action lives in the operator CLI.
        raise HTTPException(409, "An admin cannot remove their own access")
    if body.is_admin and not existing.is_admin:
        _guard_admin_creation(request, actor, existing.email)

    # `model_fields_set` (not "value is not None") decides what was
    # actually submitted: display_name can be explicitly cleared to null,
    # so inferring "provided" from non-None would silently no-op a
    # `{"display_name": null}` request — a 200 that changes nothing and
    # writes no audit row. tier/is_admin/is_active can never be None here:
    # UserPatch._reject_explicit_null already turned an explicit null for
    # those into a 422 before this handler ran.
    changes = {
        name: getattr(body, name)
        for name in ("display_name", "tier", "is_admin", "is_active")
        if name in body.model_fields_set and getattr(body, name) != getattr(existing, name)
    }
    updated = store.update_user(user_id, **changes) if changes else existing
    for name, value in changes.items():
        store.record_audit(
            actor_id=actor.id,
            target_id=user_id,
            field=name,
            old_value=str(getattr(existing, name)),
            new_value=str(value),
        )
    if body.password is not None:
        _check_password_strength(body.password)
        store.set_password(user_id, body.password)
        # Never record password material, not even its length.
        store.record_audit(actor_id=actor.id, target_id=user_id, field="password")
    return updated
