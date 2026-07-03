from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import ProviderSettings, Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        providers=ProviderSettings(ollama_base_url="http://127.0.0.1:9"),
    )
    return TestClient(create_app(settings))


def test_lists_both_providers_with_availability(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    providers = {p["name"]: p for p in client.get("/api/providers").json()}

    assert set(providers) == {"ollama", "claude"}
    # Ollama at an unreachable address: reported but unavailable.
    assert providers["ollama"]["available"] is False
    assert providers["ollama"]["models"] == []
    assert providers["ollama"]["default_model"]
    # No API key in the environment: Claude unavailable.
    assert providers["claude"]["available"] is False
    assert providers["claude"]["default_model"] == "claude-sonnet-5"


def test_claude_available_with_api_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    providers = {p["name"]: p for p in client.get("/api/providers").json()}
    assert providers["claude"]["available"] is True
