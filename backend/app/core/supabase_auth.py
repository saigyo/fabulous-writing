"""Supabase-mode authentication: configuration and token verification.

Identity only: Supabase authenticates who the caller is; every
authorization decision (is_admin, tier, is_active) stays with the local
users table, so nothing in a Supabase JWT's claims can grant privileges.
"""

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime

import jwt

from app.core.auth import AuthConfigError, IAT_LEEWAY_SECONDS, InvalidToken, VerifiedToken
from app.core.config import Settings
from app.services.users import DuplicateEmailError, User, UserStore

logger = logging.getLogger(__name__)

SUPABASE_PUBLISHABLE_KEY_ENV = "FW_SUPABASE_PUBLISHABLE_KEY"
SUPABASE_SECRET_KEY_ENV = "FW_SUPABASE_SECRET_KEY"


@dataclass(frozen=True)
class SupabaseCredentials:
    url: str              # normalized: no trailing slash
    # repr=False on both keys: the dataclass repr would otherwise put key
    # material into any debug log, --showlocals dump, or exception chain
    # that formats this object.
    publishable_key: str = field(repr=False)  # user-flow GoTrue calls
    secret_key: str = field(repr=False)       # admin API only; never leaves the backend


def resolve_supabase_credentials(
    settings: Settings, env: Mapping[str, str] | None = None
) -> SupabaseCredentials:
    """Fail-closed startup gate for supabase mode.

    Messages name the missing variable, never any value: a config error
    report must not become a credential at rest in a log file.
    """
    supabase = settings.auth.supabase
    if supabase is None or not supabase.url.strip():
        raise AuthConfigError(
            "auth.mode is 'supabase' but auth.supabase.url is not configured"
        )
    environ = os.environ if env is None else env
    publishable = environ.get(SUPABASE_PUBLISHABLE_KEY_ENV, "")
    secret = environ.get(SUPABASE_SECRET_KEY_ENV, "")
    if not publishable:
        raise AuthConfigError(f"{SUPABASE_PUBLISHABLE_KEY_ENV} is unset")
    if not secret:
        raise AuthConfigError(f"{SUPABASE_SECRET_KEY_ENV} is unset")
    return SupabaseCredentials(
        url=supabase.url.strip().rstrip("/"),
        publishable_key=publishable,
        secret_key=secret,
    )


SUPABASE_AUDIENCE = "authenticated"
_JWKS_CACHE_SECONDS = 600  # matches Supabase's own edge-cache guidance


def resolve_supabase_user(
    store: UserStore, *, subject: str, email: str | None
) -> User:
    """Map a verified Supabase subject UUID to the local user row.

    Order matters: external_id first (the common case), then adopt-by-email
    (a pre-Supabase local account logging in through Supabase for the first
    time), then JIT-create (an invited user's first login). An email owned
    by a row already linked to a DIFFERENT subject fails closed — one local
    account never serves two Supabase identities.
    """
    user = store.get_by_external_id(subject)
    if user is not None:
        return user
    if email:
        existing = store.get_by_email(email)
        if existing is not None:
            if existing.external_id is not None:
                raise InvalidToken("email belongs to a different subject")
            linked = store.update_user(existing.id, external_id=subject)
            if linked is None:  # row vanished between the two statements
                raise InvalidToken("adoption race lost")
            return linked
    if not email:
        raise InvalidToken("token carries no email; cannot provision")
    try:
        return store.create_user(email, None, external_id=subject)
    except DuplicateEmailError as exc:  # lost a concurrent-provision race
        raced = store.get_by_external_id(subject)
        if raced is not None:
            return raced
        raise InvalidToken("provisioning race lost") from exc


class SupabaseTokenVerifier:
    """Verifies Supabase-issued JWTs locally (auth.mode: supabase).

    JWKS is fetched lazily on first use and cached (PyJWKClient); a
    misconfigured URL therefore surfaces on the first login attempt, in the
    server log, not at startup — a Supabase outage must not wedge container
    restarts. Requests fail closed (401) until the key set is reachable.
    """

    def __init__(self, url: str, user_store: UserStore, *, jwks_client=None) -> None:
        self._issuer = f"{url}/auth/v1"
        self._store = user_store
        self._jwks = jwks_client or jwt.PyJWKClient(
            f"{url}/auth/v1/.well-known/jwks.json",
            cache_keys=True,
            lifespan=_JWKS_CACHE_SECONDS,
        )

    def verify(self, token: str) -> VerifiedToken:
        try:
            key = self._jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                key.key,
                algorithms=["ES256", "RS256"],  # asymmetric only, never HS256
                issuer=self._issuer,
                audience=SUPABASE_AUDIENCE,
                options={
                    "require": ["sub", "exp", "iat", "iss", "aud"],
                    "verify_iat": False,  # explicit leeway check below
                },
            )
        except (jwt.PyJWTError, RecursionError) as exc:
            # PyJWKClientError (unknown kid, unreachable JWKS) subclasses
            # PyJWTError, so network failure fails closed right here.
            raise InvalidToken(str(exc)) from exc
        # Fail closed on CLAIMS, not on dashboard configuration: the setup
        # guide says to disable anonymous sign-ins and public signup, but a
        # dashboard toggle must never be the only thing standing between a
        # drive-by visitor and a JIT-provisioned local row.
        if claims.get("is_anonymous") is True:
            raise InvalidToken("anonymous tokens are not accepted")
        if claims.get("role") != "authenticated":
            raise InvalidToken("role is not authenticated")
        try:
            issued_at = datetime.fromtimestamp(float(claims["iat"]), UTC)
        except (TypeError, ValueError, OverflowError, OSError) as exc:
            raise InvalidToken("iat is not a usable timestamp") from exc
        if issued_at.timestamp() - datetime.now(UTC).timestamp() > IAT_LEEWAY_SECONDS:
            raise InvalidToken("token issued too far in the future")
        subject = claims["sub"]
        if not isinstance(subject, str) or not subject:
            raise InvalidToken("sub is not a subject id")
        email = claims.get("email")
        if email is not None and not isinstance(email, str):
            raise InvalidToken("email claim is not a string")
        user = resolve_supabase_user(self._store, subject=subject, email=email)
        # epoch=None routes deps.py to its iat-vs-password_changed_at
        # fallback — the revocation contract for this verifier.
        return VerifiedToken(user_id=user.id, issued_at=issued_at, epoch=None)
