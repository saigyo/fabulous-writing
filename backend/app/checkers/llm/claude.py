from typing import Any

from .provider import (
    GenerationResult,
    MissingApiKeyError,
    ProgressCallback,
    TokenUsage,
    TruncatedResponseError,
)

# Sonnet 5 / Opus 5 run adaptive thinking by default and thinking tokens
# count against max_tokens, so the cap needs headroom well beyond the
# visible answer (a 4096 cap starved real responses mid-JSON in production).
# Only generated tokens are billed; the cap is a safety ceiling.
_MAX_TOKENS = 16384


def _max_tokens_for(model: str) -> int:
    """Legacy Claude 3.x models reject max_tokens above their output limits
    (4096 for claude-3-*, 8192 for claude-3-5-*) — and they don't think by
    default, so their original caps are also sufficient. claude-3-7 and
    everything after accept the full headroom."""
    if model.startswith("claude-3-5-"):
        return 8192
    if model.startswith("claude-3-7-"):
        return _MAX_TOKENS
    if model.startswith("claude-3-"):
        return 4096
    return _MAX_TOKENS


def _usage_of(source: Any) -> TokenUsage:
    """Read input/output token counts off an SDK usage object, tolerating
    absence — missing telemetry is never an error."""
    usage = getattr(source, "usage", None)
    return TokenUsage(
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
    )


def _truncated(
    response_chars: int, usage: TokenUsage, max_tokens: int
) -> TruncatedResponseError:
    exc = TruncatedResponseError(response_chars, max_tokens)
    exc.usage = usage
    return exc


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
            import os

            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise MissingApiKeyError(
                    "No API key for provider 'claude' — "
                    "set the ANTHROPIC_API_KEY environment variable."
                )
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic()
        return self._client

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> GenerationResult:
        max_tokens = _max_tokens_for(self.model)
        kwargs: dict[str, Any] = dict(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        if on_progress is not None:
            return await self._generate_streaming(kwargs, on_progress)
        response = await self._get_client().messages.create(**kwargs)
        text = "".join(
            block.text for block in response.content if block.type == "text"
        )
        if getattr(response, "stop_reason", None) == "max_tokens":
            raise _truncated(len(text), _usage_of(response), max_tokens)
        return GenerationResult(text=text, usage=_usage_of(response))

    async def list_models(self) -> list[str]:
        # Anthropic lists newest first; keep that order (unlike the sorted
        # OpenAI-compat listings) so the best default surfaces on top.
        page = await self._get_client().models.list(limit=100)
        return [model.id for model in page.data]

    async def _generate_streaming(
        self, kwargs: dict[str, Any], on_progress: ProgressCallback
    ) -> GenerationResult:
        parts: list[str] = []
        input_tokens: int | None = None
        output_tokens: int | None = None
        stop_reason: str | None = None
        stream = await self._get_client().messages.create(**kwargs, stream=True)
        async for event in stream:
            if event.type == "content_block_delta" and event.delta.type == "text_delta":
                parts.append(event.delta.text)
            elif event.type == "message_start":
                input_tokens = _usage_of(event.message).input_tokens
            elif event.type == "message_delta":
                # Cumulative; the last one is the final count.
                output_tokens = event.usage.output_tokens
                on_progress(event.usage.output_tokens)
                stop_reason = getattr(
                    getattr(event, "delta", None), "stop_reason", None
                ) or stop_reason
        usage = TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens)
        if stop_reason == "max_tokens":
            raise _truncated(len("".join(parts)), usage, kwargs["max_tokens"])
        return GenerationResult(text="".join(parts), usage=usage)
