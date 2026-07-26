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
