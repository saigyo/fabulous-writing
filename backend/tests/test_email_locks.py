"""EmailLocks (B31, #101): per-email serialization for admin user flows."""

import asyncio

import pytest

from app.core.email_locks import _ENTRY_TTL_SECONDS, _MAX_ENTRIES, EmailLocks


async def test_same_email_serializes():
    locks = EmailLocks()
    order: list[str] = []

    async def worker(tag: str, hold: float) -> None:
        async with locks.acquire("User@Example.com" if tag == "a" else "user@example.com"):
            order.append(f"{tag}-in")
            await asyncio.sleep(hold)
            order.append(f"{tag}-out")

    await asyncio.gather(worker("a", 0.05), worker("b", 0))
    # normalization makes these the SAME lock: no interleaving possible
    assert order == ["a-in", "a-out", "b-in", "b-out"]


async def test_different_emails_do_not_serialize():
    locks = EmailLocks()
    started = asyncio.Event()
    release = asyncio.Event()

    async def holder() -> None:
        async with locks.acquire("a@example.com"):
            started.set()
            await release.wait()

    async def other() -> None:
        await started.wait()
        async with locks.acquire("b@example.com"):
            release.set()  # only reachable if b's lock is independent

    await asyncio.wait_for(asyncio.gather(holder(), other()), timeout=2)


async def test_lock_released_on_exception():
    locks = EmailLocks()
    with pytest.raises(RuntimeError):
        async with locks.acquire("a@example.com"):
            raise RuntimeError("boom")
    async with locks.acquire("a@example.com"):  # must not deadlock
        pass


async def test_expired_unheld_entries_are_pruned(monkeypatch):
    locks = EmailLocks()
    async with locks.acquire("old@example.com"):
        pass
    # age the entry past TTL, then touch another email to trigger pruning
    key = "old@example.com"
    lock, ts = locks._locks[key]
    locks._locks[key] = (lock, ts - _ENTRY_TTL_SECONDS - 1)
    async with locks.acquire("new@example.com"):
        pass
    assert key not in locks._locks


async def test_cap_never_evicts_a_held_lock():
    locks = EmailLocks()
    async with locks.acquire("held@example.com"):
        for i in range(_MAX_ENTRIES + 5):
            async with locks.acquire(f"u{i}@example.com"):
                pass
        assert "held@example.com" in locks._locks


async def test_cap_pressure_never_evicts_entry_with_queued_waiter(monkeypatch):
    """The release-to-reacquire window (PR #105 review): Lock.locked() is
    False the instant release() runs, while the woken waiter has not yet
    re-acquired. A prune in that window must NOT evict the entry -- a
    third request would mint a fresh lock and same-email operations would
    overlap. Reference counting (holders + waiters) is what prevents it.
    """
    locks = EmailLocks()
    key = "contended@example.com"
    order: list[str] = []
    release_holder = asyncio.Event()

    async def holder() -> None:
        async with locks.acquire(key):
            order.append("a-in")
            await release_holder.wait()
        order.append("a-out")

    async def waiter() -> None:
        async with locks.acquire(key):
            order.append("b-in")

    task_a = asyncio.create_task(holder())
    await asyncio.sleep(0)  # holder acquires
    task_b = asyncio.create_task(waiter())
    await asyncio.sleep(0)  # waiter queues on the SAME lock
    lock_before = locks._locks[key][0]
    assert lock_before.locked()  # sanity: currently held

    release_holder.set()
    await asyncio.sleep(0)  # holder releases and exits; waiter woken, NOT resumed
    assert order == ["a-in", "a-out"]
    assert not lock_before.locked()  # the exact window the refcount guards

    # simulate cap pressure landing inside the window
    monkeypatch.setattr("app.core.email_locks._MAX_ENTRIES", 0)
    locks._prune(999_999_999.0)
    assert key in locks._locks, "entry with a queued waiter was evicted"
    assert locks._locks[key][0] is lock_before

    await asyncio.gather(task_a, task_b)
    assert order == ["a-in", "a-out", "b-in"]
