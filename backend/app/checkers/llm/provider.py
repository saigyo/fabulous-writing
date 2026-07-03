from typing import Protocol


class LLMProvider(Protocol):
    """A pluggable LLM backend for the checking pipeline."""

    name: str

    async def generate(self, system: str, user: str) -> str:
        """Return the raw model response for a system+user prompt."""
        ...


class FakeProvider:
    """Canned-response provider for tests and offline development."""

    name = "fake"

    def __init__(self, response: str) -> None:
        self.response = response
        self.calls: list[tuple[str, str]] = []

    async def generate(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.response
