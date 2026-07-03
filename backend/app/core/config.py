from pathlib import Path

import yaml
from pydantic import BaseModel, Field

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent


class ProviderSettings(BaseModel):
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"
    anthropic_model: str = "claude-sonnet-5"
    default_provider: str = "ollama"


class Settings(BaseModel):
    db_path: Path = BACKEND_DIR / "data" / "fabulous.db"
    rules_dir: Path = BACKEND_DIR / "rules"
    providers: ProviderSettings = Field(default_factory=ProviderSettings)


def load_settings(config_file: Path | None = None) -> Settings:
    """Load settings from a YAML file, falling back to defaults."""
    path = config_file or BACKEND_DIR / "config.yaml"
    if not path.is_file():
        return Settings()
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return Settings.model_validate(data)
