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

from app.core.config import CreditCostSettings, LimitsSettings, TierLimitsSettings
from app.core.permissions import EffectiveSelection, RequestedLLM
from app.services._sqlite import connect, migrate_columns
from app.services.credits import estimate_cost, run_cost

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
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with connect(db_path, timeout=timeout) as conn:
            conn.executescript(_SCHEMA)
            migrate_columns(
                conn,
                "llm_usage",
                [("fail_stage", "TEXT"), ("fail_detail", "TEXT"),
                 ("credits", "INTEGER")],
            )

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
        estimate = estimate_cost(
            source=source, provider=effective.provider or "",
            model=effective.model or "", text_chars=text_chars,
            config=self.credit_cost,
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
