import asyncio
from typing import Any

from app.checkers.llm.bedrock import BedrockProvider
from app.checkers.llm.provider import TokenUsage


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
        assert result.usage == TokenUsage()

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
        assert result.usage == TokenUsage(input_tokens=None, output_tokens=5)

    async def test_generate_extracts_usage(self) -> None:
        class Client(_FakeRuntimeClient):
            def converse(self, **kwargs: Any) -> dict[str, Any]:
                response = super().converse(**kwargs)
                response["usage"] = {"inputTokens": 70, "outputTokens": 5}
                return response

        provider = BedrockProvider(model="m", client=Client())
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=70, output_tokens=5)

    async def test_streaming_extracts_usage(self) -> None:
        events = [
            {"contentBlockDelta": {"delta": {"text": "[]"}}},
            {"metadata": {"usage": {"inputTokens": 66, "outputTokens": 5}}},
        ]
        provider = BedrockProvider(
            model="m", client=_FakeRuntimeClient(stream_events=events)
        )
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.usage == TokenUsage(input_tokens=66, output_tokens=5)
