# M5: Metering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every LLM run is recorded in an `llm_usage` ledger and admitted through one transactional reservation (daily quota + per-user and server-wide concurrency), with size caps, visible degradation for non-retryable denials, a documented 429 for the retryable one, and quota/limit visibility on `/api/auth/me` and in the UI.

**Architecture:** A new `app/services/usage.py` owns the ledger schema and the reservation transaction. The existing single LLM gate (`app/api/llm_gate.py`, M4) grows the spec-ordered steps around `resolve_llm_selection`: per-tier size cap → resolve → provider construction → reservation. Callers receive a reservation handle and write the terminal ledger status exception-safely. A pure ASGI middleware enforces the global request-byte budget; char-level 413s sit at the three text-entry endpoints. `/api/auth/me` gains `usage`/`limits`/`allow_additional_admins`; the frontend surfaces quota state, the two new skip codes, a transient 429 notice, and a character count with the two thresholds marked.

**Tech Stack:** Python 3.13 / FastAPI / SQLite (stdlib `sqlite3`), pydantic v2, pytest; React 19 / TypeScript / zustand / vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-multi-user-auth-design.md` §5.3 (ledger), §6.1 (limits config), §6.4 (quotas), §6.5 (size limits), §6.6 (concurrency + backpressure), §7.1 (`/me`), §7.2 (gate ordering, degradation), §8 (frontend), §10 (tests). Roadmap: `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md` M5 row and Cross-milestone interfaces.

## Global Constraints

Copied from the spec / house rules; every task's requirements implicitly include these.

- **Inert by default.** With no `tiers:` configured, every user (and every admin, always) is metered against the generous `limits.admin` defaults (500 runs/day, 200 000 LLM chars, 5 concurrent); server-wide defaults: `max_document_chars: 200000`, `max_concurrent_llm_runs: 20`, `llm_run_max_age: 900`, `concurrency_reject_delay: 0.25`. Existing usage must not notice M5.
- **Every denial degrades rather than erroring, except the documented 429 (concurrency, retryable, `Retry-After: 5`) and 413 (global size cap).** 403 is never used on the LLM selection path. Daily-quota exhaustion is never a 429.
- **One gate.** `grep -rn "provider_factory" backend/app --include='*.py'` matches only `app/main.py` and `app/api/llm_gate.py`. Every LLM-invoking endpoint (checks, suggestions, document naming) resolves and reserves through `get_effective_provider`.
- **Reservation is one SQLite transaction, insert-first.** Staleness sweep → INSERT the reservation row → counts *including the just-inserted row* → commit iff `day_count <= llm_checks_per_day` AND `user_in_flight <= concurrent_llm_runs` AND `server_in_flight <= max_concurrent_llm_runs`, else roll back. Never "optimize" into count-then-insert. Quota is decided before concurrency (an exhausted allowance must never be reported as a retryable 429).
- **Day counts are UTC and status-blind** (`completed`/`failed`/`cancelled`/`abandoned` all count). **In-flight counts filter on `status='started'` (and `created_at` only for staleness) and are never day-scoped.**
- **Terminal ledger writes are exception-safe by construction** (`finally`, covering success, exception and `CancelledError` alike) **and conditional** (`... WHERE id = :id AND status = 'started'`); a swept row logs a warning and is not resurrected.
- **Backpressure:** the per-user-cap 429 waits `concurrency_reject_delay` via a non-blocking `await asyncio.sleep(...)` on an `async def` path, *after* the transaction rolled back, small and fixed (never escalating). Server-wide-cap 429s answer immediately, no pause.
- **Admins take exactly the same path** with `limits.admin` replacing their tier's block — same transaction, same ledger row. The ceiling is config-only; no API may raise it. An admin reaching the ceiling logs a WARNING with user id and the day's count.
- **Skip codes are shared with M4:** `quota_exhausted`, `document_too_large`, `llm_unavailable` — one vocabulary on `EffectiveSelection.skipped`, the `effective_llm` report (POST + SSE), and `SuggestionResponse.skipped`.
- **Vocabulary discipline:** *user tiers* = config `tiers:` keys; *quality tiers* = the fixed ladder in `TIERS`. Never mix them in names or copy.
- **Frontend single gating source:** components read `/me` (`auth/policy.ts` helpers plus the new `usage`/`limits` fields); no component reads the API `allowed` flags.
- New UI copy lands in all seven locale catalogs (`en de fr es it ja zh`), impersonal register (matching the existing catalogs).
- Tests never touch `backend/data/fabulous.db`; every test passes `tmp_path`-based `Settings`; `create_app()` is never called with default settings in tests.
- Gates before every commit: backend `uv run pytest -q` from `backend/` with **zero warnings**; frontend `npx vitest run && npm run lint && npm run build` from `frontend/` (bare `tsc --noEmit` checks zero files — `npm run build` runs `tsc -b`).
- **Mutation-verify every guard test** (delete the guard, watch the named test fail, restore) — the plan marks these steps explicitly.
- Never `git commit --amend`, `git rebase`, or force-push. Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`
- Pyright diagnostics in this repo are unreliable (broken import resolution); the passing suite is ground truth.

## Design decisions (locked here so tasks don't re-derive them)

1. **`limits_for` fallback.** `limits_for(*, tier, is_admin, settings) -> TierLimitsSettings` returns `settings.limits.admin` for admins, the tier's (now required) `limits:` block when the tier is configured, and `settings.limits.admin` otherwise. "Otherwise" covers two cases: (a) no `tiers:` configured at all — the inert-default mode, where the generous admin numbers are exactly the "high enough to be inert" defaults the roadmap requires; (b) a user row naming an unknown tier while `tiers:` is configured — that user's policy is already `NO_LLM_POLICY` (M4 fails closed), so resolution floors out with `llm_unavailable` and **never reaches the reservation**; the returned block only feeds the `/me` display, where the admin numbers are a harmless upper bound on an account that can run nothing.
2. **Provider construction happens before reservation.** Gate order: direct-only unknown-provider 422 → per-tier size cap → `resolve_llm_selection` → provider construction (ValueError → `llm_unavailable`, unchanged) → reservation. A run whose provider cannot even be constructed never consumed quota, and no cleanup path is needed for a reservation that would have to be voided. The spec's ordering constraint (size → resolve → reserve) is preserved; construction is not part of that ordering.
3. **Reservation handle keys on the ledger row id**, not `run_id`: `UPDATE llm_usage SET ... WHERE id = :id AND status = 'started'`. Strictly narrower than the spec's `WHERE run_id = :id AND status = 'started'` (same semantics, immune to any future run_id reuse). `run_id` stays the correlation column: checks use the natural check id; suggestions and naming mint a UUID.
4. **Token columns:** providers report no usage today (`generate` returns only text), so `input_tokens` is always NULL in v1. The checks path records the last cumulative count from the existing progress callback as an approximate `output_tokens`; suggestions/naming write NULL. Spec allows NULL "when the provider reports nothing".
5. **Rollback rolls back the sweep too.** A denied reservation rolls back the whole transaction, including the staleness `UPDATE` that opened it. Harmless and self-healing: the denial was computed on the swept counts, and the next reservation re-sweeps.
6. **Naming propagates the 429.** `generate_name`'s broad silent-fallback `try` gains `except HTTPException: raise` above `except Exception` — quota/size/floor denials still fall back silently (provider is None, no exception), but the concurrency 429 applies to every LLM-invoking endpoint alike (spec §7.2).
7. **No new fields on `EffectiveLlmReport`.** The quota note's limit comes from `/me` (`usage.limit`), the size note's from `/me` (`limits.max_llm_document_chars`), and the reset is always "midnight UTC" — the skip *code* alone travels with the check. **Documented deviation from §6.4/§6.5**, which say the scorecard/SSE report carries the limit (and reset day) inline: behaviorally equivalent for this UI, but a non-browser consumer of `effective_llm` must call `/me` for the numbers. Task 10 records this in the roadmap's as-built section so the spec is not mistaken for the as-built contract.
8. **Frontend quota freshness:** the store's `user` (from `/me`) is the single source; `session.ts` exports `refreshUser()` (generation-guarded re-fetch of `/me`) and the check/suggestion flows trigger it fire-and-forget after an LLM run completes — via a leaf registration slot (`auth/refreshSlot.ts`), because a direct `checking/* → auth/session.ts` import would close the module cycle `controller → session → documents → hydration → controller` that `checking/cancelSlot.ts` exists to break. Client-side increments are not attempted.
9. **Per-tier `limits:` becomes required.** M4 shipped it optional-until-M5 by design (`TierSettings` docstring). **Release note for operators:** a `tiers:` block whose tiers lack `limits:` now aborts startup.
10. **Middleware order:** the request-size middleware is added **before** the CORS `add_middleware` call in `create_app` — Starlette treats the *last-added* middleware as outermost, so CORS stays outermost and a 413 still carries CORS headers (spec §6.5).

## File map

| File | Task | Change |
|---|---|---|
| `backend/app/core/config.py` | 1 | `LimitsSettings`, `Settings.limits`, tier `limits:` required, cross-checks |
| `backend/config.example.yaml` | 1 | `limits:` example, tier `limits:` blocks |
| `backend/app/services/usage.py` | 2 | new: ledger schema, `reserve_llm_run`, `finish_run`, sweeps, `used_today` |
| `backend/app/core/permissions.py` | 3 | `limits_for` |
| `backend/app/main.py` | 3, 6 | `app.state.usage_store` + startup sweep; size middleware |
| `backend/app/api/llm_gate.py` | 4 | async gate: size cap, reservation, 429 + backpressure |
| `backend/app/api/checks.py` | 4, 6 | gate call, terminal writes in `_run_llm`; char 413 |
| `backend/app/api/suggestions.py` | 5 | gate call, terminal writes, skip codes |
| `backend/app/api/documents.py` | 5, 6 | naming gate call + 429 passthrough; char 413 |
| `backend/app/api/request_size.py` | 6 | new: ASGI byte-budget middleware |
| `backend/app/api/auth.py` | 7 | `UsagePayload`, `LimitsPayload`, `MeResponse` fields |
| `frontend/src/types.ts`, `api/client.ts` | 8 | payload types, `MeResponse` fields (required) |
| `frontend/src/auth/session.ts`, `auth/refreshSlot.ts` (new) | 8 | `refreshUser()` behind a cycle-breaking slot |
| `frontend/src/checking/controller.ts`, `checking/suggest.ts` | 8 | 429 notice, skip-code branches, `refreshUser()` calls |
| `frontend/src/i18n/*` (×8) | 8 | new keys |
| `frontend/src/sidebar/Sidebar.tsx` | 9 | quota/size skip notes; char count with thresholds |
| `frontend/src/App.tsx`, `state/store.ts`, `editor/Editor.tsx`, `App.css` | 9 | quota indicator; docChars plumbing |
| `docs/backend-architecture.md`, `docs/frontend-architecture.md`, roadmap, `docs/LOGBOOK.md` | 10 | M5 sections, as-built interfaces, logbook |

---

### Task 1: `limits:` config block; per-tier `limits:` becomes required

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `backend/config.example.yaml`
- Test: `backend/tests/test_config.py`

**Interfaces:**
- Consumes: `TierLimitsSettings` (M4, unchanged shape).
- Produces: `LimitsSettings` with fields `max_document_chars: int`, `max_concurrent_llm_runs: int`, `llm_run_max_age: int`, `concurrency_reject_delay: float`, `admin: TierLimitsSettings`; `Settings.limits: LimitsSettings`; `TierSettings.limits: TierLimitsSettings` (required). Later tasks reference `settings.limits.<field>` and `settings.limits.admin.<field>` exactly.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_config.py` (follow the file's existing helper style for building settings dicts — it already has M4 tier-validation tests to mirror):

```python
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
```

If the file does not already import `pytest`/`ValidationError`, add the imports at the top (it already imports `Settings`).

- [ ] **Step 2: Run tests to verify they fail**

Run from `backend/`: `uv run pytest tests/test_config.py -q`
Expected: the new tests FAIL (`Settings` has no attribute `limits`; tier without limits currently validates).

- [ ] **Step 3: Implement**

In `backend/app/core/config.py`:

Add after `TierLimitsSettings` (it must be defined already — it is):

```python
def _default_admin_limits() -> TierLimitsSettings:
    # Deliberately generous: the inert-by-default numbers from spec §6.1.
    return TierLimitsSettings(
        llm_checks_per_day=500,
        max_llm_document_chars=200000,
        concurrent_llm_runs=5,
    )


class LimitsSettings(BaseModel):
    """Global, server-level limits (spec §6.1) plus the admin blast-radius
    ceiling. The ceiling is config-only by design — no API surface may read
    it as input or mutate it (spec §6.1); a partial admin block is a config
    error because a missing member would fail open on the one account that
    carries an explicit "not unlimited" guarantee."""

    model_config = ConfigDict(extra="forbid")  # see TierLimitsSettings

    max_document_chars: int = 200000
    max_concurrent_llm_runs: int = 20
    # Seconds; 'started' ledger rows older than this are swept (spec §6.6).
    llm_run_max_age: int = 900
    # Seconds of backpressure before a per-user-cap 429 (spec §6.6).
    concurrency_reject_delay: float = 0.25
    admin: TierLimitsSettings = Field(default_factory=_default_admin_limits)

    @field_validator("max_document_chars", "max_concurrent_llm_runs", "llm_run_max_age")
    @classmethod
    def _positive(cls, value: int, info) -> int:
        if value <= 0:
            raise ValueError(f"{info.field_name} must be a positive integer")
        return value

    @field_validator("concurrency_reject_delay")
    @classmethod
    def _delay_in_range(cls, value: float) -> float:
        if not 0 <= value <= 2:
            raise ValueError(
                "concurrency_reject_delay must be within [0, 2] seconds"
                " (a longer pause would amplify load, spec §6.6)"
            )
        return value
