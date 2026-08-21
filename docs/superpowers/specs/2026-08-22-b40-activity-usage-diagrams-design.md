# B40: Activity/Usage Diagrams — Design

**Issue:** #124 · **Branch:** `b40-activity` · **Date:** 2026-08-22

## Problem

Neither users nor the admin can see usage over time. The `llm_usage`
ledger (B6) records every LLM run — timestamps, UTC `day`, status,
tier/provider/model, input/output tokens, source, credits — but the only
surface is the current-window quota numbers on `/auth/me`. Users should
see their own activity and token usage as charts; the admin should see
the same screen for any user, plus an all-users aggregate.

## Settled decisions (brainstorming, 2026-08-22)

- **Data: `llm_usage` only.** No new event collection. The response
  shape is extension-ready: a later activity-events source (rule-only
  checks, document edits, …) adds keys under `series` without breaking
  consumers.
- **Server-side aggregation** (rejected: shipping raw rows for
  client-side bucketing — growing payloads, duplicated logic, an
  unnecessary data-exposure surface for the admin case).
- **Daily buckets** on the ledger's own UTC `day` column, zero-filled
  over the full requested range; ranges 30 (default) / 90 / 365 days.
- **Hand-rolled SVG charts** — no new frontend dependency (rejected:
  Recharts ≈ 100 kB + d3 transitives in the license inventory; uPlot —
  canvas, imperative, hard to test).
- **Navigation:** own activity via an **account-menu entry** (admins
  included; the header bar stays uncrowded); all-users via a **control
  in the admin section**, with per-user drill-down from its table.
- **Failed runs** (`status != 'ok'` in a settled state) are a visible
  runs-category; their tokens/credits count as the ledger recorded them.

## Requirements

### R1 — Aggregation on the usage store

`UsageStore` gains one read-only method (name and exact signature are
plan-phase; semantics fixed here):

- Input: `user_id: int | None` (None = all users), `days: int`
  (validated ∈ {30, 90, 365} at the API layer), plus an `end_day`
  injection point for tests (defaults to today, UTC).
- Output: for each of the `days` calendar days ending today (UTC),
  zero-filled: runs by category — `check`, `suggestion`, `name` (only
  settled-OK runs; the ledger's `source` values) and `failed` (any
  settled non-OK status, regardless of source) — plus summed
  `input_tokens`, `output_tokens`, `credits`. In-flight (`'started'`)
  rows are excluded everywhere: they are not activity yet, and the
  startup sweep may still re-label them.
- One SQL `GROUP BY day` (+ conditional aggregation per category)
  through the db seam, identical semantics on sqlite and postgres;
  `idx_llm_usage_user_day` covers the per-user filter. No new columns,
  no schema change.
- A second method for the all-users table: per-user totals over the
  range — `user_id`, run count (incl. failed), `input_tokens`,
  `output_tokens`, `credits` — joined with email/display_name at the
  API layer via the existing user store. Users with zero rows in range
  are omitted (the admin user list, not this table, enumerates
  everyone).

### R2 — Three read-only endpoints

New router `app/api/usage_activity.py` (or folded into an existing
router if the plan finds a better fit; paths are fixed):

1. `GET /api/usage/activity?days=30` — the caller's own series. Any
   authenticated user.
2. `GET /api/usage/activity/all?days=30` — admin only: all-users
   aggregate series plus `per_user` totals. Registered before the
   `{user_id}` route so `all` never parses as a user id.
3. `GET /api/usage/activity/{user_id}?days=30` — admin only: that
   user's series. Unknown user id → 404 with the admin router's
   existing not-found idiom.

Common behavior: `days` outside {30, 90, 365} → 422 (validation, not
silent clamping); admin-only routes reuse the existing admin
dependency; responses carry no fields beyond the documented shape
(no fail_detail, no model strings — nothing an extension didn't ask
for).

Response shape (all three; `per_user` only on `/all`):

```json
{
  "days": ["2026-07-24", "…", "2026-08-22"],
  "series": {
    "runs": {"check": [0, …], "suggestion": [0, …],
              "name": [0, …], "failed": [0, …]},
    "input_tokens": [0, …],
    "output_tokens": [0, …],
    "credits": [0, …]
  },
  "totals": {"runs": 0, "input_tokens": 0, "output_tokens": 0,
              "credits": 0},
  "per_user": [{"user_id": 1, "email": "…", "display_name": null,
                 "runs": 0, "input_tokens": 0, "output_tokens": 0,
                 "credits": 0}]
}
```

Every array in `series` has exactly `len(days)` entries. `days` is
ascending and ends at today (UTC). The `runs` sub-object is the
extension point: future activity kinds append sibling keys under
`series` (or new categories under `runs`) without changing existing
ones.

### R3 — Shared ActivityView

