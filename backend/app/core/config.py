import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent

# The five providers with dedicated construction/auth logic. Extra provider
# names must not shadow them.
BUILTIN_PROVIDERS = ("ollama", "claude", "openai", "mistral", "bedrock")

# Env variable per built-in API provider (extras derive theirs by name:
# <NAME>_API_KEY). Shared by the providers and routing routers.
BUILTIN_ENV_KEYS = {
    "claude": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "mistral": "MISTRAL_API_KEY",
}

# Feature flags a tier may grant (spec §6.3). A closed set: config validation
# rejects unknown names so a typo cannot silently withhold (or appear to
# grant) a capability.
KNOWN_FEATURES = ("custom_profiles", "custom_domains")


def known_provider_names(providers: "ProviderSettings") -> tuple[str, ...]:
    """Every provider name this deployment can construct: the built-in five
    plus configured extras. The vocabulary for tier policies and for direct
    provider selection."""
    return BUILTIN_PROVIDERS + tuple(providers.extra_providers)


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


# The four quality tiers, in UI order. Fixed — not user-definable.
TIERS = ("quality", "balanced", "cheap", "local")

# Kept as a literal (not imported from app.core.models) to avoid a config →
# models dependency for the sake of seven constant strings.
_LANGUAGE_CODES = ("en", "de", "fr", "es", "it", "ja", "zh")


class RoutingEntry(BaseModel):
    provider: str
    model: str


def _default_routing_languages() -> dict[str, dict[str, RoutingEntry]]:
    """Default tier table, from docs/model-recommendations.md §3-5.

    Entries may reference extra providers (deepseek, gemini, qwen) that are
    not configured — those tiers report as unavailable with a reason, which
    doubles as configuration guidance.
    """

    def entry(provider: str, model: str) -> RoutingEntry:
        return RoutingEntry(provider=provider, model=model)

    def european(balanced: RoutingEntry) -> dict[str, RoutingEntry]:
        return {
            "quality": entry("claude", "claude-opus-4-8"),
            "balanced": balanced,
            "cheap": entry("gemini", "models/gemini-flash-latest"),
            "local": entry("ollama", "mistral-nemo:12b-instruct-2407-q6_K"),
        }

    def cjk(quality: RoutingEntry, balanced: RoutingEntry) -> dict[str, RoutingEntry]:
        return {
            "quality": quality,
            "balanced": balanced,
            "cheap": entry("deepseek", "deepseek-v4-flash"),
            "local": entry("ollama", "qwen3:8b"),
        }

    return {
        "en": european(entry("claude", "claude-sonnet-5")),
        "de": european(entry("mistral", "mistral-large-latest")),
        "fr": european(entry("mistral", "mistral-large-latest")),
        "es": european(entry("mistral", "mistral-large-latest")),
        "it": european(entry("mistral", "mistral-large-latest")),
        "zh": cjk(entry("deepseek", "deepseek-v4-pro"), entry("qwen", "qwen3.7-max")),
        "ja": cjk(entry("qwen", "qwen3.7-max"), entry("qwen", "qwen3.6-plus")),
    }


class RoutingSettings(BaseModel):
    default_tier: str = "balanced"
    languages: dict[str, dict[str, RoutingEntry]] = Field(
        default_factory=_default_routing_languages
    )

    @model_validator(mode="before")
    @classmethod
    def _overlay_defaults(cls, data: object) -> object:
        # A user-supplied language replaces that language's whole tier map;
        # languages the user does not mention keep their defaults.
        if isinstance(data, dict):
            user = data.get("languages") or {}
            defaults = {
                lang: tiers
                for lang, tiers in _default_routing_languages().items()
                if lang not in user
            }
            data = {**data, "languages": {**defaults, **user}}
        return data

    @field_validator("default_tier")
    @classmethod
    def _check_default_tier(cls, value: str) -> str:
        if value not in TIERS:
            raise ValueError(f"unknown tier '{value}': must be one of {TIERS}")
        return value

    @field_validator("languages")
    @classmethod
    def _check_languages(
        cls, value: dict[str, dict[str, RoutingEntry]]
    ) -> dict[str, dict[str, RoutingEntry]]:
        for lang, tiers in value.items():
            if lang not in _LANGUAGE_CODES:
                raise ValueError(
                    f"unknown language '{lang}': must be one of {_LANGUAGE_CODES}"
                )
            for tier in tiers:
                if tier not in TIERS:
                    raise ValueError(
                        f"unknown tier '{tier}' for {lang}: must be one of {TIERS}"
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


class CorsSettings(BaseModel):
    # Browsers only. The API is also reachable by non-browser clients, which
    # CORS does not constrain — this narrows which *web origins* may call it.
    origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])


