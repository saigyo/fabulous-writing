from datetime import UTC, date, datetime

import pytest

from app.services.usage import UsageStore, _utc_now

END = date(2026, 8, 22)

_run_counter = 0


@pytest.fixture
def store(db):
    return UsageStore(db)


def _row(store, *, user_id, day, status="completed", source="check",
         input_tokens=100, output_tokens=40, credits=5):
    global _run_counter
    _run_counter += 1
    run_id = f"run-{_run_counter}"
    with store.db.connect() as conn:
        conn.execute(
            """INSERT INTO llm_usage (user_id, day, created_at, status,
                   provider, model, text_chars, input_tokens, output_tokens,
                   source, run_id, credits)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id,
                day,
                f"{day}T00:00:00+00:00",
                status,
                "p",
                "m",
                0,
                input_tokens,
                output_tokens,
                source,
                run_id,
                credits,
            ),
        )


class TestActivitySeries:
    def test_buckets_and_zero_fill(self, store):
        _row(store, user_id=1, day="2026-08-20")
        _row(store, user_id=1, day="2026-08-20", source="suggestion")
        _row(store, user_id=1, day="2026-08-22")
        s = store.activity_series(1, days=30, end=END)
        assert len(s.days) == 30
        assert s.days[0] == "2026-07-24" and s.days[-1] == "2026-08-22"
        assert all(len(v) == 30 for v in s.runs.values())
        i20 = s.days.index("2026-08-20")
        assert s.runs["check"][i20] == 1
        assert s.runs["suggestion"][i20] == 1
        assert s.runs["check"][s.days.index("2026-08-21")] == 0
        assert s.input_tokens[i20] == 200

    def test_category_split_and_started_excluded(self, store):
        _row(store, user_id=1, day="2026-08-22", source="name")
        _row(store, user_id=1, day="2026-08-22", status="failed",
             source="check", input_tokens=50, output_tokens=None, credits=0)
        _row(store, user_id=1, day="2026-08-22", status="cancelled",
             source="suggestion")
        _row(store, user_id=1, day="2026-08-22", status="abandoned")
        _row(store, user_id=1, day="2026-08-22", status="started")
        s = store.activity_series(1, days=30, end=END)
        last = -1
        assert s.runs["name"][last] == 1
        assert s.runs["failed"][last] == 3     # failed + cancelled + abandoned
        assert s.runs["check"][last] == 0      # the failed check is not an OK check
        # name(100) + failed(50) + cancelled(100) + abandoned(100) = 350.
        # The started row (a further +100) MUST be absent: 450 here means
        # the status filter is gone — this is what mutation 1 flips.
        assert s.input_tokens[last] == 350

    def test_range_edges(self, store):
        _row(store, user_id=1, day="2026-07-24")   # first included day
        _row(store, user_id=1, day="2026-07-23")   # one day too early
        s = store.activity_series(1, days=30, end=END)
        assert s.runs["check"][0] == 1
        assert sum(s.runs["check"]) == 1

    def test_cross_user_isolation_and_all_users(self, store):
        _row(store, user_id=1, day="2026-08-22")
        _row(store, user_id=2, day="2026-08-22")
        s1 = store.activity_series(1, days=30, end=END)
        assert s1.runs["check"][-1] == 1
        s_all = store.activity_series(None, days=30, end=END)
        assert s_all.runs["check"][-1] == 2

    def test_default_end_uses_now(self, store):
        inserted_day = _utc_now().strftime("%Y-%m-%d")
        _row(store, user_id=1, day=inserted_day)
        s = store.activity_series(1, days=30)
        assert s.runs["check"][s.days.index(inserted_day)] == 1


class TestActivityUserTotals:
    def test_totals_and_zero_row_users_omitted(self, store):
        _row(store, user_id=1, day="2026-08-22")
        _row(store, user_id=1, day="2026-08-22", status="failed", credits=0)
        _row(store, user_id=2, day="2026-07-01")   # outside range
        totals = store.activity_user_totals(days=30, end=END)
        assert [t.user_id for t in totals] == [1]
        assert totals[0].runs == 2                 # settled runs incl. failed
        assert totals[0].credits == 5

    def test_started_row_excluded(self, store):
        # Copilot (PR #125): no fixture here previously seeded a 'started'
        # row, so _select_activity_user_totals's `status != 'started'`
        # predicate had no independent guard — dropping it from just that
        # query stayed green (activity_series's own started-exclusion test
        # covers a different query entirely). An in-flight run must not
        # count toward /all's per_user runs or credits.
        _row(store, user_id=1, day="2026-08-22")
        _row(store, user_id=1, day="2026-08-22", status="started",
             input_tokens=999, credits=999)
        totals = store.activity_user_totals(days=30, end=END)
        assert [t.user_id for t in totals] == [1]
        assert totals[0].runs == 1                  # the started row excluded
        assert totals[0].credits == 5                # not 5 + 999


class TestActivityAll:
    def test_single_snapshot_totals_agree_with_series(self, store):
        # Two users, in-range and out-of-range rows for user 2 — the
        # out-of-range row must be excluded from BOTH halves of the
        # returned tuple, or the settled-run sum below silently disagrees.
        _row(store, user_id=1, day="2026-08-22")
        _row(store, user_id=1, day="2026-08-22", source="suggestion")
        _row(store, user_id=2, day="2026-08-22", status="failed", credits=0)
        _row(store, user_id=2, day="2026-07-01")   # outside the 30-day range
        series, totals = store.activity_all(days=30, end=END)
        assert {t.user_id for t in totals} == {1, 2}
        settled_from_series = sum(sum(v) for v in series.runs.values())
        settled_from_totals = sum(t.runs for t in totals)
        assert settled_from_series == settled_from_totals == 3


class TestPostgresActivityAllIsolation:
    def test_repeatable_read_pins_one_snapshot_across_series_and_totals(
        self, pg_database, monkeypatch
    ):
        """Copilot round 3 (PR #125): TestActivityAll above seeds every row
        BEFORE calling activity_all, so it passes even without the
        BEGIN/REPEATABLE READ pinning — it does not guard the snapshot
        itself. This test does, mirroring
        TestPostgresCreditsUsedIsolation's mechanism exactly
        (test_usage.py): a second, independent connection commits a new row
        BETWEEN activity_all's two internal queries (series, then totals),
        landing inside the requested day range. Under REPEATABLE READ, the
        whole transaction reads one snapshot taken on the first
        data-touching query (the series SELECT) — a row committed after
        that point stays invisible to the LATER totals SELECT too, even
        though it runs after the commit. Under READ COMMITTED, the totals
        SELECT (which takes its own fresh snapshot) would see it while the
        already-run series SELECT would not, so the two projections would
        diverge instead of both reflecting the original snapshot.

        Mutation contract: replacing activity_all's SET TRANSACTION
        ISOLATION LEVEL statement with `pass` makes the final assertions
        fail — totals picks up the injected row, series does not.
        """
        import psycopg

        import app.services.usage as usage_module

        store = UsageStore(pg_database)
        moment = datetime(2026, 8, 22, 12, 0, tzinfo=UTC)
        # Baseline row, visible before either internal query runs. Through
        # the seam (store.db.connect()), so '?' — not '%s' — is canonical
        # (PostgresConnection.execute translates it; see db/postgres.py).
        with store.db.connect() as conn:
            conn.execute(
                """INSERT INTO llm_usage (user_id, day, created_at, status,
                       provider, model, text_chars, input_tokens,
                       output_tokens, source, run_id, credits)
                   VALUES (?, ?, ?, 'completed', 'p', 'm', 0, 10, 5,
                           'check', 'baseline', 5)""",
                (1, moment.strftime("%Y-%m-%d"), moment.isoformat(timespec="seconds")),
            )

        real_select_totals = usage_module._select_activity_user_totals
        dsn = pg_database._pool.conninfo

        def spy_select_totals(conn, *, days, end=None):
            # Runs after the series SELECT has already executed (activity_all
            # calls series first) but before the totals SELECT below it —
            # exactly the gap credits_used's spy_window_start exploits
            # between the 'hour' and 'week' SELECTs.
            with psycopg.connect(dsn, autocommit=True) as injector:
                injector.execute(
                    """INSERT INTO llm_usage (user_id, day, created_at,
                           status, provider, model, text_chars,
                           input_tokens, output_tokens, source, run_id,
                           credits)
                       VALUES (%s, %s, %s, 'completed', 'p', 'm', 0, 10, 5,
                               'check', 'injected', 1000)""",
                    (2, moment.strftime("%Y-%m-%d"), moment.isoformat(timespec="seconds")),
                )
            return real_select_totals(conn, days=days, end=end)

        monkeypatch.setattr(usage_module, "_select_activity_user_totals", spy_select_totals)

        series, totals = store.activity_all(days=30, end=moment.date())

        # Both projections must reflect the ORIGINAL (pre-injection)
        # snapshot: the injected user never appears in either.
        assert {t.user_id for t in totals} == {1}
        assert sum(t.credits for t in totals) == 5
        assert sum(series.credits) == 5
