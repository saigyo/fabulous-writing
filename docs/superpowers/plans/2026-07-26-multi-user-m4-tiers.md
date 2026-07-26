# Multi-User M4 — Tiered LLM Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user's tier (config-defined) decides which LLM quality tiers, providers and models they may use and which features (custom profiles/domains) they may create — enforced server-side with graceful degradation that is always visible, never an error; the default configuration changes nothing.

**Architecture:** A `tiers:` block in `config.yaml` maps user-tier names to an LLM policy and feature list. One pure function, `resolve_llm_selection` (`app/core/permissions.py`), maps (policy, requested selection, language) to what actually runs — degrading down the quality ladder, substituting allowlisted models, or skipping the LLM phase entirely at the floor. Every LLM-invoking endpoint (checks, suggestions, document naming) acquires its provider through one gate (`get_effective_provider`), so no route can bypass policy. Check responses and SSE carry an `effective_llm` report (requested vs. effective + `degraded`); `/api/auth/me` carries the caller's policy and features; `/api/routing` and `/api/providers` grow per-entry `allowed` flags. The frontend greys out disallowed selections with a "not on your plan" hint (distinct from "offline"), shows degradation notes, hides the LLM phase at the floor, and hides create affordances for missing features.

**Tech Stack:** Python 3.13 / FastAPI / SQLite (backend, `uv` from `backend/`), React 19 / TypeScript / zustand / vitest (frontend, from `frontend/`).

**Spec:** `docs/superpowers/specs/2026-07-24-multi-user-auth-design.md` §6.1 (configuration), §6.2 (graceful degradation), §6.3 (feature gating), §7.1 (`/api/auth/me`), §7.2 (allowed flags, the single gate, degradation for LLM-only endpoints), §8 (frontend gating). Roadmap: `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md` (M4 row, Cross-milestone interfaces).

