import json

import httpx

from .provider import ProgressCallback


class OllamaProvider:
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

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> str:
        payload = {
            "model": self.model,
            "stream": on_progress is not None,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if on_progress is not None:
            return await self._generate_streaming(payload, on_progress)
        async with self._client() as client:
            response = await client.post("/api/chat", json=payload)
            response.raise_for_status()
            return response.json()["message"]["content"]

    async def _generate_streaming(
        self, payload: dict, on_progress: ProgressCallback
    ) -> str:
        # Ollama streams one NDJSON object per generated token.
        parts: list[str] = []
        async with self._client() as client:
            async with client.stream("POST", "/api/chat", json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    parts.append(data.get("message", {}).get("content", ""))
                    on_progress(len(parts))
        return "".join(parts)

    async def list_models(self) -> list[str]:
        async with self._client() as client:
            response = await client.get("/api/tags")
            response.raise_for_status()
            return [m["name"] for m in response.json().get("models", [])]
