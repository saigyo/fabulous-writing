from dataclasses import dataclass
from typing import Callable, Protocol

# Called with the cumulative number of generated output tokens (approximate
# for providers that only expose chunk counts).
ProgressCallback = Callable[[int], None]


@dataclass(frozen=True)
class TokenUsage:
    """Exact counts reported by the provider API. None means "not reported"
    — never 0, which is a real reported value."""

    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class GenerationResult:
    text: str
    usage: TokenUsage


class MissingApiKeyError(RuntimeError):
    """No API key configured for a provider. Its own type so failure
    classification can file it as a 'request'-stage error without matching
    on message text."""


class LLMProvider(Protocol):
    """A pluggable LLM backend for the checking pipeline."""

    name: str

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        """Return the raw model response plus reported token usage.

        When `on_progress` is given, providers stream the response and report
        cumulative output tokens as they arrive. A provider that cannot find
        usage in a response returns TokenUsage(None, None) — missing
        telemetry is never an error.
        """
        ...


class FakeProvider:
    """Canned-response provider for tests and offline development."""

    name = "fake"

    def __init__(
        self,
        response: str,
        progress_steps: list[int] | None = None,
        usage: TokenUsage | None = None,
    ) -> None:
        self.response = response
        self.progress_steps = progress_steps or []
        # `is not None`, not `or`: None means "not configured" everywhere in
        # this module and must not be conflated with falsiness.
        self.usage = usage if usage is not None else TokenUsage()
        self.calls: list[tuple[str, str]] = []

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        self.calls.append((system, user))
        if on_progress is not None:
            for step in self.progress_steps:
                on_progress(step)
        return GenerationResult(text=self.response, usage=self.usage)
