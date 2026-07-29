import json
from collections.abc import Iterable

import httpx

from ._http_chat import HttpChatProvider, StreamEvent
from .provider import MissingApiKeyError, TokenUsage


class OpenAICompatProvider(HttpChatProvider):
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
            raise MissingApiKeyError(
                f"No API key for provider '{self.name}' — "
                f"set the {self.name.upper()}_API_KEY environment variable."
            )
        return httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            transport=self._transport,
            timeout=300.0,
        )

    _chat_path = "/chat/completions"

    def _payload(self, system: str, user: str, stream: bool) -> dict:
        payload = super()._payload(system, user, stream)
        if stream and self.name in ("openai", "mistral"):
            # OpenAI sends the final usage chunk only when asked; Mistral
            # accepts the option too. Configured extra compat endpoints are
            # left untouched — some reject unknown fields, and a rejected
            # request would fail a previously-working deployment. They just
            # lack streaming usage telemetry.
            payload["stream_options"] = {"include_usage": True}
        return payload

    def _response_text(self, data: dict) -> str:
        return data["choices"][0]["message"]["content"]

    def _response_usage(self, data: dict) -> TokenUsage:
        usage = data.get("usage") or {}
        return TokenUsage(
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )

    def _stream_events(self, line: str) -> Iterable[StreamEvent]:
        # SSE: one `data: {json}` line per chunk, `data: [DONE]` terminates.
        # Progress is chunk-counted (≈ tokens); a final usage chunk, when
        # present, corrects it to the exact output-token count.
        if not line.startswith("data: "):
            return
        data = line[len("data: ") :]
        if data.strip() == "[DONE]":
            yield ("done", "")
            return
        chunk = json.loads(data)
        usage = chunk.get("usage")
        if usage:
            if usage.get("completion_tokens") is not None:
                yield ("tokens", usage["completion_tokens"])
            yield ("usage", self._response_usage(chunk))
        # Deliberately not `elif`/early-return: some endpoints pack the final
        # content delta into the same chunk that also carries usage, so the
        # choices/content check below must still run on a usage chunk.
        choices = chunk.get("choices") or []
        content = choices[0].get("delta", {}).get("content") if choices else None
        if content:
            yield ("content", content)

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
