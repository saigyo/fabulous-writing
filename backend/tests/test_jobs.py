"""Unit tests for the in-memory job store's retention behavior.

Exercises JobManager directly with plain int owner ids and small MAX_JOBS /
MAX_JOBS_PER_OWNER values (monkeypatched), rather than spinning up many real
users through the API.
"""

import pytest

from app.services import jobs as jobs_module
from app.services.jobs import JobManager, JobsAtCapacity


def test_global_backstop_evicts_oldest_finished_job_never_a_running_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Pins the fix: the global backstop used to evict the global oldest job
    # regardless of status, so a foreign owner's still-running check could
    # be evicted out from under it. It must instead skip running jobs and
    # take the oldest *finished* one.
    monkeypatch.setattr(jobs_module, "MAX_JOBS", 3)
    monkeypatch.setattr(jobs_module, "MAX_JOBS_PER_OWNER", 3)
    manager = JobManager()

    running = manager.create(owner_id=1)  # oldest overall, but never finishes
    finished_old = manager.create(owner_id=2)
    finished_old.finish()
    finished_new = manager.create(owner_id=3)
    finished_new.finish()
    # Store is now at MAX_JOBS (3). A fourth owner's check pushes it over.

    manager.create(owner_id=4)

    assert manager.get(running.id, owner_id=1) is not None  # running: never evicted
    assert manager.get(finished_old.id, owner_id=2) is None  # oldest finished: evicted
    assert manager.get(finished_new.id, owner_id=3) is not None  # newer finished: kept


def test_create_refuses_when_at_capacity_with_every_job_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(jobs_module, "MAX_JOBS", 3)
    monkeypatch.setattr(jobs_module, "MAX_JOBS_PER_OWNER", 3)
    manager = JobManager()

    manager.create(owner_id=1)
    manager.create(owner_id=2)
    manager.create(owner_id=3)  # store now at MAX_JOBS, all three running

    with pytest.raises(JobsAtCapacity):
        manager.create(owner_id=4)

    # The refused attempt left no trace in the store.
    assert len(manager._jobs) == 3


def test_per_owner_trim_evicts_oldest_finished_never_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Pins the fix: per-owner trim must evict the owner's oldest *finished*
    # job, never a running one. This keeps a user's live checks reachable
    # even when they flood with submissions.
    monkeypatch.setattr(jobs_module, "MAX_JOBS_PER_OWNER", 3)
    manager = JobManager()

    finished_old = manager.create(owner_id=1)
    finished_old.finish()
    running_b = manager.create(owner_id=1)
    running_c = manager.create(owner_id=1)
    # Owner 1 now has 3 jobs (oldest is finished, rest running).

    running_d = manager.create(owner_id=1)

    assert manager.get(finished_old.id, owner_id=1) is None  # oldest finished: evicted
    assert manager.get(running_b.id, owner_id=1) is not None  # running: kept
    assert manager.get(running_c.id, owner_id=1) is not None  # running: kept
    assert manager.get(running_d.id, owner_id=1) is not None  # newly created: kept


def test_per_owner_trim_refuses_when_owner_at_capacity_with_all_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Pins the fix: when an owner is at MAX_JOBS_PER_OWNER with only
    # running jobs, new submissions are refused rather than displacing
    # a live check.
    monkeypatch.setattr(jobs_module, "MAX_JOBS_PER_OWNER", 2)
    manager = JobManager()

    running_a = manager.create(owner_id=1)
    running_b = manager.create(owner_id=1)
    # Owner 1 now has 2 jobs, both running.

    with pytest.raises(JobsAtCapacity):
        manager.create(owner_id=1)

    # The refused attempt left no trace, and the two running jobs remain.
    assert len(manager._jobs) == 2
    assert manager.get(running_a.id, owner_id=1) is not None
    assert manager.get(running_b.id, owner_id=1) is not None
