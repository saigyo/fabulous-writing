import json
from typing import Any

import httpx

from app.checkers.llm.claude import ClaudeProvider
from app.checkers.llm.ollama import OllamaProvider


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

        assert result == "[]"
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


class TestClaudeProvider:
    async def test_generate_passes_prompts_and_returns_text(self) -> None:
        stub = _StubAnthropicClient()
        provider = ClaudeProvider(model="claude-sonnet-5", client=stub)
        result = await provider.generate("system prompt", "user prompt")

        assert result == "[]"
        assert stub.messages.kwargs["model"] == "claude-sonnet-5"
        assert stub.messages.kwargs["system"] == "system prompt"
        assert stub.messages.kwargs["messages"] == [
            {"role": "user", "content": "user prompt"}
        ]


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
        assert result == '["a"]'
        assert progress == [1, 2, 3]


class _StubStreamingMessages:
    async def create(self, **kwargs: Any) -> Any:
        assert kwargs["stream"] is True

        class Delta:
            type = "text_delta"
            text = ""

        def event(kind: str, text: str = "", tokens: int | None = None) -> Any:
            class Event:
                type = kind

            e = Event()
            if kind == "content_block_delta":
                d = Delta()
                d.text = text
                e.delta = d
            if tokens is not None:
                class Usage:
                    output_tokens = tokens

                e.usage = Usage()
            return e

        async def stream() -> Any:
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
        assert result == "[]"
        assert progress == [7, 12]
