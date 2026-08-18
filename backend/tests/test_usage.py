import logging
import multiprocessing
import sqlite3
import threading
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.core.config import CreditCostSettings, LimitsSettings, ProviderCreditSettings, Settings, TierLimitsSettings
from app.core.permissions import EffectiveSelection, RequestedLLM
from app.main import create_app
from app.services.db.sqlite import SqliteDatabase, connect
from app.services.usage import _FAIL_STAGES, UsageStore


class FakeUser:
    def __init__(self, user_id: int, is_admin: bool = False):
        self.id = user_id
        self.is_admin = is_admin


LIMITS = TierLimitsSettings(
    credits_per_day=1_000_000, max_llm_document_chars=20000, concurrent_llm_runs=2
)
SERVER = LimitsSettings(max_concurrent_llm_runs=4)

REQUESTED = RequestedLLM(tier="balanced")
EFFECTIVE = EffectiveSelection(
    tier="cheap", provider="ollama", model="llama3.1", degraded=True
)


@pytest.fixture
def store(db):
    return UsageStore(db)


def reserve(store, user=None, *, limits=LIMITS, server=SERVER, run_id="run-1",
            text_chars=100, source="check", now=None):
    return store.reserve_llm_run(
        user or FakeUser(1), limits, server, REQUESTED, EFFECTIVE,
        text_chars, source, run_id, now=now,
    )


def rows(store):
    with store.db.connect() as conn:
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
        assert row["credits"] == 19  # estimate for 42 chars (spec B6 §4)

    def test_check_constraint_rejects_unknown_status(self, store):
        # A typo'd terminal status would silently leak a concurrency slot
        # for llm_run_max_age (spec §5.3) — it must fail loudly instead.
        # The CHECK genuinely holds on both backends; psycopg is imported
        # here (not at module level) so the SQLite-only default gate never
        # requires it as a dependency.
        import psycopg

        with store.db.connect() as conn:
            with pytest.raises((sqlite3.IntegrityError, psycopg.errors.CheckViolation)):
                conn.execute(
                    """INSERT INTO llm_usage (user_id, day, created_at, status,
                       provider, model, text_chars, source, run_id)
                       VALUES (1, '2026-07-27', '2026-07-27T00:00:00+00:00',
                               'compelted', 'p', 'm', 1, 'check', 'r')"""
                )


class TestDailyQuota:
    def test_quota_outranks_concurrency(self, store):
        # Both limits exceeded at once -> quota_exhausted, never a 429: an
        # exhausted allowance is not retryable and must not tell the client
        # to retry (spec §6.4 — evaluation order is the contract).
        limits = budget_limits(credits_per_day=2 * 49, concurrent_llm_runs=2)
        reserve(store, limits=limits, run_id="r0")  # started, never finished
        reserve(store, limits=limits, run_id="r1")  # started, never finished
        # Third reservation: day spend 147 > 98 AND in-flight 3 > 2 — both
        # conditions fail, and the quota verdict must win.
        denied = reserve(store, limits=limits, run_id="r2")
        assert denied.kind == "quota_exhausted"

    def test_admin_ceiling_denial_logs_warning(self, store, caplog):
        # A budget the default reserve() text (100 chars -> estimate 49)
        # exactly fills: first admitted, second rejected — any priming loop
        # is dead weight at this budget.
        limits = budget_limits(credits_per_day=49)
        admin = FakeUser(7, is_admin=True)
        assert reserve(store, admin, limits=limits, run_id="a0").kind == "admitted"
        with caplog.at_level(logging.WARNING, logger="app.services.usage"):
            denied = reserve(store, admin, limits=limits, run_id="a1")
        assert denied.kind == "quota_exhausted"
        assert any(
            "exhausted the day credit budget" in r.message and "7" in r.message
            for r in caplog.records
        )

    def test_normal_user_denial_does_not_warn(self, store, caplog):
        limits = budget_limits(credits_per_day=49)
        assert reserve(store, limits=limits, run_id="r0").kind == "admitted"
        with caplog.at_level(logging.WARNING, logger="app.services.usage"):
            denied = reserve(store, limits=limits, run_id="r1")
        assert denied.kind == "quota_exhausted"
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
        store = UsageStore(SqliteDatabase(tmp_path / "usage.db"))  # sqlite-only: relies on SQLite's global writer lock, not the PG advisory lock (see TestPostgresReservationConcurrency for the PG sibling)
        limits = budget_limits(credits_per_day=1)
        # Two racing reservations at 1 credit each: the first to insert sums
        # to 1 (not > 1, admitted); the second sums to 2 (> 1, rejected).
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
        # Abandoned rows still count toward the day budget (spec §4): their
        # admission estimate stands even after the staleness sweep flips
        # their status. Budget 49 == one default-reserve() estimate.
        limits = budget_limits(credits_per_day=49)
        assert reserve(
            store, limits=limits, run_id="stale", now=self.OLD
        ).kind == "admitted"
        # The sweep runs inside this reservation's own transaction (spec
        # §6.6) and abandons "stale" first; its estimate still counts.
        denied = reserve(store, limits=limits, run_id="fresh", now=self.BASE)
        assert denied.kind == "quota_exhausted"

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


