"""The llm_usage ledger and the transactional run reservation (spec §5.3,
§6.4, §6.6).

Record richly, limit simply: every LLM-invoking endpoint writes one row per
run; v1 enforces per-tier credit-window budgets plus two concurrency caps,
but every future limit dimension is computable from this ledger without
schema changes.
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol

from app.core.config import CreditCostSettings, LimitsSettings, TierLimitsSettings
from app.core.permissions import EffectiveSelection, RequestedLLM
from app.services.credits import estimate_cost, run_cost
from app.services.db import Database, Row, migrate_columns

logger = logging.getLogger(__name__)

# Spec §6.6: small and fixed — a longer value would only hold connections
# open against the very pressure the cap relieves.
RETRY_AFTER_SECONDS = 5

# The single source for the fresh-schema CHECK and finish_run's code-level
# enforcement (migrated databases have no CHECK): _SCHEMA interpolates
# _FAIL_STAGE_CHECK below, so the two can never drift apart.
_FAIL_STAGES = ("request", "provider", "response")
_FAIL_STAGE_CHECK = ", ".join(f"'{s}'" for s in _FAIL_STAGES)

_SCHEMA = f"""
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
    fail_stage         TEXT,
    fail_detail        TEXT,
    -- Integer credits (B6): admission estimate while 'started', settled
    -- from actual tokens at finish_run. NULL only on pre-B6 rows.
    credits            INTEGER,
    -- Not decoration: a typo'd terminal status would silently leak a
    -- concurrency slot for llm_run_max_age (spec §5.3).
    CHECK (status IN ('started','completed','failed','cancelled','abandoned')),
    -- Enum guard for fresh databases only; migrated tables rely on the
    -- code-level guarantee (SQLite cannot add a CHECK without a rebuild,
    -- and a bad fail_stage cannot leak a concurrency slot).
    CHECK (fail_stage IN ({_FAIL_STAGE_CHECK}) OR fail_stage IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_day ON llm_usage(user_id, day);
-- The server-wide in-flight count has no user_id predicate; without this
-- partial index it degrades to a full table scan inside the transaction
-- that serializes every user's reservation (spec §5.3).
CREATE INDEX IF NOT EXISTS idx_llm_usage_inflight ON llm_usage(status, created_at)
    WHERE status = 'started';
-- Hour/week/month windows predicate on created_at (B6 spec §3); without
-- this the per-user SUM scans the user's full history inside the
-- serializing reservation transaction.
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_created
    ON llm_usage(user_id, created_at);
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
    # The window whose budget bound (B6 spec §5) -- internal: tests and
    # logs only, never a user-facing number.
    exhausted_window: str | None = None


def _utc_now() -> datetime:
    return datetime.now(UTC)


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


class UsageStore:
    def __init__(
        self,
        db: Database,
        *,
        credit_cost: CreditCostSettings | None = None,
    ) -> None:
        self.db = db
        # Pricing is global and static, unlike per-tier limits -- injected
        # once here so finish_run's signature (and every settle frame that
        # calls it) stays untouched (B6 spec §4).
        self.credit_cost = credit_cost or CreditCostSettings()
        with self.db.connect() as conn:
            conn.executescript(_SCHEMA)
            migrate_columns(
                conn,
                "llm_usage",
                [("fail_stage", "TEXT"), ("fail_detail", "TEXT"),
                 ("credits", "INTEGER")],
            )

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
        estimate = estimate_cost(
            source=source, provider=effective.provider or "",
            model=effective.model or "", text_chars=text_chars,
            config=self.credit_cost,
        )
        conn = self.db.raw_connect()
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
                       source, run_id, credits)
                   VALUES (?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   RETURNING id""",
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
            reservation_id = cursor.fetchone()["id"]
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
        fail_stage: str | None = None,
        fail_detail: str | None = None,
    ) -> None:
        """Terminal write — conditional on the row still being 'started'
        (spec §6.6): a swept row's slot is already gone, so it is warned
        about, never resurrected. Callers run this in a finally block.

        fail_stage/fail_detail land only with status='failed' — nulled here
        by construction, not by caller discipline. The stage enum is
        enforced here in code, not only by the fresh-schema CHECK: migrated
        databases have no CHECK, and a typo'd stage must fail loudly on
        them too. Credits settle here from actual tokens — B6 spec §4."""
        if status != "failed":
            fail_stage = None
            fail_detail = None
        if fail_stage is not None and fail_stage not in _FAIL_STAGES:
            raise ValueError(f"unknown fail_stage: {fail_stage!r}")
        with self.db.connect() as conn:
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

    def _settled_credits(
        self,
        row: Row,
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

    def credits_used(
        self, user_id: int, windows: list[str], *, now: datetime | None = None
    ) -> dict[str, int]:
        """Per-window credit sums over ALL the user's rows in the window,
        regardless of status (B6 spec §3). /me's data source."""
        moment = now or _utc_now()
        used: dict[str, int] = {}
        with self.db.connect() as conn:
            # Plain SELECTs run in sqlite3's autocommit mode (no implicit
            # transaction), so without an explicit BEGIN a reservation or
            # settlement could commit between two of this loop's per-window
            # SELECTs and mix ledger snapshots across windows in one /me
            # payload. BEGIN pins every window's sum to one snapshot; the
            # `connect()` context manager's commit on exit ends it.
            conn.execute("BEGIN")
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

    def sweep_all_started(self) -> int:
        """Startup sweep (spec §6.6): in a single-process deployment no
        'started' row can belong to a live run once the process is gone."""
        with self.db.connect() as conn:
            cursor = conn.execute(
                "UPDATE llm_usage SET status = 'abandoned' WHERE status = 'started'"
            )
            return cursor.rowcount
