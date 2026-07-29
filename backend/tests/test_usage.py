import logging
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.core.config import LimitsSettings, Settings, TierLimitsSettings
from app.core.permissions import EffectiveSelection, RequestedLLM
from app.main import create_app
from app.services._sqlite import connect
from app.services.usage import _FAIL_STAGES, UsageStore


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


def test_startup_sweeps_started_ledger_rows(tmp_path: Path):
    # Build tmp_path-based Settings exactly the way the neighboring
    # create_app tests do (conftest already provides the FW_* env the app
    # factory needs) — the arrange/assert below is the requirement.
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
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
        with connect(store.db_path) as conn:
            with pytest.raises(sqlite3.IntegrityError):
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
        store = UsageStore(db_path)
        (row,) = rows(store)
        assert row["fail_stage"] is None
        assert row["fail_detail"] is None
        # And the migrated store accepts classified writes.
        decision = reserve(store, run_id="r2")
        store.finish_run(
            decision.reservation_id, "failed",
            fail_stage="request", fail_detail="ConnectError: refused",
        )
        assert rows(store)[-1]["fail_stage"] == "request"


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
