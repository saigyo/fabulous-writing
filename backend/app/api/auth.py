"""Local and supabase-mode authentication endpoints (app/core/config.py:
AuthSettings.mode). login, change_password and (Task 5) admin create serve
both modes; every other route here is mode-specific (see
_require_supabase_mode)."""

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from app.api.deps import CurrentUser, get_current_user
from app.core.auth import (
    SELF_MIN_PASSWORD_LENGTH,
    InvalidToken,
    issue_token,
    validate_password,
)
from app.core.config import KNOWN_FEATURES, Settings
from app.core.permissions import features_for, label_for, limits_for, policy_for
from app.services.supabase_gateway import SupabaseAuthError, SupabaseUnavailableError
from app.services.usage import UsageStore
from app.services.users import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])

# Never say which of "no such account", "wrong password" or "deactivated"
# applied: any distinction is an account-enumeration oracle.
_INVALID_LOGIN = "Invalid email or password"

# Upper bound on the exponent used in LoginThrottle's backoff calculation
# (see `record_failure`). 2**64 already dwarfs any realistic `max_delay` by
# many orders of magnitude while staying nowhere near the ~2**1024 boundary
# where a double's range ends, so `2.0 ** _MAX_SAFE_EXPONENT` is cheap and
# exact regardless of how large `failures` gets.
_MAX_SAFE_EXPONENT = 64


@dataclass
class _Attempts:
    failures: int = 0
    blocked_until: float = 0.0
    last_seen: float = 0.0


