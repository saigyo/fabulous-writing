"""Request identity: one dependency every authenticated route goes through."""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from app.core.auth import InvalidToken

# One message for every authentication failure: which of them occurred is
# not the caller's business.
_UNAUTHENTICATED = "Not authenticated"

# A locally issued token is ~208 bytes, so this ceiling is generous by
# comparison — but do not tune it down to fit only today's local tokens:
# the future Supabase verifier will see third-party JWTs carrying user
# metadata that can run to a couple of kilobytes. 8192 still sits far below
# the ~26.7 KB a token needs to drive PyJWT's header-segment json.loads into
# RecursionError (see LocalTokenVerifier.verify in app/core/auth.py, which
# is what actually guarantees that a request can never hit that path — this
# is just the cheap first line that rejects the obviously-oversized case
# before the verifier is even invoked).
MAX_TOKEN_BYTES = 8192


@dataclass(frozen=True)
class CurrentUser:
    id: int
    email: str
    display_name: str | None
    tier: str
    is_admin: bool


def get_current_user(request: Request) -> CurrentUser:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, _UNAUTHENTICATED)
    if len(token.encode("utf-8")) > MAX_TOKEN_BYTES:
        raise HTTPException(401, _UNAUTHENTICATED)
    try:
        user_id = request.app.state.token_verifier.verify(token)
    except InvalidToken:
        raise HTTPException(401, _UNAUTHENTICATED) from None
    # Re-read per request rather than trusting the token's claims: this is
    # what makes deactivation and de-admin effective immediately, without
    # any token revocation machinery.
    user = request.app.state.user_store.get_user(user_id)
    if user is None or not user.is_active:
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
