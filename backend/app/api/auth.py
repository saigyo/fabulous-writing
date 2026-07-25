"""Local authentication endpoints (auth.mode: local)."""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user
from app.core.auth import SELF_MIN_PASSWORD_LENGTH, issue_token, validate_password
from app.services.users import User

router = APIRouter(prefix="/api", tags=["auth"])

# Never say which of "no such account", "wrong password" or "deactivated"
# applied: any distinction is an account-enumeration oracle.
_INVALID_LOGIN = "Invalid email or password"


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

    The table is deliberately bounded. Its keys come from unauthenticated
    input, so an attacker who sends one failed login each for a million
    distinct addresses would otherwise grow it without limit — turning a
    brute-force defense into a memory-exhaustion vector. Entries also expire:
    a failure from an hour ago says nothing about the current attempt.

    An entry whose block is still active (`blocked_until` in the future) is
    never evicted by the size cap, and never ages out via the TTL as long as
    the caller reports rejected attempts with `record_blocked_attempt`.
    Without both of those, an attacker who has already triggered a block
    against one victim key could spray `max_entries` failed logins from
    disposable, unrelated addresses (no IP spoofing needed — the key varies
    by email) to evict the victim's entry and discard its accumulated
    backoff, or simply wait out the TTL against a victim nobody is
    "refreshing" the record for.
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
                delay = min(
                    self.max_delay, self.base_delay * 2 ** (entry.failures - self.threshold)
                )
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
    email: str
    password: str


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
    return (email.strip().lower(), client_ip)


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