@dataclass
class LoginThrottle:
    """Exponential backoff per (email, client IP) after repeated failures.

    In-process state, which is correct for the single-process deployment the
    spec requires; it is not shared across other processes.

    Two instances exist, on `app.state`: `login_throttle` guards
    `/auth/login` in both modes; `reset_throttle` is a SEPARATE instance
    guarding `/auth/reset-request` only. They must never share a table:
    sharing would let 5 free reset-request POSTs block a legitimate login
    for the same (email, ip), and would void the bcrypt-bounded-exemption
    argument below for the shared table (reset requests pay no bcrypt).

    The three handlers serving both auth modes (`login`, `change_password`,
    and the Task 5 admin-create route) run their LOCAL branch via
    `run_in_threadpool` rather than inline on the event loop — this is what
    keeps their bcrypt calls (~173 ms in production) off the loop, and it is
    also what this table's thread-safety reasoning below assumes; this
    deliberately preserves the pre-async-conversion threadpool hop rather
    than changing it.

    FastAPI runs synchronous ("def") route handlers in a threadpool, so a
    single process still means *multiple OS threads* touching this table
    concurrently. `self._lock` guards every read and write of `_state`, so
    `blocked_for`, `record_failure`, `record_success`,
    `record_blocked_attempt` and `entry_count` are each atomic with respect
    to one another. `_prune_locked` and `_evict_to_cap_locked` are
    deliberately lock-free — their `_locked` suffix is the contract: callers
    must already hold `self._lock` before calling them, which every public
    method here does. Do not add a call to either from outside this class.

    The table is bounded, but the cap is a soft ceiling: an entry whose
    block is still active (`blocked_until` in the future) is exempt from the
    size cap via an explicit check in `_evict_to_cap_locked`, so
    `entry_count()` can exceed `max_entries`. It is also, in effect, exempt
    from the TTL sweep — but `_prune_locked` has no `blocked_until` check at
    all; that exemption is not an explicit rule but a consequence of
    `__post_init__`'s `max_delay <= entry_ttl` invariant. A still-blocked
    entry's `blocked_until` is at most `last_seen + max_delay`, so for as
    long as it remains blocked, `last_seen` is at most `max_delay` (<=
    `entry_ttl`) in the past — always inside the TTL sweep's cutoff, so the
    sweep never reaches it. Every other entry is hard-bounded as before —
    expired by `entry_ttl` or evicted under the cap — since its keys come
    from unauthenticated input and an attacker spraying one failed login per
    address would otherwise grow the table without limit.

    The exemption exists to close a bypass, not to reopen one: without it,
    an attacker who has already triggered a block on one victim key could
    spray roughly `max_entries` cheap failed logins from disposable,
    unrelated addresses on the same IP (no IP spoofing needed — the key
    varies by email) to evict the victim's entry and discard its
    accumulated backoff.

    What actually limits growth of the exempt set is bcrypt cost, not the
    cap — for the LOGIN instance in LOCAL mode: every entry that becomes
    exempt first had to reach `threshold` failed logins, and
    `record_failure` only runs after `verify_credentials` has already spent
    a full bcrypt hash on that attempt — there is no way to make an entry
    exempt without paying that cost `threshold` times over. Sustaining a
    large exempt set means renewing roughly `exempt_entries / max_delay`
    blocks per second, each a bcrypt call: a rate high enough to pin a
    large table is a rate the server's own bcrypt throughput cannot absorb
    anyway. That traffic is still CPU load on an unauthenticated endpoint —
    true of any bcrypt-backed login endpoint, not a cost this exemption
    introduces — and it is per-IP or global rate limiting at the deployment
    layer, not this table, that is meant to address it.

    In SUPABASE mode there is no local bcrypt hash to pay: `_login_supabase`
    calls `record_failure` after a rejected `gateway.sign_in`, a full GoTrue
    round trip, not a local hash. The bound above still holds in kind, not
    in mechanism — an entry cannot become exempt without paying for
    `threshold` (5) real remote authentication attempts against Supabase's
    own endpoint, which enforces its own rate limits on that traffic. This
    table adds no cost of its own beyond that; `entry_ttl` remains the
    backstop bounding how long a lower-cost exempt entry can occupy a slot,
    same as it is for `reset_throttle` below.

    `reset_throttle`'s exempt entries cost NOTHING to mint — reset-request
    calls `record_failure` unconditionally on every non-blocked attempt, no
    bcrypt or any other expensive operation in between — so the bcrypt
    argument above does not apply to it. What bounds its exempt set instead
    is `entry_ttl` (900 s) plus the small `threshold` (3): an exempt entry
    still expires at `last_seen + max_delay` at the latest and, per the
    `__post_init__` invariant, `max_delay <= entry_ttl`, so the same
    TTL-sweep argument used for ordinary entries applies here too, just
    without a bcrypt cost gating how fast new exempt entries can be minted.
    """

    threshold: int = 5
    base_delay: float = 1.0
    max_delay: float = 60.0
    entry_ttl: float = 900.0
    max_entries: int = 4096
    clock: Callable[[], float] = time.monotonic
    _state: "OrderedDict[tuple[str, str], _Attempts]" = field(default_factory=OrderedDict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def __post_init__(self) -> None:
        if self.max_delay > self.entry_ttl:
            raise ValueError(
                f"max_delay ({self.max_delay}) must not exceed entry_ttl "
                f"({self.entry_ttl}): otherwise the TTL sweep could prune an "
                "entry whose block is still nominally active"
            )

    def entry_count(self) -> int:
        with self._lock:
            return len(self._state)

    def _prune_locked(self, now: float) -> None:
        """Evict expired and excess entries. Caller must hold `self._lock`."""
        cutoff = now - self.entry_ttl
        # Insertion order is maintained as last-seen order (record_failure
        # and record_blocked_attempt both move a touched entry to the end),
        # so expired entries are a prefix.
        while self._state:
            key, entry = next(iter(self._state.items()))
            if entry.last_seen >= cutoff:
                break
            del self._state[key]
        if len(self._state) > self.max_entries:
            self._evict_to_cap_locked(now)

    def _evict_to_cap_locked(self, now: float) -> None:
        """Evict least-recently-seen, non-blocked entries down to
        `max_entries`. Caller must hold `self._lock`.

        A single left-to-right pass over a snapshot of `_state` in last-seen
        order (oldest first): O(n) once per call, not a rescan per eviction.
        An entry whose block is still active (`blocked_until > now`) is
        skipped rather than evicted, so the cap is not a hard ceiling in the
        pathological case where every remaining entry is currently blocked —
        the table is then allowed to exceed `max_entries` until those blocks
        expire. That is still bounded in practice: reaching a blocked state
        costs `threshold` failed logins per entry, each paying full bcrypt
        time, and every block clears within `max_delay`.
        """
        excess = len(self._state) - self.max_entries
        if excess <= 0:
            return
        removed = 0
        for key, entry in list(self._state.items()):
            if removed >= excess:
                break
            if entry.blocked_until > now:
                continue
            del self._state[key]
            removed += 1

    def blocked_for(self, key: tuple[str, str]) -> float:
        with self._lock:
            entry = self._state.get(key)
            if entry is None:
                return 0.0
            return max(0.0, entry.blocked_until - self.clock())

    def record_failure(self, key: tuple[str, str]) -> None:
        now = self.clock()
        with self._lock:
            entry = self._state.get(key)
            if entry is None:
                entry = _Attempts()
                self._state[key] = entry
            else:
                self._state.move_to_end(key)
            entry.failures += 1
            entry.last_seen = now
            if entry.failures >= self.threshold:
                # `failures` only grows while the key is unblocked, and every
                # increment already costs a full bcrypt hash, so reaching a
                # huge exponent this way is not a realistic attack — but the
                # arithmetic should be obviously safe regardless, not safe by
                # that argument. Plain integer exponentiation (`2 **
                # huge_int`) would materialize a bigint with millions of
                # digits before `min()` ever looks at it. Switching only the
                # base to float does NOT fix this the way it would in other
                # languages: CPython's `**` raises OverflowError on a float
                # result outside double range instead of returning `inf`
                # (verified: `2.0 ** 1024` raises; it does not saturate).
                # Capping the exponent at `_MAX_SAFE_EXPONENT` sidesteps both
                # problems — `2.0 ** _MAX_SAFE_EXPONENT` is a cheap, exact
                # power of two, nowhere near the overflow boundary, and
                # already dwarfs any realistic `max_delay` by many orders of
                # magnitude, so the `min()` below always resolves to
                # `max_delay` once `failures` is large. Do not restore
                # unbounded exponentiation, integer or float.
                exponent = min(entry.failures - self.threshold, _MAX_SAFE_EXPONENT)
                delay = min(self.max_delay, self.base_delay * 2.0**exponent)
                entry.blocked_until = now + delay
            self._prune_locked(now)

    def record_success(self, key: tuple[str, str]) -> None:
        with self._lock:
            self._state.pop(key, None)

    def record_blocked_attempt(self, key: tuple[str, str]) -> None:
        """Refresh recency for a key rejected while already blocked.

        Does not increment `failures` and does not extend `blocked_until` —
        the caller already paid the throttle's cost by being blocked. This
        exists solely so that being under continuous attack does not itself
        become a way to escape the block, via TTL expiry or the size cap
        (see the class docstring). A no-op if the key is not currently
        tracked (e.g. its block already expired and was pruned).
        """
        with self._lock:
            entry = self._state.get(key)
            if entry is None:
                return
            entry.last_seen = self.clock()
            self._state.move_to_end(key)


class LoginRequest(BaseModel):
    # 320 is RFC 5321's ceiling for an address (64 local-part + '@' + 255
    # domain). Bounding it here keeps an unauthenticated caller from parking
    # an arbitrarily large key in the login throttle (see `_throttle_key`).
    email: str = Field(max_length=320)
    password: str

    @field_validator("email")
    @classmethod
    def _reject_blank_email(cls, value: str) -> str:
        # Empty-after-stripping must be rejected here, not merely normalized
        # downstream: `UserStore` strips whitespace too (see its
        # docstrings), so an all-whitespace email would otherwise normalize
        # to '' and become a usable "no email" account/login. Returning the
        # stripped value (not the raw one) means this validator agrees with
        # `UserStore` and `_throttle_key`, which both strip too — the value
        # that reaches the throttle key and the store is already the same
        # string either way, so stripping here does not fight their own
        # stripping, it just does it once, earlier, and rejects the empty
        # case before any throttle or DB work happens.
        stripped = value.strip()
        if not stripped:
            raise ValueError("email must not be empty or whitespace-only")
        return stripped


class LlmPolicyPayload(BaseModel):
    """None = unrestricted (config 'all')."""

    tiers: list[str] | None = None
    providers: list[str] | None = None
    models: dict[str, list[str]] | None = None


class PolicyPayload(BaseModel):
    llm: LlmPolicyPayload
    features: list[str]


def _policy_payload(user: User, settings: Settings) -> PolicyPayload:
    policy = policy_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    features = features_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    return PolicyPayload(
        llm=LlmPolicyPayload(
            tiers=None if policy.tiers is None else list(policy.tiers),
            providers=None if policy.providers is None else list(policy.providers),
            models=None
            if policy.models is None
            else {name: list(models) for name, models in policy.models.items()},
        ),
        # KNOWN_FEATURES order, so the payload is deterministic.
        features=[f for f in KNOWN_FEATURES if f in features],
    )


class WindowUsage(BaseModel):
    window: str
    used_percent: int


class UsagePayload(BaseModel):
    """B6 spec §5: tier label + whole-percent usage per configured window
    (fixed order hour, day, week, month), rounded up and capped at 100.
    Never absolute numbers, for any caller -- admins included."""

    label: str
    windows: list[WindowUsage]


class LimitsPayload(BaseModel):
    max_document_chars: int
    max_llm_document_chars: int
    concurrent_llm_runs: int


class MeResponse(BaseModel):
    """The caller's own account: identity (M1), LLM policy and features
    (M4), quota/size/concurrency limits (M5). The frontend's single source
    of truth for gating."""

    id: int
    email: str
    display_name: str | None = None
    tier: str
    is_admin: bool
    policy: PolicyPayload
    usage: UsagePayload
    limits: LimitsPayload
    # Read-only mirror of the config-only switch (spec §7.1): lets the M6
    # admin view disable a checkbox that would only 403. No endpoint accepts
    # it as input, so reporting it does not weaken the config-only guarantee.
    allow_additional_admins: bool

    @classmethod
    def from_user(
        cls, user: User, settings: Settings, *, usage_store: UsageStore
    ) -> "MeResponse":
        limits = limits_for(
            tier=user.tier, is_admin=user.is_admin, settings=settings
        )
        windows = limits.credit_windows()
        used = usage_store.credits_used(user.id, list(windows))
        return cls(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            tier=user.tier,
            is_admin=user.is_admin,
            policy=_policy_payload(user, settings),
            usage=UsagePayload(
                label=label_for(
                    tier=user.tier, is_admin=user.is_admin, settings=settings
                ),
                windows=[
                    WindowUsage(
                        window=window,
                        used_percent=min(100, -(-used[window] * 100 // budget)),
                    )
                    for window, budget in windows.items()
                ],
            ),
            limits=LimitsPayload(
                max_document_chars=settings.limits.max_document_chars,
                max_llm_document_chars=limits.max_llm_document_chars,
                concurrent_llm_runs=limits.concurrent_llm_runs,
            ),
            allow_additional_admins=settings.auth.allow_additional_admins,
        )


class LoginResponse(BaseModel):
    token: str
    # Supabase mode only; local mode leaves both None and the frontend
    # treats their absence as "this session never refreshes".
    refresh_token: str | None = None
    expires_at: int | None = None
    user: MeResponse


class PasswordChange(BaseModel):
    current: str
    new: str


class RefreshRequest(BaseModel):
    refresh_token: str = Field(max_length=8192)


class ResetRequest(BaseModel):
    email: str = Field(max_length=320)


class ResetConfirm(BaseModel):
    token_hash: str = Field(max_length=1024)
    type: Literal["recovery", "invite"]
    new_password: str


def _require_supabase_mode(request: Request) -> None:
    """These routes do not exist in local mode: there is no Supabase
    session to refresh, revoke, or reset a password against."""
    if request.app.state.settings.auth.mode != "supabase":
        raise HTTPException(404, "Not found")


def _bearer_token(request: Request) -> str:
    """Raw bearer token from the request headers.

    get_current_user's CurrentUser does not carry the raw token (only the
    verified identity), but sign_out/global_sign_out need the actual token
    string to hand to GoTrue -- so routes that need both re-read the header
    directly, same as get_current_user itself does.
    """
    _scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    return token.strip()


def _throttle_key(request: Request, email: str) -> tuple[str, str]:
    # Forwarded headers cannot mint throttle keys from untrusted peers:
    # uvicorn's proxy-header middleware (on by default) rewrites
    # request.client.host from X-Forwarded-For only for connections from
    # its trust list — loopback or the standard FORWARDED_ALLOW_IPS env
    # var by default, replaced by FW_TRUSTED_PROXIES (container env),
    # which the entrypoint passes as --forwarded-allow-ips. External
    # clients are not on the default list, so spoofed headers cannot
    # bypass the throttle; this key needs no app-side change.
    # request.client is only None for a connection with no transport-level
    # peer address (e.g. certain non-network ASGI test transports); every
    # such connection collapsing into one shared "unknown" bucket is an
    # accepted collision, not an oversight — ordinary HTTP deployments
    # always populate request.client.
    client_ip = request.client.host if request.client else "unknown"
    # Defensive memory bound, not a validation rule: `LoginRequest.email`
    # already caps input at 320 chars (RFC 5321's ceiling for an address),
    # but this truncation holds regardless of what any future caller passes
    # in, so a single throttle key can never grow unbounded. 320 exceeds any
    # realistic address's length, so this never fires for real traffic and
    # never changes which entries collide.
    normalized_email = email.strip().lower()[:320]
    return (normalized_email, client_ip)


def _login_local(request: Request, body: LoginRequest) -> LoginResponse:
    app = request.app
    key = _throttle_key(request, body.email)
    if app.state.login_throttle.blocked_for(key) > 0:
        # Refresh recency without counting another failure or extending the
        # block: otherwise an attacker who keeps hitting an already-blocked
        # key indefinitely could let it age out via the TTL or the size cap
        # (see LoginThrottle's docstring).
        app.state.login_throttle.record_blocked_attempt(key)
        raise HTTPException(401, _INVALID_LOGIN)
    user = app.state.user_store.verify_credentials(body.email, body.password)
    if user is None:
        app.state.login_throttle.record_failure(key)
        raise HTTPException(401, _INVALID_LOGIN)
    app.state.login_throttle.record_success(key)
    return LoginResponse(
        token=issue_token(user.id, app.state.auth_secret, epoch=user.token_epoch),
        user=MeResponse.from_user(
            user, app.state.settings, usage_store=app.state.usage_store,
        ),
    )


async def _login_supabase(request: Request, body: LoginRequest) -> LoginResponse:
    app = request.app
    key = _throttle_key(request, body.email)
    if app.state.login_throttle.blocked_for(key) > 0:
        app.state.login_throttle.record_blocked_attempt(key)
        raise HTTPException(401, _INVALID_LOGIN)
    try:
        session = await app.state.supabase_gateway.sign_in(body.email, body.password)
    except SupabaseAuthError:
        app.state.login_throttle.record_failure(key)
        raise HTTPException(401, _INVALID_LOGIN) from None
    except SupabaseUnavailableError:
        raise HTTPException(503, "Authentication service unavailable") from None
    # Route the session's own access token through the configured verifier
    # rather than resolving it directly: resolve_supabase_user alone applies
    # none of the verifier's claim guards (is_anonymous / role /
    # app_metadata.provider). app_metadata.provider records the FIRST
    # provider an identity ever used, not the grant now in flight -- a user
    # who signed up via Google and later had a password set by an admin
    # still carries provider: "google" and can use this password grant, so
    # even the login route (password-authenticated) needs this check, not
    # just refresh/reset-confirm. verify() is sync and may block on a JWKS
    # fetch; run_in_threadpool keeps that off the event loop the same way
    # deps.get_current_user's sync dependency already does.
    try:
        verified = await run_in_threadpool(
            app.state.token_verifier.verify, session.access_token
        )
    except InvalidToken:
        # e.g. the session's email belongs to a local row already linked to
        # a DIFFERENT external_id (resolve_supabase_user's fail-closed
        # collision guard, applied inside verify()), or a claim guard
        # rejected the session outright. A verified Supabase session that
        # cannot be mapped to a local user is an authentication failure from
        # the caller's point of view, not a server error -- same generic 401
        # as every other login failure, no exception text leaked.
        app.state.login_throttle.record_failure(key)
        raise HTTPException(401, _INVALID_LOGIN) from None
    # verified.epoch is always None here (the epoch-less contract of every
    # Supabase-mode verifier) -- only the is_active check applies, same as
    # deps.get_current_user without the epoch/password_changed_at fallback,
    # which cannot fire meaningfully on a token minted seconds ago.
    user = app.state.user_store.get_user(verified.user_id)
    if user is None or not user.is_active:
        app.state.login_throttle.record_failure(key)
        raise HTTPException(401, _INVALID_LOGIN)
    app.state.login_throttle.record_success(key)
    return LoginResponse(
        token=session.access_token,
        refresh_token=session.refresh_token,
        expires_at=session.expires_at,
        user=MeResponse.from_user(
            user, app.state.settings, usage_store=app.state.usage_store,
        ),
    )


@router.post("/auth/login")
async def login(request: Request, body: LoginRequest) -> LoginResponse:
    if request.app.state.settings.auth.mode == "supabase":
        return await _login_supabase(request, body)
    # bcrypt (~173 ms/hash in production) must not block the event loop;
    # see LoginThrottle's docstring.
    return await run_in_threadpool(_login_local, request, body)


@router.post("/auth/refresh")
async def refresh(request: Request, body: RefreshRequest) -> LoginResponse:
    # No throttle here, unlike login: refresh tokens are 256-bit random (not
    # guessable the way a password is), GoTrue applies its own rate limiting
    # server-side, and an IP-keyed throttle on this route would let one NAT
    # (many callers sharing one client IP) starve every legitimate refresh
    # behind it -- a self-inflicted denial of service login's throttle does
    # not risk, since login is keyed on (email, ip) rather than ip alone.
    _require_supabase_mode(request)
    app = request.app
    try:
        session = await app.state.supabase_gateway.refresh(body.refresh_token)
    except SupabaseAuthError:
        raise HTTPException(401, _INVALID_LOGIN) from None
    except SupabaseUnavailableError:
        raise HTTPException(503, "Authentication service unavailable") from None
    # Same reasoning as _login_supabase above: verify() applies the claim
    # guards resolve_supabase_user alone does not, and this route is
    # unauthenticated and unthrottled, so an accidentally-enabled OAuth/SSO
    # provider must not reach JIT provisioning or email-adoption at all.
    try:
        verified = await run_in_threadpool(
            app.state.token_verifier.verify, session.access_token
        )
    except InvalidToken:
        raise HTTPException(401, _INVALID_LOGIN) from None
    user = app.state.user_store.get_user(verified.user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, _INVALID_LOGIN)
    return LoginResponse(
        token=session.access_token,
        refresh_token=session.refresh_token,
        expires_at=session.expires_at,
        user=MeResponse.from_user(
            user, app.state.settings, usage_store=app.state.usage_store,
        ),
    )


@router.post("/auth/logout", status_code=204)
async def logout(
    request: Request, current: CurrentUser = Depends(get_current_user)
) -> Response:
    # get_current_user (above, via Depends) runs before this body -- an
    # anonymous caller is rejected with 401 in BOTH modes, which is exactly
    # why this route is deliberately absent from test_auth_enforcement's
    # allowlist. Only an AUTHENTICATED caller reaches the mode check below,
    # so a local-mode instance answers 404, not 500 (it has no
    # supabase_gateway to call).
    _require_supabase_mode(request)
    try:
        await request.app.state.supabase_gateway.sign_out(_bearer_token(request))
    except (SupabaseAuthError, SupabaseUnavailableError):
        # Best-effort: the frontend clears its local session regardless of
        # whether Supabase-side revocation succeeded.
        pass
    return Response(status_code=204)


@router.get("/auth/me")
def me(request: Request, current: CurrentUser = Depends(get_current_user)) -> MeResponse:
    user = request.app.state.user_store.get_user(current.id)
    if user is None:  # pragma: no cover - get_current_user already rejected this
        raise HTTPException(401, "Not authenticated")
    return MeResponse.from_user(
        user, request.app.state.settings,
        usage_store=request.app.state.usage_store,
    )


def _change_password_local(
    request: Request, body: PasswordChange, current: CurrentUser
) -> Response:
    store = request.app.state.user_store
    # 422, not 401: the bearer token authenticated this request fine — this
    # is a validation failure of the submitted body, not a failure to
    # authenticate. A wrong-current-password 401 here would be
    # indistinguishable from get_current_user's "your token is dead" 401,
    # and the two need different client responses (retry the form vs. sign
    # in again).
    if store.verify_credentials(current.email, body.current) is None:
        raise HTTPException(422, {"code": "wrong_current_password"})
    try:
        validate_password(body.new, min_length=SELF_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        # validate_password conflates two distinct failures behind one
        # exception type (too short vs. bcrypt's 72-byte ceiling); recover
        # which one by re-checking the cheap condition, so the client gets a
        # discriminator instead of a shared 422 it cannot act on.
        code = (
            "password_too_short"
            if len(body.new) < SELF_MIN_PASSWORD_LENGTH
            else "password_too_long"
        )
        raise HTTPException(422, {"code": code}) from exc
    store.set_password(current.id, body.new)
    return Response(status_code=204)


async def _change_password_supabase(
    request: Request, body: PasswordChange, current: CurrentUser
) -> Response:
    app = request.app
    try:
        await app.state.supabase_gateway.sign_in(current.email, body.current)
    except SupabaseAuthError:
        raise HTTPException(422, {"code": "wrong_current_password"}) from None
    except SupabaseUnavailableError:
        raise HTTPException(503, "Authentication service unavailable") from None
    try:
        validate_password(body.new, min_length=SELF_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        code = (
            "password_too_short"
            if len(body.new) < SELF_MIN_PASSWORD_LENGTH
            else "password_too_long"
        )
        raise HTTPException(422, {"code": code}) from exc
    store = app.state.user_store
    user = store.get_user(current.id)
    try:
        await app.state.supabase_gateway.change_password(user.external_id, body.new)
    except SupabaseAuthError:
        # No local state changed yet: a failed remote rotation must not
        # bump password_changed_at or the token epoch.
        raise HTTPException(422, {"code": "password_change_failed"}) from None
    except SupabaseUnavailableError:
        raise HTTPException(503, "Authentication service unavailable") from None
    store.mark_password_changed(current.id)
    try:
        await app.state.supabase_gateway.global_sign_out(_bearer_token(request))
    except (SupabaseAuthError, SupabaseUnavailableError):
        # Best-effort: the local password_changed_at bump above already
        # revoked every outstanding access token at our own layer.
        logger.warning(
            "supabase global_sign_out unavailable after password change for user %s",
            current.id,
        )
    return Response(status_code=204)


@router.post("/auth/password", status_code=204)
async def change_password(
    request: Request, body: PasswordChange, current: CurrentUser = Depends(get_current_user)
) -> Response:
    if request.app.state.settings.auth.mode == "supabase":
        return await _change_password_supabase(request, body, current)
    return await run_in_threadpool(_change_password_local, request, body, current)


@router.post("/auth/reset-request", status_code=204)
async def reset_request(request: Request, body: ResetRequest) -> Response:
    _require_supabase_mode(request)
    app = request.app
    key = _throttle_key(request, body.email)
    if app.state.reset_throttle.blocked_for(key) > 0:
        # Silent: no gateway call, so an attacker cannot use this to
        # mail-bomb a victim, and the response gives no signal either way.
        app.state.reset_throttle.record_blocked_attempt(key)
        return Response(status_code=204)
    # Each request costs one slot regardless of outcome -- success never
    # resets the count (resets are rare), unlike login's record_success.
    app.state.reset_throttle.record_failure(key)
    try:
        await app.state.supabase_gateway.send_reset_email(body.email)
    except (SupabaseAuthError, SupabaseUnavailableError):
        # Swallowed: an unknown email must look identical to a known one.
        pass
    return Response(status_code=204)


@router.post("/auth/reset-confirm", status_code=204)
async def reset_confirm(request: Request, body: ResetConfirm) -> Response:
    _require_supabase_mode(request)
    app = request.app
    try:
        validate_password(body.new_password, min_length=SELF_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        code = (
            "password_too_short"
            if len(body.new_password) < SELF_MIN_PASSWORD_LENGTH
            else "password_too_long"
        )
        raise HTTPException(422, {"code": code}) from exc
    try:
        session = await app.state.supabase_gateway.confirm_with_token_hash(
            body.token_hash, body.type, body.new_password
        )
    except SupabaseAuthError:
        raise HTTPException(422, {"code": "invalid_or_expired_link"}) from None
    except SupabaseUnavailableError:
        raise HTTPException(503, "Authentication service unavailable") from None
    store = app.state.user_store
    # confirm_with_token_hash has already rotated the remote password at
    # this point. Eviction bookkeeping below is therefore keyed ONLY to the
    # confirmed subject's EXISTING local row -- a plain lookup, never a
    # JIT-create -- and runs BEFORE the verifier call so it survives a
    # verification failure (JWKS outage, external-id collision, inactive
    # check): without it, a completed remote reset would leave any pre-reset
    # access token for this subject authorizing locally until its natural
    # TTL. A subject with no local row has nothing to evict; the claim
    # guards (the verifier, below) still gate all provisioning and the
    # response itself.
    existing_row = store.get_by_external_id(session.user_id)
    if existing_row is not None:
        store.mark_password_changed(existing_row.id)
        try:
            await app.state.supabase_gateway.global_sign_out(session.access_token)
        except (SupabaseAuthError, SupabaseUnavailableError):
            logger.warning(
                "supabase global_sign_out unavailable after reset-confirm"
                " eviction for user %s",
                existing_row.id,
            )
    # JIT: for an invite-type hash, this IS the invite-acceptance
    # materialization point -- verify() calls resolve_supabase_user
    # internally, so the local row is still created here, on first confirm,
    # not at invite time. Routed through the verifier for the same reason as
    # login/refresh: the claim guards must run before resolution, not be
    # bypassed by resolving the session directly.
    try:
        verified = await run_in_threadpool(
            app.state.token_verifier.verify, session.access_token
        )
    except InvalidToken:
        # Same collision guard as login/refresh (applied inside verify()):
        # the confirmed session's email belongs to a local row already
        # linked to a DIFFERENT external_id. Reported as the same "link no
        # good" code as an expired/invalid token_hash -- never leak the
        # exception text. The eviction above already ran if this subject had
        # an existing row of its own.
        raise HTTPException(422, {"code": "invalid_or_expired_link"}) from None
    user = store.get_user(verified.user_id)
    if user is None or not user.is_active:
        raise HTTPException(422, {"code": "invalid_or_expired_link"})
    if existing_row is None:
        # First mark for this row: it did not exist yet at the pre-verify
        # lookup above, so it was just JIT-created or adopted-by-email
        # inside verify() and has never been evicted for this reset.
        store.mark_password_changed(user.id)
        try:
            await app.state.supabase_gateway.global_sign_out(session.access_token)
        except (SupabaseAuthError, SupabaseUnavailableError):
            pass
    return Response(status_code=204)