```

Change `TierSettings.limits` from optional to required, and update the two docstrings that promised this change:

```python
class TierLimitsSettings(BaseModel):
    """Per-user-tier numeric limits (spec §6.1): the block is all-or-nothing
    and, since M5, required on every configured tier — a missing member (or
    block) would fail open now that reservation enforces these numbers."""
    ...


class TierSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")  # see TierLimitsSettings

    llm: TierLLMSettings = Field(default_factory=TierLLMSettings)
    limits: TierLimitsSettings
    features: list[str] = Field(default_factory=list)
```

(Keep the `_known_features` validator unchanged.)

On `Settings`: add the field and extend the model validator:

```python
    limits: LimitsSettings = Field(default_factory=LimitsSettings)
```

Append to `_validate_tier_provider_names` (same validator, so all cross-field checks live in one place — rename it to `_validate_cross_references` and update nothing else, or keep the name; keep whichever reads cleaner with the smallest diff — do **not** add a second `model_validator`):

```python
        cap = self.limits.max_concurrent_llm_runs
        if self.limits.admin.concurrent_llm_runs > cap:
            raise ValueError(
                "limits.admin.concurrent_llm_runs exceeds max_concurrent_llm_runs"
                " — a single account could starve the shared pool"
            )
        for tier_name, tier in self.tiers.items():
            if tier.limits.concurrent_llm_runs > cap:
                raise ValueError(
                    f"tiers.{tier_name}.limits.concurrent_llm_runs exceeds"
                    " max_concurrent_llm_runs — a single user could starve"
                    " the shared pool"
                )
```

- [ ] **Step 4: Run the tests**

`uv run pytest tests/test_config.py -q` — all pass. Then the full suite: `uv run pytest -q` — **expect fallout**: any existing test that configures a `tiers:` block without `limits:` now fails validation. Fix each by adding a limits block to the fixture, e.g. `"limits": {"llm_checks_per_day": 100, "max_llm_document_chars": 100000, "concurrent_llm_runs": 5}` — generous values so those tests' behavior is otherwise unchanged. Sweep: `grep -rln '"tiers"\|tiers=' backend/tests` and check every hit that builds `Settings`.

**Fixture rule for the whole milestone** (Tasks 4–7 depend on it): any test settings that lower `max_concurrent_llm_runs` below 5 must also supply a **complete** `limits.admin` block with `concurrent_llm_runs <= max_concurrent_llm_runs` — the default admin ceiling carries `concurrent_llm_runs=5`, so a lowered server cap alone fails the new cross-check at `Settings` construction, before the test body ever runs. (A partial admin block is itself invalid — all three members, always.)

- [ ] **Step 5: Update `backend/config.example.yaml`**

Add a commented `limits:` section next to the existing `tiers:` example, with the defaults spelled out and one line each on: global vs per-tier, the admin ceiling being config-only, and the [0, 2] delay bound. Add `limits:` blocks to the example tiers (20/20000/3 for basic, 200/100000/5 for premium — spec §6.1's numbers) and a note that `limits:` is required on every configured tier since M5.

- [ ] **Step 6: Commit**

```bash
git add backend/app/core/config.py backend/config.example.yaml backend/tests/
git commit -m "feat(config): global limits block and required per-tier limits (M5)"
```
(with the two mandatory trailer lines).

---

### Task 2: the `llm_usage` ledger and `reserve_llm_run` (`app/services/usage.py`)

**Files:**
- Create: `backend/app/services/usage.py`
- Test: `backend/tests/test_usage.py`

**Interfaces:**
- Consumes: `TierLimitsSettings`, `LimitsSettings` (Task 1); `RequestedLLM`, `EffectiveSelection` (M4, `app/core/permissions.py`); `connect` (`app/services/_sqlite.py`).
- Produces (later tasks rely on these exact names):
  - `UsageStore(db_path)` with methods
    `reserve_llm_run(user, limits, server_limits, requested, effective, text_chars, source, run_id, *, now=None) -> QuotaDecision`,
    `finish_run(reservation_id: int, status: str, *, input_tokens: int | None = None, output_tokens: int | None = None) -> None`,
    `used_today(user_id: int, *, now: datetime | None = None) -> int`,
    `sweep_all_started() -> int`.
  - `QuotaDecision` frozen dataclass: `kind: Literal["admitted", "quota_exhausted", "concurrency_rejected"]`, `reservation_id: int | None = None`, `server_wide: bool = False`, `retry_after: int = RETRY_AFTER_SECONDS`.
  - `RETRY_AFTER_SECONDS = 5` (module constant; spec §6.6 — small and fixed).
  - `MeteredUser` Protocol: read-only `id: int` / `is_admin: bool` properties (so this service never imports from `app.api`, and the frozen `CurrentUser` dataclass satisfies it structurally).

The `user` parameter follows the roadmap's fixed signature; it is typed as `MeteredUser`, satisfied by `app.api.deps.CurrentUser`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_usage.py`:

```python
import logging
import sqlite3
import threading
from datetime import UTC, datetime, timedelta

import pytest

from app.core.config import LimitsSettings, TierLimitsSettings
from app.core.permissions import EffectiveSelection, RequestedLLM
from app.services._sqlite import connect
from app.services.usage import QuotaDecision, UsageStore


class FakeUser:
    def __init__(self, user_id: int, is_admin: bool = False):
        self.id = user_id
        self.is_admin = is_admin


LIMITS = TierLimitsSettings(
    llm_checks_per_day=3, max_llm_document_chars=20000, concurrent_llm_runs=2
)
SERVER = LimitsSettings(max_concurrent_llm_runs=4)

REQUESTED = RequestedLLM(tier="balanced")
EFFECTIVE = EffectiveSelection(
    tier="cheap", provider="ollama", model="llama3.1", degraded=True
)


@pytest.fixture
def store(tmp_path):
    return UsageStore(tmp_path / "usage.db")


def reserve(store, user=None, *, limits=LIMITS, server=SERVER, run_id="run-1",
            text_chars=100, source="check", now=None):
    return store.reserve_llm_run(
        user or FakeUser(1), limits, server, REQUESTED, EFFECTIVE,
        text_chars, source, run_id, now=now,
    )


def rows(store):
    with connect(store.db_path) as conn:
        return conn.execute("SELECT * FROM llm_usage ORDER BY id").fetchall()


class TestReservationRow:
    def test_admitted_row_is_complete(self, store):
        moment = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)  # fixed: no midnight race
        decision = reserve(store, run_id="check-abc", text_chars=42, now=moment)
        assert decision.kind == "admitted"
        assert decision.reservation_id is not None
        (row,) = rows(store)
        assert row["user_id"] == 1
        assert row["status"] == "started"
        assert row["day"] == "2026-07-27"
        assert row["created_at"].startswith(row["day"])
        assert row["llm_tier"] == "cheap"
        assert row["provider"] == "ollama"
        assert row["model"] == "llama3.1"
        assert row["requested_tier"] == "balanced"
        assert row["requested_provider"] is None
        assert row["requested_model"] is None
        assert row["text_chars"] == 42
        assert row["source"] == "check"
        assert row["run_id"] == "check-abc"
        assert row["input_tokens"] is None
        assert row["output_tokens"] is None

    def test_check_constraint_rejects_unknown_status(self, store):
        # A typo'd terminal status would silently leak a concurrency slot
        # for llm_run_max_age (spec §5.3) — it must fail loudly instead.
        with connect(store.db_path) as conn:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    """INSERT INTO llm_usage (user_id, day, created_at, status,
                       provider, model, text_chars, source, run_id)
                       VALUES (1, '2026-07-27', '2026-07-27T00:00:00+00:00',
                               'compelted', 'p', 'm', 1, 'check', 'r')"""
                )


class TestDailyQuota:
    def test_admits_exactly_the_limit(self, store):
        for i in range(3):
            decision = reserve(store, run_id=f"r{i}")
            assert decision.kind == "admitted"
            store.finish_run(decision.reservation_id, "completed")
        assert reserve(store, run_id="r3").kind == "quota_exhausted"

    def test_denial_rolls_back_the_row(self, store):
        for i in range(3):
            d = reserve(store, run_id=f"r{i}")
            store.finish_run(d.reservation_id, "failed")
        reserve(store, run_id="r3")
        assert len(rows(store)) == 3  # the denied insert did not survive

    def test_all_statuses_count_toward_the_day(self, store):
        # failed/cancelled/abandoned runs spent a reservation (spec §6.4):
        # cancel-and-retry must not hit providers for free.
        for status in ("failed", "cancelled", "abandoned"):
            d = reserve(store, run_id=f"r-{status}")
            store.finish_run(d.reservation_id, status)
        assert reserve(store, run_id="r3").kind == "quota_exhausted"

    def test_utc_day_rollover_resets_the_count(self, store):
        day1 = datetime(2026, 7, 27, 23, 59, tzinfo=UTC)
        for i in range(3):
            d = reserve(store, run_id=f"r{i}", now=day1)
            store.finish_run(d.reservation_id, "completed")
        assert reserve(store, run_id="r3", now=day1).kind == "quota_exhausted"
        day2 = day1 + timedelta(minutes=2)
        assert reserve(store, run_id="r4", now=day2).kind == "admitted"

    def test_quota_outranks_concurrency(self, store):
        # Both limits exceeded at once -> quota_exhausted, never a 429: an
        # exhausted allowance is not retryable and must not tell the client
        # to retry (spec §6.4 — evaluation order is the contract).
        limits = TierLimitsSettings(
            llm_checks_per_day=2, max_llm_document_chars=20000,
            concurrent_llm_runs=2,
        )
        reserve(store, limits=limits, run_id="r0")  # started, never finished
        reserve(store, limits=limits, run_id="r1")  # started, never finished
        # Third reservation: day_count 3 > 2 AND in-flight 3 > 2 — both
        # conditions fail, and the quota verdict must win.
        denied = reserve(store, limits=limits, run_id="r2")
        assert denied.kind == "quota_exhausted"

    def test_admin_ceiling_denial_logs_warning(self, store, caplog):
        limits = TierLimitsSettings(
            llm_checks_per_day=1, max_llm_document_chars=200000,
            concurrent_llm_runs=5,
        )
        admin = FakeUser(7, is_admin=True)
        d = reserve(store, admin, limits=limits, run_id="a0")
        store.finish_run(d.reservation_id, "completed")
        with caplog.at_level(logging.WARNING, logger="app.services.usage"):
            denied = reserve(store, admin, limits=limits, run_id="a1")
        assert denied.kind == "quota_exhausted"
        assert any(
            "admin" in r.message and "7" in r.message and "2" in r.message
            for r in caplog.records
        )

    def test_normal_user_denial_does_not_warn(self, store, caplog):
        for i in range(3):
            d = reserve(store, run_id=f"r{i}")
            store.finish_run(d.reservation_id, "completed")
        with caplog.at_level(logging.WARNING, logger="app.services.usage"):
            reserve(store, run_id="r3")
        assert not caplog.records


class TestConcurrency:
    def test_per_user_cap_rejects_and_reports_not_server_wide(self, store):
        reserve(store, run_id="r0")
        reserve(store, run_id="r1")
        denied = reserve(store, run_id="r2")
        assert denied.kind == "concurrency_rejected"
        assert denied.server_wide is False
        assert denied.retry_after == 5
        assert len(rows(store)) == 2

    def test_other_user_is_unaffected_by_a_full_user(self, store):
        reserve(store, FakeUser(1), run_id="r0")
        reserve(store, FakeUser(1), run_id="r1")
        assert reserve(store, FakeUser(2), run_id="r2").kind == "admitted"

    def test_server_wide_cap_binds_across_users(self, store):
        for i in range(4):
            assert reserve(store, FakeUser(i + 10), run_id=f"r{i}").kind == "admitted"
        denied = reserve(store, FakeUser(99), run_id="r4")
        assert denied.kind == "concurrency_rejected"
        assert denied.server_wide is True

    def test_finish_frees_the_slot(self, store):
        d0 = reserve(store, run_id="r0")
        reserve(store, run_id="r1")
        store.finish_run(d0.reservation_id, "failed")
        assert reserve(store, run_id="r2").kind == "admitted"

    def test_in_flight_is_never_day_scoped(self, store):
        # A run started at 23:59 must not escape its cap at midnight
        # (spec §6.6): in-flight filters on status/created_at only.
        before = datetime(2026, 7, 26, 23, 59, tzinfo=UTC)
        after = datetime(2026, 7, 27, 0, 1, tzinfo=UTC)
        reserve(store, run_id="r0", now=before)
        reserve(store, run_id="r1", now=before)
        denied = reserve(store, run_id="r2", now=after)
        assert denied.kind == "concurrency_rejected"

    def test_two_simultaneous_reservations_admit_exactly_one(self, tmp_path):
        # TOCTOU (spec §6.4): insert-first serializes concurrent starts.
        store = UsageStore(tmp_path / "usage.db")
        limits = TierLimitsSettings(
            llm_checks_per_day=3, max_llm_document_chars=20000,
            concurrent_llm_runs=2,
        )
        d = store.reserve_llm_run(
            FakeUser(1), limits, SERVER, REQUESTED, EFFECTIVE, 1, "check", "r0"
        )
        store.finish_run(d.reservation_id, "completed")
        d = store.reserve_llm_run(
            FakeUser(1), limits, SERVER, REQUESTED, EFFECTIVE, 1, "check", "r1"
        )
        store.finish_run(d.reservation_id, "completed")
        # 2 of 3 used; two racing reservations may admit only one.
        barrier = threading.Barrier(2)
        decisions = []

        def attempt(run_id):
            barrier.wait()
            decisions.append(store.reserve_llm_run(
                FakeUser(1), limits, SERVER, REQUESTED, EFFECTIVE,
                1, "check", run_id,
            ))

        threads = [threading.Thread(target=attempt, args=(f"race{i}",))
                   for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        kinds = sorted(d.kind for d in decisions)
        assert kinds == ["admitted", "quota_exhausted"]


class TestSweeps:
    # Fixed mid-day times, not now()-relative: with `old = now - 1000s`,
    # a test run in the first ~17 minutes after UTC midnight would put the
    # stale rows on yesterday's `day` and flip the quota assertions.
    BASE = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)
    OLD = BASE - timedelta(seconds=1000)  # past llm_run_max_age (900)

    def test_stale_started_rows_are_swept_at_reservation(self, store):
        reserve(store, run_id="stale", now=self.OLD)
        reserve(store, run_id="stale2", now=self.OLD)
        # Both slots freed by the sweep that opens the next reservation:
        d = reserve(store, run_id="fresh", now=self.BASE)
        assert d.kind == "admitted"
        by_run = {r["run_id"]: r["status"] for r in rows(store)}
        assert by_run["stale"] == "abandoned"
        assert by_run["stale2"] == "abandoned"
        assert by_run["fresh"] == "started"

    def test_swept_rows_still_count_toward_the_day(self, store):
        # concurrent_llm_runs=3, not the helper default of 2: all three
        # stale reservations must be ADMITTED (an in-flight rejection on the
        # third would roll its row back and leave only two to count).
        wide = TierLimitsSettings(
            llm_checks_per_day=3, max_llm_document_chars=20000,
            concurrent_llm_runs=3,
        )
        for i in range(3):
            assert reserve(
                store, limits=wide, run_id=f"stale{i}", now=self.OLD
            ).kind == "admitted"
        denied = reserve(store, limits=wide, run_id="fresh", now=self.BASE)
        assert denied.kind == "quota_exhausted"  # day_count 4 > 3

    def test_terminal_write_does_not_resurrect_a_swept_row(self, store, caplog):
        d = reserve(store, run_id="stale", now=self.OLD)
        reserve(store, run_id="sweeper", now=self.BASE)  # sweeps the stale row
        with caplog.at_level(logging.WARNING, logger="app.services.usage"):
            store.finish_run(d.reservation_id, "completed", output_tokens=10)
        (stale_row,) = [r for r in rows(store) if r["run_id"] == "stale"]
        assert stale_row["status"] == "abandoned"
        assert stale_row["output_tokens"] is None
        assert any("swept" in r.message for r in caplog.records)

    def test_sweep_all_started(self, store):
        reserve(store, run_id="r0")
        reserve(store, run_id="r1")
        assert store.sweep_all_started() == 2
        assert all(r["status"] == "abandoned" for r in rows(store))


class TestUsedToday:
    def test_counts_every_status_for_the_utc_day(self, store):
        now = datetime(2026, 7, 27, 12, 0, tzinfo=UTC)
        limits = TierLimitsSettings(
            llm_checks_per_day=10, max_llm_document_chars=20000,
            concurrent_llm_runs=10,
        )
        for i, status in enumerate(["completed", "failed", "cancelled"]):
            d = reserve(store, limits=limits, run_id=f"r{i}", now=now)
            store.finish_run(d.reservation_id, status)
        reserve(store, limits=limits, run_id="r3", now=now)  # still started
        d_old = reserve(store, limits=limits, run_id="old",
                        now=now - timedelta(days=1))
        store.finish_run(d_old.reservation_id, "completed")
        assert store.used_today(1, now=now) == 4
        assert store.used_today(2, now=now) == 0
```

