import re
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent

# The five providers with dedicated construction/auth logic. Extra provider
# names must not shadow them.
BUILTIN_PROVIDERS = ("ollama", "claude", "openai", "mistral", "bedrock")

# Extra provider names derive their env variable (<NAME>_API_KEY), so they
# must be safe identifiers.
_EXTRA_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")


class ExtraProviderSettings(BaseModel):
    """An OpenAI-compatible provider defined in config (key: <NAME>_API_KEY)."""

    base_url: str
    default_model: str
    exclude_model_fragments: list[str] = Field(default_factory=list)


class ProviderSettings(BaseModel):
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"
    anthropic_model: str = "claude-sonnet-5"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-5-mini"
    mistral_base_url: str = "https://api.mistral.ai/v1"
    mistral_model: str = "mistral-small-latest"
    # None: use the AWS default region chain (AWS_REGION / profile).
    bedrock_region: str | None = None
    # Inference-profile ids are region-family-specific (us./eu./apac. prefix).
    bedrock_model: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    # When set, skips live Bedrock model discovery (which needs the
    # bedrock:ListFoundationModels / ListInferenceProfiles permissions).
    bedrock_models: list[str] = Field(default_factory=list)
    default_provider: str = "ollama"
    extra_providers: dict[str, ExtraProviderSettings] = Field(default_factory=dict)

    @field_validator("extra_providers")
    @classmethod
    def _check_extra_names(
        cls, value: dict[str, ExtraProviderSettings]
    ) -> dict[str, ExtraProviderSettings]:
        for name in value:
            if not _EXTRA_NAME_RE.match(name):
                raise ValueError(
                    f"invalid extra provider name '{name}': must match"
                    " ^[a-z][a-z0-9_]*$ (the name derives the"
                    f" {name.upper()}_API_KEY environment variable)"
                )
            if name in BUILTIN_PROVIDERS:
                raise ValueError(
                    f"extra provider name '{name}' collides with a built-in provider"
                )
        return value


class NlpSettings(BaseModel):
    # Language code -> spaCy pipeline package. ja uses GiNZA (see design spec);
    # ja_core_news_sm is the documented fallback.
    models: dict[str, str] = Field(
        default_factory=lambda: {
            "en": "en_core_web_sm",
            "de": "de_core_news_sm",
            "fr": "fr_core_news_sm",
            "es": "es_core_news_sm",
            "it": "it_core_news_sm",
            "ja": "ja_ginza",
            "zh": "zh_core_web_sm",
        }
    )


class Settings(BaseModel):
    db_path: Path = BACKEND_DIR / "data" / "fabulous.db"
    rules_dir: Path = BACKEND_DIR / "rules"
    demos_dir: Path = BACKEND_DIR / "demos"
    # Seed an empty terminology DB with an example domain on startup.
    seed_terminology: bool = True
    # Seed Marketing / Technical Documentation example profiles (EN, DE, JA)
    # the first time profiles are seeded for a language.
    seed_example_profiles: bool = True
    # Deterministically vet LLM-generated suggestions (spell gate + rule re-check).
    vet_suggestions: bool = True
    # Hunspell dictionaries (<lang>.aff/.dic) for the morphology-aware spell
    # gate; install via scripts/install-dictionaries.sh. Missing files are fine.
    dictionaries_dir: Path = BACKEND_DIR / "dictionaries"
    providers: ProviderSettings = Field(default_factory=ProviderSettings)
    nlp: NlpSettings = Field(default_factory=NlpSettings)


def load_settings(config_file: Path | None = None) -> Settings:
    """Load settings from a YAML file, falling back to defaults."""
    path = config_file or BACKEND_DIR / "config.yaml"
    if not path.is_file():
        return Settings()
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return Settings.model_validate(data)
