# B6: Credit-Based LLM Budgeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-day run counter with integer credit budgets per calendar window (hour/day/week/month), priced from real token usage and enforced in the existing reservation transaction.

**Architecture:** A pure costing module (`services/credits.py`) prices runs from a new `credit_cost` config block; the `llm_usage` ledger gains a `credits` column written as an estimate at reservation and settled from actual tokens at `finish_run`; `reserve_llm_run` sums credits per configured window inside its existing transaction; `/me` reports a tier label plus whole-percent usage per window and the frontend renders the tightest one.

**Tech Stack:** Python 3.13 / FastAPI / SQLite (uv-managed, pydantic v2), React 19 / TypeScript / Vite.

**Spec:** `docs/superpowers/specs/2026-07-29-credit-budgeting-design.md` — the authority on every value below.

## Global Constraints

- All backend commands run from `backend/` via `uv run`. Gate before EVERY commit: `uv run pytest -q` passes with ZERO warnings.
- Frontend gate (Tasks 6–7 only): `npm test -- --run` and `npm run build` pass from `frontend/`.
- The live database `backend/data/fabulous.db` is never read or written by tests; every test passes `tmp_path`-based `Settings`; `create_app()` is never called with default settings in tests.
- Never kill, restart, or start anything on ports 5173 and 8000.
- Never widen a wall-clock test bound. Mutation-verify every guard test (delete the guard, watch the test fail, restore).
- Credit limits are enforced **between** runs, never as mid-run cutoffs (spec §1). Overshoot is bounded by one run.
- Credits are **integers** (SQLite `INTEGER`); the formula rounds up via `math.ceil`; budgets and sums are exact integer arithmetic (spec §2.1).
- The user never sees absolute credit numbers — `/me` reports label + whole percents only, admins included (spec §1).
- `name` runs are free: `source_weights["name"] = 0.0` by default (spec §2.1).
- Budget exhaustion degrades (`skipped="quota_exhausted"`), it never 429s (spec §5). The concurrency 429s are untouched.
- Windows are calendar-aligned UTC: current hour / UTC day (existing `day` column) / ISO week from Monday 00:00 UTC / calendar month (spec §3).
- Every commit message ends with exactly these two trailer lines:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

---

### Task 1: Costing function + `credit_cost` config block

**Files:**
- Create: `backend/app/services/credits.py`
- Create: `backend/tests/test_credits.py`
- Modify: `backend/app/core/config.py` (add `ProviderCreditSettings`, `CreditCostSettings`, `Settings.credit_cost`, one model validator)
- Modify: `backend/tests/test_config.py` (append a `TestCreditCostConfig` class)

**Interfaces:**
- Consumes: `app.core.config.known_provider_names(providers)` (existing), pydantic `BaseModel`/`ConfigDict`/`Field`/`field_validator`/`model_validator` (existing imports in config.py).
- Produces (later tasks rely on these exact names):
  - `app.core.config.CreditCostSettings` — fields `default_factor: float`, `default_output_weight: float`, `source_weights: dict[str, float]`, `providers: dict[str, ProviderCreditSettings]`
  - `app.core.config.Settings.credit_cost: CreditCostSettings`
  - `app.services.credits.run_cost(*, source: str, provider: str, model: str, input_tokens: int, output_tokens: int, config: CreditCostSettings) -> int`
  - `app.services.credits.estimate_cost(*, source: str, provider: str, model: str, text_chars: int, config: CreditCostSettings) -> int`

- [ ] **Step 1: Write the failing costing tests**

Create `backend/tests/test_credits.py`:

```python
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_credits.py -q`
Expected: collection error — `app.services.credits` does not exist.

- [ ] **Step 3: Add the config models**

