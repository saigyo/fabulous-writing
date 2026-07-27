"""Exhaustive tables for spec §6.2 — resolve_llm_selection and the policy
builders. Routing defaults used below (from config._default_routing_languages,
language 'en'): quality→claude, balanced→claude, cheap→gemini, local→ollama."""

import logging

import pytest

from app.core import permissions
from app.core.config import Settings
from app.core.permissions import (
    FULL_POLICY,
    NO_LLM_POLICY,
    EffectiveSelection,
    LLMPolicy,
    RequestedLLM,
    default_model_for,
    features_for,
    limits_for,
    policy_for,
    resolve_llm_selection,
)

SETTINGS = Settings()  # default routing table + default providers

_LIMITS = {
    "llm_checks_per_day": 100, "max_llm_document_chars": 100000, "concurrent_llm_runs": 5,
}

TIERED = Settings.model_validate({
    "tiers": {
        "basic": {
            "llm": {"tiers": ["cheap", "local"], "providers": ["ollama"]},
            "limits": _LIMITS,
        },
        "premium": {
            "llm": {}, "features": ["custom_profiles", "custom_domains"], "limits": _LIMITS,
        },
    }
})


class TestPolicyFor:
    def test_no_tiers_configured_is_full_policy(self):
        assert policy_for(tier="basic", is_admin=False, settings=SETTINGS) == FULL_POLICY

    def test_admin_bypasses_configured_tiers(self):
        assert policy_for(tier="basic", is_admin=True, settings=TIERED) == FULL_POLICY

    def test_configured_tier_maps_to_policy(self):
        policy = policy_for(tier="basic", is_admin=False, settings=TIERED)
        assert policy == LLMPolicy(
            tiers=("cheap", "local"), providers=("ollama",), models=None
        )

    def test_unknown_tier_fails_closed_and_warns_once(self, caplog, monkeypatch):
        # Isolate the module-level warn-once set so this test is order-independent.
        monkeypatch.setattr(permissions, "_warned_unknown_tiers", set())
        with caplog.at_level(logging.WARNING, logger="app.core.permissions"):
            assert policy_for(tier="ghost", is_admin=False, settings=TIERED) == NO_LLM_POLICY
            assert policy_for(tier="ghost", is_admin=False, settings=TIERED) == NO_LLM_POLICY
        warnings = [r for r in caplog.records if "ghost" in r.getMessage()]
        assert len(warnings) == 1  # once per tier name, not once per request

    def test_features_for_unknown_tier_warns_too(self, caplog, monkeypatch):
        # A feature-gated create can be the first call that hits an unknown
        # tier (policy_for and /me need never have run) — the diagnostic
        # must not depend on which builder fires first.
        monkeypatch.setattr(permissions, "_warned_unknown_tiers", set())
        with caplog.at_level(logging.WARNING, logger="app.core.permissions"):
            assert features_for(tier="ghost", is_admin=False, settings=TIERED) == frozenset()
        assert any("ghost" in r.getMessage() for r in caplog.records)

    def test_features_default_and_admin_and_unknown(self):
        full = frozenset({"custom_profiles", "custom_domains"})
        assert features_for(tier="basic", is_admin=False, settings=SETTINGS) == full
        assert features_for(tier="basic", is_admin=True, settings=TIERED) == full
        assert features_for(tier="premium", is_admin=False, settings=TIERED) == full
        assert features_for(tier="basic", is_admin=False, settings=TIERED) == frozenset()
        assert features_for(tier="ghost", is_admin=False, settings=TIERED) == frozenset()


def eff(tier, provider, model, degraded, skipped=None):
    return EffectiveSelection(
        tier=tier, provider=provider, model=model, degraded=degraded, skipped=skipped
    )


