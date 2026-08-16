"""Shared supabase-mode test doubles: static JWKS + fake gateway (Task 4)."""

import time
from datetime import UTC, datetime

import jwt

from app.core.auth import InvalidToken, VerifiedToken
from app.core.supabase_auth import resolve_supabase_user
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseEmailExistsError,
    SupabaseSession,
    SupabaseUnavailableError,
    SupabaseUserSummary,
    SupabaseWeakPasswordError,
)


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
        # email -> invite_pending (True: invited_at set, never signed in;
        # mirrors the real gateway's GoTrue-derived flag). Missing means
        # False, same as an identity GoTrue never marked invited.
        self._invite_pending: dict[str, bool] = {}
        # email -> provider (app_metadata.provider). Missing means "email",
        # the default for every account this fake mints itself
        # (create_user/invite_user); a test opts an entry into a
        # non-email/OAuth origin via register_user(..., provider="google").
        self._provider: dict[str, str] = {}
        # Provider names GET /auth/v1/settings would report enabled
        # (get_enabled_external_providers). "email" only, matching a
        # correctly configured project, unless a test overrides this.
        self.enabled_providers: list[str] = ["email"]
        self._next_uuid = 1
        self._next_token = 1
        # access_token -> (uuid, email, issued_at epoch seconds)
        self.sessions: dict[str, tuple[str, str, float]] = {}
        # refresh_token -> (uuid, email)
        self._refresh_tokens: dict[str, tuple[str, str]] = {}
        # hash -> (uuid, email); populated by tests via direct assignment.
        self.valid_token_hashes: dict[str, tuple[str, str]] = {}
        # access_token -> the amr method set that minted it. Parallel to
        # `sessions` rather than widening its 3-tuple (unpacked elsewhere,
        # see the class docstring): "password" for sign_in/refresh-minted
        # sessions, "otp" for verify_token_hash-minted ones. Read by
        # FakeSupabaseVerifier to populate VerifiedToken.methods.
        self.session_methods: dict[str, frozenset[str]] = {}
        self.sign_in_calls: list[tuple[str, str]] = []
        self.sign_out_calls: list[str] = []
        self.global_sign_out_calls: list[str] = []
        self.reset_emails: list[str] = []
        self.invites: list[str] = []
        self.create_user_calls: list[tuple[str, str]] = []
        # email -> number of invites delivered (PROBED semantics: a PENDING
        # identity gets a fresh invite delivered on every retry, not a
        # rejection -- see invite_user below).
        self.invite_calls: dict[str, int] = {}
        # Set by a test to make change_password raise SupabaseWeakPasswordError
        # with these reasons instead of succeeding.
        self.weak_password_reasons: list[str] | None = None
        # Set by a test to make the NEXT change_password call raise
        # SupabaseUnavailableError once, then reset itself -- models a
        # transient remote failure a retry should recover from.
        self.fail_change_password_once: bool = False
        # Opt-in for the two reconciliation-rig tests that need invite_user
        # to reject a duplicate email unconditionally (the pre-fact-1 always-
        # raise model) so they still reach _resolve_after_duplicate_rejection.
        # Every other test gets GoTrue's real PROBED semantics (see
        # invite_user).
        self.invite_rejects_duplicates: bool = False
        # Set by a test to make invite_user raise this instead of running
        # its normal logic (rate-limit/misconfig-class failures).
        self.invite_failure: Exception | None = None

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
        self.session_methods[access] = frozenset({"password"})
        self._refresh_tokens[refresh] = (uuid, email)
        return SupabaseSession(
            access_token=access, refresh_token=refresh,
            expires_at=2_000_000_000, user_id=uuid, email=email,
        )

    def stored_password(self, email: str) -> str | None:
        """Test assertion helper: the password currently on file, if any."""
        stored = self._users.get(email)
        return stored[0] if stored else None

    def register_user(
        self,
        email: str,
        password: str,
        *,
        uuid: str | None = None,
        invite_pending: bool = False,
        provider: str = "email",
    ) -> str:
        """Test setup: register an email/password pair, as if already
        signed up with Supabase. Returns the (possibly generated) uuid.
        `invite_pending` simulates an identity minted by an unfinished
        invite (GoTrue's invited_at set, never signed in); the default
        (False) matches a directly created/active account. `provider`
        simulates `app_metadata.provider`; the default ("email") matches
        this app's own flows -- a test opts into an OAuth-origin identity
        by passing e.g. provider="google"."""
        uuid = uuid or self._mint_uuid()
        self._users[email] = (password, uuid)
        self._invite_pending[email] = invite_pending
        self._provider[email] = provider
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
        if self.weak_password_reasons is not None:
            raise SupabaseWeakPasswordError(self.weak_password_reasons)
        if self.fail_change_password_once:
            self.fail_change_password_once = False
            raise SupabaseUnavailableError("transiently unavailable")
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

    async def verify_token_hash(self, token_hash: str, type_: str) -> SupabaseSession:
        # Burn: pop, not get -- a reused or unknown hash raises, mirroring
        # GoTrue's one-time link. Does NOT touch the password (B29, #97);
        # that is the caller's separate, retryable step.
        entry = self.valid_token_hashes.pop(token_hash, None)
        if entry is None:
            raise SupabaseAuthError("invalid or expired token_hash")
        uuid, email = entry
        # Materialize the identity on consumption, mirroring GoTrue:
        # verify_otp confirms an identity that already exists remotely, so a
        # subsequent change_password(uuid, ...) must find it -- without this
        # a confirm-only rig raises "unknown user_id" here.
        self._users.setdefault(email, ("", uuid))
        session = self._mint_session(uuid, email)
        self.session_methods[session.access_token] = frozenset({"otp"})
        return session

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
        # PROBED semantics (spec fact 1): real GoTrue only rejects a retry
        # against a CONFIRMED identity -- a PENDING one (invited, never
        # signed in) gets a fresh invite delivered instead, the same UUID
        # returned. `invite_rejects_duplicates` is the opt-in for the two
        # reconciliation-rig tests that need the old always-raise model to
        # reach _resolve_after_duplicate_rejection.
        if self.invite_failure is not None:
            raise self.invite_failure
        stored = self._users.get(email)
        if stored is not None:
            if self.invite_rejects_duplicates:
                raise SupabaseAuthError(f"{email} already registered")
            if self._invite_pending.get(email, False):
                uuid = stored[1]
                self.invites.append(email)
                self.invite_calls[email] = self.invite_calls.get(email, 0) + 1
                return uuid
            raise SupabaseEmailExistsError(f"{email} already registered")
        uuid = self._mint_uuid()
        self._users[email] = ("", uuid)
        self._invite_pending[email] = True
        self.invites.append(email)
        self.invite_calls[email] = self.invite_calls.get(email, 0) + 1
        return uuid

    async def get_user_by_email(self, email: str) -> SupabaseUserSummary | None:
        stored = self._users.get(email)
        if stored is None:
            return None
        return SupabaseUserSummary(
            id=stored[1],
            invite_pending=self._invite_pending.get(email, False),
            provider=self._provider.get(email, "email"),
        )

    async def get_user_id_by_email(self, email: str) -> str | None:
        summary = await self.get_user_by_email(email)
        return summary.id if summary is not None else None

    async def get_enabled_external_providers(self) -> list[str]:
        return list(self.enabled_providers)


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
            methods=self._gateway.session_methods.get(token, frozenset({"password"})),
        )
