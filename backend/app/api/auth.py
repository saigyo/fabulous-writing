"""Local authentication endpoints (auth.mode: local)."""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentUser, get_current_user
from app.core.auth import SELF_MIN_PASSWORD_LENGTH, issue_token, validate_password
from app.services.users import User

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
    spec requires; it is not shared across other processes. Supabase's own
    rate limiting replaces this in sub-project 2.

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
    cap: every entry that becomes exempt first had to reach `threshold`
    failed logins, and `record_failure` only runs after `verify_credentials`
    has already spent a full bcrypt hash on that attempt — there is no way
    to make an entry exempt without paying that cost `threshold` times over.
    Sustaining a large exempt set means renewing roughly
    `exempt_entries / max_delay` blocks per second, each a bcrypt call: a
    rate high enough to pin a large table is a rate the server's own bcrypt
    throughput cannot absorb anyway. That traffic is still CPU load on an
    unauthenticated endpoint — true of any bcrypt-backed login endpoint, not
    a cost this exemption introduces — and it is per-IP or global rate
    limiting at the deployment layer, not this table, that is meant to
    address it.
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


class MeResponse(BaseModel):
    """The caller's own account. Later milestones extend this model with the
    LLM policy (M4) and quota/size/concurrency limits (M5)."""

    id: int
    email: str
    display_name: str | None = None
    tier: str
    is_admin: bool

    @classmethod
    def from_user(cls, user: User) -> "MeResponse":
        return cls(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            tier=user.tier,
            is_admin=user.is_admin,
        )


class LoginResponse(BaseModel):
    token: str
    user: MeResponse


class PasswordChange(BaseModel):
    current: str
    new: str


def _require_local_mode(request: Request) -> None:
    """Local login does not exist in supabase mode: a leaked FW_AUTH_SECRET
    must not be able to forge tokens against a Supabase-mode instance."""
    if request.app.state.settings.auth.mode != "local":
        raise HTTPException(404, "Not found")


def _throttle_key(request: Request, email: str) -> tuple[str, str]:
    # Forwarded headers are deliberately ignored: trusting them unverified
    # would let an attacker mint a fresh spoofed IP per request and bypass
    # the throttle entirely. A deployment behind a proxy must configure a
    # trusted-proxy list first (sub-project 3).
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


@router.post("/auth/login")
def login(request: Request, body: LoginRequest) -> LoginResponse:
    _require_local_mode(request)
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
        token=issue_token(user.id, app.state.auth_secret),
        user=MeResponse.from_user(user),
    )


@router.get("/auth/me")
def me(request: Request, current: CurrentUser = Depends(get_current_user)) -> MeResponse:
    user = request.app.state.user_store.get_user(current.id)
    if user is None:  # pragma: no cover - get_current_user already rejected this
        raise HTTPException(401, "Not authenticated")
    return MeResponse.from_user(user)


@router.post("/auth/password", status_code=204)
def change_password(
    request: Request, body: PasswordChange, current: CurrentUser = Depends(get_current_user)
) -> Response:
    _require_local_mode(request)
    store = request.app.state.user_store
    if store.verify_credentials(current.email, body.current) is None:
        raise HTTPException(401, "Current password is incorrect")
    try:
        validate_password(body.new, min_length=SELF_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    store.set_password(current.id, body.new)
    return Response(status_code=204)