ALLOW_CHEAP_LOCAL = LLMPolicy(tiers=("cheap", "local"), providers=("ollama",), models=None)
ALLOW_LOCAL = LLMPolicy(tiers=("local",), providers=(), models=None)
ALLOW_QUALITY_ONLY = LLMPolicy(tiers=("quality",), providers=(), models=None)
DIRECT_ONLY = LLMPolicy(
    tiers=(), providers=("ollama", "claude"), models={"ollama": ("llama3.1", "qwen3:8b")}
)
DIRECT_ONLY_ALL_MODELS = LLMPolicy(tiers=(), providers=("ollama",), models=None)
TIERS_EMPTY_PROVIDERS_ALL = LLMPolicy(tiers=(), providers=None, models=None)
MODEL_ALLOWLIST = LLMPolicy(
    tiers=None, providers=None, models={"ollama": ("qwen3:8b",)}
)

RESOLUTION_TABLE = [
    # (id, policy, requested, expected)
    ("full-tier-passes", FULL_POLICY, RequestedLLM(tier="balanced"),
     eff("balanced", "claude", "claude-sonnet-5", False)),
    ("full-direct-passes", FULL_POLICY, RequestedLLM(provider="ollama", model="llama3.1"),
     eff(None, "ollama", "llama3.1", False)),
    ("no-selection-uses-default-provider", FULL_POLICY, RequestedLLM(),
     eff(None, "ollama", "llama3.1", False)),
    # §6.2 tier rule 2: walk down the ladder.
    ("tier-degrades-down", ALLOW_CHEAP_LOCAL, RequestedLLM(tier="balanced"),
     eff("cheap", "gemini", "models/gemini-flash-latest", True)),
    # §6.2 tier rule 3: nothing below → nearest allowed above wins.
    ("tier-walks-up", ALLOW_QUALITY_ONLY, RequestedLLM(tier="local"),
     eff("quality", "claude", "claude-opus-4-8", True)),
    ("tier-allowed-unchanged", ALLOW_CHEAP_LOCAL, RequestedLLM(tier="local"),
     eff("local", "ollama", "mistral-nemo:12b-instruct-2407-q6_K", False)),
    # §6.2 tier rule 4: direct-only policy — first provider, first allowlisted model.
    ("tier-under-direct-only", DIRECT_ONLY, RequestedLLM(tier="balanced"),
     eff(None, "ollama", "llama3.1", True)),
    # Rule 4 with models: all — the provider's configured default model.
    ("tier-under-direct-only-all-models", DIRECT_ONLY_ALL_MODELS, RequestedLLM(tier="balanced"),
     eff(None, "ollama", "llama3.1", True)),
    # tiers [] with providers "all": no ordered list to take the head of —
    # degrade to the server's default provider (same as the no-selection path).
    ("tier-under-unordered-direct", TIERS_EMPTY_PROVIDERS_ALL, RequestedLLM(tier="cheap"),
     eff(None, "ollama", "llama3.1", True)),
    # …and that fallback must still respect a models allowlist for the
    # default provider (providers "all" + models mapping is valid config).
    ("tier-under-unordered-direct-allowlisted",
     LLMPolicy(tiers=(), providers=None, models={"ollama": ("qwen3:8b",)}),
     RequestedLLM(tier="cheap"),
     eff(None, "ollama", "qwen3:8b", True)),
    # §6.2 floor: both lists empty → the LLM phase is skipped, visibly.
    ("floor-skips", NO_LLM_POLICY, RequestedLLM(tier="balanced"),
     eff(None, None, None, False, "llm_unavailable")),
    ("floor-skips-direct", NO_LLM_POLICY, RequestedLLM(provider="claude"),
     eff(None, None, None, False, "llm_unavailable")),
    # §6.2 direct rule 1/2: model allowlist substitution.
    ("direct-model-allowed", MODEL_ALLOWLIST, RequestedLLM(provider="ollama", model="qwen3:8b"),
     eff(None, "ollama", "qwen3:8b", False)),
    ("direct-model-substituted", MODEL_ALLOWLIST, RequestedLLM(provider="ollama", model="llama3.1"),
     eff(None, "ollama", "qwen3:8b", True)),
    ("direct-no-model-uses-default", FULL_POLICY, RequestedLLM(provider="claude"),
     eff(None, "claude", "claude-sonnet-5", False)),
    # §6.2 direct rule 3: provider not allowed → best allowed quality tier.
    ("direct-falls-to-best-tier", ALLOW_CHEAP_LOCAL, RequestedLLM(provider="claude", model="claude-opus-4-8"),
     eff("cheap", "gemini", "models/gemini-flash-latest", True)),
    # Direct rule 3 under a direct-only policy: first provider + first model.
    ("direct-falls-to-first-provider", DIRECT_ONLY, RequestedLLM(provider="mistral"),
     eff(None, "ollama", "llama3.1", True)),
    # §6.2 rule 5: a granted tier implies its routed provider — the
    # provider/model lists are NOT additionally consulted on the tier path.
    ("granted-tier-ignores-provider-list", ALLOW_CHEAP_LOCAL, RequestedLLM(tier="cheap"),
     eff("cheap", "gemini", "models/gemini-flash-latest", False)),
]


