# B6: Credit-Based LLM Budgeting — Design

**Issue:** #40 · **Depends on:** B7 real token usage (#39, merged in PR #45) and B5 failure classification (#38, same PR).
**Decided with the owner:** core design 2026-07-27 (PR #30 review discussion, carried in issue #40); the open
parameters below were settled in the 2026-07-29 brainstorming session.

## 1. Goal and shape

Replace the M5 run counter (`llm_checks_per_day`) with credit budgets per time window. A 100k-char
quality-tier check, a one-word suggestion, and an auto-title no longer all cost 1 against one limit:
each run costs credits proportional to its real token usage, weighted by model price and by what kind
of run it was. Budgets are enforced in the same `reserve_llm_run` transaction that enforces
concurrency today — admit on a size estimate, settle on actual tokens at `finish_run`.

**Binding constraints (carried from the owner decisions):**

- Credit limits are enforced **between** runs, never as mid-run cutoffs. Overshoot is bounded by one run.
- `name` runs (auto-titles) are effectively free: they are system-triggered, not user-initiated.
- The user never sees absolute credit numbers — only a tier label and per-window usage percentages
  (admins included; `/me` has one payload shape). Raw numbers exist only in config and the ledger.
- The replacement is hard: `llm_checks_per_day` is deleted from `TierLimitsSettings`. A config that
  still carries it fails at startup (`extra="forbid"` makes this loud). Every tier limits block must
  configure at least one credit window — the fail-closed property the mandatory run counter provided.

## 2. Costing model

### 2.1 The formula

```
credits = ceil( source_weight(source)
              × factor(provider, model)
              × (input_tokens + output_weight(provider) × output_tokens) )
```

- **Integer credits.** No divider: one credit ≈ one input-weighted token on a factor-1.0 model.
  Stored and summed as SQLite `INTEGER` — sums are exact, comparisons are exact, no float drift.
  Budgets are large numbers (e.g. `credits_per_day: 500000`); only the operator ever sees them.
- **`factor` is an input price** per model, grouped by provider. Lookup chain:
  exact model in the provider's `models` map → the provider's `default_factor` → the global
  `default_factor`.
- **`output_weight` is per provider** (the input→output price ratio is near-constant within a
  provider — Anthropic ≈ 5, OpenAI ≈ 6, Deepseek ≈ 2 — but varies widely across providers), with a
  global `default_output_weight` fallback.
- **`source_weight`** defaults: `check: 1.0`, `suggestion: 1.0`, `name: 0.0`. Weight 0 → `ceil(0)`
  = 0: `name` runs cost nothing regardless of size.

The costing function is pure and lives in a new `backend/app/services/credits.py`:
`run_cost(*, source, provider, model, input_tokens, output_tokens, config) -> int`.

### 2.2 Config

New top-level `credit_cost` block on `Settings` (server-wide, like `limits`):

```yaml
credit_cost:
  default_factor: 1.0
  default_output_weight: 4
  source_weights: { check: 1.0, suggestion: 1.0, name: 0.0 }
  providers:
    claude:
      output_weight: 5
      default_factor: 3.0
      models:
        "claude-haiku-4-5": 1.0
    ollama:
      default_factor: 0.1
```

House-style load-time validation:

- `extra="forbid"` on every block (`CreditCostSettings`, per-provider blocks).
- All factors and weights ≥ 0 (0 is legal: free local models, free sources); `output_weight` > 0.
- `source_weights` keys restricted to exactly `check`, `suggestion`, `name`; partial maps merge
  over the defaults.
- Provider keys under `providers:` validated against the configured provider names (same
  `known_provider_names` check the tier policy blocks use).
- The whole block is optional with usable defaults: an absent `credit_cost` prices every model at
  factor 1.0 with output weight 4.

### 2.3 Tier config

`TierLimitsSettings` becomes:

```yaml
limits:
  # llm_checks_per_day: DELETED — config carrying it fails at startup
  credits_per_hour: 50000      # each window optional …
  credits_per_day: 500000
  credits_per_week: 2000000
  credits_per_month: 5000000   # … but at least one required
  max_llm_document_chars: 200000
  concurrent_llm_runs: 3
```

- Validation: every configured `credits_per_*` positive; at least one of the four present
  (model-level validator — a tier with no budget would fail open).
- `_default_admin_limits()` (which also covers no-tiers mode and unknown tiers via `limits_for`)
  replaces `llm_checks_per_day=500` with `credits_per_day=5_000_000` — the same "generous but not
  unlimited" posture (≈ 500 checks of ~10k weighted tokens).
- Each tier block gains an optional display `label` (`tiers.pro.label: "Pro"`), defaulting to the
  capitalized tier name; admins display as `"Admin"`.

## 3. Windows

Four calendar-aligned UTC windows, matching the existing `day` column's semantics:

| Window | Start of current window |
|---|---|
| `hour` | `created_at ≥ YYYY-MM-DDTHH:00:00` (current UTC hour) |
| `day` | existing `day` column = current UTC date |
| `week` | Monday 00:00 UTC of the current ISO week |
| `month` | first of the current month, 00:00 UTC |

Hour/week/month predicate on `created_at` — the stored `isoformat(timespec="seconds")` strings are
lexicographically ordered, exactly as the staleness sweep already relies on. New index
`idx_llm_usage_user_created ON llm_usage(user_id, created_at)` serves these windows; `day` keeps
using `idx_llm_usage_user_day`.

A window's usage is `SUM(COALESCE(credits, 0))` over **all** of the user's rows in the window,
regardless of status — the same "all rows count" rule `used_today` established. In-flight rows
contribute their admission estimate; pre-B6 rows have `credits NULL` and count 0.

## 4. Ledger changes

- New column `credits INTEGER` (nullable), added via `migrate_columns` like `fail_stage`/`fail_detail`.
- `reserve_llm_run` writes the admission estimate into the INSERT, then — inside the same
  transaction — evaluates each window the tier configures:
  `SUM(COALESCE(credits,0))` including the just-inserted row;
  any window over budget → rollback → `QuotaDecision(kind="quota_exhausted")` extended with
  `exhausted_window: str | None` so the 429 detail can name it. Check order: budget windows
  (smallest window first: hour, day, week, month), then per-user concurrency, then server-wide
  concurrency — quota before concurrency, as today. The run-count check is deleted.
- **Admission estimate** (module constants in `credits.py`, not config — settle corrects them):
  `est_input = ceil(text_chars / 4)`, `est_output = est_input // 4`, priced through the same
  `run_cost` formula.
- `finish_run` settles `credits` by terminal status, reading `provider`, `model`, `source` off the
  row (they are reservation-time facts the caller shouldn't re-supply):
  - `completed` → actual tokens through `run_cost` (`None` treated as 0 per side); if the provider
    reported no tokens at all (both `None`), the admission estimate stands.
  - `failed` → actual tokens if any were reported (`None` treated as 0 per side); if both are
    `None`, **0 credits** — request-stage failures never reached the provider and cost nothing;
    response-stage failures carry real counts via B7/`UnparseableResponseError.usage`.
  - `cancelled` → the estimate stands (cost was plausibly incurred; actuals unknown).
  - Abandoned rows are swept by UPDATEs that never touch `credits` — the estimate stands.
- `UsageStore` gains a `credit_cost: CreditCostSettings` constructor parameter (defaulting to
  `CreditCostSettings()`; `app.main` passes `settings.credit_cost`). Unlike per-tier limits, pricing
  is global and static — constructor injection leaves `finish_run`'s signature and all three
  settle frames untouched.
- `used_today` is replaced by `credits_used(user_id, windows, *, now) -> dict[str, int]` returning
  the summed usage per requested window (one query per window; `/me` is the only caller).

## 5. API surface

`/me` (and the login response's embedded user) — `usage` becomes:

```json
"usage": {
  "label": "Pro",
  "windows": [
    { "window": "day",   "used_percent": 82 },
    { "window": "month", "used_percent": 41 }
  ]
}
```

- One entry per window the caller's limits block configures, in fixed order hour, day, week, month.
- `used_percent = min(100, ceil(used / budget × 100))` — whole percent, rounded up (0.2% shows as
  1%), capped at 100. No absolute numbers in the payload, for any caller.
- `label` from the tier block (default capitalized tier name; `"Admin"` for admins).
- Budget exhaustion keeps its existing surface: the run degrades with `skipped="quota_exhausted"`
  (an exhausted allowance is not retryable, so no 429 — unchanged §6.4 behavior). The binding
  window travels internally as `QuotaDecision.exhausted_window` for tests and logs. The
  concurrency 429s are unchanged.

## 6. Frontend

- The header quota indicator shows the tier label and the **tightest** window — the highest
  `used_percent` — e.g. `Pro · 82%`. The tooltip/aria-label lists every configured window's
  percentage. Percent ≥ 100 renders the same exhausted styling the counter used at limit.
- The session-refresh race guard (`refreshSeq` in `session.ts`: only the last-issued refresh may
  commit) is payload-shape-agnostic and needs no change.
- Test fixtures (~10 files construct `usage: { used_today, limit }`) move to the new shape.

## 7. Testing

House rules apply: TDD, zero-warning pytest gate, mutation-verify every guard test, no live-DB
access, never widen wall-clock bounds.

- **Costing unit tests:** lookup chain (model hit / provider default / global default), per-provider
  output weight vs global, each source weight, `name` → 0, ceil behavior, zero-token runs.
- **Window tests:** boundary instants for hour/week/month (e.g. Sunday 23:59:59 vs Monday 00:00:00
  UTC for `week`), via `reserve_llm_run`'s `now` parameter.
- **Reservation tests:** admit under budget; reject when any single window is exhausted (tightest
  binds); in-flight estimates count toward the sum; estimate row rolls back on rejection;
  `exhausted_window` reported; pre-B6 `NULL` rows count 0; run-count check gone (a tier admitting
  many cheap runs in one day passes).
- **Settlement tests:** per terminal status incl. failed-with-no-tokens → 0, completed-with-no-tokens
  → estimate stands, cancelled → estimate stands; settled credits visible to the next reservation.
- **Config validation tests:** stale `llm_checks_per_day` fails startup; tier block with no windows
  fails; unknown provider under `credit_cost.providers` fails; unknown `source_weights` key fails;
  negative factor fails; absent `credit_cost` block works with defaults.
- **API/frontend tests:** `/me` payload shape and percent math; indicator shows tightest window and
  label; monotonic guard per window.

## 8. Out of scope

- Retroactive re-costing of historical rows (the ledger keeps the raw inputs; re-pricing is an
  offline exercise; pre-B6 rows simply count 0).
- An admin-only raw-numbers usage view (possible later without changing this design).
- Per-user (as opposed to per-tier) budget overrides.
- Mid-run streaming cutoffs — explicitly rejected by the carried-over §6.4 constraint.
