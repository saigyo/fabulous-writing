"""Shared skeleton for HTTP chat-completion providers (Ollama, OpenAI-compat).

Both speak "POST a {model, stream, messages} payload; non-streaming returns
one JSON body; streaming yields lines". Subclasses supply the endpoint path,
the response/line parsers, and the configured httpx client.
"""

from abc import ABC, abstractmethod
from collections.abc import Iterable

import httpx

from .provider import ProgressCallback

# One parsed streaming line: ("content", text) appends and counts progress,
# ("tokens", n) reports an exact token count, ("done", "") ends the stream.
StreamEvent = tuple[str, str | int]


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
    ) -> str:
        payload = self._payload(system, user, stream=on_progress is not None)
        if on_progress is not None:
            return await self._generate_streaming(payload, on_progress)
        async with self._client() as client:
            response = await client.post(self._chat_path, json=payload)
            response.raise_for_status()
            return self._response_text(response.json())

    async def _generate_streaming(
        self, payload: dict, on_progress: ProgressCallback
    ) -> str:
        parts: list[str] = []
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
                        elif kind == "done":
                            done = True
                    if done:
                        break
        return "".join(parts)
