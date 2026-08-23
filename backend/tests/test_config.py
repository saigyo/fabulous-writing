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
            "credits_per_day": 1_000_000,
            "max_llm_document_chars": 100000,
            "concurrent_llm_runs": 5,
        }}}})
        tier = settings.tiers["basic"]
        assert tier.llm.tiers == "all"
        assert tier.llm.providers == "all"
        assert tier.llm.models == "all"
        assert tier.features == []
        assert tier.limits.credits_per_day == 1_000_000

    def test_spec_sample_config_loads(self):
        settings = Settings.model_validate({
            "tiers": {
                "basic": {
                    "llm": {"tiers": ["cheap", "local"], "providers": ["ollama"], "models": "all"},
                    "limits": {
                        "credits_per_day": 1_000_000,
                        "max_llm_document_chars": 20000,
                        "concurrent_llm_runs": 3,
                    },
                    "features": [],
                },
                "premium": {
                    "llm": {"tiers": "all", "providers": "all", "models": "all"},
                    "limits": {
                        "credits_per_day": 1_000_000,
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
                "credits_per_day": 1_000_000,
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
        "credits_per_day": 1_000_000,
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
        # fail open once M5 enforces them). Since M5, the block itself is
        # also required (see test_tier_without_limits_block_is_rejected).
        complete = {
            "credits_per_day": 1_000_000,
            "max_llm_document_chars": 20000,
            "concurrent_llm_runs": 3,
        }
        with pytest.raises(ValidationError, match="credits_per_day"):
            Settings.model_validate(
                {"tiers": {"basic": {"limits": {**complete, "credits_per_day": 0}}}}
            )
        with pytest.raises(ValidationError):  # empty block: members missing
            Settings.model_validate({"tiers": {"basic": {"limits": {}}}})
        with pytest.raises(ValidationError):  # explicit null member
            Settings.model_validate(
                {"tiers": {"basic": {"limits": {**complete, "concurrent_llm_runs": None}}}}
            )

    def test_misspelled_tier_keys_fail_closed(self):
        # extra='forbid' on all three tier models: a typo must be a config
        # error, never a silently-unrestricted policy. Each sub-case supplies
        # a complete `limits:` block so it fails for its own typo — not for
        # the (now required) limits block being absent.
        with pytest.raises(ValidationError):  # 'provider' for 'providers'
            Settings.model_validate(
                {"tiers": {"basic": {
                    "llm": {"provider": ["ollama"]}, "limits": self._LIMITS,
                }}}
            )
        with pytest.raises(ValidationError):  # 'lmm' for 'llm'
            Settings.model_validate(
                {"tiers": {"basic": {
                    "lmm": {"tiers": ["local"]}, "limits": self._LIMITS,
                }}}
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
        assert settings.limits.admin.credits_per_day == 5_000_000
        assert settings.limits.admin.max_llm_document_chars == 200000
        assert settings.limits.admin.concurrent_llm_runs == 5

    def test_partial_admin_block_is_rejected(self):
        # Spec §6.1: the admin ceiling is all-or-nothing — a missing member
        # would fail open on the one account with a "not unlimited" guarantee.
        with pytest.raises(ValidationError, match="concurrent_llm_runs"):
            Settings.model_validate(
                {"limits": {"admin": {"credits_per_day": 1_000_000,
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
                    "admin": {"credits_per_day": 1_000_000,
                              "max_llm_document_chars": 200000,
                              "concurrent_llm_runs": 4},
                },
                "tiers": {"basic": {"limits": {
                    "credits_per_day": 1_000_000,
                    "max_llm_document_chars": 20000,
                    "concurrent_llm_runs": 5,
                }}},
            })

    def test_admin_concurrency_above_server_cap_is_rejected(self):
        with pytest.raises(ValidationError, match="limits.admin"):
            Settings.model_validate({
                "limits": {
                    "max_concurrent_llm_runs": 4,
                    "admin": {"credits_per_day": 1_000_000,
                              "max_llm_document_chars": 200000,
                              "concurrent_llm_runs": 5},
                },
            })

    def test_tier_without_limits_block_is_rejected(self):
        # M4 kept the block optional "until M5 requires it" — M5 requires it.
        with pytest.raises(ValidationError, match="limits"):
            Settings.model_validate({"tiers": {"basic": {}}})


class TestCreditCostConfig:
    def test_absent_block_defaults(self):
        settings = Settings()
        assert settings.credit_cost.default_factor == 1.0
        assert settings.credit_cost.default_output_weight == 4.0
        assert settings.credit_cost.source_weights == {
            "check": 1.0, "suggestion": 1.0, "name": 0.0,
        }

    def test_partial_source_weights_merge_over_defaults(self):
        settings = Settings.model_validate(
            {"credit_cost": {"source_weights": {"suggestion": 0.5}}}
        )
        assert settings.credit_cost.source_weights == {
            "check": 1.0, "suggestion": 0.5, "name": 0.0,
        }

    def test_unknown_source_key_fails(self):
        with pytest.raises(ValidationError, match="unknown source"):
            Settings.model_validate(
                {"credit_cost": {"source_weights": {"naming": 0.0}}}
            )

    def test_negative_weight_fails(self):
        with pytest.raises(ValidationError, match=">= 0"):
            Settings.model_validate(
                {"credit_cost": {"source_weights": {"check": -1.0}}}
            )

    def test_unknown_provider_key_fails(self):
        with pytest.raises(ValidationError, match="unknown provider 'nope'"):
            Settings.model_validate(
                {"credit_cost": {"providers": {"nope": {"default_factor": 1.0}}}}
            )

    def test_known_provider_key_accepted(self):
        settings = Settings.model_validate(
            {"credit_cost": {"providers": {"ollama": {"default_factor": 0.1}}}}
        )
        assert settings.credit_cost.providers["ollama"].default_factor == 0.1

    def test_extra_key_fails(self):
        with pytest.raises(ValidationError):
            Settings.model_validate({"credit_cost": {"output_weight": 4}})

    def test_zero_output_weight_fails(self):
        with pytest.raises(ValidationError, match="must be a finite number > 0"):
            Settings.model_validate({"credit_cost": {"default_output_weight": 0}})

    def test_non_finite_values_fail(self):
        # NaN passes every sign comparison and inf passes > 0; both would
        # survive to run time and make math.ceil raise on every run.
        for bad in (float("nan"), float("inf")):
            with pytest.raises(ValidationError, match="finite"):
                Settings.model_validate({"credit_cost": {"default_factor": bad}})
            with pytest.raises(ValidationError, match="finite"):
                Settings.model_validate(
                    {"credit_cost": {"source_weights": {"check": bad}}}
                )
            with pytest.raises(ValidationError, match="finite"):
                Settings.model_validate({"credit_cost": {"providers": {
                    "ollama": {"models": {"m": bad}},
                }}})


class TestCreditWindows:
    COMPLETE = {
        "credits_per_day": 1_000_000, "max_llm_document_chars": 100000,
        "concurrent_llm_runs": 5,
    }

    def test_windows_are_optional_and_ordered(self):
        settings = Settings.model_validate({"tiers": {"basic": {"limits": {
            **self.COMPLETE, "credits_per_month": 9, "credits_per_hour": 1,
        }}}})
        limits = settings.tiers["basic"].limits
        assert limits.credit_windows() == {
            "hour": 1, "day": 1_000_000, "month": 9,
        }
        assert list(limits.credit_windows()) == ["hour", "day", "month"]

    def test_zero_window_budget_fails(self):
        with pytest.raises(ValidationError, match="credits_per_day"):
            Settings.model_validate({"tiers": {"basic": {"limits": {
                **self.COMPLETE, "credits_per_day": 0,
            }}}})

    def test_admin_defaults_include_a_day_budget(self):
        assert Settings().limits.admin.credits_per_day == 5_000_000

    def test_stale_llm_checks_per_day_fails_loudly(self):
        # The B6 replacement is hard (spec §1): a config still carrying the
        # M5 counter must abort startup, not silently ignore it.
        with pytest.raises(ValidationError, match="llm_checks_per_day"):
            Settings.model_validate({"tiers": {"basic": {"limits": {
                "llm_checks_per_day": 100, "credits_per_day": 1000,
                "max_llm_document_chars": 100000, "concurrent_llm_runs": 5,
            }}}})

    def test_tier_without_any_window_fails(self):
        # Fail-closed (spec §2.3): no budget at all would fail open.
        with pytest.raises(ValidationError, match="at least one"):
            Settings.model_validate({"tiers": {"basic": {"limits": {
                "max_llm_document_chars": 100000, "concurrent_llm_runs": 5,
            }}}})


class TestDatabaseSettings:
    def test_default_backend_is_sqlite(self):
        assert Settings().database.backend == "sqlite"

    def test_postgres_backend_accepted(self):
        assert Settings(database={"backend": "postgres"}).database.backend == "postgres"

    def test_unknown_backend_rejected(self):
        with pytest.raises(ValidationError):
            Settings(database={"backend": "mysql"})

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            Settings(database={"backend": "sqlite", "pool_size": 3})


class TestEmbedSettings:
    def test_default_is_empty(self):
        assert Settings().embed.allowed_ancestors == []

    def test_valid_origins_accepted(self):
        settings = Settings.model_validate(
            {"embed": {"allowed_ancestors": [
                "chrome-extension://abc", "https://example.com",
                "https://example.com:8443",
            ]}}
        )
        assert settings.embed.allowed_ancestors == [
            "chrome-extension://abc", "https://example.com",
            "https://example.com:8443",
        ]

    @pytest.mark.parametrize("entry", [
        "chrome-extension://abcdefgh",
        "https://example.com:8443",
        "http://localhost:5199",
    ])
    def test_valid_origin_controls_accepted(self, entry):
        settings = Settings.model_validate({"embed": {"allowed_ancestors": [entry]}})
        assert settings.embed.allowed_ancestors == [entry]

    # Copilot round 9: the old single regex's permissive host character
    # class (`[A-Za-z0-9.\-]+`) and unbounded `(:\d+)?` port group full-match
    # strings that are not valid origins, silently emitting a CSP source
    # that can never match a real Origin header. Real parsing (scheme,
    # per-label hostname, numeric 1-65535 port) rejects all three.
    @pytest.mark.parametrize("entry", [
        "https://example.com:99999",  # port above 65535
        "https://-bad.example",  # label starting with a hyphen
        "https://.",  # empty labels
    ])
    def test_non_origin_vectors_rejected(self, entry):
        with pytest.raises(ValidationError, match="allowed_ancestors"):
            Settings.model_validate({"embed": {"allowed_ancestors": [entry]}})

    # Mutation-verify: reverting `1 <= int(port) <= 65535` to a passthrough
    # (or dropping the range check entirely) makes this pass instead of
    # raising -- confirms the range bound, not just port digit-ness, is
    # actually enforced.
    def test_port_zero_rejected(self):
        with pytest.raises(ValidationError, match="allowed_ancestors"):
            Settings.model_validate({"embed": {"allowed_ancestors": ["https://example.com:0"]}})

    # Copilot round 12: str.isdigit() accepts non-ASCII decimal digits too
    # (e.g. Arabic-Indic ٨٤٤٣), which int() happily parses as 8443 -- the
    # normalized entry would then carry a non-Latin-1 port straight into
    # the CSP header, where h11 fails to serialize it at request time
    # instead of this startup validator catching it. Mutation-verify by
    # reverting `port.isascii() and port.isdigit()` back to bare
    # `port.isdigit()`: this then passes validation instead of raising.
    def test_non_ascii_digit_port_rejected(self):
        with pytest.raises(ValidationError, match="allowed_ancestors"):
            Settings.model_validate(
                {"embed": {"allowed_ancestors": ["https://example.com:٨٤٤٣"]}}
            )

    def test_self_accepted(self):
        settings = Settings.model_validate({"embed": {"allowed_ancestors": ["'self'"]}})
        assert settings.embed.allowed_ancestors == ["'self'"]

    # Copilot round 8: YAML `- 'self'` parses to the bare Python string
    # "self" (the quotes are YAML string delimiters), not the literal
    # `'self'` CSP token — only the undocumented `- "'self'"` (double-quoted
    # to preserve the inner quotes) survived the old, bare-rejecting
    # validator. Bare self must both be accepted AND normalized to the
    # literal 'self' the CSP header needs (main.py joins the stored list
    # directly into frame-ancestors) — mutation-verify by reverting the
    # `entry == "self"` branch to a passthrough: this assertion then fails
    # because the stored entry stays "self", unquoted.
    def test_bare_self_accepted_and_normalized(self):
        settings = Settings.model_validate({"embed": {"allowed_ancestors": ["self"]}})
        assert settings.embed.allowed_ancestors == ["'self'"]

    def test_ipv6_bracket_literal_accepted(self):
        settings = Settings.model_validate(
            {"embed": {"allowed_ancestors": ["http://[::1]:8000"]}}
        )
        assert settings.embed.allowed_ancestors == ["http://[::1]:8000"]

    def test_ipv6_bracket_literal_without_port_accepted(self):
        settings = Settings.model_validate(
            {"embed": {"allowed_ancestors": ["https://[2001:db8::1]"]}}
        )
        assert settings.embed.allowed_ancestors == ["https://[2001:db8::1]"]

    @pytest.mark.parametrize(
        "entry",
        [
            "http://[::1",           # unclosed bracket
            "http://[not-an-ip]",    # not an IPv6 literal
            "http://[::1]x",         # trailing junk after the bracket
            "http://[::1]:99999",    # port out of range
            "http://[::1]:١٢٣",      # non-ASCII digits (same guard as hostnames)
            "http://[]",             # empty literal
            "http://[1.2.3.4]",      # IPv4 in brackets is not an IPv6 literal
            "http://[fe80::1%eth0]", # zone ID — can never match an Origin header
        ],
    )
    def test_ipv6_bracket_literal_rejected(self, entry):
        with pytest.raises(ValidationError, match="allowed_ancestors"):
            Settings.model_validate({"embed": {"allowed_ancestors": [entry]}})

    @pytest.mark.parametrize("entry", [
        "not a url",
        "https://exa mple.com",
        "*",
        "https://*.example.com",
        "https://exa\"mple.com",
        "example.com",
        # Python's `$` anchor matches before a trailing newline, not only at
        # the true end of string — `match()` alone would let these through,
        # and the newline would then blow up h11 header serialization on
        # every request instead of failing fast at startup.
        "https://good.com\n",
        "'self'\n",
        "self\n",  # bare self is a special-cased exact match, not a pattern -- a trailing newline must still be rejected
    ])
    def test_invalid_entries_rejected(self, entry):
        with pytest.raises(ValidationError, match="allowed_ancestors"):
            Settings.model_validate({"embed": {"allowed_ancestors": [entry]}})

    def test_unknown_key_rejected(self):
        with pytest.raises(ValidationError):
            Settings.model_validate({"embed": {"allowed_ancestor": ["'self'"]}})
