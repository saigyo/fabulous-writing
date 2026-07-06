import json

import httpx

from .provider import ProgressCallback


class OpenAICompatProvider:
    """LLM provider for OpenAI-compatible chat-completions APIs.

    Covers OpenAI and Mistral (and any other endpoint speaking the same
    protocol): `POST {base}/chat/completions` with SSE streaming and
    `GET {base}/models` for discovery. The API key comes from the
    environment (never stored); a missing key fails with a clear message.
    """

    def __init__(
        self,
        name: str,
        base_url: str,
        api_key: str | None,
        model: str,
        transport: httpx.AsyncBaseTransport | None = None,
        exclude_models: tuple[str, ...] = (),
    ) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.exclude_models = exclude_models
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        if not self.api_key:
            raise RuntimeError(
                f"No API key for provider '{self.name}' — "
                f"set the {self.name.upper()}_API_KEY environment variable."
            )
        return httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            transport=self._transport,
            timeout=300.0,
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
            response = await client.post("/chat/completions", json=payload)
            response.raise_for_status()
            return response.json()["choices"][0]["message"]["content"]

    async def _generate_streaming(
        self, payload: dict, on_progress: ProgressCallback
    ) -> str:
        # SSE: one `data: {json}` line per chunk, terminated by `data: [DONE]`.
        # Progress is chunk-counted (≈ tokens); a final usage chunk, when the
        # server sends one, corrects it to the exact output-token count.
        parts: list[str] = []
        async with self._client() as client:
            async with client.stream(
                "POST", "/chat/completions", json=payload
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[len("data: ") :]
                    if data.strip() == "[DONE]":
                        break
                    chunk = json.loads(data)
                    usage = chunk.get("usage")
                    if usage and usage.get("completion_tokens") is not None:
                        on_progress(usage["completion_tokens"])
                        continue
                    choices = chunk.get("choices") or []
                    content = choices[0].get("delta", {}).get("content") if choices else None
                    if content:
                        parts.append(content)
                        on_progress(len(parts))
        return "".join(parts)

    async def list_models(self) -> list[str]:
        async with self._client() as client:
            response = await client.get("/models")
            response.raise_for_status()
            ids = [entry["id"] for entry in response.json()["data"]]
        # Some endpoints (e.g. Mistral) list the same id more than once.
        return sorted(
            {
                model
                for model in ids
                if not any(fragment in model for fragment in self.exclude_models)
            }
        )
