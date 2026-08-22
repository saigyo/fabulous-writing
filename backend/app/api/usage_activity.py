"""Read-only activity/usage series (B40, #124). Aggregation lives on the
usage store; this router only validates, authorizes, and shapes."""

from datetime import UTC, datetime
from enum import IntEnum

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user, require_admin

router = APIRouter(prefix="/api/usage/activity", tags=["usage"])


class Days(IntEnum):
    """Allowed range values. NOT a Literal[30, 90, 365]: FastAPI query
    values arrive as strings and pydantic does not coerce "30" -> 30 for
    an int Literal, so a Literal 422s on EVERY explicit ?days= value
    (probed on the pinned fastapi/pydantic). IntEnum coerces and 422s
    only on values outside the enum."""

    d30 = 30
    d90 = 90
    d365 = 365


class ActivitySeriesPayload(BaseModel):
    runs: dict[str, list[int]]
    input_tokens: list[int]
    output_tokens: list[int]
    credits: list[int]


class ActivityTotals(BaseModel):
    runs: int
    input_tokens: int
    output_tokens: int
    credits: int


class PerUserRow(ActivityTotals):
    user_id: int
    email: str
    display_name: str | None


class ActivityResponse(BaseModel):
    """Own/{user_id} shape. per_user is deliberately NOT a field here (not
    even Optional) — the spec reserves it for /all only, and an Optional
    default would still serialize as `"per_user": null` on these two routes
    instead of omitting the key. AllActivityResponse below adds it."""

    days: list[str]
    series: ActivitySeriesPayload
    totals: ActivityTotals


class AllActivityResponse(ActivityResponse):
    per_user: list[PerUserRow]


def _totals(s) -> ActivityTotals:
    return ActivityTotals(
        runs=sum(sum(v) for v in s.runs.values()),
        input_tokens=sum(s.input_tokens),
        output_tokens=sum(s.output_tokens),
        credits=sum(s.credits),
    )


def _activity_response(s) -> ActivityResponse:
    return ActivityResponse(
        days=s.days,
        series=ActivitySeriesPayload(
            runs=s.runs, input_tokens=s.input_tokens,
            output_tokens=s.output_tokens, credits=s.credits,
        ),
        totals=_totals(s),
    )


@router.get("")
def own_activity(request: Request, days: Days = Days.d30,
                 user: CurrentUser = Depends(get_current_user)) -> ActivityResponse:
    store = request.app.state.usage_store
    return _activity_response(store.activity_series(user.id, days=int(days)))


# Registered before /{user_id} so "all" never parses as a user id.
@router.get("/all")
def all_activity(request: Request, days: Days = Days.d30,
                 _admin: CurrentUser = Depends(require_admin)) -> AllActivityResponse:
    store = request.app.state.usage_store
    # One clock read for BOTH queries: across midnight the series and the
    # per-user table must describe the same range. activity_all (not the
    # two separate activity_series/activity_user_totals calls) also pins
    # both queries to one DB snapshot — see its own docstring for why that
    # matters beyond the shared end_day.
    end_day = datetime.now(UTC).date()
    series, user_totals = store.activity_all(days=int(days), end=end_day)
    users = {u.id: u for u in request.app.state.user_store.list_users()}
    per_user = [
        PerUserRow(
            user_id=t.user_id,
            email=users[t.user_id].email if t.user_id in users else "",
            display_name=users[t.user_id].display_name if t.user_id in users else None,
            runs=t.runs, input_tokens=t.input_tokens,
            output_tokens=t.output_tokens, credits=t.credits,
        )
        for t in user_totals
    ]
    return AllActivityResponse(**_activity_response(series).model_dump(), per_user=per_user)


@router.get("/{user_id}")
def user_activity(request: Request, user_id: int, days: Days = Days.d30,
                  _admin: CurrentUser = Depends(require_admin)) -> ActivityResponse:
    store = request.app.state.usage_store
    if request.app.state.user_store.get_user(user_id) is None:
        raise HTTPException(404, "User not found")
    return _activity_response(store.activity_series(user_id, days=int(days)))
