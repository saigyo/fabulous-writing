"""Credit pricing for LLM runs (B6 spec §2): a pure function of the run's
token counts and the server-wide credit_cost config. Integer credits --
ceil of the weighted token total -- so ledger sums and budget comparisons
stay exact."""

import math

from app.core.config import CreditCostSettings

# Admission estimate (B6 spec §4): settle corrects the numbers, so these
# stay module constants, not config knobs.
_EST_CHARS_PER_TOKEN = 4
_EST_OUTPUT_RATIO = 4  # estimated output tokens = estimated input // 4


def run_cost(
    *,
    source: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    config: CreditCostSettings,
) -> int:
    """credits = ceil(source_weight * factor * (input + output_weight * output)).

    Factor lookup chain: exact model in the provider block -> the provider's
    default_factor -> the global default_factor. output_weight: provider
    block -> global default_output_weight (B6 spec §2.1)."""
    weight = config.source_weights.get(source, 1.0)
    factor = config.default_factor
    output_weight = config.default_output_weight
    block = config.providers.get(provider)
    if block is not None:
        if block.output_weight is not None:
            output_weight = block.output_weight
        if block.default_factor is not None:
            factor = block.default_factor
        if model in block.models:
            factor = block.models[model]
    # Clamp per side: a malformed provider reporting negative counts must
    # not mint budget by shrinking the window SUM.
    weighted = max(0, input_tokens) + output_weight * max(0, output_tokens)
    # round() before ceil: binary-float artifacts (1.1 * 100 ==
    # 110.00000000000001) must not buy a phantom credit. The 1e-9
    # quantization is a deliberate tolerance -- pricing has no sub-
    # nanocredit resolution.
    return math.ceil(round(weight * factor * weighted, 9))


def estimate_cost(
    *,
    source: str,
    provider: str,
    model: str,
    text_chars: int,
    config: CreditCostSettings,
) -> int:
    """The admission estimate (B6 spec §4): chars/4 input tokens, a quarter
    of that as output, priced through run_cost."""
    est_input = -(-text_chars // _EST_CHARS_PER_TOKEN)
    est_output = est_input // _EST_OUTPUT_RATIO
    return run_cost(
        source=source, provider=provider, model=model,
        input_tokens=est_input, output_tokens=est_output, config=config,
    )
