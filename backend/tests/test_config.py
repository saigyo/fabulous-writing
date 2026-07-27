from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings, load_settings, known_provider_names


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


class TestTiersConfig:
    def test_default_is_no_tiers(self):
        assert Settings().tiers == {}

    def test_minimal_tier_defaults_to_all(self):
        # M5: limits is required, so the minimal valid tier must supply one.
        settings = Settings.model_validate({"tiers": {"basic": {"limits": {
            "llm_checks_per_day": 100,
            "max_llm_document_chars": 100000,
            "concurrent_llm_runs": 5,
        }}}})
        tier = settings.tiers["basic"]
        assert tier.llm.tiers == "all"
        assert tier.llm.providers == "all"
        assert tier.llm.models == "all"
        assert tier.features == []
        assert tier.limits.llm_checks_per_day == 100

    def test_spec_sample_config_loads(self):
        settings = Settings.model_validate({
            "tiers": {
                "basic": {
                    "llm": {"tiers": ["cheap", "local"], "providers": ["ollama"], "models": "all"},
                    "limits": {
                        "llm_checks_per_day": 20,
                        "max_llm_document_chars": 20000,
                        "concurrent_llm_runs": 3,
                    },
                    "features": [],
                },
                "premium": {
                    "llm": {"tiers": "all", "providers": "all", "models": "all"},
                    "limits": {
                        "llm_checks_per_day": 100,
                        "max_llm_document_chars": 100000,
                        "concurrent_llm_runs": 5,
                    },
                    "features": ["custom_profiles", "custom_domains"],
                },
            }
        })
        assert settings.tiers["basic"].llm.tiers == ["cheap", "local"]
        assert settings.tiers["premium"].features == ["custom_profiles", "custom_domains"]

    def test_empty_llm_lists_are_the_valid_floor(self):
        settings = Settings.model_validate({"tiers": {"basic": {
            "llm": {"tiers": [], "providers": []},
            "limits": {
                "llm_checks_per_day": 100,
                "max_llm_document_chars": 100000,
                "concurrent_llm_runs": 5,
            },
        }}})
        assert settings.tiers["basic"].llm.tiers == []
        assert settings.tiers["basic"].llm.providers == []

    def test_unknown_quality_tier_rejected(self):
        with pytest.raises(ValidationError, match="unknown quality tier 'turbo'"):
            Settings.model_validate({"tiers": {"basic": {"llm": {"tiers": ["turbo"]}}}})

    def test_unknown_feature_rejected(self):
        with pytest.raises(ValidationError, match="unknown feature 'teleport'"):
            Settings.model_validate({"tiers": {"basic": {"features": ["teleport"]}}})

    # Generous, complete limits block: these tests exercise llm/features
    # validation and must not trip on the (now required) limits block.
    _LIMITS = {
        "llm_checks_per_day": 100,
        "max_llm_document_chars": 100000,
        "concurrent_llm_runs": 5,
    }

    def test_unknown_provider_rejected(self):
        with pytest.raises(ValidationError, match="unknown provider 'nope'"):
            Settings.model_validate({"tiers": {"basic": {
                "llm": {"providers": ["nope"]}, "limits": self._LIMITS,
            }}})

    def test_models_key_unknown_provider_rejected(self):
        # A typo in a models key must not silently narrow a policy (spec §6.1).
        with pytest.raises(ValidationError, match="unknown provider 'nope'"):
            Settings.model_validate(
                {"tiers": {"basic": {
                    "llm": {"models": {"nope": ["x"]}}, "limits": self._LIMITS,
                }}}
            )

    def test_models_key_outside_providers_rejected(self):
        with pytest.raises(ValidationError, match="'claude' is not in providers"):
            Settings.model_validate({
                "tiers": {"basic": {"llm": {
                    "providers": ["ollama"], "models": {"claude": ["claude-sonnet-5"]},
                }, "limits": self._LIMITS}}
            })

    def test_empty_model_allowlist_rejected(self):
        # An empty list would leave the degradation substitute undefined
        # (spec §6.1); "no models" is expressed by omitting the provider.
        with pytest.raises(ValidationError, match="empty model allowlist"):
            Settings.model_validate(
                {"tiers": {"basic": {
                    "llm": {"models": {"ollama": []}}, "limits": self._LIMITS,
                }}}
            )

    def test_extra_provider_usable_in_tier_policy(self):
        settings = Settings.model_validate({
            "providers": {"extra_providers": {"deepseek": {
                "base_url": "https://api.deepseek.com/v1", "default_model": "deepseek-v4-pro",
            }}},
            "tiers": {"basic": {
                "llm": {"providers": ["deepseek"]}, "limits": self._LIMITS,
            }},
        })
        assert "deepseek" in known_provider_names(settings.providers)

    def test_incomplete_or_nonpositive_tier_limits_rejected(self):
        # Spec §6.1: a supplied limits block is all-or-nothing — missing,
        # null, or non-positive members are load-time errors (they would
        # fail open once M5 enforces them). Absent block stays fine.
        complete = {
            "llm_checks_per_day": 20,
            "max_llm_document_chars": 20000,
            "concurrent_llm_runs": 3,
        }
        with pytest.raises(ValidationError, match="llm_checks_per_day"):
            Settings.model_validate(
                {"tiers": {"basic": {"limits": {**complete, "llm_checks_per_day": 0}}}}
            )
        with pytest.raises(ValidationError):  # empty block: members missing
            Settings.model_validate({"tiers": {"basic": {"limits": {}}}})
        with pytest.raises(ValidationError):  # explicit null member
            Settings.model_validate(
                {"tiers": {"basic": {"limits": {**complete, "concurrent_llm_runs": None}}}}
            )

    def test_misspelled_tier_keys_fail_closed(self):
        # extra='forbid' on all three tier models: a typo must be a config
        # error, never a silently-unrestricted policy.
        with pytest.raises(ValidationError):  # 'provider' for 'providers'
            Settings.model_validate(
                {"tiers": {"basic": {"llm": {"provider": ["ollama"]}}}}
            )
        with pytest.raises(ValidationError):  # 'lmm' for 'llm'
            Settings.model_validate(
                {"tiers": {"basic": {"lmm": {"tiers": ["local"]}}}}
            )
        with pytest.raises(ValidationError):  # typo inside limits
            Settings.model_validate(
                {"tiers": {"basic": {"limits": {"llm_checks_per_dya": 5}}}}
            )
        with pytest.raises(ValidationError):  # top-level: 'tier' for 'tiers'
            Settings.model_validate({"tier": {"basic": {}}})


