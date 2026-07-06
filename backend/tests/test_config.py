from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings, load_settings


def test_load_settings_from_yaml(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
db_path: /tmp/custom.db
providers:
  ollama_model: mistral
  default_provider: claude
""",
        encoding="utf-8",
    )
    settings = load_settings(config)
    assert settings.db_path == Path("/tmp/custom.db")
    assert settings.providers.ollama_model == "mistral"
    assert settings.providers.default_provider == "claude"
    # Unset keys keep their defaults.
    assert settings.providers.anthropic_model == "claude-sonnet-5"


def test_load_settings_without_file_uses_defaults(tmp_path: Path) -> None:
    settings = load_settings(tmp_path / "missing.yaml")
    assert settings == Settings()


def test_extra_providers_parsed_from_yaml(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
providers:
  extra_providers:
    deepseek:
      base_url: https://api.deepseek.com/v1
      default_model: deepseek-v4-pro
    openrouter:
      base_url: https://openrouter.ai/api/v1
      default_model: anthropic/claude-sonnet-5
      exclude_model_fragments: [embedding]
""",
        encoding="utf-8",
    )
    settings = load_settings(config)
    extras = settings.providers.extra_providers
    assert set(extras) == {"deepseek", "openrouter"}
    assert extras["deepseek"].base_url == "https://api.deepseek.com/v1"
    assert extras["deepseek"].default_model == "deepseek-v4-pro"
    assert extras["deepseek"].exclude_model_fragments == []
    assert extras["openrouter"].exclude_model_fragments == ["embedding"]


def test_extra_providers_default_empty() -> None:
    assert Settings().providers.extra_providers == {}


def test_extra_provider_name_collision_with_builtin_fails(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
providers:
  extra_providers:
    mistral:
      base_url: https://example.test/v1
      default_model: some-model
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="built-in"):
        load_settings(config)


def test_extra_provider_invalid_name_fails(tmp_path: Path) -> None:
    # Uppercase/hyphens are rejected: the name derives the env variable.
    config = tmp_path / "config.yaml"
    config.write_text(
        """
providers:
  extra_providers:
    Deep-Seek:
      base_url: https://example.test/v1
      default_model: some-model
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="name"):
        load_settings(config)


def test_routing_defaults_cover_all_languages_and_tiers() -> None:
    routing = Settings().routing
    assert routing.default_tier == "balanced"
    assert set(routing.languages) == {"en", "de", "fr", "es", "it", "ja", "zh"}
    for tiers in routing.languages.values():
        assert set(tiers) == {"quality", "balanced", "cheap", "local"}
    assert routing.languages["de"]["balanced"].provider == "mistral"
    assert routing.languages["zh"]["quality"].provider == "deepseek"
    assert routing.languages["en"]["local"].provider == "ollama"


def test_routing_user_override_replaces_only_that_language(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
routing:
  languages:
    de:
      balanced: { provider: openai, model: gpt-5-mini }
""",
        encoding="utf-8",
    )
    routing = load_settings(config).routing
    # de is replaced wholesale (only the tiers the user listed exist) ...
    assert set(routing.languages["de"]) == {"balanced"}
    assert routing.languages["de"]["balanced"].provider == "openai"
    # ... while every other language keeps its defaults.
    assert set(routing.languages["fr"]) == {"quality", "balanced", "cheap", "local"}


def test_routing_rejects_unknown_tier(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
routing:
  languages:
    en:
      premium: { provider: claude, model: claude-opus-4-8 }
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="tier"):
        load_settings(config)


def test_routing_rejects_unknown_language(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text(
        """
routing:
  languages:
    xx:
      balanced: { provider: claude, model: claude-sonnet-5 }
""",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="language"):
        load_settings(config)


def test_routing_rejects_unknown_default_tier(tmp_path: Path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text("routing:\n  default_tier: premium\n", encoding="utf-8")
    with pytest.raises(ValidationError, match="tier"):
        load_settings(config)
