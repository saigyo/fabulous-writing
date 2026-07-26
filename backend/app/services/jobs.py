import asyncio
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator
from typing import Any

from app.core.models import Finding, Scorecard

MAX_JOBS = 100


class CheckJob:
    def __init__(self, job_id: str, owner_id: int) -> None:
        self.id = job_id
        self.owner_id = owner_id
        self.status = "running"
        self.findings: list[Finding] = []
        self.skipped_rules: list[str] = []
        self.scorecard: Scorecard | None = None
        self.events: list[tuple[str, dict[str, Any]]] = []
        self._task: asyncio.Task[None] | None = None
        self._new_event = asyncio.Event()

    def emit(self, name: str, data: dict[str, Any]) -> None:
        self.events.append((name, data))
        self._new_event.set()

    def add_findings(self, checker: str, findings: list[Finding]) -> None:
        self.findings.extend(findings)
        self.emit(
            "checker_result",
            {
                "checker": checker,
                "findings": [f.model_dump(mode="json") for f in findings],
            },
        )

    def set_scorecard(self, scorecard: Scorecard) -> None:
        self.scorecard = scorecard
        self.emit("scorecard", scorecard.model_dump(mode="json"))

    def finish(self) -> None:
        self.status = "done"
        self.emit("done", {"status": self.status})

    def attach_task(self, task: asyncio.Task[None]) -> None:
        self._task = task

    async def stream(self) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Yield all events (replaying history), ending after 'done'."""
        index = 0
        while True:
            while index < len(self.events):
                name, data = self.events[index]
                index += 1
                yield name, data
                if name == "done":
                    return
            self._new_event.clear()
            if index < len(self.events):
                continue
            await self._new_event.wait()


class JobManager:
    def __init__(self) -> None:
        self._jobs: OrderedDict[str, CheckJob] = OrderedDict()

    def create(self, owner_id: int) -> CheckJob:
        job = CheckJob(str(uuid.uuid4()), owner_id)
        self._jobs[job.id] = job
        while len(self._jobs) > MAX_JOBS:
            self._jobs.popitem(last=False)
        return job

    def get(self, job_id: str, *, owner_id: int) -> CheckJob | None:
        job = self._jobs.get(job_id)
        # A foreign job answers exactly like a missing one: check results
        # quote spans of the document text, and a UUID in a URL is not an
        # authorization boundary.
        if job is None or job.owner_id != owner_id:
            return None
        return job
