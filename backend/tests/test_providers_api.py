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
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(bedrock, "credentials_available", lambda: False)
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        providers=ProviderSettings(
            ollama_base_url="http://127.0.0.1:9",
            openai_base_url="http://127.0.0.1:9/v1",
            mistral_base_url="http://127.0.0.1:9/v1",
            extra_providers={
                "deepseek": ExtraProviderSettings(
                    base_url="http://127.0.0.1:9/v1",
                    default_model="deepseek-v4-pro",
                )
            },
        ),
    )
    return TestClient(create_app(settings))


def test_lists_all_providers_with_availability(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    providers = {p["name"]: p for p in client.get("/api/providers").json()}

    assert set(providers) == {
        "ollama",
        "claude",
        "openai",
        "mistral",
        "bedrock",
        "deepseek",
    }
    # Ollama at an unreachable address: reported but unavailable.
    assert providers["ollama"]["available"] is False
    assert providers["ollama"]["models"] == []
    assert providers["ollama"]["default_model"]
    # No API keys in the environment.
    assert providers["claude"]["available"] is False
    assert providers["claude"]["default_model"] == "claude-sonnet-5"
    assert providers["openai"]["available"] is False
    assert providers["openai"]["default_model"] == "gpt-5-mini"
    assert providers["mistral"]["available"] is False
    assert providers["mistral"]["default_model"] == "mistral-small-latest"
    # No AWS credentials.
    assert providers["bedrock"]["available"] is False
    assert providers["bedrock"]["default_model"]


def test_claude_available_with_api_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    assert providers["claude"]["available"] is True


def test_openai_and_mistral_available_with_keys(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("MISTRAL_API_KEY", "sk-test")
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    # Key present but model listing unreachable: available, fallback models.
    assert providers["openai"]["available"] is True
    assert providers["openai"]["models"] == ["gpt-5-mini"]
    assert providers["mistral"]["available"] is True
    assert providers["mistral"]["models"] == ["mistral-small-latest"]


def test_bedrock_available_with_credentials(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bedrock, "credentials_available", lambda: True)
    monkeypatch.setattr(
        bedrock, "discover_models", lambda region: ["eu.model-a", "eu.model-b"]
    )
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    assert providers["bedrock"]["available"] is True
    assert providers["bedrock"]["models"] == ["eu.model-a", "eu.model-b"]
    assert providers["bedrock"]["default_model"] == "eu.model-a"


def test_extra_provider_unavailable_without_key(client: TestClient) -> None:
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    assert providers["deepseek"]["available"] is False
    assert providers["deepseek"]["default_model"] == "deepseek-v4-pro"


def test_extra_provider_available_with_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    # Key present but model listing unreachable: available, fallback models.
    assert providers["deepseek"]["available"] is True
    assert providers["deepseek"]["models"] == ["deepseek-v4-pro"]