@pytest.mark.parametrize(
    "policy, requested, expected",
    [row[1:] for row in RESOLUTION_TABLE],
    ids=[row[0] for row in RESOLUTION_TABLE],
)
def test_resolution_table(policy, requested, expected):
    assert resolve_llm_selection(policy, requested, "en", settings=SETTINGS) == expected


def test_missing_routing_entry_skips_with_reason():
    # A language whose tier map lacks the effective tier: resolution keeps
    # the tier but reports the skip — never silently reroutes (rule 5,
    # "as today").
    settings = Settings.model_validate(
        {"routing": {"languages": {"en": {"local": {"provider": "ollama", "model": "x"}}}}}
    )
    result = resolve_llm_selection(
        FULL_POLICY, RequestedLLM(tier="balanced"), "en", settings=settings
    )
    assert result == eff("balanced", None, None, False, "llm_unavailable")


def test_default_model_for_covers_every_builtin_and_extras():
    providers = Settings.model_validate({
        "providers": {"extra_providers": {"deepseek": {
            "base_url": "https://api.deepseek.com/v1", "default_model": "deepseek-v4-pro",
        }}}
    }).providers
    assert default_model_for(providers, "ollama") == providers.ollama_model
    assert default_model_for(providers, "claude") == providers.anthropic_model
    assert default_model_for(providers, "openai") == providers.openai_model
    assert default_model_for(providers, "mistral") == providers.mistral_model
    assert default_model_for(providers, "bedrock") == providers.bedrock_model
    assert default_model_for(providers, "deepseek") == "deepseek-v4-pro"
    assert default_model_for(providers, "nope") is None


class TestLimitsFor:
    def test_admin_gets_the_admin_ceiling(self):
        settings = Settings.model_validate({
            "limits": {"admin": {"llm_checks_per_day": 100,
                                 "max_llm_document_chars": 50000,
                                 "concurrent_llm_runs": 2}},
            "tiers": {"premium": {"limits": {
                "llm_checks_per_day": 200, "max_llm_document_chars": 100000,
                "concurrent_llm_runs": 5}}},
        })
        # The ceiling REPLACES the tier's block (spec §6.4), never raises it.
        limits = limits_for(tier="premium", is_admin=True, settings=settings)
        assert limits.llm_checks_per_day == 100

    def test_configured_tier_gets_its_own_block(self):
        settings = Settings.model_validate({
            "tiers": {"basic": {"limits": {
                "llm_checks_per_day": 20, "max_llm_document_chars": 20000,
                "concurrent_llm_runs": 3}}},
        })
        limits = limits_for(tier="basic", is_admin=False, settings=settings)
        assert limits.llm_checks_per_day == 20

    def test_no_tiers_configured_falls_back_to_admin_defaults(self):
        # Inert-by-default (roadmap M5 row): the generous admin numbers.
        limits = limits_for(tier="basic", is_admin=False, settings=Settings())
        assert limits.llm_checks_per_day == 500

    def test_unknown_tier_falls_back_to_admin_defaults(self):
        # Reachable only for display (/me): an unknown tier's policy is
        # NO_LLM_POLICY, so resolution floors out before any reservation.
        settings = Settings.model_validate({
            "tiers": {"basic": {"limits": {
                "llm_checks_per_day": 20, "max_llm_document_chars": 20000,
                "concurrent_llm_runs": 3}}},
        })
        limits = limits_for(tier="ghost", is_admin=False, settings=settings)
        assert limits.llm_checks_per_day == 500