**Out of scope (M5, not this plan):** the `llm_usage` ledger, `reserve_llm_run`, quotas, the global `limits:` block and the admin ceiling, size caps (413/`document_too_large`), concurrency caps and 429 backpressure, `used_today` on `/me`. Per-tier `limits:` blocks are *parsed and shape-validated* now (so the spec's sample config loads), but nothing enforces them until M5.

## Global Constraints

Binding for every task; copied from the spec/roadmap where they originate.

- **Vocabulary**: *user tiers* are the `tiers:` config keys (`basic`, `premium`, operator-defined); *quality tiers* are the fixed ladder `quality → balanced → cheap → local` (`TIERS` in `app/core/config.py`). Code and tests never conflate the two; new symbols say which they mean (`QualityTier` vs. user-tier strings).
- **Default config is inert** (roadmap M4 row): with no `tiers:` block configured, every user gets the full policy and all features — observable behavior is identical to M3. Tests assert this explicitly.
- **Admins bypass tier policy and feature gates** (spec §6.1): `is_admin` ⇒ full LLM policy and all features. (Admin *limits* arrive in M5; nothing in M4 restricts admins.)
- **Degradation is visible, never silent** (spec §6.2): whenever the LLM phase is requested, the check response and SSE carry an `effective_llm` block (requested vs. effective tier/provider/model, `degraded: bool`, `skipped`). **403 never occurs on the LLM selection path.** 403 remains only for: admin endpoints, feature-gated creates, mutating a global row as non-admin, and the admin-switch denials.
- **One gate** (spec §7.2): no route reaches `app.state.provider_factory` directly; every LLM-invoking endpoint goes through `get_effective_provider`. Task 4 ends with a sweep proving it.
- **LLM-only endpoints degrade with 200** (spec §7.2): a denied `POST /api/suggestions` returns **200** with an empty list and machine-readable `skipped` (M4 code: `llm_unavailable`); name generation silently falls back to local naming. Never 403 on these paths.
- **Fail closed on unknown user tiers**: when a `tiers:` block *is* configured and a user row carries a tier name not in it, that user gets the no-LLM floor and no features (WARNING logged once per tier name) — visible through degradation notes, not errors.
- **The live database `backend/data/fabulous.db` is never read or written by tests**, and `create_app()` is never called with default settings in tests — every test passes `tmp_path`-based `Settings`. The owner's dev servers on ports **5173/8000** are never killed or restarted. (M4 has no schema migration; nothing to rehearse.)
- **Gates before every commit**: backend `uv run pytest -q` from `backend/` with **zero warnings**; frontend `npx vitest run && npm run lint && npm run build` from `frontend/`. (`npm run build` runs `tsc -b`; bare `tsc --noEmit` checks zero files in this solution-style setup and is **not** a gate.)
- **One home per requirement**: each requirement lives in exactly one snippet in this plan; the snippet is canonical and the prose explains only why. If a fix changes a requirement, the snippet changes, not a prose echo.
- **Mutation-verify every guard test**: for each test that pins a guard (feature-gate 403s, degradation clamps, fail-closed unknown tier, the provider-name 422), delete the guard, watch the named test fail, restore, and state in the report which mutation was applied and what was observed. Reviewers re-run at least two claimed mutations independently.
- **Subagents never run `git commit --amend`, `git rebase`, or force-push.**
- **Secrets from the environment only** (`FW_AUTH_SECRET`, `FW_ADMIN_EMAIL`, `FW_ADMIN_PASSWORD`, provider API keys); never in the repo, the DB, or a log line. Tokens never appear in URLs.
- **UI copy**: match the current impersonal register in all seven locales (en, de, fr, es, it, ja, zh); every new key lands in `messages.ts` and all seven catalogs in the same commit as its first use.

## File Structure

| File | Change |
|---|---|
| `backend/app/core/config.py` | `KNOWN_FEATURES`, `known_provider_names()`, `TierLimitsSettings`/`TierLLMSettings`/`TierSettings`, `Settings.tiers` + cross-validation |
| `backend/config.example.yaml` | commented `tiers:` sample |
| `backend/app/core/permissions.py` | **Create**: `LLMPolicy`, `RequestedLLM`, `EffectiveSelection`, `policy_for`, `features_for`, `default_model_for`, `resolve_llm_selection` |
| `backend/app/core/models.py` | `QualityTier`, `LlmSelectionInfo`, `EffectiveLlmReport` |
| `backend/app/api/llm_gate.py` | **Create**: `get_effective_provider`, `effective_llm_report` |
| `backend/app/api/checks.py` | `llm_tier` on `CheckRequest`; gate; `effective_llm` on `CheckStatus` + SSE event; floor skip |
| `backend/app/services/jobs.py` | `CheckJob.effective_llm` |
| `backend/app/api/suggestions.py` | `llm_tier`; gate; `skipped` on `SuggestionResponse`; handler takes `CurrentUser` |
| `backend/app/api/documents.py` | `generate-name` goes through the gate |
| `backend/app/api/auth.py` | `LlmPolicyPayload`/`PolicyPayload`; `MeResponse.policy`; `from_user(user, settings)` |
| `backend/app/api/routing.py` | per-quality-tier `allowed` for the caller |
| `backend/app/api/providers.py` | per-provider `allowed` for the caller |
| `backend/app/api/profiles.py` | `custom_profiles` gate on create |
| `backend/app/api/terminology.py` | `custom_domains` gate on domain + term create |
| `backend/app/api/admin.py` | `TierName` Literal → validation against configured tier names |
| `backend/tests/test_permissions.py` | **Create**: policy + exhaustive resolution tables |
| `backend/tests/` (existing modules) | config, checks, suggestions, naming, auth, routing, providers, profiles, terminology, admin coverage |
| `frontend/src/types.ts` | `allowed` on `RoutingEntry`/`ProviderInfo`; `LlmPolicy`, `PolicyPayload`, `LlmSelectionInfo`, `EffectiveLlm`; `CheckStatus.effective_llm` |
| `frontend/src/api/client.ts` | `MeResponse.policy`; `CheckRequest.llm_tier`; `SuggestionResponse.skipped` |
| `frontend/src/auth/policy.ts` | **Create**: `tierAllowed`, `providerAllowed`, `modelAllowed`, `hasFeature`, `llmDisabled` |
| `frontend/src/header/LlmSelector.tsx` | plan-gated options; floor hides the control |
| `frontend/src/checking/controller.ts` | sends `llm_tier`; floor forces `includeLlm` off; stores `llmEffective` |
| `frontend/src/checking/suggest.ts` | sends `llm_tier`; surfaces `skipped` per finding |
| `frontend/src/checking/effectiveLabel.ts` | **Create**: label helper for degradation notes |
| `frontend/src/state/store.ts` | `llmEffective` transient state |
| `frontend/src/sidebar/Sidebar.tsx` | degradation / not-included notes |
| `frontend/src/profiles/ProfilesView.tsx` | create row gated on `custom_profiles` |
| `frontend/src/terminology/TerminologyView.tsx` | domain + term create gated on `custom_domains` |
| `frontend/src/i18n/messages.ts` + 7 catalogs | `planSuffix`, `llmDegraded`, `llmNotIncluded` |
| `docs/backend-architecture.md`, `docs/frontend-architecture.md`, roadmap | Task 10 |

**Task order and why:** Task 1 (config) has no dependencies. Task 2 (permissions) consumes Task 1's models. Task 3 (gate + checks) consumes Task 2 and defines the report models Task 4 reuses. Task 4 (suggestions/naming) completes the backend gate sweep. Tasks 5 (policy payload + allowed flags) and 6 (feature gates + admin validation) consume Task 2 and are independent of 3–4. Task 7 (frontend plumbing + selector) needs Task 5's `/me` payload; Task 8 (degradation notes) needs Task 3's `effective_llm`; Task 9 (feature-gate UI) needs Task 6's semantics. Task 10 is docs.

---

### Task 1: `tiers:` configuration block

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/config.example.yaml`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Consumes: existing `BUILTIN_PROVIDERS`, `TIERS`, `ProviderSettings` (all already in `config.py`).
- Produces (later tasks rely on these exact names): `KNOWN_FEATURES: tuple[str, ...]`, `known_provider_names(providers: ProviderSettings) -> tuple[str, ...]`, `TierLLMSettings` (fields `tiers`, `providers`, `models`, each `"all"` or a list/mapping), `TierSettings` (fields `llm: TierLLMSettings`, `limits: TierLimitsSettings | None`, `features: list[str]`), `Settings.tiers: dict[str, TierSettings]` (default `{}`).

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_config.py`; follow that module's existing import style)

```python
import pytest
from pydantic import ValidationError

from app.core.config import Settings, known_provider_names


class TestTiersConfig:
    def test_default_is_no_tiers(self):
        assert Settings().tiers == {}

    def test_minimal_tier_defaults_to_all(self):
        settings = Settings.model_validate({"tiers": {"basic": {}}})
        tier = settings.tiers["basic"]
        assert tier.llm.tiers == "all"
        assert tier.llm.providers == "all"
        assert tier.llm.models == "all"
        assert tier.features == []
        assert tier.limits is None

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
                    "features": ["custom_profiles", "custom_domains"],
                },
            }
        })
        assert settings.tiers["basic"].llm.tiers == ["cheap", "local"]
        assert settings.tiers["premium"].features == ["custom_profiles", "custom_domains"]

    def test_empty_llm_lists_are_the_valid_floor(self):
        settings = Settings.model_validate(
            {"tiers": {"basic": {"llm": {"tiers": [], "providers": []}}}}
        )
        assert settings.tiers["basic"].llm.tiers == []
        assert settings.tiers["basic"].llm.providers == []

    def test_unknown_quality_tier_rejected(self):
        with pytest.raises(ValidationError, match="unknown quality tier 'turbo'"):
            Settings.model_validate({"tiers": {"basic": {"llm": {"tiers": ["turbo"]}}}})

    def test_unknown_feature_rejected(self):
        with pytest.raises(ValidationError, match="unknown feature 'teleport'"):
            Settings.model_validate({"tiers": {"basic": {"features": ["teleport"]}}})

    def test_unknown_provider_rejected(self):
        with pytest.raises(ValidationError, match="unknown provider 'nope'"):
            Settings.model_validate({"tiers": {"basic": {"llm": {"providers": ["nope"]}}}})

    def test_models_key_unknown_provider_rejected(self):
        # A typo in a models key must not silently narrow a policy (spec §6.1).
        with pytest.raises(ValidationError, match="unknown provider 'nope'"):
            Settings.model_validate(
                {"tiers": {"basic": {"llm": {"models": {"nope": ["x"]}}}}}
            )

    def test_models_key_outside_providers_rejected(self):
        with pytest.raises(ValidationError, match="'claude' is not in providers"):
            Settings.model_validate({
                "tiers": {"basic": {"llm": {
                    "providers": ["ollama"], "models": {"claude": ["claude-sonnet-5"]},
                }}}
            })

    def test_empty_model_allowlist_rejected(self):
        # An empty list would leave the degradation substitute undefined
        # (spec §6.1); "no models" is expressed by omitting the provider.
        with pytest.raises(ValidationError, match="empty model allowlist"):
            Settings.model_validate(
                {"tiers": {"basic": {"llm": {"models": {"ollama": []}}}}}
            )

    def test_extra_provider_usable_in_tier_policy(self):
        settings = Settings.model_validate({
            "providers": {"extra_providers": {"deepseek": {
                "base_url": "https://api.deepseek.com/v1", "default_model": "deepseek-v4-pro",
            }}},
            "tiers": {"basic": {"llm": {"providers": ["deepseek"]}}},
        })
        assert "deepseek" in known_provider_names(settings.providers)

    def test_nonpositive_tier_limit_rejected(self):
        with pytest.raises(ValidationError, match="llm_checks_per_day"):
            Settings.model_validate(
                {"tiers": {"basic": {"limits": {"llm_checks_per_day": 0}}}}
            )
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_config.py -q` (from `backend/`)
Expected: FAIL — `ImportError: cannot import name 'known_provider_names'`.

- [ ] **Step 3: Implement** (in `backend/app/core/config.py`)

Add after `BUILTIN_ENV_KEYS`:

```python
# Feature flags a tier may grant (spec §6.3). A closed set: config validation
# rejects unknown names so a typo cannot silently withhold (or appear to
# grant) a capability.
KNOWN_FEATURES = ("custom_profiles", "custom_domains")


def known_provider_names(providers: "ProviderSettings") -> tuple[str, ...]:
    """Every provider name this deployment can construct: the built-in five
    plus configured extras. The vocabulary for tier policies and for direct
    provider selection."""
    return BUILTIN_PROVIDERS + tuple(providers.extra_providers)
```

Add after `AuthSettings` (needs `TIERS`, which is defined above it):

```python
class TierLimitsSettings(BaseModel):
    """Per-user-tier numeric limits (spec §6.1). Parsed and shape-validated
    here so the spec's sample config loads; enforcement (and required-ness)
    arrives with M5 metering."""

    llm_checks_per_day: int | None = None
    max_llm_document_chars: int | None = None
    concurrent_llm_runs: int | None = None

    @field_validator("llm_checks_per_day", "max_llm_document_chars", "concurrent_llm_runs")
    @classmethod
    def _positive(cls, value: int | None, info) -> int | None:
        if value is not None and value <= 0:
            raise ValueError(f"{info.field_name} must be a positive integer")
        return value


class TierLLMSettings(BaseModel):
    """What a user tier may run (spec §6.1). 'all' means unrestricted for
    that dimension. `tiers` lists *quality* tiers (the fixed ladder in
    TIERS); `providers`/`models` govern direct selection. Provider-name
    validation lives on Settings, which knows the configured extras."""

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
```

On `Settings`, add the field and the cross-validator (provider names can only be checked once `providers` is parsed):

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config.py -q`
Expected: PASS, zero warnings.

- [ ] **Step 5: Add the commented sample to `backend/config.example.yaml`** (after the `auth:` block, matching the file's commented-out style):

```yaml
# User tiers (multi-user): what each account tier may run and create.
# With no tiers block, every user is unrestricted. Admins always bypass
# tier policy. `tiers` inside `llm:` are the quality tiers
# (quality/balanced/cheap/local); `limits:` is parsed now, enforced by
# the metering milestone.
# tiers:
#   basic:
#     llm:
#       tiers: [cheap, local]   # allowed quality tiers
#       providers: [ollama]     # allowed for direct provider selection
#       models: all             # or a per-provider allowlist, e.g.
#                               #   models:
#                               #     ollama: [mistral-nemo:12b-instruct-2407-q6_K]
#     features: []
#   premium:
#     llm:
#       tiers: all
#       providers: all
#       models: all
#     features: [custom_profiles, custom_domains]
```

- [ ] **Step 6: Full backend gate, then commit**

Run: `uv run pytest -q` — all green, zero warnings.

```bash
git add app/core/config.py config.example.yaml tests/test_config.py
git commit -m "feat(config): tiers block with policy validation (M4)"
```

---

### Task 2: `app/core/permissions.py` — policy resolution with graceful degradation

**Files:**
- Create: `backend/app/core/permissions.py`
- Test: `backend/tests/test_permissions.py` (create)

**Interfaces:**
- Consumes: `KNOWN_FEATURES`, `TIERS`, `ProviderSettings`, `Settings` from `app.core.config` (Task 1).
- Produces: `LLMPolicy(tiers, providers, models)` (each `None` = unrestricted), `FULL_POLICY`, `NO_LLM_POLICY`, `RequestedLLM(tier=None, provider=None, model=None)`, `EffectiveSelection(tier, provider, model, degraded, skipped)`, `policy_for(*, tier: str, is_admin: bool, settings: Settings) -> LLMPolicy`, `features_for(*, tier: str, is_admin: bool, settings: Settings) -> frozenset[str]`, `default_model_for(providers: ProviderSettings, name: str) -> str | None`, `resolve_llm_selection(policy: LLMPolicy, requested: RequestedLLM, language: str, *, settings: Settings) -> EffectiveSelection` (`language` is the two-letter code, e.g. `"en"` — callers pass `body.language.value`).

- [ ] **Step 1: Write the failing tests** (`backend/tests/test_permissions.py`)

The resolution table is the heart of spec §6.2 — every rule gets a named row, including floor, walk-up, the direct-only cell (rule 4), and the unordered-providers variant of it. Use `local`-tier routing (provider `ollama`) so no test depends on optional extra providers.

```python
"""Exhaustive tables for spec §6.2 — resolve_llm_selection and the policy
builders. Routing defaults used below (from config._default_routing_languages,
language 'en'): quality→claude, balanced→claude, cheap→gemini, local→ollama."""

import pytest

from app.core.config import Settings
from app.core.permissions import (
    FULL_POLICY,
    NO_LLM_POLICY,
    EffectiveSelection,
    LLMPolicy,
    RequestedLLM,
    default_model_for,
    features_for,
    policy_for,
    resolve_llm_selection,
)

SETTINGS = Settings()  # default routing table + default providers

TIERED = Settings.model_validate({
    "tiers": {
        "basic": {"llm": {"tiers": ["cheap", "local"], "providers": ["ollama"]}},
        "premium": {"llm": {}, "features": ["custom_profiles", "custom_domains"]},
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

    def test_unknown_tier_fails_closed(self, caplog):
        policy = policy_for(tier="ghost", is_admin=False, settings=TIERED)
        assert policy == NO_LLM_POLICY

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
```

Note the `tier-under-unordered-direct` row: spec §6.2 rule 4 presumes an *ordered* provider list; with `tiers: []` and `providers: "all"` there is no head to take, so this plan pins the server's `default_provider` as the substitute — the same choice an empty request resolves to. This is a plan-level decision, recorded here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_permissions.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.permissions'`.

- [ ] **Step 3: Implement** (`backend/app/core/permissions.py`)

```python
"""User-tier LLM policy: what a caller may select, and what actually runs.

Vocabulary: *user tiers* are the config `tiers:` keys (basic, premium, …);
*quality tiers* are the fixed ladder in app.core.config.TIERS. This module
maps a user tier to its policy (spec §6.1) and resolves a requested
selection against it with graceful degradation (spec §6.2). Everything here
is pure — no I/O, no app state — so the §6.2 rules are testable as a table.
"""

import logging
from dataclasses import dataclass

from app.core.config import KNOWN_FEATURES, TIERS, ProviderSettings, Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LLMPolicy:
    """None means unrestricted for that dimension (config 'all'). `providers`
    keeps config order: the first entry is the degradation substitute
    (spec §6.2 rules 3–4). A provider absent from a non-None `models`
    mapping allows all its models."""

    tiers: tuple[str, ...] | None
    providers: tuple[str, ...] | None
    models: dict[str, tuple[str, ...]] | None


FULL_POLICY = LLMPolicy(tiers=None, providers=None, models=None)
# The §6.2 floor — and the fail-closed policy for a user row whose tier name
# is not in a configured tiers block.
NO_LLM_POLICY = LLMPolicy(tiers=(), providers=(), models=None)


@dataclass(frozen=True)
class RequestedLLM:
    """What the caller asked for. tier set = tier-based request (provider/
    model ignored); tier None = direct request; all None = server default."""

    tier: str | None = None
    provider: str | None = None
    model: str | None = None


@dataclass(frozen=True)
class EffectiveSelection:
    tier: str | None
    provider: str | None
    model: str | None
    degraded: bool
    # 'llm_unavailable' when the LLM phase cannot run at all (floor, or the
    # effective tier has no routing entry). M5 adds quota/size codes.
    skipped: str | None = None


# WARNING once per unknown tier name, not once per request: policy resolution
# runs on every check, and a misconfigured tier would otherwise flood the log.
_warned_unknown_tiers: set[str] = set()


def policy_for(*, tier: str, is_admin: bool, settings: Settings) -> LLMPolicy:
    if is_admin or not settings.tiers:
        # Admins bypass tier policy (spec §6.1); an instance with no tiers
        # configured behaves exactly as before M4 (roadmap: default inert).
        return FULL_POLICY
    cfg = settings.tiers.get(tier)
    if cfg is None:
        # Fail closed, visibly: the user sees degradation notes, not errors.
        if tier not in _warned_unknown_tiers:
            _warned_unknown_tiers.add(tier)
            logger.warning(
                "user tier '%s' is not configured under tiers:; treating as no-LLM",
                tier,
            )
        return NO_LLM_POLICY
    llm = cfg.llm
    return LLMPolicy(
        tiers=None if llm.tiers == "all" else tuple(llm.tiers),
        providers=None if llm.providers == "all" else tuple(llm.providers),
        models=None
        if llm.models == "all"
        else {name: tuple(models) for name, models in llm.models.items()},
    )


def features_for(*, tier: str, is_admin: bool, settings: Settings) -> frozenset[str]:
    if is_admin or not settings.tiers:
        return frozenset(KNOWN_FEATURES)
    cfg = settings.tiers.get(tier)
    if cfg is None:
        return frozenset()
    return frozenset(cfg.features)


def default_model_for(providers: ProviderSettings, name: str) -> str | None:
    """The model a bare provider selection resolves to — mirrors what
    app.main's provider factory would fall back to for each provider."""
    builtin = {
        "ollama": providers.ollama_model,
        "claude": providers.anthropic_model,
        "openai": providers.openai_model,
        "mistral": providers.mistral_model,
        "bedrock": providers.bedrock_model,
    }
    if name in builtin:
        return builtin[name]
    extra = providers.extra_providers.get(name)
    return extra.default_model if extra else None


def resolve_llm_selection(
    policy: LLMPolicy, requested: RequestedLLM, language: str, *, settings: Settings
) -> EffectiveSelection:
    """Spec §6.2, both paths. `language` is the two-letter code."""
    if requested.tier is None and requested.provider is None:
        # No explicit selection: the pre-M4 behavior was the configured
        # default provider — resolve it as a direct request.
        requested = RequestedLLM(
            provider=settings.providers.default_provider, model=requested.model
        )
    if requested.tier is not None:
        return _resolve_tier(policy, requested.tier, language, settings)
    return _resolve_direct(policy, requested, language, settings)


def _resolve_tier(
    policy: LLMPolicy, tier: str, language: str, settings: Settings
) -> EffectiveSelection:
    if policy.tiers is None or tier in policy.tiers:
        return _routed(settings, tier, language, degraded=False)
    idx = TIERS.index(tier)
    for candidate in TIERS[idx + 1 :]:  # rule 2: walk down the ladder
        if candidate in policy.tiers:
            return _routed(settings, candidate, language, degraded=True)
    for candidate in reversed(TIERS[:idx]):  # rule 3: nearest allowed above
        if candidate in policy.tiers:
            return _routed(settings, candidate, language, degraded=True)
    # policy.tiers is empty (rule 4): a direct-only policy.
    return _direct_fallback(policy, settings)


def _resolve_direct(
    policy: LLMPolicy, requested: RequestedLLM, language: str, settings: Settings
) -> EffectiveSelection:
    name = requested.provider
    assert name is not None  # normalized by resolve_llm_selection
    if policy.providers is None or name in policy.providers:
        allow = policy.models.get(name) if policy.models is not None else None
        model = requested.model or default_model_for(settings.providers, name)
        if allow is None or (model is not None and model in allow):
            return EffectiveSelection(
                tier=None, provider=name, model=model, degraded=False
            )
        # Rule 2: degrade to the first model on the provider's allowlist.
        return EffectiveSelection(
            tier=None, provider=name, model=allow[0], degraded=True
        )
    if policy.tiers is None or policy.tiers:
        # Rule 3: fall back to tier routing at the best allowed quality tier.
        best = next(
            t for t in TIERS if policy.tiers is None or t in policy.tiers
        )
        return _routed(settings, best, language, degraded=True)
    return _direct_fallback(policy, settings)


def _direct_fallback(policy: LLMPolicy, settings: Settings) -> EffectiveSelection:
    """Rules 3/4 under an empty tier list: the policy's first provider with
    its first allowlisted (or default) model; providers 'all' has no order,
    so the server default stands in; both empty is the floor."""
    if policy.providers is None:
        name = settings.providers.default_provider
        return EffectiveSelection(
            tier=None,
            provider=name,
            model=default_model_for(settings.providers, name),
            degraded=True,
        )
    if policy.providers:
        name = policy.providers[0]
        allow = policy.models.get(name) if policy.models is not None else None
        model = allow[0] if allow else default_model_for(settings.providers, name)
        return EffectiveSelection(tier=None, provider=name, model=model, degraded=True)
    return EffectiveSelection(
        tier=None, provider=None, model=None, degraded=False, skipped="llm_unavailable"
    )


def _routed(
    settings: Settings, tier: str, language: str, *, degraded: bool
) -> EffectiveSelection:
    entry = settings.routing.languages.get(language, {}).get(tier)
    if entry is None:
        # Rule 5 says a granted tier resolves through the routing table "as
        # today" — and today an unconfigured entry means the LLM phase is
        # skipped with a reason, never silently rerouted.
        return EffectiveSelection(
            tier=tier,
            provider=None,
            model=None,
            degraded=degraded,
            skipped="llm_unavailable",
        )
    return EffectiveSelection(
        tier=tier, provider=entry.provider, model=entry.model, degraded=degraded
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_permissions.py -q`
Expected: PASS. Then `uv run pytest -q` — all green, zero warnings.

- [ ] **Step 5: Mutation-verify the degradation clamps** — three named mutations, restore after each:
  1. In `_resolve_tier`, change the allowed check to `if True:` → `tier-degrades-down` and `tier-walks-up` fail.
  2. In `_resolve_direct`, delete the `allow[0]` substitution branch (return the requested model) → `direct-model-substituted` fails.
  3. In `policy_for`, make the unknown-tier branch return `FULL_POLICY` → `test_unknown_tier_fails_closed` fails.

- [ ] **Step 6: Commit**

```bash
git add app/core/permissions.py tests/test_permissions.py
git commit -m "feat(permissions): resolve_llm_selection with graceful degradation (M4)"
```

---

### Task 3: The LLM gate + checks report `effective_llm`

**Files:**
- Create: `backend/app/api/llm_gate.py`
- Modify: `backend/app/core/models.py` (add `QualityTier`, `LlmSelectionInfo`, `EffectiveLlmReport`)
- Modify: `backend/app/api/checks.py`
- Modify: `backend/app/services/jobs.py`
- Test: `backend/tests/test_check_api.py`, `backend/tests/test_register_consistency.py`

**Interfaces:**
- Consumes: Task 2's `RequestedLLM`, `EffectiveSelection`, `policy_for`, `resolve_llm_selection`; Task 1's `known_provider_names`; `CurrentUser` (`app/api/deps.py`); `app.state.provider_factory` (`app/main.py:42`).
- Produces: `QualityTier = Literal["quality", "balanced", "cheap", "local"]` and pydantic models `LlmSelectionInfo{tier, provider, model}` / `EffectiveLlmReport{requested, effective, degraded, skipped}` in `app/core/models.py`; `get_effective_provider(app, user, requested, language) -> tuple[EffectiveSelection, LLMProvider | None]` and `effective_llm_report(requested, effective) -> EffectiveLlmReport` in `app/api/llm_gate.py`; `CheckRequest.llm_tier: QualityTier | None`; `CheckStatus.effective_llm: EffectiveLlmReport | None`; SSE event `effective_llm`; `CheckJob.effective_llm`.

- [ ] **Step 1: Write the failing tests.** In `backend/tests/test_check_api.py`, following the module's existing app-building and provider-faking patterns (it already fakes LLM providers for the SSE tests — reuse that fake, recording the provider/model the factory was asked for). New tests:

```python
# Local helper for this class; TIERS_CONFIG restricts 'basic' to local/ollama.
TIERS_CONFIG = {
    "basic": {"llm": {"tiers": ["local"], "providers": ["ollama"]}},
}


class TestEffectiveLlm:
    def test_unrestricted_tier_request_resolves_via_routing(self, tmp_path):
        # Admin (bootstrap) + no tiers config: llm_tier balanced resolves to
        # the routing entry, degraded False; the POST response, a later GET,
        # and the SSE stream all carry the same effective_llm block.
        ...

    def test_restricted_user_degrades_balanced_to_local(self, tmp_path):
        # App with tiers=TIERS_CONFIG; second (non-admin, tier basic) user
        # sends llm_tier "balanced": the recording factory receives
        # ("ollama", <en local routed model>), and effective_llm reports
        # requested tier balanced / effective tier local / degraded True.
        ...

    def test_floor_user_gets_skipped_not_error(self, tmp_path):
        # tiers={"basic": {"llm": {"tiers": [], "providers": []}}}: POST with
        # checkers=["llm"] returns 202, status "done", findings [], and
        # effective_llm.skipped == "llm_unavailable"; the factory is never
        # called; GET returns the same block.
        ...

    def test_unknown_llm_provider_is_422(self, tmp_path):
        # llm_provider "nope" → 422 (today it 500s via the factory's
        # ValueError); the job is discarded (a subsequent GET on any id from
        # the response would 404, and no job leaks running).
        ...

    def test_invalid_llm_tier_is_422(self, tmp_path):
        # llm_tier "turbo" → 422 straight from the request model.
        ...

    def test_no_llm_checker_has_no_effective_llm(self, tmp_path):
        # checkers=["rules"] → effective_llm is None (the block describes the
        # LLM phase; absent phase, absent block).
        ...
```

Write these as real tests, not stubs — the `...` bodies above only abbreviate this plan. Also add to `backend/tests/test_register_consistency.py`:

```python
def test_quality_tier_literal_matches_config_tiers():
    from typing import get_args

    from app.core.config import TIERS
    from app.core.models import QualityTier

    assert tuple(get_args(QualityTier)) == TIERS
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_check_api.py tests/test_register_consistency.py -q`
Expected: FAIL — `llm_tier` unknown field / imports missing.

- [ ] **Step 3: Implement.** In `backend/app/core/models.py` (alongside the existing shared shapes):

```python
# The four quality tiers, as a request-validation type. Kept in lockstep with
# app.core.config.TIERS (test_register_consistency pins it).
QualityTier = Literal["quality", "balanced", "cheap", "local"]


class LlmSelectionInfo(BaseModel):
    tier: str | None = None
    provider: str | None = None
    model: str | None = None


class EffectiveLlmReport(BaseModel):
    """Requested vs. effective LLM selection (spec §6.2: degradation is
    visible, never silent)."""

    requested: LlmSelectionInfo
    effective: LlmSelectionInfo
    degraded: bool
    skipped: str | None = None
```

New `backend/app/api/llm_gate.py`:

```python
"""The single gate every LLM-invoking endpoint goes through (spec §7.2).

No route touches app.state.provider_factory directly: checks, suggestions
and document naming all resolve their selection here, so tier policy cannot
be bypassed. M5 extends this gate with the size cap and the quota/
concurrency reservation, in that order around resolve_llm_selection.
"""

from dataclasses import replace

from fastapi import FastAPI, HTTPException

from app.api.deps import CurrentUser
from app.checkers.llm.provider import LLMProvider
from app.core.config import known_provider_names
from app.core.models import EffectiveLlmReport, LlmSelectionInfo
from app.core.permissions import (
    EffectiveSelection,
    RequestedLLM,
    policy_for,
    resolve_llm_selection,
)


def get_effective_provider(
    app: FastAPI, user: CurrentUser, requested: RequestedLLM, language: str
) -> tuple[EffectiveSelection, LLMProvider | None]:
    """Resolve the caller's request against their policy and build the
    provider that will actually run. (selection, None) means the LLM phase
    is skipped — selection.skipped says why."""
    settings = app.state.settings
    if requested.provider is not None and requested.provider not in known_provider_names(
        settings.providers
    ):
        raise HTTPException(422, f"Unknown LLM provider: {requested.provider}")
    policy = policy_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    effective = resolve_llm_selection(policy, requested, language, settings=settings)
    if effective.provider is None:
        return effective, None
    try:
        provider = app.state.provider_factory(effective.provider, effective.model)
    except ValueError:
        # The routing table may point a tier at a provider this server has
        # not configured (the default table references optional extras as
        # configuration guidance) — that is "not configured", not a 500.
        return replace(effective, skipped="llm_unavailable"), None
    return effective, provider


def effective_llm_report(
    requested: RequestedLLM, effective: EffectiveSelection
) -> EffectiveLlmReport:
    return EffectiveLlmReport(
        requested=LlmSelectionInfo(
            tier=requested.tier, provider=requested.provider, model=requested.model
        ),
        effective=LlmSelectionInfo(
            tier=effective.tier, provider=effective.provider, model=effective.model
        ),
        degraded=effective.degraded,
        skipped=effective.skipped,
    )
```

In `backend/app/services/jobs.py`, `CheckJob.__init__` gains:

```python
        self.effective_llm: EffectiveLlmReport | None = None
```

(import `EffectiveLlmReport` from `app.core.models`, which jobs.py already imports from).

In `backend/app/api/checks.py`: `CheckRequest` gains `llm_tier: QualityTier | None = None`; `CheckStatus` gains `effective_llm: EffectiveLlmReport | None = None` (and both constructor sites pass `effective_llm=job.effective_llm`). The LLM branch of `create_check` becomes:

```python
        if "llm" in body.checkers:
            requested = RequestedLLM(
                tier=body.llm_tier, provider=body.llm_provider, model=body.llm_model
            )
            effective, provider = get_effective_provider(
                app, user, requested, body.language.value
            )
            job.effective_llm = effective_llm_report(requested, effective)
            # On the stream too (spec §6.2): SSE consumers see the same block
            # the POST response carries.
            job.emit("effective_llm", job.effective_llm.model_dump(mode="json"))
            if provider is None:
                job.finish()
            else:
                job.attach_task(
                    asyncio.create_task(
                        _run_llm(
                            job,
                            provider,
                            body.text,
                            body.language,
                            vet=app.state.settings.vet_suggestions,
                            dictionaries_dir=app.state.settings.dictionaries_dir,
                            instructions=body.llm_instructions,
                        )
                    )
                )
        else:
            job.finish()
```

The gate's 422 raises inside the existing `try:` → the `except Exception: app.state.jobs.discard(job.id); raise` net already prevents a leaked running job — do not add a second net.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_check_api.py tests/test_register_consistency.py tests/test_jobs.py -q`, then `uv run pytest -q` — all green, zero warnings.

- [ ] **Step 5: Mutation-verify**: (1) make `get_effective_provider` ignore policy (use `FULL_POLICY`) → `test_restricted_user_degrades_balanced_to_local` and `test_floor_user_gets_skipped_not_error` fail; (2) drop the `known_provider_names` check → `test_unknown_llm_provider_is_422` fails. Restore both.

- [ ] **Step 6: Commit**

```bash
git add app/api/llm_gate.py app/core/models.py app/api/checks.py app/services/jobs.py tests/
git commit -m "feat(checks): LLM gate with effective_llm reporting (M4)"
```

---

### Task 4: Suggestions and document naming through the gate

**Files:**
- Modify: `backend/app/api/suggestions.py`
- Modify: `backend/app/api/documents.py` (the `generate_name` handler, currently `documents.py:205-259`)
- Test: `backend/tests/test_suggestions_api.py` (or the module that currently tests `/api/suggestions` — locate by `grep -rln "api/suggestions" backend/tests`), `backend/tests/test_documents_api.py`

**Interfaces:**
- Consumes: Task 3's `get_effective_provider`; Task 3's `QualityTier`; `CurrentUser`/`get_current_user`.
- Produces: `SuggestionRequest.llm_tier: QualityTier | None`; `SuggestionResponse.skipped: str | None`; the invariant that `grep -rn "provider_factory" backend/app --include='*.py'` matches only `app/main.py` and `app/api/llm_gate.py`.

- [ ] **Step 1: Write the failing tests.**

Suggestions (in the module that tests `/api/suggestions`, with its existing fake-provider pattern):

```python
    def test_restricted_user_cannot_obtain_disallowed_provider(self, tmp_path):
        # tiers={"basic": {"llm": {"tiers": ["local"], "providers": ["ollama"]}}}:
        # the basic user requests llm_provider "claude" — the recording
        # factory receives ("ollama", ...) (best allowed tier "local" routes
        # there), never "claude". Spec §10: "a basic user cannot obtain a
        # premium provider through them".
        ...

    def test_floor_user_gets_200_with_skipped(self, tmp_path):
        # tiers={"basic": {"llm": {"tiers": [], "providers": []}}}: POST
        # /api/suggestions → 200, suggestions == [], skipped ==
        # "llm_unavailable", span/original still filled; factory never called.
        # Never 403 (spec §7.2).
        ...

    def test_unrestricted_response_has_no_skipped(self, tmp_path):
        # Existing happy path still returns skipped None.
        ...
```

Name generation (in `backend/tests/test_documents_api.py`, following its `generate-name` tests):

```python
    def test_generate_name_floor_user_falls_back_silently(self, tmp_path):
        # Floor-tier user POSTs generate-name on their own fallback-named
        # document with text: 200, name_source "fallback" (local naming), no
        # factory call, no error field anywhere.
        ...

    def test_generate_name_uses_cheap_route_through_gate(self, tmp_path):
        # Unrestricted user: the recording factory receives exactly the
        # routing table's ("cheap") entry for the document's language.
        ...
```

Write real bodies; the `...` only abbreviates this plan.

- [ ] **Step 2: Run to verify they fail** — `uv run pytest tests/test_suggestions_api.py tests/test_documents_api.py -q` (adjust the suggestions module name to what Step 1 located).

- [ ] **Step 3: Implement.** `suggestions.py`: add to `SuggestionRequest` the field `llm_tier: QualityTier | None = None`; add to `SuggestionResponse` the field `skipped: str | None = None`; give the handler `user: CurrentUser = Depends(get_current_user)`; replace the `provider_factory` call (currently `suggestions.py:75-77`) with:

```python
    requested = RequestedLLM(
        tier=body.llm_tier, provider=body.llm_provider, model=body.llm_model
    )
    effective, provider = get_effective_provider(
        request.app, user, requested, body.language.value
    )
    if provider is None:
        # Spec §7.2: where the LLM output IS the product, a denial degrades
        # to an empty 200 with a machine-readable reason — never 403.
        return SuggestionResponse(
            suggestions=[],
            span=SpanRef(start=start, end=end),
            original=original,
            skipped=effective.skipped,
        )
```

`documents.py` `generate_name`: replace the routing-table read + `provider_factory` call (currently `documents.py:222-241`) with the gate:

```python
    title: str | None = None
    requested = RequestedLLM(tier="cheap")  # name generation hard-selects the cheap route
    effective, provider = get_effective_provider(
        request.app, user, requested, document.language.value
    )
    if provider is not None and document.text.strip():
        try:
            system, prompt = build_title_prompt(document.text, document.language)
            title = clean_title(await provider.generate(system, prompt))
        except Exception:
            logger.warning(
                "auto-title generation failed for document %s",
                document_id,
                exc_info=True,
            )
            title = None  # silent per spec; the fallback below still applies
```

Note this renames the prompt's user-message variable from `user` to `prompt` — removing the existing shadowing of the `CurrentUser` (the `owner_id` capture above it stays but its shadowing rationale comment can now go).

- [ ] **Step 4: Run to verify green**, then the full suite: `uv run pytest -q` — zero warnings.

- [ ] **Step 5: The gate sweep** (Global Constraint "One gate"):

Run: `grep -rn "provider_factory" app --include='*.py'`
Expected: matches only in `app/main.py` (definition + `app.state` assignment) and `app/api/llm_gate.py`. Any other match is a policy bypass — route it through the gate before proceeding. Record the sweep output in the task report.

- [ ] **Step 6: Mutation-verify**: remove the `if provider is None` early return in suggestions → `test_floor_user_gets_200_with_skipped` fails (500 or 502). Restore.

- [ ] **Step 7: Commit**

```bash
git add app/api/suggestions.py app/api/documents.py tests/
git commit -m "feat(llm): suggestions and naming go through the tier gate (M4)"
```

---

### Task 5: `/api/auth/me` policy payload; `allowed` flags on routing and providers

**Files:**
- Modify: `backend/app/api/auth.py`
- Modify: `backend/app/api/routing.py`
- Modify: `backend/app/api/providers.py`
- Test: `backend/tests/test_auth_api.py`, `backend/tests/test_routing_api.py`, `backend/tests/test_providers_api.py`

**Interfaces:**
- Consumes: Task 2's `policy_for`, `features_for`; Task 1's `KNOWN_FEATURES`.
- Produces: `MeResponse.policy: PolicyPayload` where `PolicyPayload = {llm: {tiers: list|null, providers: list|null, models: dict|null}, features: list[str]}` (`null` = unrestricted — the shape the frontend consumes in Task 7); `MeResponse.from_user(user, settings)` (signature change); per-entry `allowed: bool` on `/api/routing` tier entries and `/api/providers` entries.

- [ ] **Step 1: Write the failing tests.**

`test_auth_api.py`:

```python
TIERS_CONFIG = {
    "basic": {"llm": {"tiers": ["cheap", "local"], "providers": ["ollama"],
                      "models": {"ollama": ["llama3.1"]}}, "features": []},
}


class TestMePolicy:
    def test_default_config_reports_full_policy(self, tmp_path):
        # No tiers configured: /me carries policy.llm all-null and both
        # features — the "unchanged until tiers are configured" contract.
        # (App via the module's usual custom-settings + auth_headers path.)
        # assert body["policy"] == {
        #     "llm": {"tiers": None, "providers": None, "models": None},
        #     "features": ["custom_profiles", "custom_domains"],
        # }
        ...

    def test_tiered_user_sees_their_policy(self, tmp_path):
        # tiers=TIERS_CONFIG, second (basic) user:
        # policy.llm == {"tiers": ["cheap", "local"], "providers": ["ollama"],
        #                "models": {"ollama": ["llama3.1"]}}; features == [].
        ...

    def test_admin_sees_full_policy_despite_tiers(self, tmp_path):
        ...

    def test_login_response_user_carries_policy(self, tmp_path):
        # LoginResponse.user is the same MeResponse model — policy included.
        ...
```

`test_routing_api.py`: with `tiers=TIERS_CONFIG`, the basic user's `/api/routing` marks `cheap`/`local` entries `allowed: true` and `quality`/`balanced` `allowed: false` for every language; the admin gets all-true. `test_providers_api.py`: the basic user sees `allowed: true` only on `ollama`; the admin all-true; default config all-true.

Write all of these as real tests — the `...` bodies and comment sketches above only abbreviate this plan.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** In `auth.py`:

```python
class LlmPolicyPayload(BaseModel):
    """None = unrestricted (config 'all')."""

    tiers: list[str] | None = None
    providers: list[str] | None = None
    models: dict[str, list[str]] | None = None


class PolicyPayload(BaseModel):
    llm: LlmPolicyPayload
    features: list[str]


def _policy_payload(user: User, settings: Settings) -> PolicyPayload:
    policy = policy_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    features = features_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    return PolicyPayload(
        llm=LlmPolicyPayload(
            tiers=None if policy.tiers is None else list(policy.tiers),
            providers=None if policy.providers is None else list(policy.providers),
            models=None
            if policy.models is None
            else {name: list(models) for name, models in policy.models.items()},
        ),
        # KNOWN_FEATURES order, so the payload is deterministic.
        features=[f for f in KNOWN_FEATURES if f in features],
    )
```

`MeResponse` gains `policy: PolicyPayload`; `from_user` becomes `from_user(cls, user: User, settings: Settings)` and fills `policy=_policy_payload(user, settings)`. Update both call sites (`login`, `me`) to pass `request.app.state.settings`. Update the `MeResponse` docstring: the M4 half of its promise is now delivered; M5 adds quota/size/concurrency.

`routing.py`: give `get_routing` a `user: CurrentUser = Depends(get_current_user)` parameter (FastAPI's per-request dependency cache means no second token verification), compute `policy = policy_for(tier=user.tier, is_admin=user.is_admin, settings=settings)` once, and add to each tier entry dict:

```python
                "allowed": policy.tiers is None or tier in policy.tiers,
```

`providers.py`: same dependency; after `asyncio.gather`, annotate each entry:

```python
    policy = policy_for(
        tier=user.tier, is_admin=user.is_admin, settings=request.app.state.settings
    )
    results = list(await asyncio.gather(*entries))
    for entry in results:
        # 'allowed' means allowed for DIRECT selection (spec §7.2): a
        # provider outside llm.providers can still serve a routed
        # quality-tier run (§6.2 rule 5).
        entry["allowed"] = policy.providers is None or entry["name"] in policy.providers
    return results
```

- [ ] **Step 4: Run to verify green**, then full suite: `uv run pytest -q` — zero warnings.

- [ ] **Step 5: Commit**

```bash
git add app/api/auth.py app/api/routing.py app/api/providers.py tests/
git commit -m "feat(api): /me policy payload and allowed flags (M4)"
```

---

### Task 6: Feature gates on creation; admin tier-name validation

**Files:**
- Modify: `backend/app/api/profiles.py` (`create_profile`, `profiles.py:74`)
- Modify: `backend/app/api/terminology.py` (`create_domain`, `terminology.py:50`; `create_term`, `terminology.py:119`)
- Modify: `backend/app/api/admin.py`
- Modify: `backend/app/services/users.py` (comment only, see Step 3)
- Test: `backend/tests/test_profiles_api.py`, `backend/tests/test_terminology_api.py` (locate by `grep -rln "api/domains" backend/tests`), `backend/tests/test_admin_api.py`

**Interfaces:**
- Consumes: Task 2's `features_for`.
- Produces: 403 with detail `"Your plan does not include custom profiles"` / `"Your plan does not include custom terminology domains"` on gated creates; admin `tier` fields accept any *configured* tier name (fallback `("basic", "premium")` when no `tiers:` block exists), 422 otherwise.

- [ ] **Step 1: Write the failing tests.**

Feature gates (profiles module shown; terminology mirrors it for domain AND term creation):

```python
NO_FEATURES = {"basic": {"llm": {}, "features": []}}
WITH_FEATURES = {"basic": {"llm": {}, "features": ["custom_profiles", "custom_domains"]}}


class TestCustomProfilesGate:
    def test_create_without_feature_is_403(self, tmp_path):
        # tiers=NO_FEATURES, basic user: POST /api/profiles → 403. Global
        # profiles remain listable/usable (GET still 200).
        ...

    def test_create_with_feature_succeeds(self, tmp_path):
        ...

    def test_admin_bypasses_gate(self, tmp_path):
        # tiers=NO_FEATURES, bootstrap admin: create → 201.
        ...

    def test_default_config_is_ungated(self, tmp_path):
        # No tiers block: basic user creates fine (inert default).
        ...

    def test_existing_items_stay_editable_after_flag_removal(self, tmp_path):
        # Spec §6.3: the gate is on creation. Build app A (WITH_FEATURES) on
        # db_path, create a profile as the basic user; build app B
        # (NO_FEATURES) on the SAME db_path: PUT and DELETE on that profile
        # succeed, POST is 403.
        ...
```

For terminology, the same five shapes for `POST /api/domains`, plus: `test_term_create_without_feature_is_403` (adding a term to the user's *own existing* domain, created while the flag was on, is 403 once the flag is off — creation, not editing) and `test_term_update_delete_stay_allowed`.

Admin validation (`test_admin_api.py`):

```python
    def test_default_names_accepted_without_tiers_block(self, tmp_path):
        # create user tier "premium" → 201-equivalent; patch to "basic" → ok.
        ...

    def test_configured_names_replace_defaults(self, tmp_path):
        # tiers={"gold": {}}: create with tier "gold" ok; tier "basic" → 422
        # naming the valid options; PATCH to "premium" → 422.
        ...
```

Write all of these as real tests — the `...` bodies only abbreviate this plan.

- [ ] **Step 2: Run to verify they fail** (the feature-gate tests fail with 201-instead-of-403; the admin `"gold"` test fails with 422-instead-of-ok).

- [ ] **Step 3: Implement.**

`profiles.py`, first line of `create_profile`:

```python
    if "custom_profiles" not in features_for(
        tier=user.tier, is_admin=user.is_admin, settings=request.app.state.settings
    ):
        raise HTTPException(403, "Your plan does not include custom profiles")
```

`terminology.py`: the same guard (feature `custom_domains`, detail `"Your plan does not include custom terminology domains"`) as the first line of **both** `create_domain` and `create_term`. It runs before any store read: cheap, and a foreign/global domain id changes nothing about the caller's plan. The store's existing `GlobalReadOnlyError` → 403 for global rows stays as-is behind it.

`admin.py`: delete the `TierName` Literal (and its now-satisfied "M4 replaces this" comment); `UserCreate.tier: str = "basic"`, `UserPatch.tier: str | None = None` (keep `_reject_explicit_null` listing `tier`). Add:

```python
def _validate_tier_name(request: Request, tier: str) -> None:
    """Tier names are config-defined (spec §6.1). With no tiers block the
    spec's two default names (§5.1) remain assignable — policy is
    unrestricted for everyone in that state anyway."""
    known = tuple(request.app.state.settings.tiers) or ("basic", "premium")
    if tier not in known:
        raise HTTPException(422, f"unknown tier '{tier}': must be one of {list(known)}")
```

Call it in the create handler (always — the default `"basic"` must also be validated, so a config whose tiers omit `basic` rejects a tier-less create loudly rather than minting an unconfigured tier) and in the patch handler when `body.tier is not None`. In `users.py`, update the schema comment at the `tier` column (`users.py:24-28`) to point at `config.yaml`'s `tiers:` block and `app/api/admin.py`'s validation, present tense.

- [ ] **Step 4: Run to verify green**, then full suite: `uv run pytest -q` — zero warnings.

- [ ] **Step 5: Mutation-verify** (guard tests): (1) delete the `create_profile` gate → `test_create_without_feature_is_403` fails; (2) delete the `create_term` gate → `test_term_create_without_feature_is_403` fails; (3) make `_validate_tier_name` a no-op → the 422 assertions in `test_configured_names_replace_defaults` fail. Restore all.

- [ ] **Step 6: Commit**

```bash
git add app/api/profiles.py app/api/terminology.py app/api/admin.py app/services/users.py tests/
git commit -m "feat(api): feature gates on creation, config-driven tier names (M4)"
```

---

### Task 7: Frontend policy plumbing and selector gating

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`
- Create: `frontend/src/auth/policy.ts`
- Test: `frontend/src/auth/policy.test.ts` (create)
- Modify: `frontend/src/header/LlmSelector.tsx`
- Modify: `frontend/src/i18n/messages.ts` + all seven catalogs
- Test: `frontend/src/header/LlmSelector.test.tsx` (create, jsdom render like `ProfileSelector.test.tsx`)

**Interfaces:**
- Consumes: Task 5's `/me` payload shape.
- Produces: `PolicyPayload`/`LlmPolicy`/`LlmSelectionInfo`/`EffectiveLlm` in `types.ts`; `MeResponse.policy: PolicyPayload`; `tierAllowed(user, tier)`, `providerAllowed(user, name)`, `modelAllowed(user, provider, model)`, `hasFeature(user, feature)`, `llmDisabled(user)` in `auth/policy.ts` (each takes `MeResponse | null`); i18n keys `planSuffix: string`, `llmDegraded: (effective: string, requested: string) => string`, `llmNotIncluded: string`.

**Design decision (single source of truth):** the UI gates on the `/me` policy via these helpers *everywhere*; the `allowed` flags on `/api/routing` and `/api/providers` are for API consumers and are covered by backend tests. Two live sources for the same boolean in the UI would let them disagree during refetches. This is why the helpers exist instead of reading `entry.allowed` in components.

- [ ] **Step 1: Write the failing tests** (`frontend/src/auth/policy.test.ts`)

```typescript
import { describe, expect, test } from 'vitest'
import type { MeResponse } from '../api/client'
import {
  hasFeature,
  llmDisabled,
  modelAllowed,
  providerAllowed,
  tierAllowed,
} from './policy'

function user(policy: MeResponse['policy']): MeResponse {
  return {
    id: 2, email: 'u@example.com', display_name: null, tier: 'basic',
    is_admin: false, policy,
  }
}

const FULL: MeResponse['policy'] = {
  llm: { tiers: null, providers: null, models: null },
  features: ['custom_profiles', 'custom_domains'],
}
const RESTRICTED: MeResponse['policy'] = {
  llm: { tiers: ['cheap', 'local'], providers: ['ollama'], models: { ollama: ['llama3.1'] } },
  features: [],
}
const FLOOR: MeResponse['policy'] = {
  llm: { tiers: [], providers: [], models: null },
  features: [],
}

describe('policy helpers', () => {
  test('null user (session not restored) is unrestricted — gating is cosmetic', () => {
    expect(tierAllowed(null, 'quality')).toBe(true)
    expect(providerAllowed(null, 'claude')).toBe(true)
    expect(modelAllowed(null, 'claude', 'claude-opus-4-8')).toBe(true)
    expect(hasFeature(null, 'custom_profiles')).toBe(true)
    expect(llmDisabled(null)).toBe(false)
  })

  test('null dimensions mean unrestricted', () => {
    expect(tierAllowed(user(FULL), 'quality')).toBe(true)
    expect(llmDisabled(user(FULL))).toBe(false)
  })

  test('lists restrict', () => {
    const u = user(RESTRICTED)
    expect(tierAllowed(u, 'balanced')).toBe(false)
    expect(tierAllowed(u, 'cheap')).toBe(true)
    expect(providerAllowed(u, 'claude')).toBe(false)
    expect(modelAllowed(u, 'ollama', 'llama3.1')).toBe(true)
    expect(modelAllowed(u, 'ollama', 'qwen3:8b')).toBe(false)
    expect(modelAllowed(u, 'claude', 'claude-sonnet-5')).toBe(false) // provider disallowed ⇒ model too
    expect(hasFeature(u, 'custom_domains')).toBe(false)
  })

  test('floor is both lists empty, and only that', () => {
    expect(llmDisabled(user(FLOOR))).toBe(true)
    expect(llmDisabled(user(RESTRICTED))).toBe(false)
    const tiersOnlyEmpty: MeResponse['policy'] = {
      llm: { tiers: [], providers: ['ollama'], models: null }, features: [],
    }
    expect(llmDisabled(user(tiersOnlyEmpty))).toBe(false)
  })
})
```

And `LlmSelector.test.tsx`: render with a store seeded with a RESTRICTED-policy user, a loaded routing table and providers list (copy the fixture style from `ProfileSelector.test.tsx`); assert (1) the `balanced` option is disabled and its label ends with the `planSuffix`, (2) the `local` option is enabled, (3) with a FLOOR-policy user the component renders nothing.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/auth/policy.test.ts src/header/LlmSelector.test.tsx` (module not found / assertions fail).

- [ ] **Step 3: Implement.**

`types.ts` additions (and `allowed: boolean` on both `RoutingEntry` and `ProviderInfo`; `effective_llm: EffectiveLlm | null` on `CheckStatus`):

```typescript
export interface LlmPolicy {
  tiers: Tier[] | null
  providers: string[] | null
  models: Record<string, string[]> | null
}

export interface PolicyPayload {
  llm: LlmPolicy
  features: string[]
}

export interface LlmSelectionInfo {
  tier: Tier | null
  provider: string | null
  model: string | null
}

export interface EffectiveLlm {
  requested: LlmSelectionInfo
  effective: LlmSelectionInfo
  degraded: boolean
  skipped: string | null
}
```

`client.ts`: `MeResponse` gains `policy: PolicyPayload`; `CheckRequest` gains `llm_tier?: Tier | null`; `SuggestionResponse` gains `skipped?: string | null` (M5 note stays in the MeResponse comment).

`auth/policy.ts`:

```typescript
import type { MeResponse } from '../api/client'
import type { Tier } from '../types'

/**
 * Gating helpers over the /me policy (spec §8). A null user (session not
 * yet restored) or a null dimension means unrestricted — this layer is
 * cosmetic; the backend enforces and degrades regardless (spec §6.2).
 * These helpers are the UI's single source of truth for plan gating; the
 * `allowed` flags on /api/routing and /api/providers serve API consumers.
 */
export function tierAllowed(user: MeResponse | null, tier: Tier): boolean {
  const allowed = user?.policy.llm.tiers
  return allowed == null || allowed.includes(tier)
}

export function providerAllowed(user: MeResponse | null, name: string): boolean {
  const allowed = user?.policy.llm.providers
  return allowed == null || allowed.includes(name)
}

export function modelAllowed(
  user: MeResponse | null,
  provider: string,
  model: string,
): boolean {
  if (!providerAllowed(user, provider)) return false
  const allow = user?.policy.llm.models?.[provider]
  return allow == null || allow.includes(model)
}

export function hasFeature(
  user: MeResponse | null,
  feature: 'custom_profiles' | 'custom_domains',
): boolean {
  return user == null || user.policy.features.includes(feature)
}

/** The §6.2 floor: both llm lists empty — the UI hides the LLM phase. */
export function llmDisabled(user: MeResponse | null): boolean {
  const llm = user?.policy.llm
  return llm != null && llm.tiers?.length === 0 && llm.providers?.length === 0
}
```

`LlmSelector.tsx`: read `const user = store.user`; first thing in the component body (after hooks), `if (llmDisabled(user)) return null`. Tier options: `const notOnPlan = !tierAllowed(user, tier)`; `disabled={unavailable || notOnPlan}`; suffix `notOnPlan ? m.planSuffix : unavailable ? m.offlineSuffix : ''` (plan beats offline: "not on your plan" is the actionable one). Provider options in the Advanced panel: same pattern with `providerAllowed`. Model options: `disabled={!modelAllowed(user, shownProvider, model)}` with `planSuffix` on the label. Hooks stay above the early return (React's rules).

`i18n/messages.ts` adds the three keys; all seven catalogs in the same commit:

| key | en | de |
|---|---|---|
| `planSuffix` | `' (not on your plan)'` | `' (nicht im Tarif enthalten)'` |
| `llmDegraded(effective, requested)` | `` `LLM ran on ${effective} — ${requested} is not available on your plan.` `` | `` `LLM-Prüfung lief mit ${effective} — ${requested} ist im aktuellen Tarif nicht verfügbar.` `` |
| `llmNotIncluded` | `'LLM checking is not included in your plan.'` | `'Die LLM-Prüfung ist im aktuellen Tarif nicht enthalten.'` |

| key | fr | es |
|---|---|---|
| `planSuffix` | `' (non inclus dans l’offre)'` | `' (no incluido en el plan)'` |
| `llmDegraded` | `` `Vérification LLM effectuée avec ${effective} — ${requested} n’est pas disponible dans l’offre actuelle.` `` | `` `La verificación LLM se ejecutó con ${effective} — ${requested} no está disponible en el plan actual.` `` |
| `llmNotIncluded` | `'La vérification LLM n’est pas incluse dans l’offre actuelle.'` | `'La verificación LLM no está incluida en el plan actual.'` |

| key | it | ja | zh |
|---|---|---|---|
| `planSuffix` | `' (non incluso nel piano)'` | `'（プラン対象外）'` | `'（不在当前套餐内）'` |
| `llmDegraded` | `` `Verifica LLM eseguita con ${effective} — ${requested} non è disponibile nel piano attuale.` `` | `` `LLMチェックは${effective}で実行されました。${requested}は現在のプランでは利用できません。` `` | `` `LLM 检查已使用${effective}运行，${requested}不在当前套餐内。` `` |
| `llmNotIncluded` | `'La verifica LLM non è inclusa nel piano attuale.'` | `'LLMチェックは現在のプランに含まれていません。'` | `'LLM 检查不包含在当前套餐内。'` |

(`llmDegraded` is used in Task 8; declaring it here keeps the seven catalogs in lockstep in one pass — the `i18n.test.ts` key-parity test enforces it.)

- [ ] **Step 4: Run to verify green**: `npx vitest run && npm run lint && npm run build` from `frontend/`.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/api/client.ts src/auth/policy.ts src/auth/policy.test.ts src/header/LlmSelector.tsx src/header/LlmSelector.test.tsx src/i18n/
git commit -m "feat(frontend): plan-gated LLM selector from /me policy (M4)"
```

---

### Task 8: Checks send the tier; degradation notes in the UI

**Files:**
- Modify: `frontend/src/checking/controller.ts`, `frontend/src/checking/suggest.ts`
- Create: `frontend/src/checking/effectiveLabel.ts` + `effectiveLabel.test.ts`
- Modify: `frontend/src/state/store.ts`, `frontend/src/sidebar/Sidebar.tsx`, `frontend/src/App.css`
- Test: `frontend/src/checking/controller.test.ts` (extend)

**Interfaces:**
- Consumes: Task 7's types/helpers and i18n keys; Task 3's response fields.
- Produces: `llmEffective: EffectiveLlm | null` in the store (transient, inside the reset-on-session-change data); `effectiveLabel(sel: LlmSelectionInfo, m: Messages) -> string`.

- [ ] **Step 1: Write the failing tests.**

`effectiveLabel.test.ts`: tier selections label as the localized tier name (`m.tierName('cheap')`); pinned selections as `` `${model} (${provider})` ``; an all-null selection as `''`.

`controller.test.ts` additions (follow the module's existing postCheck-mock pattern):
- tier mode (`state.tier = 'balanced'`) sends `llm_tier: 'balanced'` with `llm_provider`/`llm_model` null;
- pinned mode (`tier: null`) sends `llm_tier: null` plus the resolved pair (unchanged behavior);
- a response whose `effective_llm.degraded` is true lands in `useStore.getState().llmEffective`;
- a floor user (policy with empty lists) never includes `'llm'` in `checkers` even when `includeLlm` is true;
- a new `runCheck` resets `llmEffective` to null.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.**

`effectiveLabel.ts`:

```typescript
import type { Messages } from '../i18n/messages'
import type { LlmSelectionInfo } from '../types'

/** Human label for one side of an effective_llm report: the quality tier's
 * localized name when the selection is tier-routed, else the pinned pair. */
export function effectiveLabel(sel: LlmSelectionInfo, m: Messages): string {
  if (sel.tier) return m.tierName(sel.tier)
  if (sel.provider) return sel.model ? `${sel.model} (${sel.provider})` : sel.provider
  return ''
}
```

(Adjust the `Messages` type import to how `checking/status.ts` already types its `m` parameter — follow that file.)

`store.ts`: add `llmEffective: EffectiveLlm | null` next to `llmError` in the state data (initial `null`, NOT in the persist allowlist, inside the session-reset data so `resetSessionState()` clears it).

`controller.ts` (`runCheck`): in the `postCheck` body replace the two `llm_*` lines with:

```typescript
      llm_tier: state.tier,
      llm_provider: state.tier === null && resolution.ok ? resolution.provider : null,
      llm_model: state.tier === null && resolution.ok ? resolution.model : null,
```

Add `llmEffective: null` to the `useStore.setState` reset at the top of `runCheck` and in `cancelCheck`. Compute `const wantLlm = includeLlm && !llmDisabled(state.user) && resolution.ok` (import from `auth/policy`). After the successful `postCheck` (inside the existing staleness guards), `useStore.setState({ llmEffective: result.effective_llm ?? null })`.

Note the availability skip stays client-side and unchanged: in tier mode, `resolveModel` still refuses an unavailable/unconfigured tier before any request goes out. Server-side degradation can still land on an offline provider (the client cannot foresee which tier the server degrades to); that surfaces through the existing `checker_error` path — spec-conform, no new handling.

`suggest.ts` (`requestForFinding`): add `llm_tier: state.tier` and null out `llm_provider`/`llm_model` when `state.tier !== null` (same shape as the controller). In `fetchSuggestions`/`fetchRewrite`, before the vet logic: if `result.skipped` is set, call `setSuggestError(findingId, currentMessages().llmNotIncluded)` (resp. `setRewriteError`) and return — the existing per-finding notice channel, per spec "surfaces like the check-status notes".

`Sidebar.tsx`, directly under the `llmError` div (`Sidebar.tsx:139`):

```tsx
      {llmEffective?.degraded && (
        <div className="llm-note">
          {m.llmDegraded(
            effectiveLabel(llmEffective.effective, m),
            effectiveLabel(llmEffective.requested, m),
          )}
        </div>
      )}
      {llmEffective?.skipped === 'llm_unavailable' && (
        <div className="llm-note">{m.llmNotIncluded}</div>
      )}
```

with `const llmEffective = useStore((s) => s.llmEffective)` beside the `llmError` selector. `App.css`: a `.llm-note` rule next to `.llm-error` — same layout, muted foreground (informational, not an error).

- [ ] **Step 4: Run to verify green**: `npx vitest run && npm run lint && npm run build`.

- [ ] **Step 5: Mutation-verify**: remove the `llmDisabled` term from `wantLlm` → the floor-user controller test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/checking/ src/state/store.ts src/sidebar/Sidebar.tsx src/App.css
git commit -m "feat(frontend): tier-based check requests and degradation notes (M4)"
```

---

### Task 9: Feature-gated create affordances

**Files:**
- Modify: `frontend/src/profiles/ProfilesView.tsx`
- Modify: `frontend/src/terminology/TerminologyView.tsx`
- Test: `frontend/src/profiles/ProfilesView.features.test.tsx`, `frontend/src/terminology/TerminologyView.features.test.tsx` (create; fixture style from the existing `.ownership.test.tsx` neighbors)

**Interfaces:**
- Consumes: Task 7's `hasFeature`; Task 6's backend semantics (403 on gated creates).

**Sweep first (guard-rule lesson from M3):** the gate applies to every path that calls a creating API export, not just the views this plan names. Run from `frontend/`:

```
grep -rn "createProfile(\|createDomain(\|createTerm(" src --include='*.ts*' | grep -v test | grep -v api/client
```

Every hit must be inside a `hasFeature`-gated affordance after this task (ProfilesView's create *and duplicate* paths both call `createProfile` — gate whatever the sweep finds, and list the sweep output in the task report).

- [ ] **Step 1: Write the failing tests.** For each view, render twice (store user with/without the feature, per the policy fixtures from Task 7's tests): without `custom_profiles`, ProfilesView shows no new-profile input, no create button, and no duplicate affordance; with it, all present. Without `custom_domains`, TerminologyView shows no add-domain row and no add-term affordance (existing terms stay editable — the edit affordances from the M3 ownership tests remain); with it, all present. Admin-shaped user (`is_admin: true` — whose policy from `/me` already contains both features) sees everything.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** In each view, derive once near the existing ownership derivations:

```tsx
  const canCreate = hasFeature(user, 'custom_profiles')  // ProfilesView
  const canCreate = hasFeature(user, 'custom_domains')   // TerminologyView
```

and wrap the affordances the sweep found in `{canCreate && (...)}` — hidden, not disabled, matching the M3 read-only convention (the backend 403 remains the real boundary). No new i18n keys: hidden affordances need no copy.

- [ ] **Step 4: Run to verify green**: `npx vitest run && npm run lint && npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/profiles/ src/terminology/
git commit -m "feat(frontend): feature-gated create affordances (M4)"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`
- Modify: `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md` (Cross-milestone interfaces)

- [ ] **Step 1: `docs/backend-architecture.md`** — add a tiers/permissions section where the auth/ownership sections live: the `tiers:` config block and its validation; `app/core/permissions.py` (policy vocabulary, `resolve_llm_selection`'s ladder, the fail-closed unknown-tier rule); the single gate `app/api/llm_gate.py` and the no-direct-`provider_factory` invariant; `effective_llm` on checks/SSE; the `/me` policy payload; `allowed` flag semantics (direct-selection vs. routed, spec §7.2); feature gates being creation-only; admin tier-name validation source. Update any existing text that still says tier names are a code-level Literal.

- [ ] **Step 2: `docs/frontend-architecture.md`** — document `auth/policy.ts` as the UI's single gating source (and why the API `allowed` flags are not read by components), the `llm_tier` request field and who resolves what (client: availability; server: policy), `llmEffective` and the Sidebar notes, the floor hiding `LlmSelector`, and the feature-gated create affordances.

- [ ] **Step 3: Roadmap interfaces** — in `2026-07-25-multi-user-roadmap.md` Cross-milestone interfaces, update the M4 entry to the as-built signature: `resolve_llm_selection(policy, requested, language, *, settings) -> EffectiveSelection` in `app/core/permissions.py`, plus one line naming `get_effective_provider` (`app/api/llm_gate.py`) as the gate M5's reservation slots into. Update the `/api/auth/me` line: M4's policy/feature payload is delivered.

- [ ] **Step 4: Full gates one last time** — backend `uv run pytest -q` (zero warnings) from `backend/`; frontend `npx vitest run && npm run lint && npm run build` from `frontend/`.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs: architecture and roadmap updates for M4 tiers"
```

**LOGBOOK note:** per repo convention the LOGBOOK entry references the PR number, which does not exist until the PR is opened — the controller writes `docs/LOGBOOK.md` (inserted before the "Next" pointer) during the PR phase, as in M3. It is not part of this task.

---

## Verification

- Backend: `uv run pytest -q` — zero warnings; the `test_permissions.py` table covers every §6.2 rule (tier pass/down/up, direct-only rule 4 incl. the unordered variant, floor, model substitution, best-tier fallback, rule 5's provider-list independence, missing-routing skip); gate coverage proves suggestions/name-gen cannot yield a disallowed provider; default-config tests prove inertness.
- Frontend: `npx vitest run && npm run lint && npm run build`.
- Sweeps recorded in task reports: `provider_factory` (Task 4), frontend create call sites (Task 9).
- Manual/E2E (controller, after merge or on the scratch stack — ports 8001/4199, never 5173/8000): configure a `basic` tier limited to `[cheap, local]`, log in as a basic user, select Balanced → check runs with a degradation note naming Cheap; profile/domain create affordances hidden without features; admin unaffected.