class TestLimitsSettings:
    def test_defaults_are_inert(self):
        settings = Settings()
        assert settings.limits.max_document_chars == 200000
        assert settings.limits.max_concurrent_llm_runs == 20
        assert settings.limits.llm_run_max_age == 900
        assert settings.limits.concurrency_reject_delay == 0.25
        assert settings.limits.admin.llm_checks_per_day == 500
        assert settings.limits.admin.max_llm_document_chars == 200000
        assert settings.limits.admin.concurrent_llm_runs == 5

    def test_partial_admin_block_is_rejected(self):
        # Spec §6.1: the admin ceiling is all-or-nothing — a missing member
        # would fail open on the one account with a "not unlimited" guarantee.
        with pytest.raises(ValidationError, match="concurrent_llm_runs"):
            Settings.model_validate(
                {"limits": {"admin": {"llm_checks_per_day": 100,
                                      "max_llm_document_chars": 1000}}}
            )

    def test_unknown_key_in_limits_is_rejected(self):
        with pytest.raises(ValidationError):
            Settings.model_validate({"limits": {"max_documents_chars": 1}})

    @pytest.mark.parametrize("field", [
        "max_document_chars", "max_concurrent_llm_runs", "llm_run_max_age",
    ])
    def test_non_positive_limits_are_rejected(self, field):
        with pytest.raises(ValidationError, match=field):
            Settings.model_validate({"limits": {field: 0}})

    @pytest.mark.parametrize("value", [-0.1, 2.5, 25])
    def test_reject_delay_outside_0_to_2_is_rejected(self, value):
        # A 25 typed for 0.25 would turn backpressure into an amplification
        # vector (spec §6.1).
        with pytest.raises(ValidationError, match="concurrency_reject_delay"):
            Settings.model_validate({"limits": {"concurrency_reject_delay": value}})

    @pytest.mark.parametrize("value", [0, 0.25, 2])
    def test_reject_delay_boundaries_are_accepted(self, value):
        settings = Settings.model_validate(
            {"limits": {"concurrency_reject_delay": value}}
        )
        assert settings.limits.concurrency_reject_delay == value

    def test_tier_concurrency_above_server_cap_is_rejected(self):
        # The one configuration where a single user could starve the shared
        # pool (spec §6.1). The explicit admin block matters: the DEFAULT
        # admin ceiling carries concurrent_llm_runs=5, which would trip the
        # ADMIN comparison first and let this pass for the wrong reason.
        with pytest.raises(ValidationError, match=r"tiers\.basic"):
            Settings.model_validate({
                "limits": {
                    "max_concurrent_llm_runs": 4,
                    "admin": {"llm_checks_per_day": 500,
                              "max_llm_document_chars": 200000,
                              "concurrent_llm_runs": 4},
                },
                "tiers": {"basic": {"limits": {
                    "llm_checks_per_day": 20,
                    "max_llm_document_chars": 20000,
                    "concurrent_llm_runs": 5,
                }}},
            })

    def test_admin_concurrency_above_server_cap_is_rejected(self):
        with pytest.raises(ValidationError, match="limits.admin"):
            Settings.model_validate({
                "limits": {
                    "max_concurrent_llm_runs": 4,
                    "admin": {"llm_checks_per_day": 500,
                              "max_llm_document_chars": 200000,
                              "concurrent_llm_runs": 5},
                },
            })

    def test_tier_without_limits_block_is_rejected(self):
        # M4 kept the block optional "until M5 requires it" — M5 requires it.
        with pytest.raises(ValidationError, match="limits"):
            Settings.model_validate({"tiers": {"basic": {}}})
