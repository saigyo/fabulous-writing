"""Shared skeleton for HTTP chat-completion providers (Ollama, OpenAI-compat).

Both speak "POST a {model, stream, messages} payload; non-streaming returns
one JSON body; streaming yields lines". Subclasses supply the endpoint path,
the response/line parsers, and the configured httpx client.
"""

from abc import ABC, abstractmethod
from collections.abc import Iterable

import httpx

from .provider import GenerationResult, ProgressCallback, TokenUsage

# One parsed streaming line: ("content", text) appends and counts progress,
# ("tokens", n) reports an exact output-token count for progress,
# ("usage", TokenUsage) carries the final reported usage,
# ("done", "") ends the stream.
StreamEvent = tuple[str, str | int | TokenUsage]


class HttpChatProvider(ABC):
    model: str

    @abstractmethod
    def _client(self) -> httpx.AsyncClient: ...

    @property
    def _chat_path(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def _response_text(self, data: dict) -> str:
        """Extract the message text from a non-streaming response body."""

    def _response_usage(self, data: dict) -> TokenUsage:
        """Extract reported usage from a non-streaming response body.
        Default: nothing reported."""
        return TokenUsage()

    @abstractmethod
    def _stream_events(self, line: str) -> Iterable[StreamEvent]:
        """Parse one streamed line into events (may yield nothing)."""

    def _payload(self, system: str, user: str, stream: bool) -> dict:
        return {
            "model": self.model,
            "stream": stream,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        payload = self._payload(system, user, stream=on_progress is not None)
        if on_progress is not None:
            return await self._generate_streaming(payload, on_progress)
        async with self._client() as client:
            response = await client.post(self._chat_path, json=payload)
            response.raise_for_status()
            data = response.json()
            return GenerationResult(
                text=self._response_text(data), usage=self._response_usage(data)
            )

    async def _generate_streaming(
        self, payload: dict, on_progress: ProgressCallback
    ) -> GenerationResult:
        parts: list[str] = []
        usage = TokenUsage()
        async with self._client() as client:
            async with client.stream("POST", self._chat_path, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    done = False
                    for kind, value in self._stream_events(line):
                        if kind == "content":
                            parts.append(str(value))
                            on_progress(len(parts))
                        elif kind == "tokens":
                            on_progress(int(value))
                        elif kind == "usage":
                            usage = value  # always a TokenUsage (StreamEvent contract)
                        elif kind == "done":
                            done = True
                    if done:
                        break
        return GenerationResult(text="".join(parts), usage=usage)
