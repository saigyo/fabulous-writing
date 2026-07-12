import json
from collections.abc import Iterable

import httpx

from ._http_chat import HttpChatProvider, StreamEvent


class OllamaProvider(HttpChatProvider):
    """LLM provider backed by a local Ollama server."""

    name = "ollama"

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "llama3.1",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url, transport=self._transport, timeout=300.0
        )

    _chat_path = "/api/chat"

    def _response_text(self, data: dict) -> str:
        return data["message"]["content"]

    def _stream_events(self, line: str) -> Iterable[StreamEvent]:
        # Ollama streams one NDJSON object per generated token; every parsed
        # line appends (even empty content), matching the pre-refactor
        # progress counting exactly.
        if not line.strip():
            return
        data = json.loads(line)
        yield ("content", data.get("message", {}).get("content", ""))

    async def list_models(self) -> list[str]:
        async with self._client() as client:
            response = await client.get("/api/tags")
            response.raise_for_status()
            return [m["name"] for m in response.json().get("models", [])]