def test_startup_sweeps_started_ledger_rows(tmp_path: Path):
    # Build tmp_path-based Settings exactly the way the neighboring
    # create_app tests do (conftest already provides the FW_* env the app
    # factory needs) — the arrange/assert below is the requirement.
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    store = UsageStore(SqliteDatabase(settings.db_path))  # sqlite-only: exercises create_app's SQLite-backed startup sweep via Settings.db_path
    store.reserve_llm_run(  # leaves a 'started' row
        FakeUser(1), TierLimitsSettings(credits_per_day=1_000_000,
        max_llm_document_chars=1000, concurrent_llm_runs=5),
        LimitsSettings(), RequestedLLM(tier="cheap"),
        EffectiveSelection(tier="cheap", provider="ollama", model="m",
                           degraded=False),
        1, "check", "orphan",
    )
    create_app(settings)
    with closing(sqlite3.connect(settings.db_path)) as conn:
        (status,) = conn.execute(
            "SELECT status FROM llm_usage WHERE run_id = 'orphan'"
        ).fetchone()
    assert status == "abandoned"


class TestFailureColumns:
    def test_failed_run_records_stage_and_detail(self, store):
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id,
            "failed",
            fail_stage="provider",
            fail_detail="HTTPStatusError (503): upstream unavailable",
        )
        (row,) = rows(store)
        assert row["status"] == "failed"
        assert row["fail_stage"] == "provider"
        assert row["fail_detail"] == "HTTPStatusError (503): upstream unavailable"

    @pytest.mark.parametrize("status", ["completed", "cancelled"])
    def test_non_failed_status_nulls_stage_and_detail(self, store, status):
        # Guard (spec §4.2): NULL by construction, not caller discipline —
        # a caller passing classification alongside a success must not
        # smuggle it into the row.
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id,
            status,
            fail_stage="provider",
            fail_detail="should be discarded",
        )
        (row,) = rows(store)
        assert row["status"] == status
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None

    def test_finish_run_rejects_unknown_stage_in_code(self, store):
        # Migrated databases have no CHECK constraint on fail_stage; the
        # store itself must refuse a typo'd stage on every database.
        decision = reserve(store)
        with pytest.raises(ValueError, match="unknown fail_stage"):
            store.finish_run(
                decision.reservation_id, "failed",
                fail_stage="parse", fail_detail="typo'd stage",
            )
        (row,) = rows(store)
        assert row["status"] == "started"  # the write never happened

    def test_check_constraint_rejects_unknown_stage(self, store):
        # Same seam-agnostic widening as test_check_constraint_rejects_
        # unknown_status above: the fresh-schema CHECK holds on both
        # backends.
        import psycopg

        with store.db.connect() as conn:
            with pytest.raises((sqlite3.IntegrityError, psycopg.errors.CheckViolation)):
                conn.execute(
                    """INSERT INTO llm_usage (user_id, day, created_at, status,
                       provider, model, text_chars, source, run_id, fail_stage)
                       VALUES (1, '2026-07-29', '2026-07-29T00:00:00+00:00',
                               'failed', 'p', 'm', 1, 'check', 'r', 'parse')"""
                )

    def test_every_fail_stage_is_accepted_end_to_end(self, store):
        # _SCHEMA's CHECK is generated from _FAIL_STAGES (single source, no
        # drift possible) -- exercise every member on a fresh store's real
        # CHECK constraint, not just finish_run's code-level guard.
        for i, stage in enumerate(_FAIL_STAGES):
            decision = reserve(store, run_id=f"run-{stage}-{i}")
            store.finish_run(
                decision.reservation_id, "failed",
                fail_stage=stage, fail_detail="x",
            )
        all_rows = rows(store)
        assert len(all_rows) == len(_FAIL_STAGES)
        assert [row["fail_stage"] for row in all_rows] == list(_FAIL_STAGES)

    def test_migration_adds_columns_to_pre_b5_database(self, tmp_path):
        # A database created before this change lacks both columns; opening
        # it through UsageStore must add them and leave old rows NULL.
        db_path = tmp_path / "old.db"
        with connect(db_path) as conn:
            conn.executescript(_PRE_B5_SCHEMA)
            conn.execute(
                """INSERT INTO llm_usage (user_id, day, created_at, status,
                   provider, model, text_chars, source, run_id)
                   VALUES (1, '2026-07-20', '2026-07-20T00:00:00+00:00',
                           'failed', 'p', 'm', 1, 'check', 'r')"""
            )
        store = UsageStore(SqliteDatabase(db_path))  # sqlite-only: hand-built legacy schema
        (row,) = rows(store)
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None
        assert row["credits"] is None
        # And the migrated store accepts classified writes.
        decision = reserve(store, run_id="r2")
        store.finish_run(
            decision.reservation_id, "failed",
            fail_stage="request", fail_detail="ConnectError: refused",
        )
        assert rows(store)[-1]["fail_stage"] == "request"


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

    def test_cancelled_with_partial_tokens_keeps_the_estimate(self, store):
        # Mid-stream cancellation after some tokens have streamed: client
        # initiated cancel, partial tokens reported, estimate stands.
        decision = reserve(store)
        store.finish_run(
            decision.reservation_id, "cancelled",
            output_tokens=10,
        )
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
        store = UsageStore(store.db, credit_cost=config)
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


