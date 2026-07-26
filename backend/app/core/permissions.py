"""User-tier LLM policy: what a caller may select, and what actually runs.

Vocabulary: *user tiers* are the config `tiers:` keys (basic, premium, …);
*quality tiers* are the fixed ladder in app.core.config.TIERS. This module
maps a user tier to its policy (spec §6.1) and resolves a requested
selection against it with graceful degradation (spec §6.2). Everything here
is pure — no I/O, no app state — so the §6.2 rules are testable as a table.
"""

import logging
from dataclasses import dataclass

from app.core.config import (
    KNOWN_FEATURES,
    TIERS,
    ProviderSettings,
    Settings,
    TierSettings,
)

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


def _tier_config(tier: str, settings: Settings) -> TierSettings | None:
    """Shared unknown-tier handling for both policy builders. The warn-once
    diagnostic must fire no matter which builder a request reaches first —
    a feature-gated create can be a user's very first call after a config
    change, and its denial must not be silent."""
    cfg = settings.tiers.get(tier)
    if cfg is None and tier not in _warned_unknown_tiers:
        _warned_unknown_tiers.add(tier)
        logger.warning(
            "user tier '%s' is not configured under tiers:; treating as no-LLM",
            tier,
        )
    return cfg


def policy_for(*, tier: str, is_admin: bool, settings: Settings) -> LLMPolicy:
    if is_admin or not settings.tiers:
        # Admins bypass tier policy (spec §6.1); an instance with no tiers
        # configured behaves exactly as before M4 (roadmap: default inert).
        return FULL_POLICY
    cfg = _tier_config(tier, settings)
    if cfg is None:
        # Fail closed, visibly: the user sees degradation notes, not errors.
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
    cfg = _tier_config(tier, settings)
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
    elif policy.providers:
        name = policy.providers[0]
    else:
        name = None
    if name is not None:
        # providers "all" may still carry a models allowlist for this
        # provider — the fallback must not bypass it.
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
