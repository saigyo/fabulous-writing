import json
from typing import Any

import httpx
import pytest

from app.checkers.llm.claude import ClaudeProvider
from app.checkers.llm.ollama import OllamaProvider
from app.checkers.llm.provider import TokenUsage, TruncatedResponseError


class TestOllamaProvider:
    async def test_generate_sends_chat_request_and_returns_content(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.content)
            return httpx.Response(
                200, json={"message": {"role": "assistant", "content": "[]"}}
            )

        transport = httpx.MockTransport(handler)
        provider = OllamaProvider(
            base_url="http://ollama.test", model="llama3.1", transport=transport
        )
        result = await provider.generate("system prompt", "user prompt")

        assert result.text == "[]"
        assert seen["url"] == "http://ollama.test/api/chat"
        assert seen["body"]["model"] == "llama3.1"
        assert seen["body"]["stream"] is False
        assert seen["body"]["messages"][0] == {
            "role": "system",
            "content": "system prompt",
        }
        assert seen["body"]["messages"][1]["role"] == "user"

    async def test_list_models_queries_tags(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/tags"
            return httpx.Response(
                200, json={"models": [{"name": "llama3.1"}, {"name": "mistral"}]}
            )

        provider = OllamaProvider(
            base_url="http://ollama.test",
            model="llama3.1",
            transport=httpx.MockTransport(handler),
        )
        assert await provider.list_models() == ["llama3.1", "mistral"]

    async def test_generate_extracts_usage_counts(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "message": {"role": "assistant", "content": "[]"},
                    "prompt_eval_count": 120,
                    "eval_count": 30,
                },
            )

        provider = OllamaProvider(
            base_url="http://ollama.test", model="llama3.1",
            transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=120, output_tokens=30)

    async def test_generate_without_usage_reports_none(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"message": {"role": "assistant", "content": "[]"}}
            )

        provider = OllamaProvider(
            base_url="http://ollama.test", model="llama3.1",
            transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=None, output_tokens=None)


class _StubMessages:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] = {}

    async def create(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs

        class Block:
            type = "text"
            text = "[]"

        class Response:
            content = [Block()]

        return Response()


class _StubAnthropicClient:
    def __init__(self) -> None:
        self.messages = _StubMessages()


class _StubModels:
    async def list(self, **kwargs: Any) -> Any:
        assert kwargs == {"limit": 100}

        class Model:
            def __init__(self, id: str) -> None:
                self.id = id

        class Page:
            data = [Model("claude-sonnet-5"), Model("claude-opus-4-8")]

        return Page()


class TestClaudeProvider:
    async def test_list_models_queries_models_api_in_order(self) -> None:
        class Client:
            models = _StubModels()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        # API order is preserved (Anthropic lists newest first).
        assert await provider.list_models() == ["claude-sonnet-5", "claude-opus-4-8"]

    async def test_generate_passes_prompts_and_returns_text(self) -> None:
        stub = _StubAnthropicClient()
        provider = ClaudeProvider(model="claude-sonnet-5", client=stub)
        result = await provider.generate("system prompt", "user prompt")

        assert result.text == "[]"
        assert stub.messages.kwargs["model"] == "claude-sonnet-5"
        assert stub.messages.kwargs["system"] == "system prompt"
        assert stub.messages.kwargs["messages"] == [
            {"role": "user", "content": "user prompt"}
        ]
        assert result.usage == TokenUsage()

    async def test_missing_api_key_raises_clear_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        provider = ClaudeProvider(model="claude-sonnet-5")
        with pytest.raises(RuntimeError, match="ANTHROPIC_API_KEY"):
            await provider.generate("s", "u")

    async def test_generate_extracts_usage(self) -> None:
        class Usage:
            input_tokens = 55
            output_tokens = 9

        class Block:
            type = "text"
            text = "[]"

        class Response:
            content = [Block()]
            usage = Usage()

        class Messages:
            async def create(self, **kwargs: Any) -> Any:
                return Response()

        class Client:
            messages = Messages()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        result = await provider.generate("s", "u")
        assert result.usage == TokenUsage(input_tokens=55, output_tokens=9)

    async def test_generate_requests_headroom_for_thinking(self) -> None:
        # Sonnet 5 / Opus 5 run adaptive thinking by default and thinking
        # tokens count against max_tokens; a 4096 cap starved the visible
        # answer mid-JSON (every failed prod run settled at exactly 4096).
        stub = _StubAnthropicClient()
        provider = ClaudeProvider(model="claude-sonnet-5", client=stub)
        await provider.generate("s", "u")
        assert stub.messages.kwargs["max_tokens"] >= 16384

    async def test_truncated_response_raises_with_usage(self) -> None:
        class Usage:
            input_tokens = 12
            output_tokens = 4096

        class Block:
            type = "text"
            text = '{"findings": [{"cat'

        class Response:
            content = [Block()]
            usage = Usage()
            stop_reason = "max_tokens"

        class Messages:
            async def create(self, **kwargs: Any) -> Any:
                return Response()

        class Client:
            messages = Messages()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        with pytest.raises(TruncatedResponseError) as excinfo:
            await provider.generate("s", "u")
        # The usage the API reported still settles on the failed run.
        assert excinfo.value.usage == TokenUsage(input_tokens=12, output_tokens=4096)
        assert "max_tokens" in str(excinfo.value)
        assert "findings" not in str(excinfo.value)  # metadata only, never text


class TestOllamaStreaming:
    async def test_generate_streams_and_reports_progress(self) -> None:
        chunks = [
            {"message": {"content": "["}, "done": False},
            {"message": {"content": '"a"'}, "done": False},
            {"message": {"content": "]"}, "done": True},
        ]
        body = "\n".join(json.dumps(c) for c in chunks)

        def handler(request: httpx.Request) -> httpx.Response:
            assert json.loads(request.content)["stream"] is True
            return httpx.Response(200, text=body)

        provider = OllamaProvider(
            base_url="http://ollama.test",
            model="llama3.1",
            transport=httpx.MockTransport(handler),
        )
        progress: list[int] = []
        result = await provider.generate("s", "u", on_progress=progress.append)
        assert result.text == '["a"]'
        assert progress == [1, 2, 3]

    async def test_streaming_extracts_usage_from_final_chunk(self) -> None:
        chunks = [
            {"message": {"content": "["}, "done": False},
            {"message": {"content": "]"}, "done": True,
             "prompt_eval_count": 80, "eval_count": 2},
        ]
        body = "\n".join(json.dumps(c) for c in chunks)
        provider = OllamaProvider(
            base_url="http://ollama.test", model="llama3.1",
            transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body)),
        )
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.text == "[]"
        assert result.usage == TokenUsage(input_tokens=80, output_tokens=2)


