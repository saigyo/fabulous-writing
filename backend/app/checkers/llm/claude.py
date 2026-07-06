from typing import Any

from .provider import ProgressCallback


class ClaudeProvider:
    """LLM provider backed by the Claude API (Anthropic SDK).

    Reads the API key from the ANTHROPIC_API_KEY environment variable unless
    a preconfigured client is injected (used in tests).
    """

    name = "claude"

    def __init__(self, model: str = "claude-sonnet-5", client: Any | None = None) -> None:
        self.model = model
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic()
        return self._client

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> str:
        kwargs: dict[str, Any] = dict(
            model=self.model,
            max_tokens=4096,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        if on_progress is not None:
            return await self._generate_streaming(kwargs, on_progress)
        response = await self._get_client().messages.create(**kwargs)
        return "".join(
            block.text for block in response.content if block.type == "text"
        )

    async def list_models(self) -> list[str]:
        # Anthropic lists newest first; keep that order (unlike the sorted
        # OpenAI-compat listings) so the best default surfaces on top.
        page = await self._get_client().models.list(limit=100)
        return [model.id for model in page.data]

    async def _generate_streaming(
        self, kwargs: dict[str, Any], on_progress: ProgressCallback
    ) -> str:
        parts: list[str] = []
        stream = await self._get_client().messages.create(**kwargs, stream=True)
        async for event in stream:
            if event.type == "content_block_delta" and event.delta.type == "text_delta":
                parts.append(event.delta.text)
            elif event.type == "message_delta":
                on_progress(event.usage.output_tokens)
        return "".join(parts)
