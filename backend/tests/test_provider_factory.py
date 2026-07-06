import pytest

from app.checkers.llm.openai_compat import OpenAICompatProvider
from app.core.config import ExtraProviderSettings, ProviderSettings, Settings
from app.main import make_provider_factory


@pytest.fixture
def settings() -> Settings:
    return Settings(
        providers=ProviderSettings(
            extra_providers={
                "deepseek": ExtraProviderSettings(
                    base_url="https://api.deepseek.com/v1",
                    default_model="deepseek-v4-pro",
                    exclude_model_fragments=["embedding"],
                )
            }
        )
    )


def test_factory_builds_extra_provider(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    provider = make_provider_factory(settings)("deepseek")
    assert isinstance(provider, OpenAICompatProvider)
    assert provider.name == "deepseek"
    assert provider.base_url == "https://api.deepseek.com/v1"
    assert provider.model == "deepseek-v4-pro"
    assert provider.api_key == "sk-test"
    assert provider.exclude_models == ("embedding",)


def test_factory_extra_provider_model_override(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    provider = make_provider_factory(settings)("deepseek", "deepseek-v4-flash")
    assert provider.model == "deepseek-v4-flash"


def test_factory_extra_provider_without_key(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Construction succeeds; the missing key fails at request time with a
    # clear message (OpenAICompatProvider._client), same as openai/mistral.
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    provider = make_provider_factory(settings)("deepseek")
    assert provider.api_key is None


def test_factory_unknown_provider_still_raises(settings: Settings) -> None:
    with pytest.raises(ValueError, match="Unknown LLM provider"):
        make_provider_factory(settings)("nonexistent")
