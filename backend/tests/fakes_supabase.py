"""Shared supabase-mode test doubles: static JWKS + fake gateway (Task 4)."""

import time
from datetime import UTC, datetime

import jwt

from app.core.auth import InvalidToken, VerifiedToken
from app.core.supabase_auth import resolve_supabase_user
from app.services.supabase_gateway import SupabaseAuthError, SupabaseSession


class StaticJWKSClient:
    """Duck-types PyJWKClient.get_signing_key_from_jwt for a fixed key set.

    Keys: mapping kid -> public-key object. Unknown kid raises
    PyJWKClientError exactly like the real client after a failed refetch.
    """

    def __init__(self, keys):
        self.keys = keys
        self.calls = 0

    def get_signing_key_from_jwt(self, token: str):
        self.calls += 1
        kid = jwt.get_unverified_header(token).get("kid")
        if kid not in self.keys:
            raise jwt.exceptions.PyJWKClientError(f"Unable to find kid {kid!r}")

        class _Key:
            def __init__(self, key):
                self.key = key

        return _Key(self.keys[kid])


class FakeSupabaseGateway:
    """In-memory stand-in for SupabaseAuthGateway; no network involved.

    Mints deterministic tokens (`fake-access-<n>` / `fake-refresh-<n>`) and
    records every issued access token's (uuid, email, issued_at) in
    `sessions`, which `FakeSupabaseVerifier` reads back instead of decoding a
    JWT. `sign_out` deliberately does NOT remove a token from `sessions` --
    unlike real GoTrue, this fake models no independent Supabase-side
    revocation of ACCESS tokens, only the calls being made; the eviction
    integration test's "residual window" assertion depends on an
    already-issued access token staying resolvable here even after the
    route layer calls global_sign_out on some other token -- that residual
    (an access token stays valid until its own expiry) is the documented
    contract, not a fake gap. `global_sign_out` DOES revoke every refresh
    token belonging to the same subject as the given access token (mirrors
    GoTrue's `/logout?scope=global`), so a stale refresh token correctly
    fails at `/api/auth/refresh` after a password change or reset-confirm.
    """

    def __init__(self) -> None:
        # email -> (password, uuid)
        self._users: dict[str, tuple[str, str]] = {}
        self._next_uuid = 1
        self._next_token = 1
        # access_token -> (uuid, email, issued_at epoch seconds)
        self.sessions: dict[str, tuple[str, str, float]] = {}
        # refresh_token -> (uuid, email)
        self._refresh_tokens: dict[str, tuple[str, str]] = {}
        # hash -> (uuid, email); populated by tests via direct assignment.
        self.valid_token_hashes: dict[str, tuple[str, str]] = {}
        self.sign_in_calls: list[tuple[str, str]] = []
        self.sign_out_calls: list[str] = []
        self.global_sign_out_calls: list[str] = []
        self.reset_emails: list[str] = []
        self.invites: list[str] = []
        self.create_user_calls: list[tuple[str, str]] = []

    def _mint_uuid(self) -> str:
        uuid = f"fake-uuid-{self._next_uuid}"
        self._next_uuid += 1
        return uuid

    def _mint_session(
        self, uuid: str, email: str, *, issued_at: float | None = None
    ) -> SupabaseSession:
        n = self._next_token
        self._next_token += 1
        access = f"fake-access-{n}"
        refresh = f"fake-refresh-{n}"
        self.sessions[access] = (uuid, email, issued_at if issued_at is not None else time.time())
        self._refresh_tokens[refresh] = (uuid, email)
        return SupabaseSession(
            access_token=access, refresh_token=refresh,
            expires_at=2_000_000_000, user_id=uuid, email=email,
        )

    def stored_password(self, email: str) -> str | None:
        """Test assertion helper: the password currently on file, if any."""
        stored = self._users.get(email)
        return stored[0] if stored else None

    def register_user(self, email: str, password: str, *, uuid: str | None = None) -> str:
        """Test setup: register an email/password pair, as if already
        signed up with Supabase. Returns the (possibly generated) uuid."""
        uuid = uuid or self._mint_uuid()
        self._users[email] = (password, uuid)
        return uuid

    def issue_session(
        self, email: str, *, uuid: str | None = None, issued_at: float | None = None
    ) -> SupabaseSession:
        """Test-only: mint a session directly, bypassing sign_in, so a test
        can control `issued_at` precisely (e.g. to probe the
        password-change eviction window). Registers the email/uuid pair if
        not already known."""
        stored = self._users.get(email)
        uuid = uuid or (stored[1] if stored else self._mint_uuid())
        if stored is None:
            self._users[email] = ("unused-test-password", uuid)
        return self._mint_session(uuid, email, issued_at=issued_at)

    async def sign_in(self, email: str, password: str) -> SupabaseSession:
        self.sign_in_calls.append((email, password))
        stored = self._users.get(email)
        if stored is None or stored[0] != password:
            raise SupabaseAuthError("invalid credentials")
        return self._mint_session(stored[1], email)

    async def refresh(self, refresh_token: str) -> SupabaseSession:
        entry = self._refresh_tokens.get(refresh_token)
        if entry is None:
            raise SupabaseAuthError("invalid refresh token")
        uuid, email = entry
        return self._mint_session(uuid, email)

    async def sign_out(self, access_token: str) -> None:
        self.sign_out_calls.append(access_token)

    async def global_sign_out(self, access_token: str) -> None:
        self.global_sign_out_calls.append(access_token)
        session = self.sessions.get(access_token)
        if session is None:
            return
        uuid, _email, _issued_at = session
        for token, (rt_uuid, _rt_email) in list(self._refresh_tokens.items()):
            if rt_uuid == uuid:
                del self._refresh_tokens[token]

    async def change_password(self, user_id: str, new_password: str) -> None:
        for email, (_password, uuid) in list(self._users.items()):
            if uuid == user_id:
                self._users[email] = (new_password, uuid)
                # Mirrors real GoTrue: admin.update_user_by_id with a
                # password logs the user out everywhere as part of the same
                # call (UpdatePassword -> Logout(user.ID) server-side) --
                # every outstanding refresh token for this user dies right
                # here, with no separate sign-out call required or possible.
                for token, (rt_uuid, _email) in list(self._refresh_tokens.items()):
                    if rt_uuid == user_id:
                        del self._refresh_tokens[token]
                return
        raise SupabaseAuthError(f"unknown user_id {user_id!r}")

    async def send_reset_email(self, email: str) -> None:
        self.reset_emails.append(email)

    async def confirm_with_token_hash(
        self, token_hash: str, type_: str, new_password: str
    ) -> SupabaseSession:
        entry = self.valid_token_hashes.get(token_hash)
        if entry is None:
            raise SupabaseAuthError("invalid or expired token_hash")
        uuid, email = entry
        self._users[email] = (new_password, uuid)
        return self._mint_session(uuid, email)

    async def create_user(self, email: str, password: str) -> str:
        self.create_user_calls.append((email, password))
        if email in self._users:
            # Mirrors real GoTrue admin.create_user: a duplicate email is
            # rejected, not silently overwritten. This is what lets a test
            # simulate "re-run against an existing project" by pre-registering
            # the email via register_user() before the call under test.
            raise SupabaseAuthError(f"{email} already registered")
        uuid = self._mint_uuid()
        self._users[email] = (password, uuid)
        return uuid

    async def invite_user(self, email: str) -> str:
        if email in self._users:
            # Mirrors real GoTrue: a retry of /invite against an email that
            # already has a Supabase identity -- even one from an earlier,
            # still-unconfirmed invite -- is rejected the same way
            # admin.create_user rejects a duplicate (supabase/auth#2180),
            # not silently resent. Lets a test simulate "the first invite
            # succeeded remotely but the local write then failed" by
            # pre-registering the email before the call under test.
            raise SupabaseAuthError(f"{email} already registered")
        uuid = self._mint_uuid()
        self._users[email] = ("", uuid)
        self.invites.append(email)
        return uuid

    async def get_user_id_by_email(self, email: str) -> str | None:
        stored = self._users.get(email)
        return stored[1] if stored else None


class FakeSupabaseVerifier:
    """Resolves a FakeSupabaseGateway's own tokens; no JWKS, no network.

    Mirrors SupabaseTokenVerifier's public contract (`verify(token) ->
    VerifiedToken`), so it can be swapped in as `app.state.token_verifier`
    for a supabase-mode test app -- the real verifier is never given a
    chance to fetch JWKS.
    """

    def __init__(self, gateway: FakeSupabaseGateway, user_store) -> None:
        self._gateway = gateway
        self._store = user_store

    def verify(self, token: str) -> VerifiedToken:
        session = self._gateway.sessions.get(token)
        if session is None:
            raise InvalidToken("unknown fake token")
        uuid, email, issued_at = session
        user = resolve_supabase_user(self._store, subject=uuid, email=email)
        return VerifiedToken(
            user_id=user.id,
            issued_at=datetime.fromtimestamp(issued_at, UTC),
            epoch=None,
        )