- `ActiveView` union gains `'activity'`; `frontend/src/activity/`
  holds the view and chart components.
- Store: `activitySubject: 'self' | 'all' | number` (a user id). The
  account-menu entry sets `('activity', 'self')`; the admin-section
  control sets `('activity', 'all')`; a per-user table row sets the
  user id. Non-admins: the view renders only `self` regardless of
  store state (same client-side gating idiom as the admin view), and
  the server enforces independently.
- Screen composition (settled via visual-companion mockups,
  2026-08-22): top row with the screen heading left and the range
  picker right (30 / 90 / 365 pills; refetch on change, default 30); a
  one-line totals summary under it (runs · tokens in/out · credits);
  then the three panels as a **vertical stack of full-width charts**
  (runs stacked by category, tokens input/output, credits) — full
  width keeps per-day resolution usable at 365 days. Subject `all`
  adds the sortable
  per-user table (columns per R1; sort by any column, default credits
  descending; row click → that user's subject; a back control returns
  to `all`). Admin viewing a specific user sees whose data it is
  (email/display name in the heading).
- Loading and error states follow the existing view idioms; an empty
  range renders the charts with zero bars, not a blank screen.

### R4 — SVG chart components

In-repo components (`activity/` or `ui/`, plan decides): a stacked
daily bar chart used by all three panels. Visual style (settled via
visual-companion mockups, 2026-08-22 — "flat minimal plus gridlines"):

- flat **square-edged** stacked bars (no rounded corners, no
  animations), hairline baseline, dim axis labels;
- **faint horizontal gridlines** at the y-tick positions
  (`var(--border)`);
- **hover tooltip showing the actual numbers**: per-day `<title>`
  element (the house pattern, no portal library) listing each visible
  category with its value, e.g. "2026-08-14 — check 6, suggestion 2,
  failed 1" / "input 18,400, output 6,100" / "credits 210";
- colors from CSS custom properties, theme-aware in both themes:
  category ramp on the accent hue (`check` = `var(--accent)`,
  `suggestion` and `name` as two lighter ramp steps introduced as new
  `--accent-mid` / `--accent-faint` variables with light and dark
  values), `failed` = `var(--held-back)` amber; tokens: input =
  `var(--accent)`, output = `var(--accent-faint)`; credits =
  `var(--accent-mid)`;
- x-axis labels thinned at 90/365 so they stay legible.

Props: day labels, named series with values and colors, y-axis with a
small number of ticks. Rendering is pure (data in, SVG out) so tests
assert on the DOM with the house idioms (`getByText`,
`querySelector`); no snapshot tests.

### R5 — i18n

New message keys × 7 locales, informal register per the standing rule:
the account-menu entry ("My activity"), screen headings (own /
specific user / all users), panel titles, category labels (check,
suggestion, name, failed), range-picker labels, table headers, back
control, empty/error states. Day labels and numbers stay technical
literals (unlocalized), like the About dialog's values.

### R6 — Tests (mutation-verified per the standing rule)

Backend, store level (sqlite; the seam's live-PG parametrization runs
them against postgres too):
- bucketing and zero-fill: rows on scattered days → correct arrays,
  quiet days zero, array length == days;
- category split: OK runs by source; non-OK settled runs → `failed`
  regardless of source; `'started'` rows excluded from every series;
- range edges: a row on `end_day` and one on `end_day - days + 1`
  included, one day earlier excluded;
- cross-user isolation: user A's series never contains user B's rows;
  all-users aggregation equals the sum of per-user series;
- per-user totals: correct sums, zero-row users omitted.

Backend, API level: authz matrix (anonymous → 401 everywhere; regular
user: own OK, `/all` and `/{user_id}` → 403; admin: all three OK),
`days=31` → 422, unknown user → 404, `/all` route not shadowed by
`{user_id}`.

Frontend: non-admin never sees admin controls regardless of store
subject; range change refetches; table sorts and navigates; chart
component renders fixture data (bars, labels, categories); i18n key
parity (existing test enforces automatically).

### R7 — Documentation

`docs/backend-architecture.md`: the new endpoints and the aggregation
method on the usage-store section. `docs/frontend-architecture.md`:
the activity view, subject model, and chart components. No user-facing
ops docs affected.

## Out of scope

- Non-LLM activity events (prepared-for via the `series` shape only).
- CSV/JSON export, custom date ranges, per-model or per-provider
  breakdowns, quota lines drawn on the charts.
- Live/streaming updates — the screen fetches on open and on range or
  subject change.

## Delivery

One PR (`b40-activity`, closes #124) through the usual pipeline:
Opus-reviewed plan, SDD execution, final whole-branch review, Copilot
rounds, LOGBOOK entry as last commit (folding in the pending PR #123
line per the standing note), owner rebase-merge.
