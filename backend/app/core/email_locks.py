"""Per-email asyncio locks serializing admin user-creation flows (B31, #101).

Two concurrent admin requests for the SAME email can interleave the
pre-check -> remote create/reconcile (+credential rotation) -> local link
sequence so that one request's 201 reports a password the other request
has already rotated away. Serializing per normalized email removes the
race. Single-process deployment assumption, exactly like LoginThrottle's;
multi-process coordination is explicitly out of scope (spec §4).

Bounded-map hygiene mirrors the throttle: entries expire after
_ENTRY_TTL_SECONDS and the table is capped at _MAX_ENTRIES. Eviction is
reference-counted, not `Lock.locked()`-based: `locked()` flips false the
moment `release()` runs, even while queued waiters still reference the
lock, so a prune landing in that window could otherwise evict the entry
and let a third request mint a fresh lock (PR #105 review). An entry is
evictable only when NO acquire() call -- holder or waiter -- is inside
its context; in-flight admin requests bound how many entries are pinned.

Single-EVENT-LOOP assumption on top of the single-process one: a
contended asyncio.Lock binds to its loop and raises RuntimeError when
later contended from a different loop. Production uvicorn runs one loop;
tests that exercise contention must drive both requests inside one loop
(httpx.AsyncClient + ASGITransport, or a shared TestClient portal).
"""

import asyncio
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

_ENTRY_TTL_SECONDS = 900.0
_MAX_ENTRIES = 1024


class EmailLocks:
    def __init__(self) -> None:
        self._locks: dict[str, tuple[asyncio.Lock, float]] = {}
        # Holders + queued waiters per key; an entry with refs > 0 is
        # never evicted (see module docstring).
        self._refs: dict[str, int] = {}

    def _prune(self, now: float) -> None:
        expired = [
            key
            for key, (_lock, touched) in self._locks.items()
            if now - touched > _ENTRY_TTL_SECONDS and self._refs.get(key, 0) == 0
        ]
        for key in expired:
            del self._locks[key]
            self._refs.pop(key, None)
        if len(self._locks) > _MAX_ENTRIES:
            for key, (_lock, _touched) in sorted(
                self._locks.items(), key=lambda item: item[1][1]
            ):
                if len(self._locks) <= _MAX_ENTRIES:
                    break
                if self._refs.get(key, 0) == 0:
                    del self._locks[key]
                    self._refs.pop(key, None)

    @asynccontextmanager
    async def acquire(self, email: str) -> AsyncIterator[None]:
        key = email.strip().lower()
        now = time.monotonic()
        self._prune(now)
        entry = self._locks.get(key)
        lock = entry[0] if entry is not None else asyncio.Lock()
        self._locks[key] = (lock, now)
        self._refs[key] = self._refs.get(key, 0) + 1
        try:
            async with lock:
                yield
        finally:
            remaining = self._refs.get(key, 1) - 1
            if remaining > 0:
                self._refs[key] = remaining
            else:
                self._refs.pop(key, None)