In `backend/app/core/config.py`, directly above `class TierLimitsSettings` (add `import math` to the module's stdlib imports if absent):

```python
# Restricted to the ledger's source values; a typo'd key must fail loudly,
# not silently price a source at the default.
_CREDIT_SOURCES = ("check", "suggestion", "name")
# name is system-triggered, not user-initiated -- effectively free (B6 spec §2.1).
_DEFAULT_SOURCE_WEIGHTS = {"check": 1.0, "suggestion": 1.0, "name": 0.0}


class ProviderCreditSettings(BaseModel):
    """Per-provider pricing (B6 spec §2.2): factors are INPUT prices per
    model; output_weight is the provider's input->output price ratio
    (near-constant within a provider, widely varying across them)."""

    model_config = ConfigDict(extra="forbid")  # a typo'd key must fail loudly

    output_weight: float | None = None
    default_factor: float | None = None
    models: dict[str, float] = Field(default_factory=dict)

    @field_validator("output_weight")
    @classmethod
    def _weight_positive(cls, value: float | None) -> float | None:
        # isfinite: NaN passes every sign comparison and inf passes > 0;
        # either would survive to run time and blow up math.ceil per run.
        if value is not None and not (math.isfinite(value) and value > 0):
            raise ValueError("output_weight must be a finite number > 0")
        return value

    @field_validator("default_factor")
    @classmethod
    def _factor_non_negative(cls, value: float | None) -> float | None:
        if value is not None and not (math.isfinite(value) and value >= 0):
            raise ValueError("default_factor must be a finite number >= 0")
        return value

    @field_validator("models")
    @classmethod
    def _model_factors_non_negative(cls, value: dict[str, float]) -> dict[str, float]:
        for model, factor in value.items():
            if not (math.isfinite(factor) and factor >= 0):
                raise ValueError(f"models.{model}: factor must be a finite number >= 0")
        return value


class CreditCostSettings(BaseModel):
    """Server-wide credit pricing (B6 spec §2.2). Absent block = every model
    priced at factor 1.0 with output weight 4 -- usable defaults, no
    fail-open risk (budgets, not pricing, are the enforcement)."""

    model_config = ConfigDict(extra="forbid")  # a typo'd key must fail loudly

    default_factor: float = 1.0
    default_output_weight: float = 4.0
    source_weights: dict[str, float] = Field(
        default_factory=lambda: dict(_DEFAULT_SOURCE_WEIGHTS)
    )
    providers: dict[str, ProviderCreditSettings] = Field(default_factory=dict)

    @field_validator("default_factor")
    @classmethod
    def _factor_non_negative(cls, value: float) -> float:
        if not (math.isfinite(value) and value >= 0):
            raise ValueError("default_factor must be a finite number >= 0")
        return value

    @field_validator("default_output_weight")
    @classmethod
    def _weight_positive(cls, value: float) -> float:
        if not (math.isfinite(value) and value > 0):
            raise ValueError("default_output_weight must be a finite number > 0")
        return value

    @field_validator("source_weights")
    @classmethod
    def _known_sources(cls, value: dict[str, float]) -> dict[str, float]:
        for source, weight in value.items():
            if source not in _CREDIT_SOURCES:
                raise ValueError(
                    f"unknown source '{source}': must be one of {_CREDIT_SOURCES}"
                )
            if not (math.isfinite(weight) and weight >= 0):
                raise ValueError(
                    f"source_weights.{source} must be a finite number >= 0"
                )
        # Partial maps merge over the defaults (B6 spec §2.2).
        return {**_DEFAULT_SOURCE_WEIGHTS, **value}
```

On `Settings`, next to the existing `limits` field:

```python
    credit_cost: CreditCostSettings = Field(default_factory=CreditCostSettings)
```

And a new model validator after `_validate_tier_provider_names` (same style):

```python
    @model_validator(mode="after")
    def _validate_credit_cost_providers(self) -> "Settings":
        known = set(known_provider_names(self.providers))
        for name in self.credit_cost.providers:
            if name not in known:
                raise ValueError(
                    f"credit_cost.providers: unknown provider '{name}'"
                )
        return self
```

- [ ] **Step 4: Write the costing module**

Create `backend/app/services/credits.py`:

```python
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
```

- [ ] **Step 5: Run the costing tests**

Run: `uv run pytest tests/test_credits.py -q`
Expected: all pass.

- [ ] **Step 6: Write the failing config-validation tests**

Append to `backend/tests/test_config.py` (match the file's existing class style; it already imports `Settings`, `ValidationError`, `pytest`):

```python
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
        with pytest.raises(ValidationError, match="must be >= 0"):
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
```

- [ ] **Step 7: Run the config tests, then the full suite**

Run: `uv run pytest tests/test_config.py -q` — the new class must pass (the models already exist from Step 3; these tests verify validator behavior — if any fails, fix the validator, not the test). Then `uv run pytest -q`: everything green, zero warnings.

- [ ] **Step 8: Mutation-verify the guard tests**

Temporarily delete the `if source not in _CREDIT_SOURCES` check → `test_unknown_source_key_fails` must fail; restore. Temporarily delete the `_validate_credit_cost_providers` validator → `test_unknown_provider_key_fails` must fail; restore. Re-run `uv run pytest tests/test_config.py -q` green after restoring.

- [ ] **Step 9: Commit**

```bash
git add app/services/credits.py app/core/config.py tests/test_credits.py tests/test_config.py
git commit -m "feat(credits): pure costing function + credit_cost config block (B6, #40)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 2: Ledger `credits` column — estimate at reserve, settle at finish

**Files:**
- Modify: `backend/app/services/usage.py`
- Modify: `backend/app/main.py:128`
- Modify: `backend/tests/test_usage.py`

**Interfaces:**
- Consumes: `run_cost`/`estimate_cost` from Task 1; `CreditCostSettings` from Task 1; existing `migrate_columns(conn, table, [(name, sql_type)])` from `app.services._sqlite`.
- Produces: `UsageStore(db_path, *, credit_cost: CreditCostSettings | None = None, timeout: float | None = None)` (stores `self.credit_cost`, defaulting to `CreditCostSettings()`); reservation rows carry `credits` = admission estimate; `finish_run` settles `credits` per terminal status. `finish_run`'s signature is unchanged — the three API settle frames are NOT touched in this task or any other.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_usage.py`, extend the existing `test_admitted_row_is_complete` (it asserts every column of a fresh reservation row) with one line after the `output_tokens` assertion:

```python
        assert row["credits"] == 19  # estimate for 42 chars (spec B6 §4)
```

Then append a new class (reusing the module's existing `store` fixture, `reserve` helper, and `rows` helper):

```python
class TestCreditSettlement:
    # reserve() uses text_chars=100 by default:
    # est_input = 25, est_output = 6 -> 25 + 4*6 = 49 (default config)
    ESTIMATE = 49

    def test_reservation_writes_the_estimate(self, store):
        reserve(store)
        (row,) = rows(store)
        assert row["credits"] == self.ESTIMATE

    def test_name_reservation_is_free(self, store):
        reserve(store, source="name")
        (row,) = rows(store)
        assert row["credits"] == 0

    def test_completed_settles_actual_tokens(self, store):
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id, "completed",
            input_tokens=1000, output_tokens=200,
        )
        (row,) = rows(store)
        # 1000 + 4*200 = 1800 at factor 1.0, weight 1.0
        assert row["credits"] == 1800

    def test_completed_without_tokens_keeps_the_estimate(self, store):
        decision = reserve(store)
        store.finish_run(decision.reservation_id, "completed")
        (row,) = rows(store)
        assert row["credits"] == self.ESTIMATE

    def test_failed_settles_actual_tokens(self, store):
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id, "failed",
            input_tokens=500, output_tokens=None,
            fail_stage="response", fail_detail="x",
        )
        (row,) = rows(store)
        assert row["credits"] == 500  # None output side treated as 0

    def test_failed_without_tokens_costs_zero(self, store):
        # Request-stage failures never reached the provider (spec B6 §4).
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id, "failed",
            fail_stage="request", fail_detail="x",
        )
        (row,) = rows(store)
        assert row["credits"] == 0

    def test_cancelled_keeps_the_estimate(self, store):
        decision = reserve(store)
        store.finish_run(decision.reservation_id, "cancelled")
        (row,) = rows(store)
        assert row["credits"] == self.ESTIMATE

    def test_settlement_prices_by_the_rows_own_provider_and_source(self, store):
        # finish_run must read provider/model/source off the row, not assume
        # defaults: a claude row at factor 3 prices 3x.
        config = CreditCostSettings(
            providers={"claude": ProviderCreditSettings(
                output_weight=5.0, default_factor=3.0,
            )},
        )
        store = UsageStore(store.db_path, credit_cost=config)
        effective = EffectiveSelection(
            tier="quality", provider="claude", model="m", degraded=False
        )
        decision = store.reserve_llm_run(
            FakeUser(1), LIMITS, SERVER, REQUESTED, effective,
            100, "check", "run-c",
        )
        store.finish_run(
            decision.reservation_id, "completed",
            input_tokens=100, output_tokens=10,
        )
        (row,) = rows(store)
        assert row["credits"] == 450  # 3 * (100 + 5*10)

    def test_swept_row_keeps_its_estimate(self, store):
        # The staleness sweep flips status without touching credits: cost
        # was plausibly incurred, actuals unknown (spec B6 §4).
        moment = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)
        reserve(store, now=moment)
        reserve(
            store, run_id="run-2",
            now=moment + timedelta(seconds=SERVER.llm_run_max_age + 1),
        )
        first, _second = rows(store)
        assert first["status"] == "abandoned"
        assert first["credits"] == self.ESTIMATE
```

Add the imports the new tests need at the top of the file (alongside the existing config imports): `CreditCostSettings, ProviderCreditSettings`.

Also extend the existing migration test `test_migration_adds_columns_to_pre_b5_database` (`backend/tests/test_usage.py:390`, with `_PRE_B5_SCHEMA` just below it): add `credits` to its expectations the same way `fail_stage`/`fail_detail` were added there in B5 — a pre-B6 table re-opened by `UsageStore` must gain the `credits` column, and the pre-existing row must read back `row["credits"] is None`. Follow the exact pattern already in that test.

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_usage.py -q`
Expected: FAIL — `row["credits"]` raises `IndexError: No item with that key` (column absent).

- [ ] **Step 3: Implement**

In `backend/app/services/usage.py`:

1. Imports: add `from app.core.config import CreditCostSettings` to the existing `app.core.config` import line, and `from app.services.credits import estimate_cost, run_cost`.

2. Schema — add the column to `_SCHEMA` after `fail_detail`:

```sql
    fail_detail        TEXT,
    -- Integer credits (B6): admission estimate while 'started', settled
    -- from actual tokens at finish_run. NULL only on pre-B6 rows.
    credits            INTEGER,
```

3. Migration — extend the `migrate_columns` list:

```python
            migrate_columns(
                conn,
                "llm_usage",
                [("fail_stage", "TEXT"), ("fail_detail", "TEXT"),
                 ("credits", "INTEGER")],
            )
```

4. Constructor:

```python
    def __init__(
        self,
        db_path: Path,
        *,
        credit_cost: CreditCostSettings | None = None,
        timeout: float | None = None,
    ) -> None:
        self.db_path = db_path
        # Pricing is global and static, unlike per-tier limits -- injected
        # once here so finish_run's signature (and every settle frame that
        # calls it) stays untouched (B6 spec §4).
        self.credit_cost = credit_cost or CreditCostSettings()
        self.timeout = timeout
        ...  # rest unchanged
```

5. `reserve_llm_run` — compute the estimate before the INSERT and write it:

```python
        estimate = estimate_cost(
            source=source, provider=effective.provider or "",
            model=effective.model or "", text_chars=text_chars,
            config=self.credit_cost,
        )
```

and change the INSERT to include the column (13 → 14 columns; 12 → 13 `?` placeholders — the status is the literal `'started'`):

```python
            cursor = conn.execute(
                """INSERT INTO llm_usage (user_id, day, created_at, status,
                       llm_tier, provider, model, requested_tier,
                       requested_provider, requested_model, text_chars,
                       source, run_id, credits)
                   VALUES (?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    user.id,
                    day,
                    moment.isoformat(timespec="seconds"),
                    effective.tier,
                    effective.provider,
                    effective.model,
                    requested.tier,
                    requested.provider,
                    requested.model,
                    text_chars,
                    source,
                    run_id,
                    estimate,
                ),
            )
```

6. `finish_run` — settle credits. Replace the `with connect(...)` block body:

```python
        if status != "failed":
            fail_stage = None
            fail_detail = None
        if fail_stage is not None and fail_stage not in _FAIL_STAGES:
            raise ValueError(f"unknown fail_stage: {fail_stage!r}")
        with connect(self.db_path, timeout=self.timeout) as conn:
            row = conn.execute(
                """SELECT provider, model, source, credits FROM llm_usage
                   WHERE id = ? AND status = 'started'""",
                (reservation_id,),
            ).fetchone()
            if row is None:
                logger.warning(
                    "llm_usage row %s was already swept; terminal status %r"
                    " discarded",
                    reservation_id,
                    status,
                )
                return
            credits = self._settled_credits(row, status, input_tokens, output_tokens)
            cursor = conn.execute(
                """UPDATE llm_usage
                   SET status = ?, input_tokens = ?, output_tokens = ?,
                       fail_stage = ?, fail_detail = ?, credits = ?
                   WHERE id = ? AND status = 'started'""",
                (status, input_tokens, output_tokens,
                 fail_stage, fail_detail, credits, reservation_id),
            )
            if cursor.rowcount == 0:
                # Swept between the read above and this write -- same
                # warning as the read-side miss, never resurrected.
                logger.warning(
                    "llm_usage row %s was already swept; terminal status %r"
                    " discarded",
                    reservation_id,
                    status,
                )
```

(The docstring keeps its existing content; append one line: "Credits settle here from actual tokens — B6 spec §4.")

7. New private method after `finish_run`:

```python
    def _settled_credits(
        self,
        row: sqlite3.Row,
        status: str,
        input_tokens: int | None,
        output_tokens: int | None,
    ) -> int | None:
        """B6 spec §4: completed -> actual tokens (estimate stands if the
        provider reported none at all); failed -> actual tokens if any, else
        0 (a request-stage failure never reached the provider); cancelled ->
        the estimate stands (cost plausibly incurred, actuals unknown)."""
        if input_tokens is None and output_tokens is None:
            return 0 if status == "failed" else row["credits"]
        if status == "cancelled":
            return row["credits"]
        return run_cost(
            source=row["source"], provider=row["provider"], model=row["model"],
            input_tokens=input_tokens or 0, output_tokens=output_tokens or 0,
            config=self.credit_cost,
        )
```

8. In `backend/app/main.py` line 128:

```python
    app.state.usage_store = UsageStore(settings.db_path, credit_cost=settings.credit_cost)
```

- [ ] **Step 4: Run the tests**

Run: `uv run pytest tests/test_usage.py -q` — all pass. Then `uv run pytest -q` — green, zero warnings.

- [ ] **Step 5: Mutation-verify the guard tests**

Temporarily change `return 0 if status == "failed" else row["credits"]` to always `return row["credits"]` → `test_failed_without_tokens_costs_zero` must fail; restore. Temporarily make `reserve_llm_run` insert `0` instead of `estimate` → `test_reservation_writes_the_estimate` must fail; restore. Green after restoring.

- [ ] **Step 6: Commit**

```bash
git add app/services/usage.py app/main.py tests/test_usage.py
git commit -m "feat(ledger): credits column — estimate at reserve, settle at finish_run (B6, #40)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 3: Window budgets — config fields + reservation enforcement

**Files:**
- Modify: `backend/app/core/config.py` (`TierLimitsSettings` gains four optional window fields + `credit_windows()`; `_default_admin_limits` gains `credits_per_day`)
- Modify: `backend/app/services/usage.py` (`QuotaDecision.exhausted_window`, `_window_start`, window enforcement in `reserve_llm_run`, `credits_used`, new index)
- Modify: `backend/tests/test_usage.py`, `backend/tests/test_config.py`

**Interfaces:**
- Consumes: `credits` column + estimate from Task 2.
- Produces:
  - `TierLimitsSettings.credits_per_hour/credits_per_day/credits_per_week/credits_per_month: int | None = None` and `TierLimitsSettings.credit_windows() -> dict[str, int]` (configured windows only, fixed order hour, day, week, month)
  - `QuotaDecision.exhausted_window: str | None = None`
  - `UsageStore.credits_used(user_id: int, windows: list[str], *, now: datetime | None = None) -> dict[str, int]`
  - `llm_checks_per_day` still exists and is still enforced — its removal is Task 5.

- [ ] **Step 1: Write the failing config tests**

Append to `backend/tests/test_config.py`'s new `TestCreditCostConfig` class (or a sibling class `TestCreditWindows`):

```python
class TestCreditWindows:
    COMPLETE = {
        "llm_checks_per_day": 100, "max_llm_document_chars": 100000,
        "concurrent_llm_runs": 5,
    }

    def test_windows_are_optional_and_ordered(self):
        settings = Settings.model_validate({"tiers": {"basic": {"limits": {
            **self.COMPLETE, "credits_per_month": 9, "credits_per_hour": 1,
        }}}})
        limits = settings.tiers["basic"].limits
        assert limits.credit_windows() == {"hour": 1, "month": 9}
        assert list(limits.credit_windows()) == ["hour", "month"]

    def test_zero_window_budget_fails(self):
        with pytest.raises(ValidationError, match="credits_per_day"):
            Settings.model_validate({"tiers": {"basic": {"limits": {
                **self.COMPLETE, "credits_per_day": 0,
            }}}})

    def test_admin_defaults_include_a_day_budget(self):
        assert Settings().limits.admin.credits_per_day == 5_000_000
```

- [ ] **Step 2: Write the failing enforcement tests**

Append to `backend/tests/test_usage.py`:

```python
def budget_limits(**windows):
    return TierLimitsSettings(
        llm_checks_per_day=500, max_llm_document_chars=20000,
        concurrent_llm_runs=10, **windows,
    )


class TestWindowEnforcement:
    # reserve() default text_chars=100 -> estimate 49 (see TestCreditSettlement)
    EST = 49
    NOON = datetime(2026, 7, 29, 12, 30, tzinfo=UTC)  # Wednesday

    def test_admits_up_to_the_budget_and_rejects_past_it(self, store):
        limits = budget_limits(credits_per_day=2 * self.EST)
        assert reserve(store, limits=limits, run_id="r1", now=self.NOON).kind == "admitted"
        assert reserve(store, limits=limits, run_id="r2", now=self.NOON).kind == "admitted"
        decision = reserve(store, limits=limits, run_id="r3", now=self.NOON)
        assert decision.kind == "quota_exhausted"
        assert decision.exhausted_window == "day"

    def test_rejected_reservation_rolls_back_its_row(self, store):
        limits = budget_limits(credits_per_day=self.EST)
        reserve(store, limits=limits, run_id="r1", now=self.NOON)
        reserve(store, limits=limits, run_id="r2", now=self.NOON)
        assert len(rows(store)) == 1  # the rejected estimate row is gone

    def test_in_flight_estimates_count(self, store):
        # Two concurrent 'started' rows: the second must see the first's
        # estimate even though nothing has settled yet.
        limits = budget_limits(credits_per_day=self.EST)
        assert reserve(store, limits=limits, run_id="r1", now=self.NOON).kind == "admitted"
        assert reserve(store, limits=limits, run_id="r2", now=self.NOON).kind == "quota_exhausted"

    def test_tightest_window_binds_and_is_named(self, store):
        limits = budget_limits(credits_per_hour=self.EST, credits_per_day=10 * self.EST)
        reserve(store, limits=limits, run_id="r1", now=self.NOON)
        decision = reserve(store, limits=limits, run_id="r2", now=self.NOON)
        assert decision.kind == "quota_exhausted"
        assert decision.exhausted_window == "hour"

    def test_hour_window_resets_on_the_hour(self, store):
        limits = budget_limits(credits_per_hour=self.EST)
        reserve(store, limits=limits, run_id="r1", now=self.NOON)
        next_hour = self.NOON.replace(hour=13, minute=0, second=0)
        assert reserve(store, limits=limits, run_id="r2", now=next_hour).kind == "admitted"

    def test_week_window_starts_monday_utc(self, store):
        limits = budget_limits(credits_per_week=self.EST)
        sunday = datetime(2026, 7, 26, 23, 59, 59, tzinfo=UTC)
        monday = datetime(2026, 7, 27, 0, 0, 0, tzinfo=UTC)
        reserve(store, limits=limits, run_id="r1", now=sunday)
        # Sunday's spend belongs to last week; Monday opens a fresh budget.
        assert reserve(store, limits=limits, run_id="r2", now=monday).kind == "admitted"
        assert reserve(store, limits=limits, run_id="r3", now=monday).kind == "quota_exhausted"

    def test_month_window_starts_on_the_first(self, store):
        limits = budget_limits(credits_per_month=self.EST)
        july = datetime(2026, 7, 31, 23, 0, tzinfo=UTC)
        august = datetime(2026, 8, 1, 0, 0, tzinfo=UTC)
        reserve(store, limits=limits, run_id="r1", now=july)
        assert reserve(store, limits=limits, run_id="r2", now=august).kind == "admitted"

    def test_settled_credits_replace_the_estimate_in_the_sum(self, store):
        limits = budget_limits(credits_per_day=100)
        decision = reserve(store, limits=limits, run_id="r1", now=self.NOON)
        # Settle far above the estimate: the next run must see 1800, not 49.
        store.finish_run(decision.reservation_id, "completed",
                        input_tokens=1000, output_tokens=200)
        assert reserve(store, limits=limits, run_id="r2", now=self.NOON).kind == "quota_exhausted"

    def test_null_credit_rows_count_zero(self, store):
        # Pre-B6 rows have credits NULL; they must not poison the SUM.
        limits = budget_limits(credits_per_day=self.EST)
        with connect(store.db_path) as conn:
            conn.execute(
                """INSERT INTO llm_usage (user_id, day, created_at, status,
                       provider, model, text_chars, source, run_id)
                   VALUES (1, '2026-07-29', '2026-07-29T12:00:00+00:00',
                           'completed', 'ollama', 'm', 5, 'check', 'old')""",
            )
        assert reserve(store, limits=limits, run_id="r1", now=self.NOON).kind == "admitted"

    def test_zero_cost_run_admitted_at_a_full_budget(self, store):
        # name runs cost 0: at spend == budget they still fit (sum does not
        # exceed); only an already-overshot budget blocks them.
        limits = budget_limits(credits_per_day=self.EST)
        reserve(store, limits=limits, run_id="r1", now=self.NOON)
        assert reserve(
            store, limits=limits, run_id="r2", source="name", now=self.NOON
        ).kind == "admitted"

    def test_no_windows_configured_means_no_budget_check(self, store):
        # budget_limits() without window kwargs: counter 500, concurrency 10.
        # The module LIMITS would trip its own counter (3) and concurrency
        # cap (2) here -- do not use it.
        limits = budget_limits()
        for i in range(4):
            assert reserve(
                store, limits=limits, run_id=f"r{i}", now=self.NOON
            ).kind == "admitted"


class TestCreditsUsed:
    NOON = datetime(2026, 7, 29, 12, 30, tzinfo=UTC)

    def test_sums_per_window(self, store):
        limits = budget_limits(credits_per_day=1000)
        d1 = reserve(store, limits=limits, run_id="r1", now=self.NOON)
        store.finish_run(d1.reservation_id, "completed", input_tokens=100, output_tokens=0)
        reserve(store, limits=limits, run_id="r2", now=self.NOON)  # in flight: 49
        used = store.credits_used(1, ["hour", "day", "week", "month"], now=self.NOON)
        assert used == {"hour": 149, "day": 149, "week": 149, "month": 149}

    def test_all_statuses_count(self, store):
        # Status-blind aggregation (spec §3): completed, failed, cancelled
        # and started rows ALL contribute -- completed/failed at their
        # settled cost, cancelled at its estimate, started at its estimate.
        limits = budget_limits(credits_per_day=10_000)
        for status, rid in (("completed", "r1"), ("failed", "r2"),
                            ("cancelled", "r3")):
            decision = reserve(store, limits=limits, run_id=rid, now=self.NOON)
            store.finish_run(
                decision.reservation_id, status,
                input_tokens=100, output_tokens=0,
                fail_stage="provider" if status == "failed" else None,
                fail_detail="x" if status == "failed" else None,
            )
        reserve(store, limits=limits, run_id="r4", now=self.NOON)  # started
        # completed 100 + failed 100 + cancelled 49 (estimate) + started 49
        assert store.credits_used(1, ["day"], now=self.NOON) == {"day": 298}

    def test_day_window_excludes_yesterday(self, store):
        limits = budget_limits(credits_per_day=1000)
        yesterday = self.NOON - timedelta(days=1)
        reserve(store, limits=limits, run_id="r1", now=yesterday)
        used = store.credits_used(1, ["day"], now=self.NOON)
        assert used == {"day": 0}

    def test_other_users_do_not_count(self, store):
        limits = budget_limits(credits_per_day=1000)
        reserve(store, FakeUser(2), limits=limits, run_id="r1", now=self.NOON)
        assert store.credits_used(1, ["day"], now=self.NOON) == {"day": 0}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `uv run pytest tests/test_usage.py tests/test_config.py -q`
Expected: FAIL — `TierLimitsSettings` rejects `credits_per_day` (extra="forbid"), `QuotaDecision` has no `exhausted_window`, `credits_used` undefined.

- [ ] **Step 4: Implement the config side**

In `backend/app/core/config.py`, inside `TierLimitsSettings`:

```python
    llm_checks_per_day: int
    max_llm_document_chars: int
    concurrent_llm_runs: int
    # Credit budgets per calendar-aligned UTC window (B6 spec §2.3): each
    # optional. Task-5 note: once llm_checks_per_day is removed, at least
    # one window becomes mandatory.
    credits_per_hour: int | None = None
    credits_per_day: int | None = None
    credits_per_week: int | None = None
    credits_per_month: int | None = None

    def credit_windows(self) -> dict[str, int]:
        """Configured windows in enforcement order (B6 spec §4)."""
        pairs = (
            ("hour", self.credits_per_hour),
            ("day", self.credits_per_day),
            ("week", self.credits_per_week),
            ("month", self.credits_per_month),
        )
        return {name: budget for name, budget in pairs if budget is not None}

    @field_validator(
        "credits_per_hour", "credits_per_day", "credits_per_week",
        "credits_per_month",
    )
    @classmethod
    def _window_positive(cls, value: int | None, info) -> int | None:
        if value is not None and value <= 0:
            raise ValueError(f"{info.field_name} must be a positive integer")
        return value
```

In `_default_admin_limits` add (keeping `llm_checks_per_day=500` for now):

```python
        # Generous but not unlimited (B6 spec §2.3): ~500 checks of ~10k
        # weighted tokens per day.
        credits_per_day=5_000_000,
```

- [ ] **Step 5: Implement the enforcement side**

In `backend/app/services/usage.py`:

1. `QuotaDecision` gains a field after `server_wide`:

```python
    # The window whose budget bound (B6 spec §5) -- internal: tests and
    # logs only, never a user-facing number.
    exhausted_window: str | None = None
```

2. Schema gains the window index (after the in-flight index):

```sql
-- Hour/week/month windows predicate on created_at (B6 spec §3); without
-- this the per-user SUM scans the user's full history inside the
-- serializing reservation transaction.
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_created
    ON llm_usage(user_id, created_at);
```

3. Module-level helper after `_utc_now`:

```python
def _window_start(moment: datetime, window: str) -> datetime:
    """Calendar-aligned UTC window starts (B6 spec §3). `day` never comes
    through here -- it predicates on the ledger's day column."""
    # created_at comparisons are lexicographic on +00:00 isoformat strings;
    # a non-UTC moment must not leak a different offset into them (a naive
    # one is declared UTC -- astimezone would misread it as system-local).
    moment = (
        moment.replace(tzinfo=UTC)
        if moment.tzinfo is None
        else moment.astimezone(UTC)
    )
    if window == "hour":
        return moment.replace(minute=0, second=0, microsecond=0)
    if window == "week":
        monday = moment - timedelta(days=moment.weekday())
        return monday.replace(hour=0, minute=0, second=0, microsecond=0)
    if window == "month":
        return moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    raise ValueError(f"unknown credit window: {window!r}")
```

4. In `reserve_llm_run`, insert the budget check between the `day_count` check and the `user_in_flight` check (quota before concurrency, spec §4):

```python
            for window, budget in limits.credit_windows().items():
                if window == "day":
                    (spent,) = conn.execute(
                        "SELECT COALESCE(SUM(credits), 0) FROM llm_usage"
                        " WHERE user_id = ? AND day = ?",
                        (user.id, day),
                    ).fetchone()
                else:
                    start = _window_start(moment, window).isoformat(
                        timespec="seconds"
                    )
                    (spent,) = conn.execute(
                        "SELECT COALESCE(SUM(credits), 0) FROM llm_usage"
                        " WHERE user_id = ? AND created_at >= ?",
                        (user.id, start),
                    ).fetchone()
                if spent > budget:
                    conn.rollback()
                    if user.is_admin:
                        # Same signal as the run-counter ceiling: an admin
                        # exhausting a generous budget means a runaway loop
                        # or a compromised account (spec §6.4).
                        logger.warning(
                            "admin user %s exhausted the %s credit budget"
                            " (%s credits in window)",
                            user.id, window, spent,
                        )
                    return QuotaDecision(
                        kind="quota_exhausted", exhausted_window=window
                    )
```

5. New method after `used_today`:

```python
    def credits_used(
        self, user_id: int, windows: list[str], *, now: datetime | None = None
    ) -> dict[str, int]:
        """Per-window credit sums over ALL the user's rows in the window,
        regardless of status -- the same all-rows-count rule as used_today
        (B6 spec §3). /me's data source."""
        moment = now or _utc_now()
        used: dict[str, int] = {}
        with connect(self.db_path, timeout=self.timeout) as conn:
            for window in windows:
                if window == "day":
                    (total,) = conn.execute(
                        "SELECT COALESCE(SUM(credits), 0) FROM llm_usage"
                        " WHERE user_id = ? AND day = ?",
                        (user_id, moment.strftime("%Y-%m-%d")),
                    ).fetchone()
                else:
                    start = _window_start(moment, window).isoformat(
                        timespec="seconds"
                    )
                    (total,) = conn.execute(
                        "SELECT COALESCE(SUM(credits), 0) FROM llm_usage"
                        " WHERE user_id = ? AND created_at >= ?",
                        (user_id, start),
                    ).fetchone()
                used[window] = total
        return used
```

- [ ] **Step 6: Run the tests**

Run: `uv run pytest tests/test_usage.py tests/test_config.py -q` — pass. Then `uv run pytest -q` — green, zero warnings (the run counter still guards everything else).

- [ ] **Step 7: Mutation-verify the guard tests**

Temporarily remove the `conn.rollback()` in the window-rejection branch → `test_rejected_reservation_rolls_back_its_row` must fail; restore. Temporarily change `spent > budget` to `spent >= budget` → `test_zero_cost_run_admitted_at_a_full_budget` must fail; restore. Temporarily make `_window_start("week", ...)` return `moment.replace(hour=0, minute=0, second=0, microsecond=0)` (day-start instead of Monday) → `test_week_window_starts_monday_utc`'s third reservation must fail; restore. Green after restoring.

- [ ] **Step 8: Commit**

```bash
git add app/core/config.py app/services/usage.py tests/test_usage.py tests/test_config.py
git commit -m "feat(ledger): enforce credit-window budgets in the reservation transaction (B6, #40)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 4: `/me` reports label + per-window percentages

**Files:**
- Modify: `backend/app/core/config.py` (`TierSettings.label`)
- Modify: `backend/app/core/permissions.py` (add `label_for`)
- Modify: `backend/app/api/auth.py` (`WindowUsage`, new `UsagePayload`, `from_user` signature, both call sites)
- Modify: `backend/app/services/usage.py` (delete `used_today` — its only callers were the two auth sites)
- Modify: `backend/tests/test_auth_api.py`, `backend/tests/test_admin_api.py`, `backend/tests/test_usage.py`, `backend/tests/test_permissions.py`

**Interfaces:**
- Consumes: `credit_windows()` and `credits_used()` from Task 3.
- Produces:
  - `TierSettings.label: str | None = None`
  - `app.core.permissions.label_for(*, tier: str, is_admin: bool, settings: Settings) -> str`
  - `UsagePayload(label: str, windows: list[WindowUsage])`, `WindowUsage(window: str, used_percent: int)`
  - `MeResponse.from_user(user, settings, *, usage_store)` — takes the store instead of a precomputed count.
  - `UsageStore.used_today` no longer exists.
  - NOTE: until Task 5's ≥1-window validator lands, a tier block without `credits_per_*` keys is legal and yields `usage.windows == []` — test fixtures without windows must expect the empty list in this task.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/test_permissions.py`, append (match its existing Settings-construction style — see its line 198 area):

```python
class TestLabelFor:
    def test_admin_label(self):
        assert label_for(tier="basic", is_admin=True, settings=Settings()) == "Admin"

    def test_configured_label_wins(self):
        settings = Settings.model_validate({"tiers": {"pro": {
            "label": "Pro Plan",
            "limits": {"llm_checks_per_day": 100,
                       "max_llm_document_chars": 100000,
                       "concurrent_llm_runs": 5},
        }}})
        assert label_for(tier="pro", is_admin=False, settings=settings) == "Pro Plan"

    def test_default_label_capitalizes_the_tier_name(self):
        settings = Settings.model_validate({"tiers": {"basic": {
            "limits": {"llm_checks_per_day": 100,
                       "max_llm_document_chars": 100000,
                       "concurrent_llm_runs": 5},
        }}})
        assert label_for(tier="basic", is_admin=False, settings=settings) == "Basic"

    def test_unknown_tier_falls_back_to_its_name(self):
        settings = Settings.model_validate({"tiers": {"basic": {
            "limits": {"llm_checks_per_day": 100,
                       "max_llm_document_chars": 100000,
                       "concurrent_llm_runs": 5},
        }}})
        assert label_for(tier="ghost", is_admin=False, settings=settings) == "Ghost"
```

(Add `label_for` to the file's existing `app.core.permissions` import.)

In `backend/tests/test_auth_api.py`, rewrite the usage assertions:

- The site around line 386 (login response) and line 430 (/me) currently assert `{"used_today": ..., "limit": admin_limits.llm_checks_per_day}`. Replace with the new shape — for an admin with no runs:

```python
        assert body["usage"] == {
            "label": "Admin",
            "windows": [{"window": "day", "used_percent": 0}],
        }
```

- The site around line 455 similarly asserts against `limits.admin.llm_checks_per_day` — same replacement.
- `test_auth_api.py:420` (`test_used_today_counts_every_status`): asserts `body["usage"]["used_today"] == 3` — KeyError under the new payload. Its intent (all statuses count) is unit-covered by Task 3's `TestCreditsUsed::test_all_statuses_count` (completed/failed/cancelled/started all summed); delete the API-level test in THIS task.
- `test_auth_api.py:442` (`test_tier_user_sees_their_tier_block`): asserts `body["usage"]["limit"] == 100`. In THIS task the fixture tier has no credit windows yet, so assert `body["usage"]["windows"] == []` (and `body["usage"]["label"]`). Task 5's sweep then gives that tier `credits_per_day` and the assertion changes to `[{"window": "day", "used_percent": 0}]` — Task 5 rule C covers it.
- Add one new test next to the existing /me usage test (~line 430) exercising the percent math end-to-end. **The caller must be a NON-ADMIN tier user** — `limits_for` hands admins the admin block (budget 5,000,000, where 49 credits reads as 1%, not 5%). Reuse the file's tier-app construction (line 31's pattern) with the tier's limits carrying `credits_per_day=1000` (plus the block's other required members), and the file's existing non-admin login helper. Mechanics: settle spend directly on the store, then read `/me`:

```python
def test_me_reports_ceil_percent(...):  # non-admin fixtures; tier budget 1000
    store = <app>.state.usage_store
    decision = store.reserve_llm_run(
        FakeMeteredUser(<non-admin user id>), <that tier's limits>,
        <settings>.limits, RequestedLLM(tier="cheap"),
        EffectiveSelection(tier="cheap", provider="ollama", model="m", degraded=False),
        100, "check", "run-pct",
    )
    store.finish_run(decision.reservation_id, "completed",
                     input_tokens=49, output_tokens=0)  # 49 of 1000
    me = <client>.get("/api/auth/me", headers=<non-admin auth headers>).json()
    (day,) = [w for w in me["usage"]["windows"] if w["window"] == "day"]
    assert day["used_percent"] == 5  # ceil(4.9); floor would read 4
```

The angle-bracketed pieces name the file's real fixtures/helpers — substitute them 1:1 (if the file has no metered-user stub, a 2-line `FakeMeteredUser` class with `id`/`is_admin` attributes like test_usage.py's `FakeUser` works). The assertion values are binding: settled spend 49 against budget 1000 must read exactly 5.

In `backend/tests/test_admin_api.py` around line 248, `test_no_admin_endpoint_can_raise_the_ceiling` asserts `me["usage"]["limit"] == admin_limits.llm_checks_per_day`. The guard's point is "the PATCH changed nothing" — re-express it:

```python
    assert me["usage"]["windows"] == [{"window": "day", "used_percent": 0}]
```

In `backend/tests/test_usage.py`, delete the `used_today` tests (search for `used_today` in the file) — `credits_used` from Task 3 already carries equivalent coverage (day scoping, per-user scoping).

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_permissions.py tests/test_auth_api.py tests/test_admin_api.py -q`
Expected: FAIL — `label_for` does not exist; payload shape mismatch.

- [ ] **Step 3: Implement**

1. `backend/app/core/config.py`, in `TierSettings`:

```python
    # Display label for /me (B6 spec §5); None -> capitalized tier name.
    label: str | None = None
```

2. `backend/app/core/permissions.py`, after `limits_for`:

```python
def label_for(*, tier: str, is_admin: bool, settings: Settings) -> str:
    """The user-facing tier label (B6 spec §5): the only budget-related
    string /me exposes besides percentages. capitalize() is the fallback
    for unlabeled single-word tier names; multi-word tiers set `label`."""
    if is_admin:
        return "Admin"
    cfg = settings.tiers.get(tier)
    if cfg is not None and cfg.label is not None:
        return cfg.label
    return tier.capitalize()
```

3. `backend/app/api/auth.py` — replace `UsagePayload` and rewire `from_user`:

```python
class WindowUsage(BaseModel):
    window: str
    used_percent: int


class UsagePayload(BaseModel):
    """B6 spec §5: tier label + whole-percent usage per configured window
    (fixed order hour, day, week, month), rounded up and capped at 100.
    Never absolute numbers, for any caller -- admins included."""

    label: str
    windows: list[WindowUsage]
```

`from_user` becomes:

```python
    @classmethod
    def from_user(
        cls, user: User, settings: Settings, *, usage_store: UsageStore
    ) -> "MeResponse":
        limits = limits_for(
            tier=user.tier, is_admin=user.is_admin, settings=settings
        )
        windows = limits.credit_windows()
        used = usage_store.credits_used(user.id, list(windows))
        return cls(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            tier=user.tier,
            is_admin=user.is_admin,
            policy=_policy_payload(user, settings),
            usage=UsagePayload(
                label=label_for(
                    tier=user.tier, is_admin=user.is_admin, settings=settings
                ),
                windows=[
                    WindowUsage(
                        window=window,
                        used_percent=min(100, -(-used[window] * 100 // budget)),
                    )
                    for window, budget in windows.items()
                ],
            ),
            limits=LimitsPayload(
                max_document_chars=settings.limits.max_document_chars,
                max_llm_document_chars=limits.max_llm_document_chars,
                concurrent_llm_runs=limits.concurrent_llm_runs,
            ),
            allow_additional_admins=settings.auth.allow_additional_admins,
        )
```

Imports: add `label_for` to the `app.core.permissions` import and `from app.services.usage import UsageStore` (auth.py currently has no UsageStore import — check and add). Update the `UsagePayload` docstring reference comment in `frontend/src/types.ts` later (Task 6).

Both call sites (login ~line 389, /me ~line 401) become:

```python
        user=MeResponse.from_user(
            user, app.state.settings, usage_store=app.state.usage_store,
        ),
```

```python
    return MeResponse.from_user(
        user, request.app.state.settings,
        usage_store=request.app.state.usage_store,
    )
```

4. `backend/app/services/usage.py` — delete the `used_today` method entirely.

5. Sweep for other `used_today` references: `grep -rn "used_today" app tests` — any remaining backend reference (e.g. comments) gets updated or removed. Frontend references are Task 6's.

- [ ] **Step 4: Run the tests**

Run: `uv run pytest -q` — green, zero warnings. (Frontend is expected to be stale against the new payload until Task 6 — that is fine; its own suite still passes against its own mocks.)

- [ ] **Step 5: Mutation-verify the guard tests**

Temporarily drop the `min(100, ...)` cap → drive `used` above budget in the percent test (or add a one-off assert) and confirm a >100 value escapes; the binding check: temporarily change `-(-used * 100 // budget)` to `used * 100 // budget` (floor) → `test_me_reports_ceil_percent_capped_at_100` must fail (4 ≠ 5); restore. Green after restoring.

- [ ] **Step 6: Commit**

```bash
git add app/core/config.py app/core/permissions.py app/api/auth.py app/services/usage.py tests/
git commit -m "feat(auth): /me reports tier label + percent-only credit windows (B6, #40)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 5: Remove `llm_checks_per_day` — the hard replacement

**Files:**
- Modify: `backend/app/core/config.py` (delete the field, require ≥1 window, admin defaults)
- Modify: `backend/app/services/usage.py` (delete the run-count check)
- Modify: `backend/config.yaml`, `backend/config.example.yaml`
- Modify (sweep): `backend/tests/test_admin_api.py`, `test_auth_api.py`, `test_check_api.py`, `test_config.py`, `test_documents_api.py`, `test_permissions.py`, `test_profiles_api.py`, `test_providers_api.py`, `test_routing_api.py`, `test_suggestions_api.py`, `test_terminology_api.py`, `test_usage.py`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `TierLimitsSettings` without `llm_checks_per_day`; a config carrying the key fails at startup (`extra="forbid"`); every tier block must configure ≥1 credit window.

- [ ] **Step 1: Write the failing validator tests**

In `backend/tests/test_config.py`, add to `TestCreditWindows` (and update its `COMPLETE` dict by swapping `"llm_checks_per_day": 100` for `"credits_per_day": 1_000_000`):

```python
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
```

- [ ] **Step 2: Implement the removal**

1. `backend/app/core/config.py`, `TierLimitsSettings`:
   - Delete the `llm_checks_per_day: int` field and remove it from the `_positive` field-validator list.
   - Update the Task-3 comment on the window fields (drop the "Task-5 note" sentence).
   - Add the fail-closed validator:

```python
    @model_validator(mode="after")
    def _at_least_one_window(self) -> "TierLimitsSettings":
        if not self.credit_windows():
            raise ValueError(
                "at least one credits_per_{hour,day,week,month} is required"
                " -- a tier without a budget would fail open"
            )
        return self
```

2. `_default_admin_limits`: delete `llm_checks_per_day=500` (keeping `credits_per_day=5_000_000` from Task 3).

3. `backend/app/services/usage.py`, `reserve_llm_run`: delete the entire `day_count` block (the SELECT COUNT, the `if day_count > limits.llm_checks_per_day` branch, and its admin-warning) — the window loop from Task 3 is now the sole quota check. `day` stays: the INSERT and the day-window predicate still use it. Update the MODULE docstring (`usage.py:5-6` — "one daily quota plus two concurrency caps") to name credit-window budgets instead.

3b. Stale-comment sweep, same commit: `backend/app/api/llm_gate.py:188-189` — the quota-exhausted comment says "not retryable until tomorrow"; with hour/week/month windows that reads "not retryable until the binding window rolls over". Then `grep -rn "llm_checks_per_day\|checks per day" app/` must return nothing.

4. `backend/config.yaml` — replace both counters:

```yaml
    limits:
      credits_per_day: 200000
      max_llm_document_chars: 20000
      concurrent_llm_runs: 3
```

for `basic`, and for `premium`:

```yaml
    limits:
      credits_per_day: 2000000
      max_llm_document_chars: 100000
      concurrent_llm_runs: 5
```

5. `backend/config.example.yaml` — in the commented `limits:` block replace `llm_checks_per_day: 500` with `credits_per_day: 5000000`, and in the two commented tier examples replace `llm_checks_per_day: 20` / `llm_checks_per_day: 200` with `credits_per_day: 200000` / `credits_per_day: 2000000`. Update the surrounding prose: the tier-limits comment sentence "`limits:` is required on every configured tier since M5" gains "and must configure at least one credits_per_{hour,day,week,month} budget (B6)". Append a commented `credit_cost` example after the `limits` block:

```yaml
# Credit pricing (B6): factors are INPUT-token prices per model, grouped by
# provider; output_weight is the provider's input->output price ratio.
# Absent block = factor 1.0 / output weight 4 for everything. Budgets are
# credits per window: credits = ceil(weight * factor * (in + ow * out)).
# credit_cost:
#   default_factor: 1.0
#   default_output_weight: 4
#   source_weights: { check: 1.0, suggestion: 1.0, name: 0.0 }
#   providers:
#     claude:
#       output_weight: 5
#       default_factor: 3.0
#       models:
#         claude-haiku-4-5: 1.0
#     ollama:
#       default_factor: 0.1
```

- [ ] **Step 3: Sweep the test files**

Run `grep -rn "llm_checks_per_day" tests/` and convert every site. Rules:

**A. Plain fixture blocks** (the tier exists so the app boots; the test is not about quotas): replace `"llm_checks_per_day": <n>` / `llm_checks_per_day=<n>` with `"credits_per_day": 1_000_000` / `credits_per_day=1_000_000`. This covers: `test_auth_api.py:31`, `test_check_api.py:334,508,1046,1067,1126,1167,1201,1255,1302,1345,1401`, `test_documents_api.py:217,420`, `test_permissions.py:27,198,202,212,228`, `test_profiles_api.py:224`, `test_providers_api.py:15`, `test_admin_api.py:327,364`, and the analogous sites in `test_routing_api.py`, `test_terminology_api.py`, and `test_suggestions_api.py` (grep finds them; same rule) — EXCEPT `test_suggestions_api.py:386`, which is a rule-B site (see B).

**A2. `test_usage.py` special cases** (it tested the counter itself). Baseline changes:
- Module `LIMITS` (line 22, `llm_checks_per_day=3`): replace the counter with `credits_per_day=1_000_000`. Its `concurrent_llm_runs=2` stays — the concurrency tests keep working unchanged.
- The `budget_limits` helper from Task 3: delete its `llm_checks_per_day=500` line (every remaining call site passes at least one window, so the ≥1-window validator is satisfied).
- Delete `test_no_windows_configured_means_no_budget_check` (from Task 3): after the ≥1-window validator a windowless `TierLimitsSettings` cannot be constructed — the premise is now an impossible config. Its replacement is the new no-run-counter test below.

Counter-based tests that must be **restaged onto credit windows, never deleted** — each guards behavior that survives B6 and has no other coverage (the default-`reserve()` text is 100 chars → estimate 49):
- `test_quota_outranks_concurrency` (~line 119) — the spec §4 evaluation order. Restage: `limits = budget_limits(credits_per_day=2 * 49)` with `concurrent_llm_runs=2` passed explicitly into a `TierLimitsSettings` (or extend `budget_limits` to accept it); two admitted reservations left in flight, the third must return `quota_exhausted` (budget binds), NOT `concurrency_rejected`.
- `test_admin_ceiling_denial_logs_warning` (~line 134) and `test_normal_user_denial_does_not_warn` (~line 150) — the only coverage of the admin-warning branch, which now lives in the window loop. Restage both onto `budget_limits(credits_per_day=49)` and REWRITE the bodies to two reservations each (any priming loop like the existing `for i in range(3)` is dead at this budget — runs 2+ are already rejected): first admitted, second rejected; the admin caller logs the "exhausted the day credit budget" warning, the normal user does not.
- `test_two_simultaneous_reservations_admit_exactly_one` (~line 197) — the suite's only TOCTOU/insert-first serialization guard. CAUTION: this test calls `store.reserve_llm_run(...)` directly with `text_chars=1` (lines 205/209/219), which estimates at **1 credit**, not 49. Restage: delete its priming reservations, set `budget_limits(credits_per_day=1)`, and race the two `text_chars=1` reservations — run 1 sums to 1 (not > 1, admitted), run 2 sums to 2 (> 1, rejected); assert exactly `["admitted", "quota_exhausted"]` in some order.
- `test_swept_rows_still_count_toward_the_day` (~line 251) — abandoned rows still count (their estimate stands, spec §4). Restage onto `budget_limits(credits_per_day=49)`: reserve, advance past `llm_run_max_age` so the sweep abandons it, then the next reservation must still be `quota_exhausted`.

New test (spec §7: "run-count check gone"), added to Task 3's `TestWindowEnforcement` class:

```python
    def test_many_cheap_runs_pass_without_a_run_counter(self, store):
        # 20 tiny runs would have tripped any counter <= 20; only credits
        # bind now. 5-char text -> est_input 2, est_output 0 -> 2 credits.
        limits = budget_limits(credits_per_day=100)
        noon = datetime(2026, 7, 29, 12, 30, tzinfo=UTC)
        for i in range(20):
            decision = reserve(store, limits=limits, run_id=f"r{i}",
                               text_chars=5, now=noon)
            assert decision.kind == "admitted"
            store.finish_run(decision.reservation_id, "completed")  # frees the slot
```

**B. Quota-exhaustion tests** (`llm_checks_per_day=1` at `test_check_api.py:987,1090,1441`, `test_documents_api.py:363`, and `test_suggestions_api.py:386` — `TestSuggestionsMetering::test_quota_exhausted_returns_200_with_skip_code` is a rule-B site, NOT rule A: at `credits_per_day=1_000_000` its second POST would succeed and the test would fail): these arrange "the NEXT run is rejected". Recreate that state with a budget the first run exactly fills. This works because the endpoints' `FakeProvider` reports `TokenUsage()` (both sides `None`), so a completed run keeps its admission estimate — if a test's fake DOES report tokens, size the budget from those settled numbers instead. Add this helper to each file that needs it (imports: `from app.core.config import CreditCostSettings` and `from app.services.credits import estimate_cost`):

```python
def one_run_budget(text: str, source: str = "check") -> int:
    """A credits_per_day that admits exactly one run of `text`: after run 1
    the sum equals the budget (not >); run 2 pushes it over."""
    return estimate_cost(source=source, provider="any", model="any",
                         text_chars=len(text), config=CreditCostSettings())
```

Set the tier's `credits_per_day=one_run_budget(TEXT)` where `TEXT` is the exact text the test posts. Read each test first: if it asserts the FIRST run already degrades (counter pre-exhausted by an earlier request in the test), mirror that by issuing the same prior request — the mechanics carry over 1:1 because both counter and credits count the admission row.
**`test_documents_api.py:363` special case:** naming runs cost 0 credits, so a name run can no longer exhaust its own budget — but the naming endpoint's `quota_exhausted` degradation path must KEEP endpoint-level coverage (it must not become untested dead code). Overshoot cannot be staged at ADMISSION — the reservation sum includes the just-inserted estimate, so an over-budget check is rejected and rolled back, leaving the ledger empty. Overshoot only arises at SETTLEMENT: admit a check that fits (`credits_per_day = one_run_budget(check_text)`), then settle it ABOVE the budget — either drive the run through a fake provider that reports large actual usage, or settle directly on the store: `store.finish_run(<that run's reservation id>, "completed", input_tokens=10 * budget, output_tokens=0)`. Now `spent > budget`, and the subsequent name run is rejected → the endpoint falls back to the local name. Add a companion assertion (or sibling test) for the free-run side: at an exactly-full (not overshot) budget, naming still proceeds — Task 3's `test_zero_cost_run_admitted_at_a_full_budget` is the unit-level twin. Rewrite test names/docstrings to say "naming is free until the budget is overshot".

**C. Assertion sites** (`test_config.py:169–394`, `test_permissions.py:207,216,221,232`, `test_auth_api.py` leftovers — including `test_auth_api.py:442`, whose Task-4 assertion `usage["windows"] == []` becomes `[{"window": "day", "used_percent": 0}]` once rule A gives its tier `credits_per_day`; note the counter-grep will NOT surface this site, only the suite run does): re-express against the new fields — e.g. `assert tier.limits.llm_checks_per_day == 100` becomes `assert tier.limits.credits_per_day == 1_000_000` (matching the fixture value chosen under rule A); `test_config.py:288-290` (the zero-value validator test) switches to `credits_per_day: 0` expecting `match="credits_per_day"`; `test_config.py:331` (admin defaults) becomes `assert settings.limits.admin.credits_per_day == 5_000_000`.

- [ ] **Step 4: Run the full suite**

Run: `uv run pytest -q`
Expected: green, zero warnings. Iterate on missed sweep sites until clean — `grep -rn "llm_checks_per_day" app tests ../backend/config*.yaml` must return nothing (only docs/ mentions may remain until Task 7).

- [ ] **Step 5: Mutation-verify the fail-closed guard**

Temporarily delete the `_at_least_one_window` validator → `test_tier_without_any_window_fails` must fail; restore. Green after restoring.

- [ ] **Step 6: Commit**

```bash
git add app/ config.yaml config.example.yaml tests/
git commit -m "feat(config)!: replace llm_checks_per_day with mandatory credit windows (B6, #40)

Breaking config change (owner-approved, spec §1): a limits block still
carrying the M5 run counter aborts startup; every tier must configure at
least one credits_per_{hour,day,week,month} budget.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 6: Frontend — budget indicator, copy, fixtures

**Files:**
- Modify: `frontend/src/types.ts` (UsagePayload)
- Modify: `frontend/src/App.tsx` (indicator)
- Modify: `frontend/src/checking/skipNotice.ts:17`
- Modify: `frontend/src/i18n/messages.ts` + all seven locales (`en.ts`, `de.ts`, `es.ts`, `fr.ts`, `it.ts`, `ja.ts`, `zh.ts`)
- Modify (fixture sweep): every file `grep -rn "used_today" src/` hits — 26 test files plus the comment-only sites; Step 5 lists the known ones

**Interfaces:**
- Consumes: the Task 4 payload: `usage: { label: string, windows: [{ window, used_percent }] }`.
- Produces: header indicator `Label · N%` (tightest window), tooltip listing all windows; `llmQuotaExhausted` becomes a plain string (no limit argument); new `windowName(window)` message.

- [ ] **Step 1: Update the types**

In `frontend/src/types.ts` replace the `UsagePayload` interface (line ~176):

```ts
/** Mirrors backend WindowUsage (app/api/auth.py). */
export interface WindowUsage {
  window: string
  used_percent: number
}

/** Mirrors backend UsagePayload (app/api/auth.py): tier label + whole-
 * percent usage per configured window — never absolute numbers (B6). */
export interface UsagePayload {
  label: string
  windows: WindowUsage[]
}
```

- [ ] **Step 2: Update the messages**

In `frontend/src/i18n/messages.ts`:

```ts
  llmQuotaExhausted: string        // was (limit: number) => string
  quotaIndicatorTitle: string      // unchanged type, new copy
  windowName: (window: string) => string   // new
```

Locale values (exact strings; place each next to its existing neighbors):

| locale | `llmQuotaExhausted` | `quotaIndicatorTitle` | `windowName` map |
|---|---|---|---|
| en | `LLM budget used up. Capacity frees up when the current period ends.` | `LLM budget used` | `{ hour: 'hour', day: 'day', week: 'week', month: 'month' }` |
| de | `LLM-Budget aufgebraucht. Kapazität wird mit Ablauf des aktuellen Zeitraums wieder frei.` | `Genutztes LLM-Budget` | `{ hour: 'Stunde', day: 'Tag', week: 'Woche', month: 'Monat' }` |
| es | `Presupuesto LLM agotado. La capacidad se libera al finalizar el período actual.` | `Presupuesto LLM utilizado` | `{ hour: 'hora', day: 'día', week: 'semana', month: 'mes' }` |
| fr | `Budget LLM épuisé. La capacité se libère à la fin de la période en cours.` | `Budget LLM utilisé` | `{ hour: 'heure', day: 'jour', week: 'semaine', month: 'mois' }` |
| it | `Budget LLM esaurito. La capacità si libera al termine del periodo corrente.` | `Budget LLM utilizzato` | `{ hour: 'ora', day: 'giorno', week: 'settimana', month: 'mese' }` |
| ja | `LLM予算を使い切りました。現在の期間が終了すると再び利用できます。` | `使用済みLLM予算` | `{ hour: '時間', day: '日', week: '週', month: '月' }` |
| zh | `LLM 额度已用完，当前周期结束后将恢复。` | `已用 LLM 额度` | `{ hour: '小时', day: '天', week: '周', month: '月' }` |

`windowName` implementation pattern (identical in every locale, its own map values):

```ts
  windowName: (window) =>
    ({ hour: 'Stunde', day: 'Tag', week: 'Woche', month: 'Monat' } as Record<string, string>)[
      window
    ] ?? window,
```

- [ ] **Step 3: Update skipNotice**

`frontend/src/checking/skipNotice.ts:17`: `return m.llmQuotaExhausted(user?.usage.limit ?? 0)` → `return m.llmQuotaExhausted` (and drop the now-unused `user` access if nothing else in the function needs it).

- [ ] **Step 4: Update the indicator**

In `frontend/src/App.tsx`, replace the quota-indicator block (lines 222–230). Above the `return`, add:

```tsx
  const usageWindows = store.user?.usage.windows ?? []
  const tightestWindow = usageWindows.reduce<WindowUsage | null>(
    (acc, w) => (acc === null || w.used_percent > acc.used_percent ? w : acc),
    null,
  )
```

(`App.tsx` sits at `src/App.tsx`, so the import is `import type { WindowUsage } from './types'` — the file currently imports nothing from `types`, add the line.) Then:

```tsx
        {store.user && !llmDisabled(store.user) && tightestWindow && (
          <span
            className="quota-indicator"
            title={usageWindows
              .map((w) => `${m.windowName(w.window)}: ${w.used_percent}%`)
              .join(' · ')}
            aria-label={`${m.quotaIndicatorTitle}: ${store.user.usage.label} · ${usageWindows
              .map((w) => `${m.windowName(w.window)}: ${w.used_percent}%`)
              .join(', ')}`}
          >
            {store.user.usage.label} · {tightestWindow.used_percent}%
          </span>
        )}
```

- [ ] **Step 5: Sweep the fixtures and assertions**

Every fixture `usage: { used_today: 0, limit: 500 }` becomes:

```ts
    usage: { label: 'Basic', windows: [{ window: 'day', used_percent: 0 }] },
```

**The authority is `grep -rn "used_today" src/` — every hit must be converted; `npm run build` (`tsc -b` over all of `src`, tests included) fails on any stale literal.** Known sites: `App.test.tsx:62`, `App.admin-gate.test.tsx:45`, `App.domains-guard.test.tsx:44`, `Sidebar.notes.test.tsx:40`, `TerminologyView.ownership.test.tsx:43`, `TerminologyView.features.test.tsx:33`, `session.integration.test.ts:35`, `AccountMenu.test.tsx:36`, `policy.test.ts:15`, `LoginGate.test.tsx:34`, `session.test.ts:46`, `client.test.ts:30`, `sse.test.ts:28`, `skipNotice.test.ts:9`, `admin/AdminView.test.tsx:44`, `state/store.test.ts:266`, `rules/RulesView.ownership.test.tsx:27`, `documents/FolderDefaultsDialog.policy.test.tsx:24`, `documents/documents.test.ts:115`, `documents/autosave.test.ts:39`, `checking/controller.test.ts:42`, `profiles/ProfilesView.ownership.test.tsx:29`, `profiles/ProfilesView.features.test.tsx:28`, `header/LlmSelector.test.tsx:19`, `header/ProfileSelector.test.tsx:27`, `checking/suggest.test.ts:47`. This list is NON-EXHAUSTIVE — the grep is the authority.

Behavior-bearing sites:

- `session.test.ts:357,361,420-449` (the refresh-race test uses `used_today: 5` vs `20`): use `windows: [{ window: 'day', used_percent: 1 }]` vs `used_percent: 4` — the guard is sequence-based, the values only need to differ.
- `Sidebar.notes.test.tsx:162-172`: `en.llmQuotaExhausted(500)` → `en.llmQuotaExhausted`; update the test name (drop "(with the fixture limit)").
- `skipNotice.test.ts:19` and `suggest.test.ts:273`: `messages.llmQuotaExhausted(...)` → `messages.llmQuotaExhausted`.
- `App.test.tsx:200-211`: the existing indicator test renders `0/20` and asserts THREE things — the text, `title === en.quotaIndicatorTitle`, and `getByLabelText(`${en.quotaIndicatorTitle}: 0/20`)`. All three change: text `Basic · 0%`, `title` is the per-window list (`${en.windowName('day')}: 0%`), and the aria-label carries the SAME full per-window list — `${en.quotaIndicatorTitle}: Basic · ${en.windowName('day')}: 0%` — so screen-reader users get the breakdown mouse users get from `title` (spec §6).
- Comment-only mentions of `used_today` at `checking/suggest.ts:75`, `checking/controller.ts:155`, and `auth/session.ts:137`: reword to name the credit windows (the described refresh behavior is unchanged — usage is still status-blind and refresh is still cosmetic). The stale CSS comment at `App.css:143-144` ("Today's LLM usage vs. the daily cap") likewise. No styling change: `.quota-indicator` has no at-limit state today and B6 adds none — spec §6 says so explicitly (a visual exhausted state is future polish outside this design).

Add one new indicator test in `App.test.tsx` next to the existing indicator coverage:

```tsx
  it('shows the tier label and the tightest window percentage', () => {
    // fixture user with windows day 30%, month 70% -> month binds
    // render, then:
    expect(screen.getByText('Basic · 70%')).toBeInTheDocument()
  })
```

(Adapt setup to the file's existing render helpers; the binding assertions: the rendered text is `Basic · 70%`, and BOTH the `title` attribute and the aria-label contain `day: 30%` and `month: 70%` — use the locale's `windowName` values.)

- [ ] **Step 6: Run the frontend gates**

Run from `frontend/`: `npm test -- --run` then `npm run build`.
Expected: all green, no type errors.

- [ ] **Step 7: Run the backend gate too**

Run from `backend/`: `uv run pytest -q` — untouched but confirm green before committing.

- [ ] **Step 8: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): budget indicator — tier label + tightest window percent (B6, #40)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

### Task 7: Architecture docs

**Files:**
- Modify: `docs/backend-architecture.md`
- Modify: `docs/frontend-architecture.md`

**Interfaces:** none — prose only. Source of truth: the spec plus the merged code from Tasks 1–6.

- [ ] **Step 1: Update `docs/backend-architecture.md`**

Locate the ledger/metering section (it documents `llm_usage`, `reserve_llm_run`, the M5 quota, and the B5/B7 columns; known stale sites: `docs/backend-architecture.md:1382, 1572, 1635, 1756-1759, 1787` — the closing grep is the authority). Update it to record:

- The `credits INTEGER` column: admission estimate while `started` (chars/4 input, quarter of that output, priced through `run_cost`), settled from actual tokens at `finish_run` (completed → actual, estimate stands if none reported; failed → actual else 0; cancelled/abandoned → estimate stands). Pre-B6 rows are `NULL` and count 0.
- `services/credits.py`: `credits = ceil(source_weight × factor × (input + output_weight × output))`; factor chain model → provider default → global default; per-provider `output_weight`; `name` free by default.
- The `credit_cost` config block and the tier `credits_per_{hour,day,week,month}` windows (≥1 required, calendar-aligned UTC, `llm_checks_per_day` removed — breaking config change).
- Enforcement: per-window `SUM(COALESCE(credits,0))` inside the reservation transaction, insert-first unchanged, between-runs only (overshoot ≤ one run), `QuotaDecision.exhausted_window`, new `(user_id, created_at)` index.
- `/me`: `label` + per-window `used_percent` (ceil, capped 100), no absolute numbers; `used_today` replaced by `credits_used`.

Also sweep the document for `llm_checks_per_day` / `used_today` mentions and update them.

- [ ] **Step 2: Update `docs/frontend-architecture.md`**

Update the quota-indicator/usage passages (known stale sites: `docs/frontend-architecture.md:1132, 1138, 1182, 1195` — the closing grep is the authority): `usage.label` + `usage.windows[]`, indicator renders the tightest window as `Label · N%`, tooltip lists all windows via `windowName`, `llmQuotaExhausted` is now a plain string (budgets are never shown as numbers).

- [ ] **Step 3: Verify and commit**

`grep -rn "llm_checks_per_day\|used_today" docs/backend-architecture.md docs/frontend-architecture.md` returns nothing. Run `uv run pytest -q` from `backend/` one final time (unchanged, but the branch must end green).

```bash
git add docs/backend-architecture.md docs/frontend-architecture.md
git commit -m "docs(architecture): record B6 credit budgeting (B6, #40)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ"
```

---

## Completion (controller, after all tasks + final review)

Follow the house workflow (superpowers:finishing-a-development-branch):

1. Final whole-branch review (most capable model), one fix wave, scoped re-review.
2. Append the LOGBOOK entry (`docs/LOGBOOK.md`, referenced by PR number once known; run `date` first).
3. Push the branch, open the PR against `main` with `Closes #40`, document any plan deviations in the PR body, request Copilot review, spawn the review watcher, triage every thread to resolution.
4. Owner merges (rebase-merge). Post-merge: sync main, delete branches, move #40 to Done on the project board (item lookup via `gh project item-list`, Status field `PVTSSF_lAHOAG7zBs4Beu68zhZG7bA`, Done option `98236657`).
