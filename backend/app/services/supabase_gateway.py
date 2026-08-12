"""Server-side Supabase Auth gateway (auth.mode: supabase).

Every method builds its own short-lived GoTrue client around a fresh
httpx.AsyncClient: seed_admin drives this from its own event loop via
asyncio.run(), so no connection pool may outlive one operation. Auth
operations are rare; the per-call handshake is irrelevant next to bcrypt.
"""

import logging
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
from supabase_auth import AsyncGoTrueAdminAPI, AsyncGoTrueClient
from supabase_auth.errors import AuthError, AuthRetryableError
from supabase_auth.types import Session

from app.core.supabase_auth import SupabaseCredentials

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SupabaseSession:
    access_token: str
    refresh_token: str
    expires_at: int | None  # epoch seconds
    user_id: str  # Supabase UUID
    email: str | None


class SupabaseAuthError(Exception):
    """Invalid credentials, token, or link."""


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
        """Runs a single GoTrue call, mapping its errors to our two types.

        Order is load-bearing: AuthRetryableError is itself an AuthError, so
        it must be caught before the generic AuthError branch, or a
        retryable/unavailable condition would be misreported as an auth
        failure.
        """
        try:
            return await coro
        except AuthRetryableError as exc:
            logger.error("supabase gateway: %s unavailable (retryable)", operation)
            raise SupabaseUnavailableError(str(exc)) from exc
        except httpx.HTTPError as exc:
            logger.error("supabase gateway: %s unavailable (transport)", operation)
            raise SupabaseUnavailableError(str(exc)) from exc
        except (AuthError, ValueError) as exc:
            logger.debug("supabase gateway: %s rejected: %s", operation, exc)
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

    async def confirm_with_token_hash(
        self, token_hash: str, type_: str, new_password: str
    ) -> SupabaseSession:
        async def call() -> SupabaseSession:
            async with self._user_client() as client:
                response = await client.verify_otp(
                    {"token_hash": token_hash, "type": type_}
                )
            session = response.session
            async with self._admin_client() as admin:
                await admin.update_user_by_id(
                    session.user.id, {"password": new_password}
                )
            return _to_session(session)

        return await self._execute("confirm_with_token_hash", call())

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

    async def get_user_id_by_email(self, email: str) -> str | None:
        async def call() -> str | None:
            target = email.lower()
            async with self._admin_client() as admin:
                page = 1
                while True:
                    users = await admin.list_users(page=page, per_page=100)
                    if not users:
                        return None
                    for user in users:
                        if user.email is not None and user.email.lower() == target:
                            return user.id
                    page += 1

        return await self._execute("get_user_id_by_email", call())
