"""Server-side Supabase Auth gateway (auth.mode: supabase).

Every method builds its own short-lived GoTrue client around a fresh
httpx.AsyncClient: seed_admin and create_app's startup provider check
(app/main.py) both drive this from their own event loop via `run_sync`
below, so no connection pool may outlive one operation. Auth operations are
rare; the per-call handshake is irrelevant next to bcrypt.
"""

import asyncio
import concurrent.futures
import logging
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
from supabase_auth import AsyncGoTrueAdminAPI, AsyncGoTrueClient
from supabase_auth.errors import AuthError, AuthRetryableError, AuthWeakPasswordError
from supabase_auth.types import Session

from app.core.supabase_auth import SupabaseCredentials

logger = logging.getLogger(__name__)


def run_sync(coro: Coroutine[Any, Any, Any]) -> Any:
    """Runs a single gateway coroutine to completion from synchronous
    startup code (seed_admin's bootstrap, create_app's provider-policy
    check) -- shared so both sites make the same loop decision.

    uvicorn imports the app from inside its own already-running event loop
    (import_from_string during Server.serve), where asyncio.run() raises.
    A private loop on a worker thread is safe there: every gateway method
    builds its own per-operation httpx client (module docstring above), so
    no client or connection pool crosses loops.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


@dataclass(frozen=True)
class SupabaseSession:
    access_token: str
    refresh_token: str
    expires_at: int | None  # epoch seconds
    user_id: str  # Supabase UUID
    email: str | None


@dataclass(frozen=True)
class SupabaseUserSummary:
    """A GoTrue admin user, reduced to what reconciliation needs to decide
    whether an email match proves a pending invitation was accepted rather
    than an unrelated pre-existing account (e.g. dashboard-created)."""

    id: str
    # True only for an identity this app's own invite flow created and that
    # has not yet been accepted: GoTrue sets `invited_at` when
    # admin.invite_user_by_email mints the identity, and clears it to a
    # sign-in only via `last_sign_in_at` once the invitee actually logs in
    # -- `invited_at` itself is never cleared. An account created any other
    # way (admin.create_user, the Supabase dashboard, a direct signup) has
    # `invited_at` unset, so it reads as NOT pending regardless of
    # `last_sign_in_at`.
    invite_pending: bool
    # The provider that minted this identity ("email", "google", ...), read
    # from the admin user object's `app_metadata.provider` -- the same
    # server-controlled field SupabaseTokenVerifier checks per-token
    # (app/core/supabase_auth.py). None if the field is absent, which
    # reconciliation callers must treat the same as "not email": a missing
    # value proves nothing.
    provider: str | None = None


class SupabaseAuthError(Exception):
    """Invalid credentials, token, or link."""


class SupabaseWeakPasswordError(SupabaseAuthError):
    """GoTrue rejected a password on strength grounds (error_code
    weak_password): dashboard length/character rules or leaked-password
    detection. `reasons` carries GoTrue's vocabulary (length, characters,
    pwned) and may be empty when GoTrue omits it."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("password rejected as too weak")
        self.reasons = reasons


class SupabaseEmailExistsError(SupabaseAuthError):
    """GoTrue's email_exists: the identity is confirmed/active. The one
    auth failure the resend route may honestly report as already_active."""


class SupabaseUnavailableError(Exception):
    """Network failure, 5xx, or timeout talking to Supabase."""


def _to_session(session: Session) -> SupabaseSession:
    return SupabaseSession(
        access_token=session.access_token,
        refresh_token=session.refresh_token,
        expires_at=session.expires_at,
        user_id=session.user.id,
        email=session.user.email,
    )


