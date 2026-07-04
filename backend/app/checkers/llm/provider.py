from typing import Callable, Protocol

# Called with the cumulative number of generated output tokens (approximate
# for providers that only expose chunk counts).
ProgressCallback = Callable[[int], None]


class LLMProvider(Protocol):
    """A pluggable LLM backend for the checking pipeline."""

    name: str

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> str:
        """Return the raw model response for a system+user prompt.

        When `on_progress` is given, providers stream the response and report
        cumulative output tokens as they arrive.
        """
        ...


class FakeProvider:
    """Canned-response provider for tests and offline development."""

    name = "fake"

    def __init__(self, response: str, progress_steps: list[int] | None = None) -> None:
        self.response = response
        self.progress_steps = progress_steps or []
        self.calls: list[tuple[str, str]] = []

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> str:
        self.calls.append((system, user))
        if on_progress is not None:
            for step in self.progress_steps:
                on_progress(step)
        return self.response
