"""The pure credit-costing function (spec B6 §2.1): integer credits from
token counts, factor lookup chain model -> provider default -> global
default, per-provider output weight, source weighting."""

import pytest

from app.core.config import CreditCostSettings, ProviderCreditSettings
from app.services.credits import estimate_cost, run_cost


DEFAULTS = CreditCostSettings()

CONFIG = CreditCostSettings(
    default_factor=1.0,
    default_output_weight=4.0,
    providers={
        "claude": ProviderCreditSettings(
            output_weight=5.0,
            default_factor=3.0,
            models={"claude-haiku-4-5": 1.0},
        ),
        "ollama": ProviderCreditSettings(default_factor=0.1),
    },
)


def cost(**kwargs):
    defaults = dict(
        source="check", provider="claude", model="m",
        input_tokens=1000, output_tokens=0, config=CONFIG,
    )
    return run_cost(**{**defaults, **kwargs})


class TestFactorLookup:
    def test_model_hit_wins(self):
        assert cost(model="claude-haiku-4-5") == 1000  # factor 1.0

    def test_provider_default_when_model_unknown(self):
        assert cost(model="claude-sonnet-4-5") == 3000  # factor 3.0

    def test_global_default_when_provider_unknown(self):
        assert cost(provider="mistral") == 1000  # factor 1.0

    def test_provider_without_default_factor_falls_through_to_global(self):
        config = CreditCostSettings(
            default_factor=2.0,
            providers={"claude": ProviderCreditSettings(output_weight=5.0)},
        )
        assert cost(config=config) == 2000


class TestOutputWeight:
    def test_provider_output_weight(self):
        # claude: factor 3.0, output_weight 5 -> 3 * (0 + 5*100) = 1500
        assert cost(input_tokens=0, output_tokens=100) == 1500

    def test_global_output_weight_when_provider_has_none(self):
        # ollama block sets no output_weight -> global 4; factor 0.1
        # 0.1 * (0 + 4*100) = 40
        assert cost(provider="ollama", input_tokens=0, output_tokens=100) == 40


class TestSourceWeights:
    def test_name_is_free_by_default(self):
        assert cost(source="name", input_tokens=100000, output_tokens=100000) == 0

    def test_check_and_suggestion_default_to_full_weight(self):
        assert cost(source="check") == cost(source="suggestion") == 3000

    def test_custom_weight_scales(self):
        config = CreditCostSettings(source_weights={"suggestion": 0.5})
        assert cost(source="suggestion", config=config) == 500


class TestRounding:
    def test_fractional_cost_rounds_up(self):
        config = CreditCostSettings(default_factor=0.001)
        # 0.001 * 1 token = 0.001 -> ceil -> 1
        assert cost(input_tokens=1, output_tokens=0, config=config) == 1

    def test_zero_tokens_cost_zero(self):
        assert cost(input_tokens=0, output_tokens=0) == 0

    def test_float_factor_does_not_phantom_round_up(self):
        # 1.1 * 100 is 110.00000000000001 in binary floats; a naive ceil
        # would price it 111. Must be exactly 110.
        config = CreditCostSettings(default_factor=1.1)
        assert cost(input_tokens=100, output_tokens=0, config=config) == 110

    def test_negative_token_counts_clamp_to_zero(self):
        # A provider reporting negative counts must not mint budget.
        assert cost(input_tokens=-500, output_tokens=-10) == 0
        # claude: factor 3, output_weight 5 -> 3 * (0 + 5*100) = 1500
        assert cost(input_tokens=-500, output_tokens=100) == 1500


class TestEstimate:
    def test_estimate_from_chars(self):
        # 100 chars -> est_input = ceil(100/4) = 25, est_output = 25//4 = 6
        # default config: factor 1.0, output_weight 4 -> 25 + 24 = 49
        assert estimate_cost(
            source="check", provider="x", model="x",
            text_chars=100, config=DEFAULTS,
        ) == 49

    def test_estimate_rounds_input_up(self):
        # 42 chars -> est_input = 11, est_output = 2 -> 11 + 8 = 19
        assert estimate_cost(
            source="check", provider="x", model="x",
            text_chars=42, config=DEFAULTS,
        ) == 19

    def test_name_estimate_is_free(self):
        assert estimate_cost(
            source="name", provider="x", model="x",
            text_chars=100000, config=DEFAULTS,
        ) == 0
