"""Request identity: one dependency every authenticated route goes through."""

from dataclasses import dataclass
from datetime import datetime

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.auth import InvalidToken

# One message for every authentication failure: which of them occurred is
# not the caller's business.
_UNAUTHENTICATED = "Not authenticated"

# Cheap first line against oversized tokens; LocalTokenVerifier.verify is
# what actually guarantees safety. Sized for the Supabase JWTs the future
# verifier will see (a few KB), not for today's ~208-byte local tokens.
MAX_TOKEN_BYTES = 8192


@dataclass(frozen=True)
class CurrentUser:
    id: int
    email: str
    display_name: str | None
    tier: str
    is_admin: bool


# Declared so the OpenAPI document carries a bearer securityScheme and
# Swagger UI renders its Authorize button. auto_error=False is load-bearing:
# the auto_error=True form raises 403 on a missing header, and every route
# here must answer 401 -- the enforcement test asserts it and the frontend's
# central 401 handler depends on it.
_bearer = HTTPBearer(
    auto_error=False,
    bearerFormat="JWT",
    description=(
        "POST /api/auth/login with your email and password, then paste the "
        "returned `token` here."
    ),
)


def get_current_user(
    request: Request,
    _credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> CurrentUser:
    # _credentials is unused: it exists only so this dependency's signature
    # advertises the bearer scheme to OpenAPI/Swagger. Token extraction below
    # is untouched -- it has its own scheme/emptiness check, latin-1 length
    # cap, and verification, none of which HTTPBearer's own parsing replaces.
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, _UNAUTHENTICATED)
    # Starlette decodes headers as latin-1, so len() already is the wire size.
    if len(token) > MAX_TOKEN_BYTES:
        raise HTTPException(401, _UNAUTHENTICATED)
    try:
        verified = request.app.state.token_verifier.verify(token)
    except InvalidToken:
        raise HTTPException(401, _UNAUTHENTICATED) from None
    # Re-read per request rather than trusting the token's claims: this is
    # what makes deactivation and de-admin effective immediately, without
    # any token revocation machinery.
    user = request.app.state.user_store.get_user(verified.user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, _UNAUTHENTICATED)
    # A password change is the other revocation lever, alongside
    # deactivation above: any token issued before the change is stale, even
    # though it has not expired.
    if verified.epoch is not None:
        # Local tokens always carry an epoch. Equality, not ordering: exact
        # revocation with no clock or granularity coupling.
        if verified.epoch != user.token_epoch:
            raise HTTPException(401, _UNAUTHENTICATED)
    elif user.password_changed_at:
        # The revocation contract for epoch-less verifiers (the future
        # Supabase verifier — pinned in the roadmap's interfaces). Both
        # sides are tz-aware UTC at second granularity (issued_at from
        # fromtimestamp(..., UTC); password_changed_at from _utcnow()),
        # which is what makes the strict `<` correct on both sides of a
        # change, including a replacement token minted in the same second
        # as the change.
        try:
            changed_at = datetime.fromisoformat(user.password_changed_at)
        except ValueError:
            # _utcnow() (users.py) is the only writer today and always
            # produces a parseable value, so this is unreachable in
            # practice — but a hand-edited row or a future migration could
            # introduce a malformed one, the same class core/auth.py's
            # check_password() and its iat guard already treat as "does not
            # match" rather than letting it 500 every request this user
            # makes.
            raise HTTPException(401, _UNAUTHENTICATED) from None
        if changed_at.tzinfo is None:
            # fromisoformat() parses a value like "2026-07-26T09:00:00"
            # successfully, but as a *naive* datetime — comparing it against
            # verified.issued_at (always tz-aware) below would raise
            # TypeError and 500 the request instead of failing closed with
            # the same 401 the ValueError guard above exists to guarantee.
            raise HTTPException(401, _UNAUTHENTICATED)
        if verified.issued_at < changed_at:
            raise HTTPException(401, _UNAUTHENTICATED)
    return CurrentUser(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        tier=user.tier,
        is_admin=user.is_admin,
    )


def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(403, "Admin privileges required")
    return user
