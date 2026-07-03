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