def budget_limits(*, concurrent_llm_runs=10, **windows):
    return TierLimitsSettings(
        max_llm_document_chars=20000, concurrent_llm_runs=concurrent_llm_runs,
        **windows,
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

    def test_day_window_resets_at_utc_midnight(self, store):
        # Mirrors the deleted counter-era test_utc_day_rollover_resets_the_
        # count: the enforcement query's day predicate (usage.py) is a
        # separate string from credits_used()'s -- dropping it would still
        # pass every other test in this file (none else spans two UTC
        # days), silently turning the day budget into an all-time one.
        limits = budget_limits(credits_per_day=self.EST)
        day1 = datetime(2026, 7, 27, 23, 59, tzinfo=UTC)
        assert reserve(store, limits=limits, run_id="r1", now=day1).kind == "admitted"
        day2 = day1 + timedelta(minutes=2)
        assert reserve(store, limits=limits, run_id="r2", now=day2).kind == "admitted"

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
        # Same ISO week, a different day: Monday's spend (r2) must still
        # bind on Wednesday. A day-start bug would check only Wednesday's
        # own day and miss it, wrongly admitting past the week budget.
        wednesday = datetime(2026, 7, 29, 12, 30, tzinfo=UTC)
        decision = reserve(store, limits=limits, run_id="r4", now=wednesday)
        assert decision.kind == "quota_exhausted"
        assert decision.exhausted_window == "week"

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
        with store.db.connect() as conn:
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
        # The budget-filling reservation itself must be admitted (spend ==
        # budget, not > budget) -- asserted here so a >= off-by-one is
        # caught on this row too, not only on the zero-cost one below.
        assert reserve(store, limits=limits, run_id="r1", now=self.NOON).kind == "admitted"
        assert reserve(
            store, limits=limits, run_id="r2", source="name", now=self.NOON
        ).kind == "admitted"

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


_PRE_B5_SCHEMA = """
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
    CHECK (status IN ('started','completed','failed','cancelled','abandoned'))
);
"""


def _pg_reservation_worker(dsn: str, run_id: str, barrier, queue) -> None:
    """One racer's whole life cycle, in its own OS process (module level
    so multiprocessing's spawn start method can pickle a reference to it
    and re-import this module in the child — see the class docstring
    below for why a process, not a thread). Reports (kind, reservation_id)
    on the queue; the parent asserts on the aggregate."""
    from app.services.db.postgres import PostgresDatabase
    from app.services.usage import UsageStore

    database = PostgresDatabase(dsn)
    try:
        store = UsageStore(database)  # idempotent open; parent already created the schema
        limits = budget_limits(credits_per_day=1)
        barrier.wait()
        decision = store.reserve_llm_run(
            FakeUser(1), limits, SERVER, REQUESTED, EFFECTIVE,
            1, "check", run_id,
        )
        queue.put((decision.kind, decision.reservation_id))
    finally:
        database.close()  # no dangling pool/thread warnings from the child


class TestPostgresReservationConcurrency:
    def test_concurrent_reservations_admit_exactly_one(self, pg_database):
        """Write-skew regression pin (spec §R4): under READ COMMITTED every
        racing insert-first reservation sees only its own uncommitted row
        (spent = 1, not > 1) and ALL of them pass the budget check — the
        SQLite write lock that made insert-first TOCTOU-safe does not
        exist here. pg_advisory_xact_lock serializes the transactions;
        with it, exactly one of these eight is admitted, deterministically.

        Raced via multiprocessing, not threading: CPython's GIL plus a
        fast loopback Postgres round-trip lets one thread's whole insert-
        then-count-then-commit sequence finish before a second thread's
        Python-level dispatch catches up, so a threading.Thread version of
        this race self-serializes to exactly one admission even with the
        lock removed — silently defeating the mutation contract below. OS
        processes have no such GIL hand-off bias and reliably reproduce
        the write skew (confirmed empirically: see task-3-report.md).

        Mutation contract: with the lock removed this fails on the first
        round with a multi-admission overshoot.
        """
        UsageStore(pg_database)  # creates the schema once; children just reopen it
        # No public accessor for the pool's DSN; the schema-scoped DSN
        # lives on the pool psycopg_pool itself builds, and every child
        # process needs its own connection to that same schema.
        dsn = pg_database._pool.conninfo
        ctx = multiprocessing.get_context("spawn")
        barrier = ctx.Barrier(8)
        queue = ctx.Queue()
        processes = [
            ctx.Process(
                target=_pg_reservation_worker, args=(dsn, f"race{i}", barrier, queue)
            )
            for i in range(8)
        ]
        for p in processes:
            p.start()
        # A worker that dies before its queue.put (or one that just never
        # shows up before the timeout) must not leave the others running:
        # a raise out of the comprehension below would skip the join loop
        # entirely, and the pg_database fixture's teardown drops this
        # schema out from under any still-live child — masking whatever
        # actually failed behind a confusing error from the orphan instead,
        # and potentially hanging CI on process cleanup. `results` stays
        # None until every expected message is in, so the finally clause
        # can tell a real failure (still-alive workers to terminate, then
        # join with a timeout so a stuck child can't hang the test run)
        # from the happy path (every worker already reported in — join
        # blocks briefly for exit, no terminate needed).
        results = None
        try:
            results = [queue.get(timeout=30) for _ in processes]
        finally:
            if results is None:
                for p in processes:
                    if p.is_alive():
                        p.terminate()
                for p in processes:
                    p.join(timeout=10)
            else:
                for p in processes:
                    p.join()
        assert all(p.exitcode == 0 for p in processes), [p.exitcode for p in processes]
        admitted = [kind for kind, _ in results if kind == "admitted"]
        assert len(admitted) == 1, (
            f"budget overshoot: {len(admitted)} admissions against a"
            " one-credit day window"
        )


class TestPostgresCreditsUsedIsolation:
    def test_repeatable_read_pins_one_snapshot_across_windows(
        self, pg_database, monkeypatch
    ):
        """Copilot round 4 (PR #109): credits_used's REPEATABLE READ
        statement (usage.py, `SET TRANSACTION ISOLATION LEVEL REPEATABLE
        READ`) had no observable test -- regressing it to READ COMMITTED
        left every PG variant green.

        Under REPEATABLE READ, the whole multi-window loop reads one
        snapshot, taken on the first data-touching query in the
        transaction (the 'hour' SELECT). A row a second, independent
        connection commits in between the 'hour' and 'week' SELECTs must
        stay invisible to 'week' too, even though 'week's window start is
        earlier and would otherwise include it. Under READ COMMITTED, each
        SELECT takes its own fresh snapshot: 'week' (which runs after the
        commit) would see the injected row while 'hour' (which already ran)
        would not, so the two totals diverge.

        Mutation contract: replacing the SET TRANSACTION ISOLATION LEVEL
        statement with `pass` makes the final assertion fail -- 'week'
        picks up the injected row's 1000 credits, 'hour' does not.
        """
        import psycopg

        import app.services.usage as usage_module

        store = UsageStore(pg_database)
        moment = datetime(2026, 7, 29, 12, 30, tzinfo=UTC)  # Wednesday
        limits = budget_limits(credits_per_day=10_000)
        baseline = reserve(store, limits=limits, run_id="baseline", now=moment)
        assert baseline.kind == "admitted"
        # text_chars=100 default estimate (see TestWindowEnforcement.EST),
        # visible to both windows before either SELECT runs.
        BASELINE_CREDITS = 49

        real_window_start = usage_module._window_start
        calls: list[str] = []
        dsn = pg_database._pool.conninfo

        def spy_window_start(m: datetime, window: str) -> datetime:
            calls.append(window)
            if len(calls) == 2:
                # Second call ('week'): a separate connection commits a new
                # row that falls inside BOTH windows, before this call
                # returns and the 'week' SELECT runs on the store's own
                # (already-snapshotted) transaction.
                with psycopg.connect(dsn, autocommit=True) as injector:
                    injector.execute(
                        """INSERT INTO llm_usage (user_id, day, created_at,
                               status, provider, model, text_chars, source,
                               run_id, credits)
                           VALUES (%s, %s, %s, 'completed', 'ollama', 'm',
                                   5, 'check', 'injected', %s)""",
                        (
                            1,
                            moment.strftime("%Y-%m-%d"),
                            moment.isoformat(timespec="seconds"),
                            1000,
                        ),
                    )
            return real_window_start(m, window)

        monkeypatch.setattr(usage_module, "_window_start", spy_window_start)

        used = store.credits_used(1, ["hour", "week"], now=moment)

        assert calls == ["hour", "week"]
        assert used == {"hour": BASELINE_CREDITS, "week": BASELINE_CREDITS}
