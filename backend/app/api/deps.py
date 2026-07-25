"""Request identity: one dependency every authenticated route goes through."""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from app.core.auth import InvalidToken

# One message for every authentication failure: which of them occurred is
# not the caller's business.
_UNAUTHENTICATED = "Not authenticated"


@dataclass(frozen=True)
class CurrentUser:
    id: int
    email: str
    display_name: str | None
    tier: str
    is_admin: bool


def get_current_user(request: Request) -> CurrentUser:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, _UNAUTHENTICATED)
    try:
        user_id = request.app.state.token_verifier.verify(token.strip())
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