class SupabaseAuthGateway:
    """Thin async wrapper over supabase_auth's GoTrue clients.

    `transport` is test-only: it is threaded into every per-operation
    httpx.AsyncClient this gateway builds, letting tests exercise the real
    library against httpx.MockTransport instead of the network.
    """

    def __init__(
        self,
        credentials: SupabaseCredentials,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._credentials = credentials
        self._transport = transport
        self._auth_url = f"{credentials.url}/auth/v1"

    @asynccontextmanager
    async def _user_client(self) -> AsyncIterator[AsyncGoTrueClient]:
        async with httpx.AsyncClient(transport=self._transport) as http_client:
            yield AsyncGoTrueClient(
                url=self._auth_url,
                headers={
                    "apikey": self._credentials.publishable_key,
                    "Authorization": f"Bearer {self._credentials.publishable_key}",
                },
                http_client=http_client,
                persist_session=False,
                auto_refresh_token=False,
            )

    @asynccontextmanager
    async def _admin_client(self) -> AsyncIterator[AsyncGoTrueAdminAPI]:
        async with httpx.AsyncClient(transport=self._transport) as http_client:
            yield AsyncGoTrueAdminAPI(
                url=self._auth_url,
                headers={
                    "apikey": self._credentials.secret_key,
                    "Authorization": f"Bearer {self._credentials.secret_key}",
                },
                http_client=http_client,
            )

    async def _execute(self, operation: str, coro: Coroutine[Any, Any, Any]) -> Any:
        """Runs a single GoTrue call, mapping its errors to our four types:
        SupabaseUnavailableError, SupabaseWeakPasswordError,
        SupabaseEmailExistsError, SupabaseAuthError.

        Order is load-bearing: AuthRetryableError is itself an AuthError, so
        it must be caught before the generic AuthError branch, or a
        retryable/unavailable condition would be misreported as an auth
        failure. The weak-password and email-exists catches must likewise
        precede the generic AuthError branch, or they'd be swallowed as a
        plain SupabaseAuthError.
        """
        try:
            return await coro
        except AuthRetryableError as exc:
            logger.error("supabase gateway: %s unavailable (retryable)", operation)
            raise SupabaseUnavailableError(str(exc)) from exc
        except httpx.HTTPError as exc:
            logger.error("supabase gateway: %s unavailable (transport)", operation)
            raise SupabaseUnavailableError(str(exc)) from exc
        except AuthWeakPasswordError as exc:
            # fact 1: exc.reasons may be a dict ({}) when GoTrue omits
            # reasons -- coerce anything non-list.
            reasons = exc.reasons if isinstance(exc.reasons, list) else []
            raise SupabaseWeakPasswordError(reasons) from exc
        except (AuthError, ValueError) as exc:
            logger.debug("supabase gateway: %s rejected: %s", operation, exc)
            if getattr(exc, "code", None) == "email_exists":
                raise SupabaseEmailExistsError(str(exc)) from exc
            raise SupabaseAuthError(str(exc)) from exc

    async def sign_in(self, email: str, password: str) -> SupabaseSession:
        async def call() -> SupabaseSession:
            async with self._user_client() as client:
                response = await client.sign_in_with_password(
                    {"email": email, "password": password}
                )
                return _to_session(response.session)

        return await self._execute("sign_in", call())

    async def refresh(self, refresh_token: str) -> SupabaseSession:
        async def call() -> SupabaseSession:
            async with self._user_client() as client:
                response = await client.refresh_session(refresh_token)
                return _to_session(response.session)

        return await self._execute("refresh", call())

    async def sign_out(self, access_token: str) -> None:
        async def call() -> None:
            async with self._admin_client() as admin:
                await admin.sign_out(access_token, "local")

        await self._execute("sign_out", call())

    async def global_sign_out(self, access_token: str) -> None:
        async def call() -> None:
            async with self._admin_client() as admin:
                await admin.sign_out(access_token, "global")

        await self._execute("global_sign_out", call())

    async def change_password(self, user_id: str, new_password: str) -> None:
        async def call() -> None:
            async with self._admin_client() as admin:
                await admin.update_user_by_id(user_id, {"password": new_password})

        await self._execute("change_password", call())

    async def send_reset_email(self, email: str) -> None:
        async def call() -> None:
            async with self._user_client() as client:
                await client.reset_password_for_email(email)

        await self._execute("send_reset_email", call())

    async def verify_token_hash(self, token_hash: str, type_: str) -> SupabaseSession:
        """The verify_otp half of confirmation only: burns the one-time
        link and returns the verified session. The password update is the
        caller's separate, retryable step (B29, #97)."""

        async def call() -> SupabaseSession:
            async with self._user_client() as client:
                response = await client.verify_otp(
                    {"token_hash": token_hash, "type": type_}
                )
            return _to_session(response.session)

        return await self._execute("verify_token_hash", call())

    async def create_user(self, email: str, password: str) -> str:
        async def call() -> str:
            async with self._admin_client() as admin:
                response = await admin.create_user(
                    {"email": email, "password": password, "email_confirm": True}
                )
                return response.user.id

        return await self._execute("create_user", call())

    async def invite_user(self, email: str) -> str:
        async def call() -> str:
            async with self._admin_client() as admin:
                response = await admin.invite_user_by_email(email)
                return response.user.id

        return await self._execute("invite_user", call())

    async def get_user_by_email(self, email: str) -> SupabaseUserSummary | None:
        async def call() -> SupabaseUserSummary | None:
            target = email.lower()
            async with self._admin_client() as admin:
                page = 1
                while True:
                    users = await admin.list_users(page=page, per_page=100)
                    if not users:
                        return None
                    for user in users:
                        if user.email is not None and user.email.lower() == target:
                            return SupabaseUserSummary(
                                id=user.id,
                                invite_pending=user.invited_at is not None
                                and user.last_sign_in_at is None,
                                provider=user.app_metadata.get("provider"),
                            )
                    page += 1

        return await self._execute("get_user_by_email", call())

    async def get_user_id_by_email(self, email: str) -> str | None:
        summary = await self.get_user_by_email(email)
        return summary.id if summary is not None else None

    async def get_enabled_external_providers(self) -> list[str]:
        """The provider configuration GoTrue publishes at GET
        {url}/auth/v1/settings -- publicly readable with just the
        publishable `apikey` header, no admin key or signed-in session
        required (this is the same endpoint supabase-js reads to decide
        which login buttons to render). Its `external` map covers every
        provider name, real OAuth/SSO ones (google, github, ...) and the
        "email"/"phone" pseudo-providers alike, each mapped to whether
        sign-in through it is enabled.

        Returns every name enabled, sorted, unfiltered -- the caller
        (create_app's startup gate) decides which names are acceptable for
        an email-only deployment. supabase_auth's GoTrue clients don't wrap
        this endpoint, so this is a raw httpx call, built the same
        per-operation way as every other method here.
        """

        async def call() -> list[str]:
            async with httpx.AsyncClient(transport=self._transport) as http_client:
                response = await http_client.get(
                    f"{self._auth_url}/settings",
                    headers={"apikey": self._credentials.publishable_key},
                )
                response.raise_for_status()
                external = response.json().get("external", {})
                return sorted(name for name, enabled in external.items() if enabled)

        try:
            return await call()
        except (httpx.HTTPError, ValueError) as exc:
            # ValueError alongside HTTPError: response.json() raises
            # json.JSONDecodeError (a ValueError subclass) on a malformed
            # body, which is a "can't read the provider config" failure the
            # same as a network error, not an auth rejection -- there is no
            # AuthError-shaped failure mode for a raw settings GET.
            logger.error("supabase gateway: get_enabled_external_providers unavailable")
            raise SupabaseUnavailableError(str(exc)) from exc
