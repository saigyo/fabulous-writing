"""Admin user management.

`require_admin` is attached to the ROUTER, not to individual endpoints, so
an admin endpoint added later inherits the check by construction and cannot
be shipped without it.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, require_admin
from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, validate_password
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseUnavailableError,
    SupabaseUserSummary,
)
from app.services.users import DuplicateEmailError, InvalidEmailError, User

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

logger = logging.getLogger(__name__)


class UserCreate(BaseModel):
    # 320 is RFC 5321's ceiling for an address; matches LoginRequest.email
    # in app/api/auth.py.
    email: str = Field(max_length=320)
    # None: local mode -> 422 (a local account with no way to log in makes
    # no sense); supabase mode -> the admin invites the user through
    # Supabase instead of setting a credential directly.
    password: str | None = None
    display_name: str | None = None
    tier: str = "basic"
    is_admin: bool = False

    @field_validator("email")
    @classmethod
    def _reject_blank_email(cls, value: str) -> str:
        # Mirrors LoginRequest._reject_blank_email in app/api/auth.py: an
        # all-whitespace email would otherwise pass this model and reach
        # `UserStore.create_user`, which strips whitespace and would
        # normalize it to ''. Stripping and returning here means this
        # validator and the store agree on the value rather than each
        # re-stripping the other's output.
        stripped = value.strip()
        if not stripped:
            raise ValueError("email must not be empty or whitespace-only")
        return stripped


class UserPatch(BaseModel):
    # display_name is the one field here with a meaningful null (it clears
    # the name), so it alone keeps a plain `| None = None`. The handler
    # tells "explicitly cleared" apart from "omitted" via
    # `model_fields_set`, not by whether the value is None.
    display_name: str | None = None
    tier: str | None = None
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


class AdminUserCreated(User):
    """The create route's response only: `invited` is an event of *this*
    call, not durable user state, so it must never appear on `User` itself
    -- that would leak a permanently-false key into GET /admin/users and
    every other `User` consumer."""

    invited: bool = False


def _store(request: Request):
    return request.app.state.user_store


def _known_tiers(request: Request) -> tuple[str, ...]:
    """Tier names are config-defined (spec §6.1). With no tiers block the
    spec's two default names (§5.1) remain assignable — policy is
    unrestricted for everyone in that state anyway."""
    return tuple(request.app.state.settings.tiers) or ("basic", "premium")


def _validate_tier_name(request: Request, tier: str) -> None:
    known = _known_tiers(request)
    if tier not in known:
        raise HTTPException(422, f"unknown tier '{tier}': must be one of {list(known)}")


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


@router.get("/tiers")
def list_tiers(request: Request) -> list[str]:
    """The tier names assignable through create/patch — the admin UI's
    select options. Names only; tier limits/policy stay config-internal."""
    return list(_known_tiers(request))


def _create_user_local(store, body: UserCreate) -> User:
    return store.create_user(
        body.email,
        body.password,
        display_name=body.display_name,
        tier=body.tier,
        is_admin=body.is_admin,
    )


async def _resolve_after_duplicate_rejection(
    gateway, email: str, exc: SupabaseAuthError, error_code: str
) -> SupabaseUserSummary:
    """A GoTrue duplicate-email rejection from create_user/invite_user is
    ambiguous: it can mean a genuine pre-existing account, but it can also
    mean THIS admin's own earlier attempt already succeeded remotely and
    only the following local step failed transiently -- a retry then lands
    here with the remote identity otherwise permanently stranded (Copilot
    round 3). Mirrors seed_admin's create-or-link fallback: look the email
    up at Supabase and reconcile onto it. Only a real "no such user" is a
    genuine failure.
    """
    try:
        existing = await gateway.get_user_by_email(email)
    except SupabaseAuthError:
        # The lookup itself failed at the gateway -- treated the same as "no
        # such user": fall through to the ORIGINAL rejection below rather
        # than letting this second, unrelated error escape (Copilot round
        # 4). This call runs inside the caller's `except SupabaseAuthError`
        # block, so an unwrapped exception here is not caught by any
        # sibling `except SupabaseUnavailableError` clause at the call site
        # -- it would propagate out of the route as an unhandled 500.
        existing = None
    except SupabaseUnavailableError as unavailable_exc:
        raise HTTPException(503, "Authentication service unavailable") from unavailable_exc
    if existing is None:
        raise HTTPException(422, {"code": error_code}) from exc
    return existing


def _adopt_existing_row(store, existing: User, external_id: str) -> User:
    """Mode-switch: attach `external_id` to a local row that predates (or is
    otherwise unlinked from) supabase mode, instead of colliding with it on
    a fresh `create_user` insert.

    `link_external_id` is the atomic conditional UPDATE (see UserStore) --
    on a False return, re-reading tells "some other request already linked
    THIS subject" (a same-uuid race, treated as success) apart from "linked
    to something else" (a genuine conflict, 409).
    """
    if store.link_external_id(existing.id, external_id):
        linked = store.get_user(existing.id)
        if linked is not None:
            return linked
    relinked = store.get_user(existing.id)
    if relinked is not None and relinked.external_id == external_id:
        return relinked
    raise HTTPException(409, {"code": "duplicate_email"})


@router.post("/users", status_code=201)
async def create_user(
    request: Request, body: UserCreate, actor: CurrentUser = Depends(require_admin)
) -> AdminUserCreated:
    _validate_tier_name(request, body.tier)
    if body.is_admin:
        _guard_admin_creation(request, actor, body.email)
    store = _store(request)
    supabase = request.app.state.settings.auth.mode == "supabase"

    if body.password is None:
        if not supabase:
            raise HTTPException(422, {"code": "password_required"})
        # Pre-check BEFORE the remote call: a row already linked to a
        # Supabase identity is a genuine duplicate and must fail closed
        # without ever inviting a second Supabase account for the same
        # email. An unlinked row is the mode-switch case, handled below.
        existing = store.get_by_email(body.email)
        if existing is not None and existing.external_id is not None:
            raise HTTPException(422, {"code": "duplicate_email"})
        gateway = request.app.state.supabase_gateway
        try:
            external_id = await gateway.invite_user(body.email)
        except SupabaseAuthError as exc:
            existing_identity = await _resolve_after_duplicate_rejection(
                gateway, body.email, exc, "invite_failed"
            )
            if not existing_identity.invite_pending:
                # A real pre-existing Supabase account (e.g. dashboard-
                # created), not this app's own stranded invite: linking it
                # would let its old, operator-unknown password in without
                # ever proving the invitation was accepted. No link, no
                # local row -- the admin must use the CREATE-with-password
                # path (which rotates the credential) instead. This also
                # excludes any OAuth-origin identity without a separate
                # provider check: `invited_at` is only ever set by this
                # app's own `invite_user_by_email` call, an email-based
                # flow, so an OAuth identity's `invite_pending` is always
                # False and lands here too.
                raise HTTPException(422, {"code": "duplicate_email"}) from exc
            external_id = existing_identity.id
        except SupabaseUnavailableError as exc:
            raise HTTPException(503, "Authentication service unavailable") from exc
        # Accepted residual: a transient local failure from this point on
        # (adoption or insert) has already invited a Supabase account/user
        # that this response reports as failed. A compensating deletion is
        # deliberately not attempted -- the admin can re-run the request,
        # which the pre-check above and create_user's duplicate handling
        # both make idempotent.
        if existing is not None:
            user = _adopt_existing_row(store, existing, external_id)
        else:
            try:
                user = store.create_user(
                    body.email,
                    None,
                    display_name=body.display_name,
                    tier=body.tier,
                    is_admin=body.is_admin,
                    external_id=external_id,
                )
            except (DuplicateEmailError, InvalidEmailError) as exc:
                raise HTTPException(422, str(exc)) from exc
        store.record_audit(
            actor_id=actor.id, target_id=user.id, field="invite", new_value=user.email
        )
        return AdminUserCreated(**user.model_dump(), invited=True)

    _check_password_strength(body.password)
    if supabase:
        # Same pre-check-before-remote-call shape as the invite branch above.
        existing = store.get_by_email(body.email)
        if existing is not None and existing.external_id is not None:
            raise HTTPException(422, {"code": "duplicate_email"})
        gateway = request.app.state.supabase_gateway
        rotated = False
        try:
            external_id = await gateway.create_user(body.email, body.password)
        except SupabaseAuthError as exc:
            existing_identity = await _resolve_after_duplicate_rejection(
                gateway, body.email, exc, "create_failed"
            )
            if existing_identity.provider != "email":
                # Unlike the invite branch above, this path has no
                # invite_pending gate to fall back on -- a real Supabase
                # identity at this email that GoTrue's password rotation
                # would happily accept is not necessarily one this app can
                # ever authenticate: SupabaseTokenVerifier rejects any
                # token whose FIRST provider (app_metadata.provider) isn't
                # "email" (setup guide §4), regardless of the credential.
                # Rotating an OAuth-origin identity's password and linking
                # it would mint an admin row that can never log in. Same
                # 422 create_failed the "no matching identity" branch
                # above already returns -- to the caller both are "cannot
                # honor this as a genuine duplicate."
                raise HTTPException(422, {"code": "create_failed"}) from exc
            external_id = existing_identity.id
            # The reconciled UUID belongs to a pre-existing Supabase
            # identity (most likely this admin's own earlier attempt,
            # already created remotely) whose credential was never set to
            # the password just submitted -- create_user() above only sets
            # it on the happy path. Without this, the response is 201 for a
            # password that cannot log in (Copilot round 4). Same
            # 422/503 mapping as the rotation in patch_user, and this runs
            # BEFORE any local row is created or linked below.
            try:
                await gateway.change_password(external_id, body.password)
            except SupabaseAuthError as pw_exc:
                raise HTTPException(422, {"code": "create_failed"}) from pw_exc
            except SupabaseUnavailableError as pw_exc:
                raise HTTPException(503, "Authentication service unavailable") from pw_exc
            rotated = True
        except SupabaseUnavailableError as exc:
            raise HTTPException(503, "Authentication service unavailable") from exc
        # Same accepted residual as the invite branch: no compensating
        # deletion on a local failure after this point.
        if existing is not None:
            user = _adopt_existing_row(store, existing, external_id)
        else:
            try:
                # Supabase owns the credential -- no local hash written,
                # ever: a local hash here would resurrect local login
                # semantics for an account whose password lives with
                # Supabase.
                user = store.create_user(
                    body.email,
                    None,
                    display_name=body.display_name,
                    tier=body.tier,
                    is_admin=body.is_admin,
                    external_id=external_id,
                )
            except (DuplicateEmailError, InvalidEmailError) as exc:
                raise HTTPException(422, str(exc)) from exc
        if rotated:
            # Mirrors patch_user's own rotation (:409): the gateway call
            # above already killed the identity's refresh tokens, but the
            # pre-existing access token is a stateless JWT that keeps
            # verifying locally until password_changed_at moves. Without
            # this, a session issued before the admin's rotation survives
            # its full TTL and now resolves -- via the external_id just
            # written -- to the row this call is creating/adopting.
            store.mark_password_changed(user.id)
    else:
        try:
            # bcrypt stays off the event loop, same rule as login/password
            # change (Task 4).
            user = await run_in_threadpool(_create_user_local, store, body)
        except (DuplicateEmailError, InvalidEmailError) as exc:
            raise HTTPException(422, str(exc)) from exc
    store.record_audit(actor_id=actor.id, target_id=user.id, field="created",
                       new_value=user.email)
    return AdminUserCreated(**user.model_dump())


def _set_password_local(store, user_id: int, password: str) -> None:
    # bcrypt stays off the event loop, same rule as create/login/self-service
    # change (Task 4) -- this runs inside run_in_threadpool below.
    store.set_password(user_id, password)


@router.patch("/users/{user_id}")
async def patch_user(
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
    if body.tier is not None:
        _validate_tier_name(request, body.tier)

    supabase_mode = request.app.state.settings.auth.mode == "supabase"
    if body.password is not None:
        _check_password_strength(body.password)
        if supabase_mode:
            if existing.external_id is None:
                # A row that predates the mode switch (or was created without
                # a Supabase identity) has nothing to rotate: sending
                # user_id=None to GoTrue's admin API would otherwise fail
                # only incidentally, via _execute's (AuthError, ValueError)
                # mapping to a generic 422 -- fail closed here instead, with
                # a code the caller can actually distinguish.
                raise HTTPException(422, {"code": "not_linked"})
            # Rotate at Supabase FIRST, before any local field is touched or
            # audited: a mixed {tier, password} PATCH whose rotation fails
            # must return the error with NO local changes at all, not a
            # partial update that already moved the tier. GoTrue's admin
            # update revokes every outstanding session/refresh token for
            # this user as part of the same call -- there is no separate
            # admin-scoped sign-out endpoint to call afterwards, unlike the
            # self-service change-password flow, which has the caller's own
            # bearer token to hand to /logout.
            gateway = request.app.state.supabase_gateway
            try:
                await gateway.change_password(existing.external_id, body.password)
            except SupabaseAuthError as exc:
                raise HTTPException(422, {"code": "password_reset_failed"}) from exc
            except SupabaseUnavailableError as exc:
                raise HTTPException(503, "Authentication service unavailable") from exc

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
        if supabase_mode:
            # NOT set_password -- no local hash written, ever: a local hash
            # here would resurrect local login semantics for an account
            # whose password lives with Supabase (same invariant create_user
            # states above). The gateway rotation already happened above,
            # before any local field was touched.
            store.mark_password_changed(user_id)
        else:
            await run_in_threadpool(_set_password_local, store, user_id, body.password)
        # Never record password material, not even its length.
        store.record_audit(actor_id=actor.id, target_id=user_id, field="password")
        # Re-fetch: `updated` above was resolved before the password write
        # ran, so it still carries the pre-reset password_changed_at — part
        # of this endpoint's response contract since it returns User directly.
        updated = store.get_user(user_id)
    return updated
