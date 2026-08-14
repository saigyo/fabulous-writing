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
from urllib.parse import urlsplit

import jwt

from app.core.auth import AuthConfigError, IAT_LEEWAY_SECONDS, InvalidToken, VerifiedToken
from app.core.config import Settings
from app.services.users import DuplicateEmailError, User, UserStore

logger = logging.getLogger(__name__)

SUPABASE_PUBLISHABLE_KEY_ENV = "FW_SUPABASE_PUBLISHABLE_KEY"
SUPABASE_SECRET_KEY_ENV = "FW_SUPABASE_SECRET_KEY"

# Loopback hostnames only: what the offline supabase-CLI e2e stack (B27 #94)
# actually binds to. Not a general "private network" allowance -- a plain
# http:// URL anywhere else would send FW_SUPABASE_SECRET_KEY unencrypted.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


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
    url = supabase.url.strip().rstrip("/")
    parsed = urlsplit(url)
    is_loopback_http = parsed.scheme == "http" and parsed.hostname in _LOOPBACK_HOSTS
    if not (parsed.scheme and parsed.netloc) or not (parsed.scheme == "https" or is_loopback_http):
        # The URL itself is not a secret (it's public knowledge — see
        # SupabaseSettings.url) and is safe to echo; only the two
        # FW_SUPABASE_* env vars are credential material.
        raise AuthConfigError(
            f"auth.supabase.url must be an https URL (http allowed only for"
            f" localhost/127.0.0.1/::1, for the offline e2e stack): {url!r}"
        )
    environ = os.environ if env is None else env
    publishable = environ.get(SUPABASE_PUBLISHABLE_KEY_ENV, "")
    secret = environ.get(SUPABASE_SECRET_KEY_ENV, "")
    if not publishable:
        raise AuthConfigError(f"{SUPABASE_PUBLISHABLE_KEY_ENV} is unset")
    if not secret:
        raise AuthConfigError(f"{SUPABASE_SECRET_KEY_ENV} is unset")
    return SupabaseCredentials(
        url=url,
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
    account never serves two Supabase identities. Adoption itself goes
    through `UserStore.link_external_id`'s atomic conditional UPDATE, not a
    plain read-then-write: two concurrent different subjects racing the
    same unlinked row must not let the second write silently overwrite the
    first and bypass the collision guard above.
    """
    user = store.get_by_external_id(subject)
    if user is not None:
        return user
    if email:
        existing = store.get_by_email(email)
        if existing is not None:
            if existing.external_id is not None:
                raise InvalidToken("email belongs to a different subject")
            if store.link_external_id(existing.id, subject):
                linked = store.get_user(existing.id)
                if linked is None:  # pragma: no cover - deleted right after our own update
                    raise InvalidToken("adoption race lost")
                return linked
            # Lost the race: some other request linked this row between our
            # read and our write. If it linked OUR subject, this call is
            # idempotent (e.g. a retried request) and returns the same
            # result it would have on a clean win. Any other subject means
            # the collision guard above simply fired a moment too late.
            raced = store.get_user(existing.id)
            if raced is not None and raced.external_id == subject:
                return raced
            raise InvalidToken("email belongs to a different subject")
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
        except jwt.exceptions.PyJWKClientError as exc:
            # Unreachable JWKS endpoint or unknown kid: also raised for an
            # unknown kid (expected during key rotation, not an outage), but
            # logging both is cheap and an outage is the case this branch
            # exists to surface -- silently folding it into InvalidToken
            # left a real Supabase/network outage indistinguishable from an
            # ordinary bad token, an unexplained wall of 401s with nothing
            # in the log to explain them. Never log the token itself.
            logger.warning("JWKS retrieval failed for %s: %s", self._issuer, exc)
            raise InvalidToken(str(exc)) from exc
        except (jwt.PyJWTError, RecursionError) as exc:
            raise InvalidToken(str(exc)) from exc
        # Fail closed on CLAIMS, not on dashboard configuration: the setup
        # guide says to disable anonymous sign-ins and public signup, but a
        # dashboard toggle must never be the only thing standing between a
        # drive-by visitor and a JIT-provisioned local row.
        if claims.get("is_anonymous") is True:
            raise InvalidToken("anonymous tokens are not accepted")
        if claims.get("role") != "authenticated":
            raise InvalidToken("role is not authenticated")
        # An OAuth/SSO identity (Google, GitHub, SAML, ...) also carries
        # role="authenticated" and is_anonymous=false, so it passes both
        # checks above and would otherwise reach JIT provisioning even with
        # every OAuth provider turned off in the dashboard (setup guide §4)
        # -- a toggle is configuration, not a control this verifier can rely
        # on. `app_metadata` (GoTrue's raw_app_meta_data) is server-controlled
        # and not user-editable, unlike `user_metadata`; its `provider` field
        # names which provider minted this session. `.get("app_metadata", {})`
        # on a missing/non-dict claim yields {} and this falls through to the
        # `!= "email"` branch, so a token with no app_metadata at all is
        # rejected rather than silently passing.
        app_metadata = claims.get("app_metadata")
        if not isinstance(app_metadata, dict):
            app_metadata = {}
        if app_metadata.get("provider") != "email":
            raise InvalidToken("provider is not email")
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
