import asyncio
from typing import Any

from .provider import ProgressCallback


def credentials_available() -> bool:
    """Whether the standard AWS credential chain resolves any credentials."""
    try:
        import boto3

        return boto3.Session().get_credentials() is not None
    except Exception:
        return False


def discover_models(region: str | None) -> list[str]:
    """Invokable model ids: on-demand foundation models + inference profiles.

    Newer models are often only invokable through cross-region inference
    profiles (ids like ``eu.anthropic…``), so both listings are merged.
    """
    import boto3

    client = boto3.client("bedrock", region_name=region)
    models = {
        entry["modelId"]
        for entry in client.list_foundation_models(
            byOutputModality="TEXT", byInferenceType="ON_DEMAND"
        )["modelSummaries"]
    }
    try:
        profiles = client.list_inference_profiles()["inferenceProfileSummaries"]
        models.update(profile["inferenceProfileId"] for profile in profiles)
    except Exception:
        pass
    return sorted(models)


class BedrockProvider:
    """LLM provider backed by AWS Bedrock's Converse API.

    The Converse API gives one request/response shape across model families
    (Claude, Mistral, Llama, Nova, …). Credentials come from the standard
    AWS chain (env, profile, instance role); the region from configuration
    or the AWS default. boto3 is synchronous, so calls run in a worker
    thread and stream progress is forwarded thread-safely into the loop.
    """

    name = "bedrock"

    def __init__(
        self,
        model: str,
        region: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.model = model
        self.region = region
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            import boto3

            self._client = boto3.client("bedrock-runtime", region_name=self.region)
        return self._client

    def _converse_kwargs(self, system: str, user: str) -> dict[str, Any]:
        return {
            "modelId": self.model,
            "system": [{"text": system}],
            "messages": [{"role": "user", "content": [{"text": user}]}],
        }

    async def generate(
        self, system: str, user: str, on_progress: ProgressCallback | None = None
    ) -> str:
        kwargs = self._converse_kwargs(system, user)
        if on_progress is not None:
            loop = asyncio.get_running_loop()

            def report(tokens: int) -> None:
                loop.call_soon_threadsafe(on_progress, tokens)

            return await asyncio.to_thread(self._stream_sync, kwargs, report)
        response = await asyncio.to_thread(lambda: self._get_client().converse(**kwargs))
        blocks = response["output"]["message"]["content"]
        return "".join(block.get("text", "") for block in blocks)

    def _stream_sync(self, kwargs: dict[str, Any], report: ProgressCallback) -> str:
        parts: list[str] = []
        response = self._get_client().converse_stream(**kwargs)
        for event in response["stream"]:
            if "contentBlockDelta" in event:
                text = event["contentBlockDelta"]["delta"].get("text", "")
                if text:
                    parts.append(text)
                    report(len(parts))
            elif "metadata" in event:
                tokens = event["metadata"].get("usage", {}).get("outputTokens")
                if tokens is not None:
                    report(tokens)
        return "".join(parts)