- [ ] **Step 2: Run to verify failure**

`uv run pytest tests/test_usage.py -q` — FAIL: `ModuleNotFoundError: app.services.usage`.

- [ ] **Step 3: Implement `backend/app/services/usage.py`**

```python
"""The llm_usage ledger and the transactional run reservation (spec §5.3,
§6.4, §6.6).

Record richly, limit simply: every LLM-invoking endpoint writes one row per
run; v1 enforces one daily quota plus two concurrency caps, but every future
limit dimension is computable from this ledger without schema changes.
"""

import logging
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal, Protocol

from app.core.config import LimitsSettings, TierLimitsSettings
from app.core.permissions import EffectiveSelection, RequestedLLM
from app.services._sqlite import connect

logger = logging.getLogger(__name__)

# Spec §6.6: small and fixed — a longer value would only hold connections
# open against the very pressure the cap relieves.
RETRY_AFTER_SECONDS = 5

_SCHEMA = """
CREATE TABLE IF NOT EXISTS llm_usage (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL,
    day                TEXT NOT NULL,
    created_at         TEXT NOT NULL,
    status             TEXT NOT NULL,
    llm_tier           TEXT,
    provider           TEXT NOT NULL,
    model              TEXT NOT NULL,
    requested_tier     TEXT,
    requested_provider TEXT,
    requested_model    TEXT,
    text_chars         INTEGER NOT NULL,
    input_tokens       INTEGER,
    output_tokens      INTEGER,
    source             TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    -- Not decoration: a typo'd terminal status would silently leak a
    -- concurrency slot for llm_run_max_age (spec §5.3).
    CHECK (status IN ('started','completed','failed','cancelled','abandoned'))
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_day ON llm_usage(user_id, day);
-- The server-wide in-flight count has no user_id predicate; without this
-- partial index it degrades to a full table scan inside the transaction
-- that serializes every user's reservation (spec §5.3).
CREATE INDEX IF NOT EXISTS idx_llm_usage_inflight ON llm_usage(status, created_at)
    WHERE status = 'started';
"""


class MeteredUser(Protocol):
    """What reservation needs to know about the caller. Satisfied by
    app.api.deps.CurrentUser without this service importing from app.api.
    Declared as read-only properties: CurrentUser is a frozen dataclass,
    and writable protocol members would reject it structurally."""

    @property
    def id(self) -> int: ...

    @property
    def is_admin(self) -> bool: ...


@dataclass(frozen=True)
class QuotaDecision:
    """Spec §6.4, evaluated in order: quota before concurrency. server_wide
    distinguishes the two 429 flavors — only the per-user one gets the
    backpressure pause (spec §6.6)."""

    kind: Literal["admitted", "quota_exhausted", "concurrency_rejected"]
    reservation_id: int | None = None
    server_wide: bool = False
    retry_after: int = RETRY_AFTER_SECONDS


def _utc_now() -> datetime:
    return datetime.now(UTC)


class UsageStore:
    def __init__(self, db_path: Path, *, timeout: float | None = None) -> None:
        self.db_path = db_path
        self.timeout = timeout
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with connect(db_path, timeout=timeout) as conn:
            conn.executescript(_SCHEMA)

    def _raw_connect(self) -> sqlite3.Connection:
        """reserve_llm_run only: it needs explicit commit/rollback on every
        branch, which _sqlite.connect's auto-committing context manager
        would fight. The caller closes in a finally. Every other method
        uses _sqlite.connect, which commits AND closes — sqlite3's own
        context manager only ends the transaction, so `with
        sqlite3.connect(...)` would leak a connection per call (used_today
        runs on every /api/auth/me)."""
        conn = (
            sqlite3.connect(self.db_path)
            if self.timeout is None
            else sqlite3.connect(self.db_path, timeout=self.timeout)
        )
        conn.row_factory = sqlite3.Row
        return conn

    def reserve_llm_run(
        self,
        user: MeteredUser,
        limits: TierLimitsSettings,
        server_limits: LimitsSettings,
        requested: RequestedLLM,
        effective: EffectiveSelection,
        text_chars: int,
        source: str,
        run_id: str,
        *,
        now: datetime | None = None,
    ) -> QuotaDecision:
        """One SQLite transaction (spec §6.4/§6.6): staleness sweep, INSERT
        the reservation row, then counts *including that row*; commit iff all
        three conditions hold, else roll back. Insert-first is what makes
        this TOCTOU-safe on a plain SQLite file — the INSERT takes the write
        lock before any count runs, so concurrent reservations serialize.
        Never reorder into count-then-insert.
        """
        moment = now or _utc_now()
        day = moment.strftime("%Y-%m-%d")
        cutoff = (moment - timedelta(seconds=server_limits.llm_run_max_age)).isoformat(
            timespec="seconds"
        )
        conn = self._raw_connect()
        try:
            # The transaction begins with the staleness fallback (spec §6.6):
            # the counts below are then already clean, and no separate
            # scheduler is needed. Staleness is measured on created_at,
            # never day.
            conn.execute(
                "UPDATE llm_usage SET status = 'abandoned'"
                " WHERE status = 'started' AND created_at < ?",
                (cutoff,),
            )
            cursor = conn.execute(
                """INSERT INTO llm_usage (user_id, day, created_at, status,
                       llm_tier, provider, model, requested_tier,
                       requested_provider, requested_model, text_chars,
                       source, run_id)
                   VALUES (?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                ),
            )
            reservation_id = cursor.lastrowid
            (day_count,) = conn.execute(
                "SELECT COUNT(*) FROM llm_usage WHERE user_id = ? AND day = ?",
                (user.id, day),
            ).fetchone()
            if day_count > limits.llm_checks_per_day:
                conn.rollback()
                if user.is_admin:
                    # Routine for a normal user; for an admin at a generous
                    # ceiling it means a runaway loop or a compromised
                    # account (spec §6.4).
                    logger.warning(
                        "admin user %s hit the llm_checks_per_day ceiling"
                        " (%s runs today)",
                        user.id,
                        day_count,
                    )
                return QuotaDecision(kind="quota_exhausted")
            (user_in_flight,) = conn.execute(
                "SELECT COUNT(*) FROM llm_usage"
                " WHERE status = 'started' AND user_id = ?",
                (user.id,),
            ).fetchone()
            if user_in_flight > limits.concurrent_llm_runs:
                conn.rollback()
                return QuotaDecision(kind="concurrency_rejected")
            (server_in_flight,) = conn.execute(
                "SELECT COUNT(*) FROM llm_usage WHERE status = 'started'"
            ).fetchone()
            if server_in_flight > server_limits.max_concurrent_llm_runs:
                conn.rollback()
                return QuotaDecision(kind="concurrency_rejected", server_wide=True)
            conn.commit()
            assert reservation_id is not None
            return QuotaDecision(kind="admitted", reservation_id=reservation_id)
        finally:
            conn.close()

    def finish_run(
        self,
        reservation_id: int,
        status: str,
        *,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
    ) -> None:
        """Terminal write — conditional on the row still being 'started'
        (spec §6.6): a swept row's slot is already gone, so it is warned
        about, never resurrected. Callers run this in a finally block."""
        with connect(self.db_path, timeout=self.timeout) as conn:
            cursor = conn.execute(
                """UPDATE llm_usage
                   SET status = ?, input_tokens = ?, output_tokens = ?
                   WHERE id = ? AND status = 'started'""",
                (status, input_tokens, output_tokens, reservation_id),
            )
            if cursor.rowcount == 0:
                logger.warning(
                    "llm_usage row %s was already swept; terminal status %r"
                    " discarded",
                    reservation_id,
                    status,
                )

    def used_today(self, user_id: int, *, now: datetime | None = None) -> int:
        """Spec §7.1: all of the user's rows for the UTC day regardless of
        status — defined identically to reserve_llm_run's count, so the UI
        and the enforcement can never drift."""
        day = (now or _utc_now()).strftime("%Y-%m-%d")
        with connect(self.db_path, timeout=self.timeout) as conn:
            (count,) = conn.execute(
                "SELECT COUNT(*) FROM llm_usage WHERE user_id = ? AND day = ?",
                (user_id, day),
            ).fetchone()
            return count

    def sweep_all_started(self) -> int:
        """Startup sweep (spec §6.6): in a single-process deployment no
        'started' row can belong to a live run once the process is gone."""
        with connect(self.db_path, timeout=self.timeout) as conn:
            cursor = conn.execute(
                "UPDATE llm_usage SET status = 'abandoned' WHERE status = 'started'"
            )
            return cursor.rowcount
```

Implementation notes for this step:
- `sqlite3.connect` default isolation opens the implicit transaction at the first write (the sweep UPDATE) — sweep, insert and counts share one transaction, and `conn.rollback()` / `conn.commit()` end it explicitly on every path. Do not wrap `reserve_llm_run`'s body in `with conn:` (its auto-commit-on-exit would fight the explicit denial rollbacks).
- Every other method goes through `app.services._sqlite.connect`, which commits and **closes** — no explicit `conn.commit()` inside those blocks, and no leaked connection per `/api/auth/me` call.
- The denial paths roll back the sweep too — deliberate, see Design decision 5.