class AuthSettings(BaseModel):
    # Startup-only knobs. None of these is reachable through the API: a
    # stolen admin session must not be able to lift its own constraints.
    mode: Literal["local", "supabase"] = "local"
    # Dev-only escape hatch for a missing FW_AUTH_SECRET (tokens die on restart).
    ephemeral_secret: bool = False
    # When false, no API path may create or promote an admin (§7.1).
    allow_additional_admins: bool = False


class TierLimitsSettings(BaseModel):
    """Per-user-tier numeric limits (spec §6.1): a supplied limits block is
    all-or-nothing — a missing or null member is a load-time error, because
    it would fail open the moment M5 starts enforcing. The block itself
    stays optional on TierSettings until M5 requires it."""

    # Access policy must not fail open on a typo: a misspelled key in any
    # tier block is a config error, not a silently-ignored extra.
    model_config = ConfigDict(extra="forbid")

    llm_checks_per_day: int
    max_llm_document_chars: int
    concurrent_llm_runs: int

    @field_validator("llm_checks_per_day", "max_llm_document_chars", "concurrent_llm_runs")
    @classmethod
    def _positive(cls, value: int, info) -> int:
        if value <= 0:
            raise ValueError(f"{info.field_name} must be a positive integer")
        return value


class TierLLMSettings(BaseModel):
    """What a user tier may run (spec §6.1). 'all' means unrestricted for
    that dimension. `tiers` lists *quality* tiers (the fixed ladder in
    TIERS); `providers`/`models` govern direct selection. Provider-name
    validation lives on Settings, which knows the configured extras."""

    model_config = ConfigDict(extra="forbid")  # see TierLimitsSettings

    tiers: list[str] | Literal["all"] = "all"
    providers: list[str] | Literal["all"] = "all"
    models: dict[str, list[str]] | Literal["all"] = "all"

    @field_validator("tiers")
    @classmethod
    def _known_quality_tiers(cls, value: list[str] | str) -> list[str] | str:
        if value == "all":
            return value
        for name in value:
            if name not in TIERS:
                raise ValueError(
                    f"unknown quality tier '{name}': must be one of {TIERS}"
                )
        return value


class TierSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")  # see TierLimitsSettings

    llm: TierLLMSettings = Field(default_factory=TierLLMSettings)
    limits: TierLimitsSettings | None = None
    features: list[str] = Field(default_factory=list)

    @field_validator("features")
    @classmethod
    def _known_features(cls, value: list[str]) -> list[str]:
        for name in value:
            if name not in KNOWN_FEATURES:
                raise ValueError(
                    f"unknown feature '{name}': must be one of {KNOWN_FEATURES}"
                )
        return value


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Fails closed by design: a deployment that forgets to set this gets
    # "production" (docs endpoints off), not an anonymously-reachable API
    # surface. A developer who forgets gets their docs turned off, which is
    # visible and harmless in comparison. See config.example.yaml for the
    # dev-friction this trades for.
    environment: Literal["dev", "staging", "production"] = "production"
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
    routing: RoutingSettings = Field(default_factory=RoutingSettings)
    nlp: NlpSettings = Field(default_factory=NlpSettings)
    auth: AuthSettings = Field(default_factory=AuthSettings)
    cors: CorsSettings = Field(default_factory=CorsSettings)

    # User tiers (spec §6.1): policy per tiers-of-service name. Distinct from
    # the quality tiers in TIERS. Empty (the default) = no policy anywhere —
    # every user unrestricted, behavior identical to pre-M4.
    tiers: dict[str, TierSettings] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_tier_provider_names(self) -> "Settings":
        known = set(known_provider_names(self.providers))
        for tier_name, tier in self.tiers.items():
            llm = tier.llm
            if llm.providers != "all":
                for name in llm.providers:
                    if name not in known:
                        raise ValueError(
                            f"tiers.{tier_name}.llm.providers: unknown provider '{name}'"
                        )
            if llm.models != "all":
                listed = None if llm.providers == "all" else set(llm.providers)
                for name, models in llm.models.items():
                    if name not in known:
                        raise ValueError(
                            f"tiers.{tier_name}.llm.models: unknown provider '{name}'"
                        )
                    if listed is not None and name not in listed:
                        raise ValueError(
                            f"tiers.{tier_name}.llm.models: '{name}' is not in providers"
                        )
                    if not models:
                        raise ValueError(
                            f"tiers.{tier_name}.llm.models.{name}: empty model allowlist"
                            " — omit the provider from llm.providers instead"
                        )
        return self


def load_settings(config_file: Path | None = None) -> Settings:
    """Load settings from a YAML file, falling back to defaults."""
    path = config_file or BACKEND_DIR / "config.yaml"
    if not path.is_file():
        return Settings()
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return Settings.model_validate(data)