class _StubStreamingMessages:
    async def create(self, **kwargs: Any) -> Any:
        assert kwargs["stream"] is True

        class Delta:
            type = "text_delta"
            text = ""

        def event(
            kind: str, text: str = "", tokens: int | None = None,
            input_tokens: int | None = None,
        ) -> Any:
            class Event:
                type = kind

            e = Event()
            if kind == "content_block_delta":
                d = Delta()
                d.text = text
                e.delta = d
            if kind == "message_start":
                class Usage:
                    pass

                usage = Usage()
                usage.input_tokens = input_tokens

                class Message:
                    pass

                message = Message()
                message.usage = usage
                e.message = message
            if tokens is not None:
                class Usage:
                    output_tokens = tokens

                e.usage = Usage()
            return e

        async def stream() -> Any:
            yield event("message_start", input_tokens=44)
            yield event("content_block_delta", "[")
            yield event("message_delta", tokens=7)
            yield event("content_block_delta", "]")
            yield event("message_delta", tokens=12)

        return stream()


class TestClaudeStreaming:
    async def test_generate_streams_and_reports_progress(self) -> None:
        class Client:
            messages = _StubStreamingMessages()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        progress: list[int] = []
        result = await provider.generate("s", "u", on_progress=progress.append)
        assert result.text == "[]"
        assert progress == [7, 12]

    async def test_streaming_extracts_usage(self) -> None:
        class Client:
            messages = _StubStreamingMessages()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        result = await provider.generate("s", "u", on_progress=lambda n: None)
        assert result.usage == TokenUsage(input_tokens=44, output_tokens=12)

    async def test_streaming_truncation_raises_with_usage(self) -> None:
        class Messages:
            async def create(self, **kwargs: Any) -> Any:
                assert kwargs["stream"] is True

                class StartUsage:
                    input_tokens = 44

                class StartMessage:
                    usage = StartUsage()

                class Start:
                    type = "message_start"
                    message = StartMessage()

                class TextDelta:
                    type = "text_delta"
                    text = '{"findings": ['

                class ContentDelta:
                    type = "content_block_delta"
                    delta = TextDelta()

                class FinalDelta:
                    stop_reason = "max_tokens"

                class FinalUsage:
                    output_tokens = 4096

                class Final:
                    type = "message_delta"
                    delta = FinalDelta()
                    usage = FinalUsage()

                async def stream() -> Any:
                    yield Start()
                    yield ContentDelta()
                    yield Final()

                return stream()

        class Client:
            messages = Messages()

        provider = ClaudeProvider(model="claude-sonnet-5", client=Client())
        with pytest.raises(TruncatedResponseError) as excinfo:
            await provider.generate("s", "u", on_progress=lambda n: None)
        assert excinfo.value.usage == TokenUsage(input_tokens=44, output_tokens=4096)
        assert "findings" not in str(excinfo.value)  # metadata only, never text