- [ ] **Step 4: Run the tests**

`uv run pytest tests/test_usage.py -q` — all pass. Full backend suite still green, zero warnings.

- [ ] **Step 5: Mutation-verify the two load-bearing guards**

1. Change `WHERE id = ? AND status = 'started'` to `WHERE id = ?` in `finish_run` → `test_terminal_write_does_not_resurrect_a_swept_row` must fail. Restore.
2. Reorder `reserve_llm_run` to count-then-insert (move the INSERT below the counts, adjust `<` accordingly) → `test_two_simultaneous_reservations_admit_exactly_one` must fail or flake (run it 20×: `uv run pytest tests/test_usage.py::TestConcurrency::test_two_simultaneous_reservations_admit_exactly_one -q --count 20` if pytest-repeat is absent, loop it in the shell). If the race does not reproduce reliably, verify instead that the quota condition uses `>` against the count *including* the inserted row (change `>` to `>=` → `test_admits_exactly_the_limit` fails). Restore.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/usage.py backend/tests/test_usage.py
git commit -m "feat(usage): llm_usage ledger and transactional run reservation (M5)"
```

---

### Task 3: wiring — `limits_for`, `app.state.usage_store`, startup sweep

**Files:**
- Modify: `backend/app/core/permissions.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_permissions.py`, `backend/tests/test_usage.py` (startup-sweep test may live in `tests/test_check_api.py`'s app-factory style instead — put it wherever the existing create_app-with-tmp-Settings helper lives; `tests/conftest.py` has the pattern)

**Interfaces:**
- Produces: `limits_for(*, tier: str, is_admin: bool, settings: Settings) -> TierLimitsSettings` in `app.core.permissions`; `app.state.usage_store: UsageStore`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_permissions.py` (mirror its existing settings-building helpers):

```python
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
```

And the startup-sweep test (place it beside the existing create_app tests; they build `Settings` over `tmp_path`):

```python
def test_startup_sweeps_started_ledger_rows(tmp_path):
    # Build tmp_path-based Settings exactly the way the neighboring
    # create_app tests do (conftest already provides the FW_* env the app
    # factory needs) — the arrange/assert below is the requirement.
    settings = ...
    store = UsageStore(settings.db_path)
    store.reserve_llm_run(  # leaves a 'started' row
        FakeUser(1), TierLimitsSettings(llm_checks_per_day=5,
        max_llm_document_chars=1000, concurrent_llm_runs=5),
        LimitsSettings(), RequestedLLM(tier="cheap"),
        EffectiveSelection(tier="cheap", provider="ollama", model="m",
                           degraded=False),
        1, "check", "orphan",
    )
    create_app(settings)
    with sqlite3.connect(settings.db_path) as conn:
        (status,) = conn.execute(
            "SELECT status FROM llm_usage WHERE run_id = 'orphan'"
        ).fetchone()
    assert status == "abandoned"
```

