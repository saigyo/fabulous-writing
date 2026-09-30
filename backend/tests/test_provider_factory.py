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


def test_factory_applies_the_configured_effort_for_the_model() -> None:
    settings = Settings(
        providers=ProviderSettings(anthropic_effort={"claude-opus-5-5": "low"})
    )
    factory = make_provider_factory(settings)
    assert factory("claude", "claude-opus-5-5").effort == "low"
    # Unlisted models run at their own default: no output_config is sent.
    assert factory("claude", "claude-sonnet-5-5").effort is None


def test_default_effort_map_pins_opus_5_5_low() -> None:
    # #132 benchmark: low effort cut Opus 5.5 check latency and token use by
    # ~40% with findings on par; Sonnet 5.5 gained too little to set one.
    assert ProviderSettings().anthropic_effort == {"claude-opus-5-5": "low"}


def test_unknown_effort_is_rejected() -> None:
    with pytest.raises(ValueError, match="effort"):
        ProviderSettings(anthropic_effort={"claude-opus-5-5": "minimal"})
