from datetime import date

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