(Adapt the fixture plumbing to the file's existing style — the assertion and the arrange steps are the requirement; `FakeUser` as in `test_usage.py`.)

- [ ] **Step 2: Run to verify failure** — `limits_for` undefined; no `usage_store`/sweep on startup.

- [ ] **Step 3: Implement**

`app/core/permissions.py` — add near `features_for` (import `TierLimitsSettings` from `app.core.config`):

```python
def limits_for(*, tier: str, is_admin: bool, settings: Settings) -> TierLimitsSettings:
    """The caller's per-user limits block (spec §6.4): the admin ceiling for
    admins (it REPLACES the tier's block, spec §6.4), the tier's required
    block when configured, and the generous admin defaults otherwise — which
    covers the no-tiers-configured inert mode, and the unknown-tier case
    that can only ever feed the /me display (an unknown tier's policy is
    NO_LLM_POLICY, so resolution floors out before any reservation)."""
    if is_admin or not settings.tiers:
        return settings.limits.admin
    cfg = _tier_config(tier, settings)
    if cfg is None:
        return settings.limits.admin
    return cfg.limits
```

`app/main.py` — in `create_app`, next to the other store constructions:

```python
    app.state.usage_store = UsageStore(settings.db_path)
```

and after `seed_admin(...)`, before the global seeders (spec §9 ordering: migrations → admin bootstrap → sweep → seeders):

```python
    # Startup sweep (spec §6.6): single-process deployment — no 'started'
    # row can belong to a live run of a process that no longer exists.
    app.state.usage_store.sweep_all_started()
```

with `from app.services.usage import UsageStore` in the imports.

- [ ] **Step 4: Run the tests, full suite, zero warnings**

- [ ] **Step 5: Commit**

```bash
git add backend/app/core/permissions.py backend/app/main.py backend/tests/
git commit -m "feat(metering): limits_for resolution and startup usage sweep (M5)"
```

---

### Task 4: the gate reserves — size cap, quota, concurrency, backpressure; checks path

**Files:**
- Modify: `backend/app/api/llm_gate.py`
- Modify: `backend/app/api/checks.py`
- Modify (mechanical signature migration only — Task 5 owns their behavior): `backend/app/api/suggestions.py`, `backend/app/api/documents.py`
- Test: `backend/tests/test_check_api.py`

**Interfaces:**
- Consumes: `UsageStore.reserve_llm_run` / `finish_run`, `QuotaDecision`, `RETRY_AFTER_SECONDS` (Task 2); `limits_for` (Task 3).
- Produces (Tasks 5 uses these verbatim):

```python
@dataclass
class LlmReservation:
    """Handle for the admitted run's ledger row. finish() is safe to call
    from a finally block and idempotent against sweeps (UsageStore warns
    instead of resurrecting)."""
    store: UsageStore
    reservation_id: int

    def finish(self, status: str, *, output_tokens: int | None = None) -> None:
        self.store.finish_run(self.reservation_id, status, output_tokens=output_tokens)


async def get_effective_provider(
    app: FastAPI,
    user: CurrentUser,
    requested: RequestedLLM,
    language: str,
    *,
    text_chars: int,
    source: str,
    run_id: str,
) -> tuple[EffectiveSelection, LLMProvider | None, LlmReservation | None]: ...
```

Return contract: `(selection, None, None)` = LLM phase skipped, `selection.skipped` says why (`document_too_large`, `llm_unavailable`, `quota_exhausted`, or the M4 floor cases); `(selection, provider, reservation)` = admitted — the caller **must** call `reservation.finish(...)` on every exit path. A concurrency rejection never returns: it raises `HTTPException(429, ..., headers={"Retry-After": "5"})`, after a non-blocking `await asyncio.sleep(settings.limits.concurrency_reject_delay)` for the per-user cap only.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_check_api.py`, following its existing app/client fixtures (they build `create_app` over `tmp_path` settings with a `FakeProvider`-style factory; reuse those). Where a test needs tier limits, configure `tiers:` with a `basic` block (and set the test user's tier) or rely on the admin/default path — follow the file's existing M4 tier-test plumbing. The behaviors to pin, each as its own test:

```python
class TestCheckMetering:
    def test_llm_run_writes_a_completed_ledger_row(self, ...):
        # POST a check with the LLM checker on a working fake provider; wait
        # for done (poll GET). Then read llm_usage directly (sqlite3 on the
        # tmp db): exactly one row; status 'completed'; source 'check';
        # run_id == the check_id from the response; text_chars == len(text);
        # output_tokens equals the fake provider's last progress value (or
        # None if the fake reports no progress — use a progress_steps fake
        # and assert the last step landed).
        ...

    def test_provider_failure_writes_a_failed_row(self, ...):
        # Fake provider raising in generate(): job finishes, checker_error
        # emitted (existing behavior), and the ledger row ends 'failed'.
        ...

    def test_quota_exhausted_degrades_with_skip_code(self, ...):
        # llm_checks_per_day=1 for the caller; run one check to completion,
        # then POST another with rules+llm. Assert: 200/202 (not 4xx), rules
        # findings present, effective_llm.skipped == 'quota_exhausted',
        # status 'done' without an LLM phase, and NO second ledger row
        # survives (the denied insert rolled back).
        ...

    def test_document_too_large_skips_llm_only(self, ...):
        # max_llm_document_chars=10 for the caller; text of 50 chars. Rules
        # still run; effective_llm.skipped == 'document_too_large'; no
        # ledger row at all (denied before reservation).
        ...

    def test_size_cap_is_decided_before_resolution(self, ...):
        # The §7.2 ORDER is the contract: a floor-policy user (llm.tiers: []
        # AND llm.providers: [] — resolution alone would say
        # 'llm_unavailable') posting text over max_llm_document_chars must
        # get skipped == 'document_too_large', because the size cap runs
        # first. Moving the size check below resolve_llm_selection flips
        # this test's expected code.
        ...

    def test_skip_reason_reaches_the_sse_stream(self, ...):
        # The effective_llm SSE event (M4) carries the new code: subscribe
        # to /events after the quota-exhausted POST and assert the
        # effective_llm event's skipped field. Mirror the file's existing
        # SSE-reading helper.
        ...

    def test_per_user_concurrency_cap_returns_429_with_retry_after(self, ...):
        # concurrent_llm_runs=1 for the caller; a hanging fake provider
        # (asyncio.Event it never sets) holds one run in flight. A second
        # POST returns 429 and response.headers["Retry-After"] == "5".
        # A DIFFERENT user's check is admitted while the first still hangs.
        # Set concurrency_reject_delay=0 in these settings so the test does
        # not sleep. Release the event afterwards so the task ends cleanly
        # (zero-warnings gate: no pending-task warnings).
        ...

    def test_server_wide_cap_returns_429(self, ...):
        # max_concurrent_llm_runs=1 (config validation requires per-user
        # caps <= server cap, so use concurrent_llm_runs=1 too, two users
        # — and per Task 1's fixture rule, a complete limits.admin block
        # with concurrent_llm_runs=1, or Settings construction fails on the
        # DEFAULT admin ceiling of 5): user A holds the slot, user B gets
        # 429.
        ...

    def test_pause_happens_outside_the_reservation_transaction(self, ...):
        # Spec §10: "happens outside the transaction". concurrent_llm_runs=1
        # and concurrency_reject_delay=1.0; while user A's rejected request
        # is mid-pause, user B's reservation must complete well inside the
        # delay (assert B's POST returns < 0.3s) — a pause inside the
        # transaction would hold the write lock and stall B for the full
        # second.
        ...

    def test_cancelled_llm_run_writes_cancelled_and_frees_the_slot(self, ...):
        # Hanging provider; cancel the job's task (job._task.cancel() via
        # app.state.jobs — or drive it through create_check then cancel);
        # after the task ends, the row is 'cancelled' and a new check for
        # the same user is admitted at concurrent_llm_runs=1.
        ...

    def test_backpressure_pause_does_not_block_the_event_loop(self, ...):
        # concurrency_reject_delay=0.5, concurrent_llm_runs=1, hanging
        # provider holding the slot. Fire 5 concurrent rejected POSTs and,
        # concurrently, one GET /api/health; assert the health call returns
        # well under 0.5s (e.g. < 0.3s measured with time.monotonic around
        # await). Use httpx.AsyncClient(transport=ASGITransport(app=app))
        # and asyncio.gather.
        ...

    def test_server_wide_rejection_skips_the_pause(self, ...):
        # concurrency_reject_delay=1.0; drive a server-wide rejection and
        # assert the 429 arrives in well under 1.0s.
        ...

    def test_admin_is_metered_with_the_admin_ceiling(self, ...):
        # A COMPLETE limits.admin block (all three members — a partial one
        # is a config error) with llm_checks_per_day=1: the admin's first
        # check writes a ledger row; the second degrades with
        # 'quota_exhausted' and logs a WARNING naming the user id (caplog).
        ...
```

Write each as a real test against the file's fixtures — the comments above are the required assertions, not placeholders to keep. Also update every existing `get_effective_provider` call-site expectation in this file that the signature change breaks (the M4 tests assert on the 2-tuple only indirectly through the API, so most should be untouched).

Two plumbing notes for these tests: (1) Task 1's fixture rule applies throughout — a lowered `max_concurrent_llm_runs` needs a complete matching `limits.admin` block. (2) The two async-client tests (`backpressure`, `pause outside transaction`) run over `httpx.AsyncClient(transport=ASGITransport(app=app))`, and `conftest`'s `auth_headers` helper takes a sync `TestClient` — obtain the bearer token with the sync client (or a direct login POST over the async client) before switching to the async transport.

- [ ] **Step 2: Run to verify failure** — new tests fail (`get_effective_provider` lacks the keyword params; no ledger rows are written).

- [ ] **Step 3: Implement the gate**

Rewrite `backend/app/api/llm_gate.py`'s `get_effective_provider` (keep `effective_llm_report` unchanged):

```python
import asyncio
from dataclasses import dataclass, replace

from fastapi import FastAPI, HTTPException

from app.api.deps import CurrentUser
from app.checkers.llm.provider import LLMProvider
from app.core.config import known_provider_names
from app.core.models import EffectiveLlmReport, LlmSelectionInfo
from app.core.permissions import (
    EffectiveSelection,
    RequestedLLM,
    limits_for,
    policy_for,
    resolve_llm_selection,
)
from app.services.usage import UsageStore


@dataclass
class LlmReservation:
    """Handle for an admitted run's ledger row (spec §5.3). finish() runs in
    the caller's finally block; UsageStore keeps it conditional, so a swept
    row is warned about, never resurrected."""

    store: UsageStore
    reservation_id: int

    def finish(self, status: str, *, output_tokens: int | None = None) -> None:
        self.store.finish_run(
            self.reservation_id, status, output_tokens=output_tokens
        )


async def get_effective_provider(
    app: FastAPI,
    user: CurrentUser,
    requested: RequestedLLM,
    language: str,
    *,
    text_chars: int,
    source: str,
    run_id: str,
) -> tuple[EffectiveSelection, LLMProvider | None, LlmReservation | None]:
    """Resolve, construct, and reserve — the M5 order (spec §7.2): size cap
    -> resolve_llm_selection -> provider construction -> reservation. A
    (selection, None, None) return means the LLM phase is skipped and
    selection.skipped says why; an admitted run's reservation MUST be
    finished by the caller on every exit path. Concurrency rejections raise
    the documented 429 instead of returning (spec §6.6)."""
    settings = app.state.settings
    if (
        requested.tier is None
        and requested.provider is not None
        and requested.provider not in known_provider_names(settings.providers)
    ):
        # Direct requests only: with a tier set, provider/model are ignored
        # by contract (RequestedLLM), so an ignored field must not 422.
        raise HTTPException(422, f"Unknown LLM provider: {requested.provider}")
    limits = limits_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    if text_chars > limits.max_llm_document_chars:
        # Spec §6.5: the per-tier cap skips only the LLM phase, before any
        # resolution or spend — characters are the pre-spend token proxy.
        return (
            EffectiveSelection(
                tier=None, provider=None, model=None, degraded=False,
                skipped="document_too_large",
            ),
            None,
            None,
        )
    policy = policy_for(tier=user.tier, is_admin=user.is_admin, settings=settings)
    effective = resolve_llm_selection(policy, requested, language, settings=settings)
    if effective.provider is None:
        return effective, None, None
    try:
        provider = app.state.provider_factory(effective.provider, effective.model)
    except ValueError:
        # The routing table may point a tier at a provider this server has
        # not configured — that is "not configured", not a 500. Constructed
        # before reserving on purpose: a run that cannot even start never
        # consumes quota.
        return replace(effective, skipped="llm_unavailable"), None, None
    decision = app.state.usage_store.reserve_llm_run(
        user, limits, settings.limits, requested, effective,
        text_chars, source, run_id,
    )
    if decision.kind == "quota_exhausted":
        # Degrade, never 429: an exhausted allowance is not retryable until
        # tomorrow (spec §6.4).
        return replace(effective, skipped="quota_exhausted"), None, None
    if decision.kind == "concurrency_rejected":
        if not decision.server_wide:
            # Backpressure (spec §6.6): non-blocking, after the reservation
            # transaction rolled back, small and fixed. Server-wide
            # rejections answer immediately — holding the connection longer
            # would add to exactly the pressure that cap relieves.
            await asyncio.sleep(settings.limits.concurrency_reject_delay)
        raise HTTPException(
            429,
            "Too many concurrent LLM runs; try again shortly.",
            headers={"Retry-After": str(decision.retry_after)},
        )
    assert decision.reservation_id is not None
    return (
        effective,
        provider,
        LlmReservation(app.state.usage_store, decision.reservation_id),
    )
```

- [ ] **Step 4: Update the checks path**

In `backend/app/api/checks.py`:

`create_check`'s LLM branch becomes:

```python
        if "llm" in body.checkers:
            requested = RequestedLLM(
                tier=body.llm_tier, provider=body.llm_provider, model=body.llm_model
            )
            effective, provider, reservation = await get_effective_provider(
                app, user, requested, body.language.value,
                text_chars=len(body.text), source="check", run_id=job.id,
            )
            job.effective_llm = effective_llm_report(requested, effective)
            # On the stream too (spec §6.2): SSE consumers see the same block
            # the POST response carries.
            job.emit("effective_llm", job.effective_llm.model_dump(mode="json"))
            if provider is None:
                job.finish()
            else:
                assert reservation is not None
                job.attach_task(
                    asyncio.create_task(
                        _run_llm(
                            job,
                            provider,
                            body.text,
                            body.language,
                            reservation,
                            vet=app.state.settings.vet_suggestions,
                            dictionaries_dir=app.state.settings.dictionaries_dir,
                            instructions=body.llm_instructions,
                        )
                    )
                )
```

The existing `except Exception: app.state.jobs.discard(job.id); raise` net already covers the gate's 429 (an `HTTPException` is an `Exception`): the job is discarded and the 429 propagates — no reservation exists on that path, so there is nothing to release.

`_run_llm` gains the reservation and the exception-safe terminal write. Full replacement:

```python
async def _run_llm(
    job: CheckJob,
    provider: LLMProvider,
    text: str,
    language: Language,
    reservation: LlmReservation,
    vet: bool = True,
    dictionaries_dir: Any = None,
    instructions: str = "",
) -> None:
    emitted = -PROGRESS_TOKEN_STEP  # the first report always goes out
    latest_tokens = 0

    def on_progress(tokens: int) -> None:
        nonlocal emitted, latest_tokens
        latest_tokens = tokens
        if tokens - emitted >= PROGRESS_TOKEN_STEP:
            emitted = tokens
            job.emit("llm_progress", {"tokens": tokens})

    # The terminal ledger write is the mechanism that releases this run's
    # concurrency slot (spec §5.3), so it must be exception-safe by
    # construction: success, failure and cancellation all pass through the
    # finally below, each with its own status.
    status = "completed"
    try:
        checker = LLMChecker(provider, vet=vet, dictionaries_dir=dictionaries_dir)
        result = await checker.check(
            text, language, on_progress=on_progress, instructions=instructions
        )
        job.add_findings("llm", drop_duplicates(result.findings, job.findings))
        if result.scorecard is not None:
            job.set_scorecard(result.scorecard)
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    except Exception as exc:
        status = "failed"
        error = str(exc) or type(exc).__name__
        logger.warning("llm check failed (provider %s): %s", provider.name, error)
        job.emit("checker_error", {"checker": "llm", "error": error})
    finally:
        reservation.finish(
            status, output_tokens=latest_tokens if latest_tokens > 0 else None
        )
        job.finish()
```

Add `from app.api.llm_gate import LlmReservation, effective_llm_report, get_effective_provider` to the imports.

- [ ] **Step 5: Run the tests**

`uv run pytest tests/test_check_api.py tests/test_usage.py -q`, then the full suite. **Expected fallout:** `tests/test_suggestions_api.py` and `tests/test_documents_api.py` fail at the old 2-tuple call sites in `app/api/suggestions.py` / `documents.py` — un-awaited, the new coroutine raises `TypeError: cannot unpack non-iterable coroutine object` and leaves a `RuntimeWarning: coroutine ... was never awaited`, which the zero-warnings gate turns into a hard failure. To keep this task's commit green, Task 4 includes the *minimal mechanical* signature migration of both call sites (add `await`, the three keyword args with `run_id=str(uuid.uuid4())`, `source="suggestion"`/`"name"`, unpack the 3-tuple, and finish the reservation around the single `provider.generate` call in each — exactly the code Task 5 shows in full). Task 5 then owns the behavior tests and any refinement.

Zero warnings (watch for un-awaited-coroutine warnings from any missed call site — grep: `grep -rn "get_effective_provider" backend/app backend/tests`).

- [ ] **Step 6: Mutation-verify**

1. Replace `await asyncio.sleep(...)` with `time.sleep(...)` in the gate → `test_backpressure_pause_does_not_block_the_event_loop` must fail (the blocking sleep stalls the unrelated health request). Restore.
2. In `_run_llm`, remove the `finally:` reservation.finish (move it to the success path only) → `test_provider_failure_writes_a_failed_row` and `test_cancelled_llm_run_writes_cancelled_and_frees_the_slot` must fail. Restore.
3. Move the `text_chars` size check below `resolve_llm_selection` (returning the resolution's floor result when it already skipped) → `test_size_cap_is_decided_before_resolution` must fail (the floor user's oversized text now reports `llm_unavailable` instead of `document_too_large`). Restore. (Quota-before-concurrency needs no gate-level mutation — the store owns that order and Task 2's `test_quota_outranks_concurrency` pins it.)

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/llm_gate.py backend/app/api/checks.py backend/app/api/suggestions.py backend/app/api/documents.py backend/tests/
git commit -m "feat(gate): size cap, quota reservation and concurrency 429 in the LLM gate (M5)"
```

---

### Task 5: suggestions and naming through the reservation

**Files:**
- Modify: `backend/app/api/suggestions.py`
- Modify: `backend/app/api/documents.py`
- Test: `backend/tests/test_suggestions_api.py`, `backend/tests/test_documents_api.py`

**Interfaces:**
- Consumes: Task 4's gate contract verbatim.

- [ ] **Step 1: Write the failing tests**

`tests/test_suggestions_api.py` additions (reuse its fixtures):

- `test_quota_exhausted_returns_200_with_skip_code`: caller's `llm_checks_per_day=1`, first suggestion completes, second returns 200 with `suggestions == []` and `skipped == "quota_exhausted"` — never 403 (spec §7.2).
- `test_document_too_large_returns_200_with_skip_code`: `max_llm_document_chars` below `len(body.text)` → 200, `skipped == "document_too_large"`, and no ledger row.
- `test_suggestion_writes_a_completed_ledger_row`: admitted run → one row, `source == "suggestion"`, `status == "completed"`, `run_id` a non-empty string, `text_chars == len(body.text)`.
- `test_provider_failure_writes_failed_and_returns_502`: raising fake provider → 502 (existing behavior) and the row ends `"failed"` — a burned run still spends quota.
- `test_concurrency_cap_gives_429`: hanging check run holds the caller's single slot (`concurrent_llm_runs=1`); the suggestion returns 429 with `Retry-After`.

`tests/test_documents_api.py` additions:

- `test_generate_name_writes_a_ledger_row`: admitted naming run → row with `source == "name"`, `status == "completed"`, `requested_tier == "cheap"`.
- `test_generate_name_quota_exhausted_falls_back_silently`: quota spent → 200, document gets the local fallback name (existing `fallback_name` behavior), no error surfaced, no new ledger row.
- `test_generate_name_concurrency_429_propagates`: `concurrent_llm_runs=1`, slot held by a hanging check → generate-name returns **429**, not a silent fallback (spec §7.2: the caps apply to every LLM-invoking endpoint alike).
- `test_generate_name_empty_text_consumes_no_quota`: empty-text document → no ledger row (the M4 guard keeps the gate unreached — this pins it now that reaching the gate costs quota).

- [ ] **Step 2: Run to verify failure** (the behavior ones fail; the mechanical migration from Task 4 already compiles).

- [ ] **Step 3: Implement — suggestions**

In `backend/app/api/suggestions.py`, replace the gate call and the generate block:

```python
    requested = RequestedLLM(
        tier=body.llm_tier, provider=body.llm_provider, model=body.llm_model
    )
    effective, provider, reservation = await get_effective_provider(
        request.app, user, requested, body.language.value,
        text_chars=len(body.text), source="suggestion", run_id=str(uuid.uuid4()),
    )
    if provider is None:
        # Spec §7.2: where the LLM output IS the product, a denial degrades
        # to an empty 200 with a machine-readable reason -- never 403.
        return SuggestionResponse(
            suggestions=[],
            span=SpanRef(start=start, end=end),
            original=original,
            skipped=effective.skipped,
        )
    assert reservation is not None
    # The terminal write releases this run's concurrency slot (spec §5.3):
    # exception-safe by construction, and a failed run still spent quota.
    status = "completed"
    try:
        try:
            response = await provider.generate(system, prompt)
        except Exception as exc:
            status = "failed"
            detail = str(exc) or type(exc).__name__
            raise HTTPException(502, f"LLM request failed: {detail}") from exc
    finally:
        reservation.finish(status)
```

(`import uuid` at the top; the rest of the endpoint is unchanged. Note the 422-on-bad-span and the prompt building stay *above* the gate — they spend nothing.)

A parse failure after a successful generate (`extract_json_array` → 502) stays `"completed"`: the provider ran and was paid; the ledger records runs, not outcomes downstream of the model.

- [ ] **Step 4: Implement — naming**

In `backend/app/api/documents.py` `generate_name`, the guarded block becomes:

```python
    if document.text.strip():
        try:
            # Acquisition sits INSIDE the fallback try: naming is silent-
            # fallback for any failure (spec §7.2), including a provider
            # constructor raising something get_effective_provider does not
            # translate. The one exception (below) is the gate's own
            # HTTPException: the concurrency 429 applies to every
            # LLM-invoking endpoint alike (spec §7.2) and must propagate.
            requested = RequestedLLM(tier="cheap")  # naming hard-selects the cheap route
            _effective, provider, reservation = await get_effective_provider(
                request.app, user, requested, document.language.value,
                text_chars=len(document.text), source="name",
                run_id=str(uuid.uuid4()),
            )
            if provider is not None:
                assert reservation is not None
                status = "completed"
                try:
                    try:
                        system, prompt = build_title_prompt(
                            document.text, document.language
                        )
                        title = clean_title(await provider.generate(system, prompt))
                    except Exception:
                        status = "failed"
                        raise
                finally:
                    reservation.finish(status)
        except HTTPException:
            raise
        except Exception:
            logger.warning(
                "auto-title generation failed for document %s",
                document_id,
                exc_info=True,
            )
            title = None  # silent per spec; the fallback below still applies
```

(`import uuid` at the top.)

- [ ] **Step 5: Run the tests, full suite, zero warnings**

- [ ] **Step 6: Mutation-verify**

1. Remove `except HTTPException: raise` in `generate_name` → `test_generate_name_concurrency_429_propagates` must fail. Restore.
2. In suggestions, move `reservation.finish(status)` inside the `try` (success path only) → `test_provider_failure_writes_failed_and_returns_502` must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/suggestions.py backend/app/api/documents.py backend/tests/
git commit -m "feat(metering): suggestions and naming reserve and settle ledger rows (M5)"
```

---

### Task 6: global size caps — byte-budget middleware and char-level 413s

**Files:**
- Create: `backend/app/api/request_size.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/api/checks.py`, `backend/app/api/documents.py`
- Test: `backend/tests/test_size_limits.py` (new)

**Interfaces:**
- Produces: `RequestSizeLimitMiddleware(app, max_bytes: int)` (pure ASGI) and `byte_budget(max_document_chars: int) -> int` in `app.api.request_size`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_size_limits.py` (reuse the shared app/client fixture pattern; set `limits.max_document_chars` small, e.g. 100, in the test settings so payloads stay tiny):

```python
class TestByteBudget:
    def test_formula(self):
        # Spec §6.5: max(5 MB, 4 × chars + 1 MB) — tuning the char cap can
        # never strand legal payloads behind a stale fixed byte limit.
        assert byte_budget(200000) == 5 * 1024 * 1024
        assert byte_budget(10_000_000) == 4 * 10_000_000 + 1024 * 1024


class TestCharCaps:
    def test_check_text_over_cap_is_413(self, ...):
        # POST /api/checks with 101 chars -> 413; body mentions the limit.

    def test_document_create_over_cap_is_413(self, ...):
    def test_document_save_over_cap_is_413(self, ...):
        # PUT with content.text over the cap -> 413. A save under the cap
        # still works (control).

    def test_oversized_document_stays_loadable(self, ...):
        # Insert a document with text over the cap directly via the store,
        # then GET it -> 200 (the caps gate new saves, never access).


class TestByteMiddleware:
    def test_oversized_content_length_is_rejected_before_parsing(self, ...):
        # Send Content-Length above the budget with a tiny actual body ->
        # 413. (httpx: headers={"Content-Length": str(budget + 1)} with
        # explicit content=b"x" — construct via a raw ASGI call if httpx
        # normalizes the header; asserting on a genuinely huge body is NOT
        # acceptable, the point is rejection before reading.)

    def test_chunked_body_without_content_length_is_capped(self, ...):
        # httpx supports content=iterator -> chunked transfer without
        # Content-Length; stream more than the budget -> 413, and the
        # endpoint handler never ran (use a path that would 404/422 loudly).

    def test_413_carries_cors_headers(self, ...):
        # Send Origin: http://localhost:5173 with the oversized request ->
        # the 413 response includes access-control-allow-origin. This pins
        # the middleware ORDER (CORS outermost, spec §6.5).

    def test_normal_requests_pass_through(self, ...):
        # A regular small POST still works with the middleware installed.
```

(Real tests, not comments — the comments are the required behaviors. For the small default budget: `byte_budget(100)` is still 5 MB, so override the budget in tests by constructing the middleware with a small `max_bytes` directly in a unit-style test *plus* one integration test against the real app where the budget comes from settings — use a large `Content-Length` header for that one, no huge body needed.)

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement the middleware**

`backend/app/api/request_size.py`:

```python
"""Global request-size cap (spec §6.5): a byte budget derived from the char
cap, enforced before parsing and on the bytes actually read — so chunked
requests without a Content-Length cannot bypass it."""


def byte_budget(max_document_chars: int) -> int:
    """max(5 MB, 4 × chars + 1 MB): UTF-8 worst case plus JSON overhead, so
    raising max_document_chars can never strand legal payloads behind a
    stale fixed byte limit (spec §6.5)."""
    return max(5 * 1024 * 1024, 4 * max_document_chars + 1024 * 1024)


class RequestSizeLimitMiddleware:
    """Pure ASGI on purpose: BaseHTTPMiddleware's response buffering would
    fight the SSE stream. Rejects on Content-Length before reading anything,
    and counts the bytes actually received for chunked bodies."""
    def __init__(self, app, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > self.max_bytes:
                    await _send_413(send)
                    return
            except ValueError:
                pass
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise BodyTooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send)
        except BodyTooLarge:
            # Starlette has not started the response yet when a request-body
            # read raises (json parsing happens before any send), so a clean
            # 413 is still possible here.
            await _send_413(send)


class BodyTooLarge(Exception):
    pass


async def _send_413(send) -> None:
    body = b'{"detail":"Request body too large"}'
    await send({
        "type": "http.response.start",
        "status": 413,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})
```

If the chunked test reveals that the exception escapes after a partial response start (it should not — FastAPI parses the body before responding), fall back to tracking a `response_started` flag in a send wrapper and only sending the 413 when nothing was started; note whichever shape shipped in the task report.

- [ ] **Step 4: Wire the middleware and the char caps**

`app/main.py` — **before** the existing `app.add_middleware(CORSMiddleware, ...)` call (Starlette makes the *last-added* middleware outermost; CORS must stay outermost so the 413 is readable by the browser, spec §6.5):

```python
    app.add_middleware(
        RequestSizeLimitMiddleware,
        max_bytes=byte_budget(settings.limits.max_document_chars),
    )
```

with the import `from app.api.request_size import RequestSizeLimitMiddleware, byte_budget`. Add a one-line comment anchoring the ordering constraint.

`app/api/checks.py` `create_check`, first statement (before job creation, so a rejected check leaks nothing):

```python
    if len(body.text) > app.state.settings.limits.max_document_chars:
        raise HTTPException(
            413,
            f"Text exceeds the {app.state.settings.limits.max_document_chars}"
            " character limit",
        )
```

(note: `app = request.app` already exists as the first line — order accordingly).

`app/api/documents.py` — same check at the top of `create_document` (against `body.text`) and inside `update_document` when `body.content is not None` (against `body.content.text`), via one module-level helper:

```python
def _enforce_document_cap(request: Request, text: str) -> None:
    cap = request.app.state.settings.limits.max_document_chars
    if len(text) > cap:
        raise HTTPException(413, f"Text exceeds the {cap} character limit")
```

- [ ] **Step 5: Run the tests, full suite, zero warnings**

- [ ] **Step 6: Mutation-verify**

1. Swap the two `add_middleware` calls (size after CORS) → `test_413_carries_cors_headers` must fail. Restore.
2. Delete the `received > self.max_bytes` raise → `test_chunked_body_without_content_length_is_capped` must fail. Restore.

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/request_size.py backend/app/main.py backend/app/api/checks.py backend/app/api/documents.py backend/tests/test_size_limits.py
git commit -m "feat(limits): global request byte budget and 413 char caps (M5)"
```

---

### Task 7: `/api/auth/me` reports usage and limits

**Files:**
- Modify: `backend/app/api/auth.py`
- Test: `backend/tests/test_auth_api.py`

**Interfaces:**
- Produces (the frontend types in Task 8 mirror these exactly):

```python
class UsagePayload(BaseModel):
    used_today: int
    limit: int          # llm_checks_per_day from the caller's block

class LimitsPayload(BaseModel):
    max_document_chars: int        # global (spec §6.5)
    max_llm_document_chars: int    # caller's block
    concurrent_llm_runs: int       # caller's block

class MeResponse(...):
    ...
    usage: UsagePayload
    limits: LimitsPayload
    allow_additional_admins: bool
```

`MeResponse.from_user(cls, user, settings, *, used_today: int)` — the two callers pass `request.app.state.usage_store.used_today(user.id)`.

- [ ] **Step 1: Write the failing tests**

`tests/test_auth_api.py` additions (reuse its login/client fixtures):

- `test_me_reports_usage_and_limits_shape`: `/me` carries `usage.used_today == 0`, `usage.limit`, all three `limits` fields, and `allow_additional_admins` matching the config (assert both `False` default and a `True`-configured app — two tests or a parametrize).
- `test_used_today_counts_every_status`: write ledger rows for the user directly via `UsageStore` (`completed`, `failed`, and one still-`started`) → `usage.used_today == 3` — defined identically to the reservation's count, no UI/backend drift (spec §7.1).
- `test_admin_sees_the_admin_ceiling`: admin's `usage.limit` and `limits.max_llm_document_chars`/`concurrent_llm_runs` come from `limits.admin`, not any tier block.
- `test_tier_user_sees_their_tier_block`: with a configured `basic` tier, a basic user's `limits`/`usage.limit` mirror that block; `max_document_chars` stays the global value.
- `test_login_response_carries_the_same_fields` (the `LoginResponse.user` path goes through the same `from_user`).
- `test_no_admin_endpoint_can_raise_the_ceiling` (spec §10: "the value comes only from config"): `PATCH /api/admin/users/{id}` with a `limits` key in the body — the extra key must be rejected or ignored (whichever the admin request model does), and a subsequent `/me` for that admin still reports the config ceiling unchanged. Place it in `tests/test_admin_api.py` next to the existing admin-switch tests.

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Implement**

In `app/api/auth.py`: add the two payload models next to `PolicyPayload`, import `limits_for`, extend `MeResponse`:

```python
class UsagePayload(BaseModel):
    """Spec §7.1: used_today is defined identically to reserve_llm_run's
    count — all of the caller's UTC-day rows regardless of status."""

    used_today: int
    limit: int


class LimitsPayload(BaseModel):
    max_document_chars: int
    max_llm_document_chars: int
    concurrent_llm_runs: int
```

```python
class MeResponse(BaseModel):
    """The caller's own account: identity (M1), LLM policy and features
    (M4), quota/size/concurrency limits (M5). The frontend's single source
    of truth for gating."""

    id: int
    email: str
    display_name: str | None = None
    tier: str
    is_admin: bool
    policy: PolicyPayload
    usage: UsagePayload
    limits: LimitsPayload
    # Read-only mirror of the config-only switch (spec §7.1): lets the M6
    # admin view disable a checkbox that would only 403. No endpoint accepts
    # it as input, so reporting it does not weaken the config-only guarantee.
    allow_additional_admins: bool

    @classmethod
    def from_user(
        cls, user: User, settings: Settings, *, used_today: int
    ) -> "MeResponse":
        limits = limits_for(
            tier=user.tier, is_admin=user.is_admin, settings=settings
        )
        return cls(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            tier=user.tier,
            is_admin=user.is_admin,
            policy=_policy_payload(user, settings),
            usage=UsagePayload(
                used_today=used_today, limit=limits.llm_checks_per_day
            ),
            limits=LimitsPayload(
                max_document_chars=settings.limits.max_document_chars,
                max_llm_document_chars=limits.max_llm_document_chars,
                concurrent_llm_runs=limits.concurrent_llm_runs,
            ),
            allow_additional_admins=settings.auth.allow_additional_admins,
        )
```

Update both call sites:

```python
        user=MeResponse.from_user(
            user, app.state.settings,
            used_today=app.state.usage_store.used_today(user.id),
        ),
```

(and analogously in `me`). Sweep for other `from_user` callers: `grep -rn "MeResponse.from_user" backend` — as of M4 there are exactly the two in `auth.py`; fix any test doubles the grep surfaces.

- [ ] **Step 4: Run the tests, full suite, zero warnings**

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/auth.py backend/tests/
git commit -m "feat(auth): /me reports usage, limits and the admin switch (M5)"
```

---

### Task 8: frontend plumbing — types, fixtures, `refreshUser`, skip/429 branches, i18n

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api/client.ts`
- Modify: `frontend/src/auth/session.ts`
- Create: `frontend/src/auth/refreshSlot.ts`, `frontend/src/checking/skipNotice.ts`
- Modify: `frontend/src/checking/controller.ts`, `frontend/src/checking/suggest.ts`
- Modify: `frontend/src/i18n/messages.ts` + all seven catalogs
- Test: `frontend/src/checking/skipNotice.test.ts`, additions to `controller.test.ts`, `suggest.test.ts`; the fixture repair sweep across existing tests

**Interfaces:**
- Consumes: Task 7's payload shapes.
- Produces: `UsagePayload`/`LimitsPayload` types; `MeResponse` with **required** `usage`, `limits`, `allow_additional_admins`; `refreshUser(): Promise<void>` (`auth/session.ts`) reached via `setRefreshUserHandler`/`refreshUserNow` (`auth/refreshSlot.ts`); `skipNoticeText(code: string | null | undefined, user: MeResponse | null, m: Messages): string | null` (`checking/skipNotice.ts`) — Task 9's Sidebar uses it.

- [ ] **Step 1: Types and client**

In `frontend/src/types.ts`, next to `PolicyPayload`:

```ts
/** Mirrors backend UsagePayload (app/api/auth.py). */
export interface UsagePayload {
  used_today: number
  limit: number
}

/** Mirrors backend LimitsPayload (app/api/auth.py). */
export interface LimitsPayload {
  max_document_chars: number
  max_llm_document_chars: number
  concurrent_llm_runs: number
}
```

In `frontend/src/api/client.ts`, extend `MeResponse` (all three **required** — the M4 convention: a stale fixture must fail the type check, never read as unrestricted):

```ts
export interface MeResponse {
  id: number
  email: string
  display_name: string | null
  tier: string
  is_admin: boolean
  policy: PolicyPayload
  usage: UsagePayload
  limits: LimitsPayload
  allow_additional_admins: boolean
}
```

(add `UsagePayload, LimitsPayload` to the type import; update the doc comment to say M5 delivered the promised extension).

- [ ] **Step 2: Fixture repair sweep**

`npm run build` (which runs `tsc -b`) now fails on every `MeResponse` fixture. Sweep: `grep -rln "MeResponse" frontend/src` (broader than grepping for `policy: {` — `TerminologyView.features.test.tsx` builds its fixture via `MeResponse['policy']` and would slip through the narrower pattern) — every hit that builds a user object gains, verbatim:

```ts
  usage: { used_today: 0, limit: 500 },
  limits: {
    max_document_chars: 200000,
    max_llm_document_chars: 200000,
    concurrent_llm_runs: 5,
  },
  allow_additional_admins: false,
```

Expected hit list (M4's fixture set — verify with the grep, don't trust this list over it): `state/store.test.ts`, `auth/session.test.ts`, `auth/session.integration.test.ts`, `auth/LoginGate.test.tsx`, `auth/AccountMenu.test.tsx`, `auth/policy.test.ts`, `api/client.test.ts`, `api/sse.test.ts`, `App.test.tsx`, `App.domains-guard.test.tsx`, `checking/controller.test.ts`, `checking/suggest.test.ts`, `checking/routing.test.ts`, `checking/model.test.ts`, `documents/documents.test.ts`, `documents/autosave.test.ts`, `documents/FolderDefaultsDialog.policy.test.tsx`, `header/ProfileSelector.test.tsx`, `header/LlmSelector.test.tsx`, `profiles/*.test.*`, `terminology/*.test.*`, `rules/RulesView.ownership.test.tsx`, `sidebar/Sidebar.notes.test.tsx`. Where a file has a shared `makeUser`-style helper, patch the helper once. `npx vitest run` and the build must both pass before moving on.

- [ ] **Step 3: i18n keys**

`frontend/src/i18n/messages.ts` — extend the interface next to the existing `llmNotIncluded`/`llmSkippedServer` block:

```ts
  serverBusy: string
  llmQuotaExhausted: (limit: number) => string
  llmDocumentTooLarge: (limit: number) => string
  quotaIndicatorTitle: string
  charCount: (n: number) => string
  charCountOverLlm: string
  charCountOverDoc: string
```

Catalog values (place beside the existing LLM-note keys; keep each file's formatting):

`en.ts`:
```ts
  serverBusy: 'Server busy — please retry shortly.',
  llmQuotaExhausted: (limit) =>
    `Daily LLM allowance used (${limit} checks). Resets at midnight UTC.`,
  llmDocumentTooLarge: (limit) =>
    `The text exceeds the plan's LLM limit of ${limit.toLocaleString('en-US')} characters.`,
  quotaIndicatorTitle: 'LLM checks used today',
  charCount: (n) => `${n.toLocaleString('en-US')} characters`,
  charCountOverLlm: 'over the LLM limit',
  charCountOverDoc: 'over the document limit',
```

`de.ts`:
```ts
  serverBusy: 'Server ausgelastet — bitte gleich erneut versuchen.',
  llmQuotaExhausted: (limit) =>
    `Tageskontingent für LLM-Prüfungen aufgebraucht (${limit}). Zurücksetzung um Mitternacht (UTC).`,
  llmDocumentTooLarge: (limit) =>
    `Der Text überschreitet das LLM-Limit von ${limit.toLocaleString('de-DE')} Zeichen.`,
  quotaIndicatorTitle: 'Heute genutzte LLM-Prüfungen',
  charCount: (n) => `${n.toLocaleString('de-DE')} Zeichen`,
  charCountOverLlm: 'über dem LLM-Limit',
  charCountOverDoc: 'über dem Dokumentlimit',
```

`fr.ts`:
```ts
  serverBusy: 'Serveur occupé — veuillez réessayer dans un instant.',
  llmQuotaExhausted: (limit) =>
    `Quota quotidien de vérifications LLM épuisé (${limit}). Réinitialisation à minuit (UTC).`,
  llmDocumentTooLarge: (limit) =>
    `Le texte dépasse la limite LLM de ${limit.toLocaleString('fr-FR')} caractères.`,
  quotaIndicatorTitle: 'Vérifications LLM utilisées aujourd’hui',
  charCount: (n) => `${n.toLocaleString('fr-FR')} caractères`,
  charCountOverLlm: 'au-delà de la limite LLM',
  charCountOverDoc: 'au-delà de la limite du document',
```

`es.ts`:
```ts
  serverBusy: 'Servidor ocupado; vuelva a intentarlo en unos instantes.',
  llmQuotaExhausted: (limit) =>
    `Cuota diaria de comprobaciones LLM agotada (${limit}). Se restablece a medianoche (UTC).`,
  llmDocumentTooLarge: (limit) =>
    `El texto supera el límite LLM de ${limit.toLocaleString('es-ES')} caracteres.`,
  quotaIndicatorTitle: 'Comprobaciones LLM utilizadas hoy',
  charCount: (n) => `${n.toLocaleString('es-ES')} caracteres`,
  charCountOverLlm: 'por encima del límite LLM',
  charCountOverDoc: 'por encima del límite del documento',
```

`it.ts`:
```ts
  serverBusy: 'Server occupato: riprovare tra poco.',
  llmQuotaExhausted: (limit) =>
    `Quota giornaliera di controlli LLM esaurita (${limit}). Si azzera a mezzanotte (UTC).`,
  llmDocumentTooLarge: (limit) =>
    `Il testo supera il limite LLM di ${limit.toLocaleString('it-IT')} caratteri.`,
  quotaIndicatorTitle: 'Controlli LLM utilizzati oggi',
  charCount: (n) => `${n.toLocaleString('it-IT')} caratteri`,
  charCountOverLlm: 'oltre il limite LLM',
  charCountOverDoc: 'oltre il limite del documento',
```

`ja.ts`:
```ts
  serverBusy: 'サーバーが混み合っています。しばらくしてから再試行してください。',
  llmQuotaExhausted: (limit) =>
    `本日のLLMチェック上限（${limit}回）に達しました。UTCの午前0時にリセットされます。`,
  llmDocumentTooLarge: (limit) =>
    `テキストがプランのLLM上限（${limit.toLocaleString('ja-JP')}文字）を超えています。`,
  quotaIndicatorTitle: '本日使用したLLMチェック数',
  charCount: (n) => `${n.toLocaleString('ja-JP')}文字`,
  charCountOverLlm: 'LLM上限超過',
  charCountOverDoc: '文書上限超過',
```

`zh.ts`:
```ts
  serverBusy: '服务器繁忙，请稍后重试。',
  llmQuotaExhausted: (limit) =>
    `今日 LLM 检查额度已用完（${limit} 次），将于 UTC 午夜重置。`,
  llmDocumentTooLarge: (limit) =>
    `文本超出套餐的 LLM 上限（${limit.toLocaleString('zh-CN')} 个字符）。`,
  quotaIndicatorTitle: '今日已用 LLM 检查次数',
  charCount: (n) => `${n.toLocaleString('zh-CN')} 个字符`,
  charCountOverLlm: '超出 LLM 上限',
  charCountOverDoc: '超出文档上限',
```

The build fails until all seven carry all seven keys — that is the completeness check.

- [ ] **Step 4: `skipNoticeText` (TDD)**

Failing test first, `frontend/src/checking/skipNotice.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { en as messages } from '../i18n/en'
import { skipNoticeText } from './skipNotice'

const user = (over: object) => ({
  id: 1, email: 'u@example.com', display_name: null, tier: 'basic',
  is_admin: false,
  policy: { llm: { tiers: null, providers: null, models: null }, features: [] },
  usage: { used_today: 20, limit: 20 },
  limits: { max_document_chars: 200000, max_llm_document_chars: 20000,
            concurrent_llm_runs: 3 },
  allow_additional_admins: false,
  ...over,
})

describe('skipNoticeText', () => {
  it('maps quota_exhausted with the caller limit', () => {
    expect(skipNoticeText('quota_exhausted', user({}), messages)).toBe(
      messages.llmQuotaExhausted(20),
    )
  })
  it('maps document_too_large with the LLM char limit', () => {
    expect(skipNoticeText('document_too_large', user({}), messages)).toBe(
      messages.llmDocumentTooLarge(20000),
    )
  })
  it('splits llm_unavailable into floor vs server copy', () => {
    const floored = user({
      policy: { llm: { tiers: [], providers: [], models: null }, features: [] },
    })
    expect(skipNoticeText('llm_unavailable', floored, messages)).toBe(
      messages.llmNotIncluded,
    )
    expect(skipNoticeText('llm_unavailable', user({}), messages)).toBe(
      messages.llmSkippedServer,
    )
  })
  it('returns null for no skip and unknown codes', () => {
    expect(skipNoticeText(null, user({}), messages)).toBeNull()
    expect(skipNoticeText('mystery', user({}), messages)).toBeNull()
  })
})
```

Run, watch fail, then implement `frontend/src/checking/skipNotice.ts`:

```ts
import type { MeResponse } from '../api/client'
import { llmDisabled } from '../auth/policy'
import type { Messages } from '../i18n/messages'

/**
 * One home for skip-code copy (spec §7.2's shared vocabulary): the sidebar
 * notes and the suggestion/rewrite errors must never drift apart. The
 * numbers come from /me — the report itself carries only the code.
 */
export function skipNoticeText(
  code: string | null | undefined,
  user: MeResponse | null,
  m: Messages,
): string | null {
  switch (code) {
    case 'quota_exhausted':
      return m.llmQuotaExhausted(user?.usage.limit ?? 0)
    case 'document_too_large':
      return m.llmDocumentTooLarge(user?.limits.max_llm_document_chars ?? 0)
    case 'llm_unavailable':
      return llmDisabled(user) ? m.llmNotIncluded : m.llmSkippedServer
    default:
      return null
  }
}
```

(The en catalog exports `en`; verify the `Messages` interface name against `i18n/messages.ts` before writing the helper.)

- [ ] **Step 5: `refreshUser` in `auth/session.ts`, reached through a leaf slot**

**`checking/*.ts` must NOT import `auth/session.ts`.** The repo has already diagnosed that edge as a crash, not a style issue: `checking/cancelSlot.ts`'s header comment documents the cycle `controller → session → documents → hydration → controller` (session.ts imports from documents.ts, documents.ts → hydration.ts, hydration.ts imports `cancelCheck` from controller.ts) — whichever module the graph enters second finds the other's binding in its temporal dead zone. `refreshUser` therefore mirrors the existing `cancelSlot` pattern exactly, in the opposite direction.

Create `frontend/src/auth/refreshSlot.ts` (leaf module — imports nothing from the app):

```ts
/**
 * Registration slot so checking/controller.ts and checking/suggest.ts can
 * trigger a /me re-fetch without importing auth/session.ts — the same
 * cycle-breaking pattern (and the same cycle: controller -> session ->
 * documents -> hydration -> controller) as checking/cancelSlot.ts, which
 * see for the full explanation.
 */
let handler: (() => Promise<void>) | null = null

export function setRefreshUserHandler(fn: () => Promise<void>): void {
  handler = fn
}

export function refreshUserNow(): void {
  void handler?.()
}
```

In `auth/session.ts`, add `refreshUser` and register it at load (next to the existing `setCancelCheckHandler`-style registrations):

```ts
/**
 * Best-effort /me re-fetch so quota display tracks reality after an LLM
 * run. Generation- and token-guarded exactly like runRestore(): a session
 * change mid-flight must drop the response, and any failure leaves the
 * last-known user in place (freshness is cosmetic; the backend enforces).
 */
export async function refreshUser(): Promise<void> {
  const startedAt = generation
  const token = useStore.getState().token
  if (!token) return
  try {
    const user = await getMe()
    if (startedAt !== generation) return
    if (useStore.getState().token !== token) return
    useStore.getState().setAuth(token, user)
  } catch {
    // Cosmetic refresh only — never surface, never clear state (a real 401
    // already went through handleUnauthorized inside request()).
  }
}

setRefreshUserHandler(refreshUser)
```

(import `setRefreshUserHandler` from `./refreshSlot`).

- [ ] **Step 6: controller and suggest branches**

`checking/controller.ts`:
- Import `HttpError` from `../api/client` (safe — client.ts is below the cycle) and `refreshUserNow` from `../auth/refreshSlot`. Never import `../auth/session` here.
- In `runCheck`'s `catch` around `postCheck`, before the generic `llmCheckFailed` state write:

```ts
    if (error instanceof HttpError && error.status === 429) {
      // Transient (spec §8): the server is busy, nothing is wrong with the
      // request — a retry note, not a failure, and never an auth event.
      useStore.setState({
        checkPhase: 'idle',
        llmError: currentMessages().serverBusy,
        llmStartedAt: null,
        llmTokens: null,
      })
      return
    }
```

(after the existing staleness guard, so a stale 429 still returns silently).
- After an LLM-bearing check concludes, refresh the quota display: in `onDone`, alongside the existing state write, add `refreshUserNow()`; and in the early branch `if (!wantLlm || result.status === 'done')`, when `wantLlm` is true add `refreshUserNow()` before returning (a skipped LLM phase may still have written no row — the refresh is cheap and self-correcting either way).

`checking/suggest.ts`:
- Replace both `result.skipped` branches' inline ternary with the shared helper:

```ts
      if (result.skipped) {
        useStore.getState().setSuggestError(
          findingId,
          skipNoticeText(result.skipped, useStore.getState().user,
            currentMessages()) ?? currentMessages().llmSkippedServer,
        )
        return
      }
```

(and the `setRewriteError` twin).
- In both `catch` blocks, before the generic message: `error instanceof HttpError && error.status === 429` → set the respective error to `currentMessages().serverBusy`.
- After a non-skipped result lands (both functions), `refreshUserNow()` (imported from `../auth/refreshSlot` — same cycle rule as controller.ts).

- [ ] **Step 7: Tests for the new branches**

`controller.test.ts`: a `postCheck` mock rejecting with `new HttpError(429, '...')` → `llmError === messages.serverBusy`, `checkPhase === 'idle'`, and auth state untouched. `suggest.test.ts`: `skipped: 'quota_exhausted'` response → `setSuggestError` got `messages.llmQuotaExhausted(<fixture limit>)`; a 429 rejection → `messages.serverBusy`. Follow each file's existing mocking style.

- [ ] **Step 8: Gates**

From `frontend/`: `npx vitest run && npm run lint && npm run build` — all green. (If the rtk-wrapped `npm run lint` output looks garbled, verify with `npx oxlint` directly.)

- [ ] **Step 9: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): usage payloads, skip-code notices and 429 handling (M5)"
```

---

### Task 9: frontend surfaces — sidebar notes, quota indicator, character count

**Files:**
- Modify: `frontend/src/sidebar/Sidebar.tsx`, `frontend/src/App.tsx`, `frontend/src/state/store.ts`, `frontend/src/editor/Editor.tsx`, `frontend/src/App.css`
- Test: `frontend/src/sidebar/Sidebar.notes.test.tsx` (skip notes AND the char count — its fixtures already set `user` and store state), `frontend/src/App.test.tsx` (or a focused new `App.quota.test.tsx` if `App.test.tsx` is unwieldy — match the repo's granularity) for the quota indicator

- [ ] **Step 1: Sidebar skip notes (TDD)**

Failing tests first, in `sidebar/Sidebar.notes.test.tsx` (extend its existing fixture plumbing; its user fixtures got `usage`/`limits` in Task 8):

- `quota_exhausted` skip → note text `messages.llmQuotaExhausted(<fixture limit>)`, rendered with `role="status"`.
- `document_too_large` skip → `messages.llmDocumentTooLarge(<fixture max_llm_document_chars>)`, `role="status"`.
- Existing `llm_unavailable` cases keep passing unchanged.

Then in `Sidebar.tsx`, replace the hardcoded `llm_unavailable` note with the shared helper (keep the degraded note as-is — `degraded && !skipped` semantics unchanged):

```tsx
      {llmEffective?.skipped &&
        skipNoticeText(llmEffective.skipped, user, m) && (
          <div className="llm-note" role="status">
            {skipNoticeText(llmEffective.skipped, user, m)}
          </div>
        )}
```

(bind the helper result to a local to avoid the double call; import from `../checking/skipNotice`).

Mutation-verify: remove `role="status"` → the two new tests and the M4 ones fail; restore.

- [ ] **Step 2: Character count state**

`state/store.ts`: add transient `docChars: number` (initial `0`) + `setDocChars(docChars: number)` next to `docWords`/`setDocWords`, same non-persisted slice.

`editor/Editor.tsx`: in the existing `updateListener` `docChanged` branch, alongside `setDocWords`: `store.setDocChars(update.state.doc.length)`; and mirror the mount-time initialization line (`useStore.getState().setDocChars(view.state.doc.length)`).

- [ ] **Step 3: Character count display + quota indicator (TDD)**

Failing tests first — quota-indicator cases in `App.test.tsx` (render the app shell with a signed-in fixture user), char-count cases in `Sidebar.notes.test.tsx` (it already renders the Sidebar with a fixture user and store state):

- Quota indicator: visible for a signed-in user showing `0/20`-style text from the fixture's `usage`; carries `title === messages.quotaIndicatorTitle`; **absent** when `llmDisabled(user)` (floor policy) and absent when logged out.
- Char count: with `docChars` between the LLM cap and the global cap, shows `messages.charCount(n)` plus `messages.charCountOverLlm`; above the global cap shows `messages.charCountOverDoc` (and not the LLM suffix — the two thresholds are marked *distinctly*, spec §8); below both, no suffix. Note the fixture: Task 8's sweep block sets BOTH caps to 200000, leaving no between-the-caps range — these tests override `limits.max_llm_document_chars` to e.g. 20000, which means widening `Sidebar.notes.test.tsx`'s user-fixture helper to accept overrides (`Partial<MeResponse>`-style) if it does not already.

Implementation:

`App.tsx` — next to `<LlmSelector />` in `header-controls` (only when the LLM controls themselves render — follow the existing floor-hiding pattern around them, which reads the user as `store.user`; keep that accessor):

```tsx
        {store.user && !llmDisabled(store.user) && (
          <span className="quota-indicator" title={m.quotaIndicatorTitle}>
            {store.user.usage.used_today}/{store.user.usage.limit}
          </span>
        )}
```

`Sidebar.tsx` — a char-count line near the existing status area (above the notes), reading `docChars` and the caps from the store user:

```tsx
      <div
        className={
          'char-count' +
          (overDoc ? ' char-count--over-doc' : overLlm ? ' char-count--over-llm' : '')
        }
      >
        {m.charCount(docChars)}
        {overDoc ? ` — ${m.charCountOverDoc}` : overLlm ? ` — ${m.charCountOverLlm}` : ''}
      </div>
```

with

```tsx
  const docChars = useStore((s) => s.docChars)
  const overLlm =
    user != null && docChars > user.limits.max_llm_document_chars
  const overDoc = user != null && docChars > user.limits.max_document_chars
```

`App.css`: `.quota-indicator` (muted, small, tabular-nums), `.char-count` (muted small), `.char-count--over-llm` (warning color used by existing notes), `.char-count--over-doc` (error color) — reuse the existing note/status color variables rather than new hexes.

- [ ] **Step 4: Gates**

`npx vitest run && npm run lint && npm run build` — green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): quota indicator, char-count thresholds and skip notes (M5)"
```

---

### Task 10: documentation, invariants, logbook

**Files:**
- Modify: `docs/backend-architecture.md`, `docs/frontend-architecture.md`
- Modify: `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md` (Cross-milestone interfaces, as-built)
- Modify: `docs/LOGBOOK.md`

- [ ] **Step 1: Invariant re-checks (no code changes expected)**

- One gate: `grep -rn "provider_factory" backend/app --include='*.py'` → only `app/main.py` and `app/api/llm_gate.py`.
- Every gate caller finishes its reservation: `grep -rn "get_effective_provider" backend/app --include='*.py'` → each call site's surrounding code has a `finally`-reachable `reservation.finish(...)` (checks `_run_llm`, suggestions, naming).
- No route imports `UsageStore` for its own counting: `grep -rn "usage_store" backend/app --include='*.py'` → `main.py` (construction + sweep), `llm_gate.py` (reserve), `auth.py` (`used_today`) only.
- Frontend gating source: `grep -rn "allowed" frontend/src --include='*.tsx' | grep -v '\.test\.'` → no component reads API `allowed` flags (M4 invariant, unchanged; test files legitimately mention the flags).

Any violation is a defect to fix in the offending task's file before this task proceeds.

- [ ] **Step 2: `docs/backend-architecture.md`**

Add an M5 section covering, factually and briefly: the `llm_usage` schema and its two indexes; the reservation transaction (insert-first, three conditions, evaluation order) and both sweeps; the gate's M5 order (422 → size cap → resolve → construct → reserve) and the three skip codes; the 429/backpressure rules (non-blocking, post-rollback, per-user only); the byte-budget middleware and its ordering constraint relative to CORS; `/me`'s `usage`/`limits`/`allow_additional_admins`; `limits_for`'s fallback rule. Update any M4-era sentence that said "M5 will…".

- [ ] **Step 3: `docs/frontend-architecture.md`**

Document: `MeResponse.usage`/`limits` as the display source; `skipNoticeText` as the one home for skip copy; `refreshUser()` and its call sites; the 429 transient notice; the quota indicator and char-count thresholds.

- [ ] **Step 4: Roadmap as-built interfaces**

In the Cross-milestone interfaces section, replace the M5 forward declaration with the as-built signatures: `UsageStore.reserve_llm_run(user, limits, server_limits, requested, effective, text_chars, source, run_id, *, now=None) -> QuotaDecision` (note `MeteredUser` and the test-only `now`), the gate's 3-tuple contract, and `limits_for`. Record the documented deviation from spec §6.4/§6.5: the `effective_llm` report carries the skip *code* only — limit and reset numbers live on `/me` (Design decision 7). Also carry over the corrected frontend gate line (`npm run build` runs `tsc -b`; bare `tsc --noEmit` checks zero files in this workspace layout). Mark the M5 row's deliverables as landed if the table carries such marks for M1–M4 (match the existing style).

- [ ] **Step 5: LOGBOOK entry**

Append the M5 entry per the logbook convention (dated, referencing the **implementation PR number**; if the PR is not yet open when this commit is made, the SDD controller fills the number at PR-open time — do not guess silently). Include the two operator-facing release notes:
1. A configured `tiers:` block now **requires** a complete `limits:` block per tier — startup aborts otherwise.
2. LLM runs are metered: `llm_usage` table, daily quotas, concurrency caps with 429, size caps with 413 — defaults are inert (500/day, 200k chars, 5 concurrent per user, 20 server-wide).

- [ ] **Step 6: Full gates, both sides, and commit**

Backend `uv run pytest -q` (zero warnings) and frontend `npx vitest run && npm run lint && npm run build`.

```bash
git add docs/
git commit -m "docs: M5 metering architecture notes, roadmap as-built, logbook"
```

---

## Self-review (performed while writing; recorded for the reviewer)

1. **Spec coverage.** §5.3 ledger → Task 2 (schema verbatim, CHECK, both indexes, NULL-token semantics). §6.1 limits config + validation → Task 1 (incl. delay range, partial-admin, cap cross-checks, required tier limits). §6.4 → Tasks 2/4 (insert-first, count-including-row, quota-before-concurrency, admin ceiling + WARNING, degrade-not-429). §6.5 → Tasks 4 (per-tier skip) and 6 (413, byte budget, chunked, CORS-outermost, oversized-stays-loadable). §6.6 → Tasks 2/4 (both caps, never-day-scoped in-flight, both sweeps, conditional terminal writes, backpressure's three binding constraints, server-wide-skips-pause). §7.1 `/me` → Task 7 (incl. `allow_additional_admins`, used_today definition parity). §7.2 → Tasks 4/5 (gate order, suggestions 200-degradation, naming silent fallback + 429 passthrough). §8 → Tasks 8/9 (429 transient + never clears auth — pinned by existing client behavior + new test, quota indicator, char-count dual thresholds, skip notices). §10's M5 bullets are distributed across the task test lists; the two-user isolation e2e stays out of scope as in M1–M4 (scratch-stack e2e is run manually per the repo's recipe, not in CI).
2. **Placeholders.** Task 4's test list and parts of Task 6's are specified as required-behavior descriptions against existing fixtures rather than verbatim code — deliberate, because those fixtures' exact helper names live in files this plan does not reproduce; each entry names the exact assertions. No TBDs remain.
3. **Type consistency.** `QuotaDecision.kind` strings match the gate's checks (Tasks 2/4); `LlmReservation.finish(status, *, output_tokens)` matches all three call sites (Tasks 4/5); `UsagePayload`/`LimitsPayload` field names match TS mirrors (Tasks 7/8); `skipNoticeText` signature matches Sidebar/suggest usage (Tasks 8/9); `limits_for` keyword-only shape matches `policy_for`/`features_for` (M4 house style).
4. **Known intentional deviations**, for the reviewer's benefit: reservation handle keys on row id, not run_id (Design decision 3); provider construction precedes reservation (decision 2); naming propagates only HTTPException (decision 6); `parse-failure-after-generate` counts as `completed` (Task 5 note); the `effective_llm` report carries the skip code without the inline limit/reset numbers §6.4/§6.5 describe (decision 7, recorded in the roadmap by Task 10).
5. **Review round 1 (2026-07-27):** Copilot could not review the file (over its per-file size limit — four attempts), so an agent-based consistency review ran instead: 1 Critical (a `checking/* → auth/session.ts` import closing the documented `controller → session → documents → hydration → controller` cycle — fixed with the `auth/refreshSlot.ts` leaf), 3 Important (an unpassable sweep-test fixture; the default `limits.admin.concurrent_llm_runs=5` vs lowered server caps in fixtures; a missing ordering guard for size-cap-before-resolve) and 12 Minor findings — all applied. A scoped re-verification confirmed every fix (arithmetic re-derived) and surfaced three documentation-level minors (refreshSlot in Task 8's Files/Interfaces; the char-count between-the-caps fixture needing a lowered LLM cap; two cosmetic wordings), also applied. Verdict: ready to execute.
