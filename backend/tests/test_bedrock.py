import asyncio
from typing import Any

from app.checkers.llm.bedrock import BedrockProvider


class _FakeRuntimeClient:
    def __init__(self, stream_events: list[dict[str, Any]] | None = None) -> None:
        self.kwargs: dict[str, Any] = {}
        self.stream_events = stream_events or []

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        self.kwargs = kwargs
        return {
            "output": {
                "message": {"role": "assistant", "content": [{"text": "[]"}]}
            }
        }

    def converse_stream(self, **kwargs: Any) -> dict[str, Any]:
        self.kwargs = kwargs
        return {"stream": iter(self.stream_events)}


class TestBedrockProvider:
    async def test_generate_uses_converse_and_returns_text(self) -> None:
        client = _FakeRuntimeClient()
        provider = BedrockProvider(model="eu.anthropic.claude-sonnet-4-5", client=client)

        result = await provider.generate("system prompt", "user prompt")

        assert result.text == "[]"
        assert client.kwargs["modelId"] == "eu.anthropic.claude-sonnet-4-5"
        assert client.kwargs["system"] == [{"text": "system prompt"}]
        assert client.kwargs["messages"] == [
            {"role": "user", "content": [{"text": "user prompt"}]}
        ]

    async def test_generate_streams_and_reports_progress(self) -> None:
        events = [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockDelta": {"delta": {"text": "["}}},
            {"contentBlockDelta": {"delta": {"text": "]"}}},
            {"metadata": {"usage": {"outputTokens": 5}}},
        ]
        client = _FakeRuntimeClient(stream_events=events)
        provider = BedrockProvider(model="m", client=client)

        progress: list[int] = []
        result = await provider.generate("s", "u", on_progress=progress.append)
        # Progress arrives via loop.call_soon_threadsafe from the worker
        # thread; give the loop one tick to drain callbacks that may still be
        # queued when generate() returns (flaked on slow CI runners).
        await asyncio.sleep(0)

        assert result.text == "[]"
        assert progress[-1] == 5
        assert progress[:-1] == [1, 2]
