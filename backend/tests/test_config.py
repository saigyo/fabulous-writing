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
