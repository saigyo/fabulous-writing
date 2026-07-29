import json
from typing import Any

import httpx
import pytest

from app.checkers.llm.openai_compat import OpenAICompatProvider


def _sse(*payloads: Any) -> str:
    lines = [f"data: {json.dumps(p)}" if p != "[DONE]" else "data: [DONE]" for p in payloads]
    return "\n\n".join(lines) + "\n\n"


class TestGenerate:
    async def test_sends_chat_completions_request_and_returns_content(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            seen["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"role": "assistant", "content": "[]"}}]},
            )

        provider = OpenAICompatProvider(
            name="openai",
            base_url="https://api.test/v1",
            api_key="sk-test",
            model="gpt-5-mini",
            transport=httpx.MockTransport(handler),
        )
        result = await provider.generate("system prompt", "user prompt")

        assert result.text == "[]"
        assert seen["url"] == "https://api.test/v1/chat/completions"
        assert seen["auth"] == "Bearer sk-test"
        assert seen["body"]["model"] == "gpt-5-mini"
        assert seen["body"]["stream"] is False
        assert seen["body"]["messages"] == [
            {"role": "system", "content": "system prompt"},
            {"role": "user", "content": "user prompt"},
        ]

    async def test_missing_api_key_raises_clear_error(self) -> None:
        provider = OpenAICompatProvider(
            name="mistral",
            base_url="https://api.test/v1",
            api_key=None,
            model="mistral-small-latest",
        )
        with pytest.raises(RuntimeError, match="MISTRAL_API_KEY"):
            await provider.generate("s", "u")

    async def test_streams_sse_and_reports_progress(self) -> None:
        body = _sse(
            {"choices": [{"delta": {"role": "assistant"}}]},
            {"choices": [{"delta": {"content": "["}}]},
            {"choices": [{"delta": {"content": "]"}}]},
            {"choices": [], "usage": {"completion_tokens": 7}},
            "[DONE]",
        )

        def handler(request: httpx.Request) -> httpx.Response:
            assert json.loads(request.content)["stream"] is True
            return httpx.Response(
                200, content=body, headers={"content-type": "text/event-stream"}
            )

        provider = OpenAICompatProvider(
            name="openai",
            base_url="https://api.test/v1",
            api_key="sk-test",
            model="gpt-5-mini",
            transport=httpx.MockTransport(handler),
        )
        progress: list[int] = []
        result = await provider.generate("s", "u", on_progress=progress.append)

        assert result.text == "[]"
        # Chunk counts while streaming, exact usage from the final chunk.
        assert progress[-1] == 7
        assert progress[:-1] == [1, 2]


class TestListModels:
    async def test_lists_and_filters_models(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/models"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "gpt-5-mini"},
                        {"id": "text-embedding-3-small"},
                        {"id": "whisper-1"},
                        {"id": "gpt-4.1"},
                    ]
                },
            )

        provider = OpenAICompatProvider(
            name="openai",
            base_url="https://api.test/v1",
            api_key="sk-test",
            model="gpt-5-mini",
            transport=httpx.MockTransport(handler),
            exclude_models=("embedding", "whisper"),
        )
        assert await provider.list_models() == ["gpt-4.1", "gpt-5-mini"]

    async def test_deduplicates_repeated_ids(self) -> None:
        # Mistral's /v1/models lists some ids twice; duplicates would break
        # keyed rendering in the frontend model dropdown.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "mistral-large-latest"},
                        {"id": "mistral-medium"},
                        {"id": "mistral-large-latest"},
                        {"id": "mistral-medium"},
                    ]
                },
            )

        provider = OpenAICompatProvider(
            name="mistral",
            base_url="https://api.test/v1",
            api_key="sk-test",
            model="mistral-medium",
            transport=httpx.MockTransport(handler),
        )
        assert await provider.list_models() == [
            "mistral-large-latest",
            "mistral-medium",
        ]
