from pathlib import Path

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
