from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.checkers.llm import bedrock
from app.core.config import ExtraProviderSettings, ProviderSettings, Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    for key in (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "MISTRAL_API_KEY",
        "DEEPSEEK_API_KEY",
        "GEMINI_API_KEY",
        "QWEN_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(bedrock, "credentials_available", lambda: False)
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        providers=ProviderSettings(
            ollama_base_url="http://127.0.0.1:9",
            extra_providers={
                "deepseek": ExtraProviderSettings(
                    base_url="http://127.0.0.1:9/v1",
                    default_model="deepseek-v4-pro",
                )
            },
        ),
    )
    return TestClient(create_app(settings))


def test_routing_shape(client: TestClient) -> None:
    body = client.get("/api/routing").json()
    assert body["default_tier"] == "balanced"
    assert body["tiers"] == ["quality", "balanced", "cheap", "local"]
    assert set(body["languages"]) == {"en", "de", "fr", "es", "it", "ja", "zh"}
    entry = body["languages"]["de"]["balanced"]
    assert entry["provider"] == "mistral"
    assert entry["model"] == "mistral-large-latest"


def test_routing_reports_unavailability_reasons(client: TestClient) -> None:
    languages = client.get("/api/routing").json()["languages"]
    # API provider without a key.
    balanced_de = languages["de"]["balanced"]
    assert balanced_de["available"] is False
    assert balanced_de["reason"] == "missing MISTRAL_API_KEY"
    # Configured extra without a key.
    quality_zh = languages["zh"]["quality"]
    assert quality_zh["available"] is False
    assert quality_zh["reason"] == "missing DEEPSEEK_API_KEY"
    # Referenced provider that exists nowhere (gemini is not configured here).
    cheap_en = languages["en"]["cheap"]
    assert cheap_en["available"] is False
    assert cheap_en["reason"] == "provider not configured"
    # Ollama at an unreachable address.
    local_en = languages["en"]["local"]
    assert local_en["available"] is False
    assert local_en["reason"] == "Ollama not running"


def test_routing_reports_available_with_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISTRAL_API_KEY", "sk-test")
    entry = client.get("/api/routing").json()["languages"]["de"]["balanced"]
    assert entry["available"] is True
    assert entry["reason"] is None


def test_routing_bedrock_availability(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bedrock, "credentials_available", lambda: True)
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        routing={
            "languages": {
                "en": {"quality": {"provider": "bedrock", "model": "eu.model-a"}}
            }
        },
    )
    client = TestClient(create_app(settings))
    entry = client.get("/api/routing").json()["languages"]["en"]["quality"]
    assert entry["available"] is True and entry["reason"] is None

    monkeypatch.setattr(bedrock, "credentials_available", lambda: False)
    entry = client.get("/api/routing").json()["languages"]["en"]["quality"]
    assert entry["available"] is False
    assert entry["reason"] == "AWS credentials not available"
