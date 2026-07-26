import base64
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.auth import LoginThrottle, _throttle_key
from app.api.deps import MAX_TOKEN_BYTES, CurrentUser, get_current_user, require_admin
from app.core.auth import LocalTokenVerifier, VerifiedToken, issue_token
from app.core.config import Settings
from app.main import create_app
from app.services.users import UserStore
from tests.conftest import TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, auth_headers

# 64 bytes, not merely the 32-byte minimum: kept consistent with the secret
# length used in tests/test_auth_core.py.
SECRET = "s" * 64


@pytest.fixture()
def probe(tmp_path: Path):
    """A minimal app exposing the dependencies, so they are tested directly
    rather than through whichever endpoint happens to use them."""
    app = FastAPI()
    app.state.user_store = UserStore(tmp_path / "test.db")
    app.state.token_verifier = LocalTokenVerifier(SECRET)

    @app.get("/probe/user")
    def probe_user(user: CurrentUser = Depends(get_current_user)) -> dict:
        return {"id": user.id, "email": user.email, "tier": user.tier,
                "is_admin": user.is_admin}

    @app.get("/probe/admin")
    def probe_admin(user: CurrentUser = Depends(require_admin)) -> dict:
        return {"id": user.id}

    return app


def auth(user_id: int) -> dict:
    return {"Authorization": f"Bearer {issue_token(user_id, SECRET, epoch=0)}"}


class _EpochlessVerifier:
    """A stub standing in for the future Supabase verifier: it never sets an
    epoch, so get_current_user must fall back to the password_changed_at
    comparison for it — the only path left where that comparison, and its
    malformed-value guards, still run."""

    def __init__(self, user_id: int, issued_at: datetime) -> None:
        self._user_id = user_id
        self._issued_at = issued_at

    def verify(self, token: str) -> VerifiedToken:
        return VerifiedToken(user_id=self._user_id, issued_at=self._issued_at, epoch=None)


def test_valid_token_resolves_the_user(probe):
    user = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    body = TestClient(probe).get("/probe/user", headers=auth(user.id)).json()
    assert body == {"id": user.id, "email": "ada@example.com", "tier": "basic",
                    "is_admin": False}


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer"}, {"Authorization": "Basic abc"},
     {"Authorization": "Bearer garbage"}],
)
def test_missing_or_malformed_credentials_are_401(probe, headers):
    assert TestClient(probe).get("/probe/user", headers=headers).status_code == 401


def test_token_for_an_unknown_user_is_401(probe):
    assert TestClient(probe).get("/probe/user", headers=auth(999)).status_code == 401


def _deeply_nested_token(depth: int = 20000) -> str:
    # Same construction as test_auth_core.py's recursion regression test:
    # a header segment whose JSON is nested far past the ~9999-depth
    # threshold that drives PyJWT's json.loads into RecursionError before
    # it ever gets to look at `alg`.
    header_json = "[" * depth + "]" * depth
    header = base64.urlsafe_b64encode(header_json.encode()).decode().rstrip("=")
    return f"{header}.e30.c2ln"  # payload "{}", arbitrary signature bytes


def test_deeply_nested_jwt_is_401_through_the_dependency_not_500(probe):
    # End-to-end regression test for the RecursionError-escapes-as-500
    # defect: this must come back as the same generic 401 as every other
    # authentication failure, never an unhandled 500.
    headers = {"Authorization": f"Bearer {_deeply_nested_token()}"}
    assert TestClient(probe).get("/probe/user", headers=headers).status_code == 401


def test_overlong_token_is_401_without_invoking_the_verifier(probe):
    # Pins the cheap-rejection property of the MAX_TOKEN_BYTES guard in
    # get_current_user: an over-long bearer token must be turned away
    # before it ever reaches the verifier, not merely end up 401 after
    # the verifier runs.
    probe.state.token_verifier.verify = MagicMock(
        side_effect=AssertionError("verifier must not be called for an over-long token")
    )
    huge_token = "a" * (MAX_TOKEN_BYTES + 1)
    headers = {"Authorization": f"Bearer {huge_token}"}
    response = TestClient(probe).get("/probe/user", headers=headers)
    assert response.status_code == 401
    probe.state.token_verifier.verify.assert_not_called()


def test_deactivation_takes_effect_on_the_next_request(probe):
    # The user row is re-read per request, so revoking access does not wait
    # for the token to expire — this is the incident-response lever.
    user = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    client = TestClient(probe)
    headers = auth(user.id)
    assert client.get("/probe/user", headers=headers).status_code == 200
    probe.state.user_store.update_user(user.id, is_active=False)
    assert client.get("/probe/user", headers=headers).status_code == 401


def test_changing_the_password_invalidates_tokens_issued_before_it(probe):
    store = probe.state.user_store
    user = store.create_user("ada@example.com", "correct horse battery")
    client = TestClient(probe)
    # Mint the "before" token at the pre-change epoch. Revocation is now
    # exact-epoch equality (Task 1), not a timing comparison, so the old
    # token fails regardless of how close in time it was issued to the
    # change — no same-second window to worry about here any more.
    old = issue_token(user.id, SECRET, epoch=user.token_epoch)
    stale = {"Authorization": f"Bearer {old}"}
    assert client.get("/probe/user", headers=stale).status_code == 200
    store.set_password(user.id, "a replacement password")
    assert client.get("/probe/user", headers=stale).status_code == 401
    # The replacement token carries the post-change epoch, exactly as a real
    # re-login would mint it.
    fresh = issue_token(user.id, SECRET, epoch=store.get_user(user.id).token_epoch)
    assert client.get(
        "/probe/user", headers={"Authorization": f"Bearer {fresh}"}
    ).status_code == 200


def test_a_corrupt_stored_password_changed_at_is_401_not_500(probe):
    # No code path writes a non-isoformat password_changed_at today
    # (set_password's _utcnow() is the sole writer), but a hand-edited row or
    # a future migration could — deps.py must treat that the same way
    # core/auth.py already treats a malformed stored password hash and a
    # malformed token iat: a generic 401, never an unhandled 500 that would
    # 500 every request this user makes.
    #
    # The password_changed_at comparison only runs for an epoch-less verifier
    # now (Task 1): a real LocalTokenVerifier token always carries a matching
    # epoch and never reaches this code at all, so the stub below is what
    # actually exercises it.
    store = probe.state.user_store
    user = store.create_user("ada@example.com", "correct horse battery")
    with store._connect() as conn:
        conn.execute(
            "UPDATE users SET password_changed_at = ? WHERE id = ?",
            ("not-a-timestamp", user.id),
        )
    probe.state.token_verifier = _EpochlessVerifier(user.id, datetime.now(UTC))
    response = TestClient(probe).get(
        "/probe/user", headers={"Authorization": "Bearer anything"}
    )
    assert response.status_code == 401


def test_a_naive_stored_password_changed_at_is_401_not_500(probe):
    # datetime.fromisoformat("2026-07-26T09:00:00") parses successfully, but
    # into a *naive* datetime — comparing it against the verifier's tz-aware
    # issued_at raises TypeError, not ValueError, so the earlier ValueError
    # guard alone lets this one through as a 500. Same failure-closed
    # contract as the corrupt-value test above, reached by a different input.
    #
    # As above, this path is only reachable through an epoch-less verifier.
    store = probe.state.user_store
    user = store.create_user("ada@example.com", "correct horse battery")
    with store._connect() as conn:
        conn.execute(
            "UPDATE users SET password_changed_at = ? WHERE id = ?",
            ("2026-07-26T09:00:00", user.id),
        )
    probe.state.token_verifier = _EpochlessVerifier(user.id, datetime.now(UTC))
    response = TestClient(probe).get(
        "/probe/user", headers={"Authorization": "Bearer anything"}
    )
    assert response.status_code == 401


def test_require_admin_rejects_a_normal_user_and_admits_an_admin(probe):
    normal = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    admin = probe.state.user_store.create_user(
        "root@example.com", "correct horse battery", is_admin=True
    )
    client = TestClient(probe)
    assert client.get("/probe/admin", headers=auth(normal.id)).status_code == 403
    assert client.get("/probe/admin", headers=auth(admin.id)).status_code == 200


def test_de_adminning_takes_effect_on_the_next_request(probe):
    admin = probe.state.user_store.create_user(
        "root@example.com", "correct horse battery", is_admin=True
    )
    client = TestClient(probe)
    headers = auth(admin.id)
    assert client.get("/probe/admin", headers=headers).status_code == 200
    probe.state.user_store.update_user(admin.id, is_admin=False)
    assert client.get("/probe/admin", headers=headers).status_code == 403


@pytest.fixture()
def app_client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("FW_AUTH_SECRET", SECRET)
    monkeypatch.setenv("FW_ADMIN_EMAIL", "root@example.com")
    monkeypatch.setenv("FW_ADMIN_PASSWORD", "bootstrap password")
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def login(client: TestClient, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_login_returns_a_token_and_the_user(app_client):
    response = login(app_client, "root@example.com", "bootstrap password")
    assert response.status_code == 200
    body = response.json()
    assert body["token"]
    assert body["user"]["email"] == "root@example.com"
    assert body["user"]["is_admin"] is True
    assert "password_hash" not in str(body)


def test_login_is_case_insensitive_on_email(app_client):
    assert login(app_client, "ROOT@Example.com", "bootstrap password").status_code == 200


def test_login_strips_surrounding_whitespace_from_email(app_client):
    assert login(app_client, "  root@example.com  ", "bootstrap password").status_code == 200


def test_login_rejects_whitespace_only_email_without_creating_a_throttle_entry(app_client):
    # Round-2 added whitespace stripping to UserStore, but nothing rejected
    # an email that is only whitespace: it normalized to '', which the
    # throttle would then key on. This must be a 422 (request validation),
    # not a 401 (invalid credentials) — and it must never reach the
    # throttle at all, since a whitespace-only email is never a real login
    # attempt to rate-limit.
    response = login(app_client, "   ", "bootstrap password")
    assert response.status_code == 422
    assert app_client.app.state.login_throttle.entry_count() == 0


def test_whitespace_variant_of_a_blocked_email_shares_its_throttle_key(app_client):
    """UserStore.create/get_by_email/verify_credentials now strip whitespace
    at the store boundary (so " x@example.com " and "x@example.com" are one
    DB row), while `_throttle_key` has always normalized with
    `.strip().lower()`. This pins the invariant a prior whole-branch review
    established: a DB match must imply an equal throttle key, so an email
    the store treats as identical to an already-blocked one cannot dodge
    the block by adding whitespace. If the two boundaries ever normalize
    whitespace differently, this test is where that would show up.
    """
    for _ in range(5):
        login(app_client, "root@example.com", "wrong password")
    blocked = login(app_client, "  root@example.com  ", "bootstrap password")
    assert blocked.status_code == 401
    assert blocked.json()["detail"] == "Invalid email or password"


@pytest.mark.parametrize(
    ("email", "password"),
    [("root@example.com", "wrong password"), ("nobody@example.com", "bootstrap password")],
)
def test_login_failures_are_indistinguishable(app_client, email, password):
    response = login(app_client, email, password)
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid email or password"


def test_deactivated_account_cannot_log_in(app_client):
    store = app_client.app.state.user_store
    store.update_user(1, is_active=False)
    assert login(app_client, "root@example.com", "bootstrap password").status_code == 401


def test_me_requires_authentication_and_returns_the_caller(app_client):
    assert app_client.get("/api/auth/me").status_code == 401
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    body = app_client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert body["email"] == "root@example.com" and body["is_admin"] is True
    assert body["tier"] == "premium"


def test_password_change_requires_the_current_password(app_client):
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    wrong = app_client.post(
        "/api/auth/password",
        json={"current": "not it", "new": "a new long password"},
        headers=headers,
    )
    # 422, not 401: the bearer token authenticated fine, so a wrong current
    # password must not share a status with get_current_user's "token
    # rejected" 401 — see the docstring in app/api/auth.py.
    assert wrong.status_code == 422
    assert wrong.json()["detail"]["code"] == "wrong_current_password"
    ok = app_client.post(
        "/api/auth/password",
        json={"current": "bootstrap password", "new": "a new long password"},
        headers=headers,
    )
    assert ok.status_code == 204
    assert login(app_client, "root@example.com", "bootstrap password").status_code == 401
    assert login(app_client, "root@example.com", "a new long password").status_code == 200


def test_password_change_enforces_the_self_chosen_minimum(app_client):
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    response = app_client.post(
        "/api/auth/password",
        json={"current": "bootstrap password", "new": "short"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "password_too_short"


def test_password_change_rejects_a_password_over_the_bcrypt_byte_ceiling(app_client):
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    # A multibyte string makes the byte-vs-character distinction real: 37
    # "é" characters is 74 bytes (2 bytes each in UTF-8) but only 37
    # characters — well past SELF_MIN_PASSWORD_LENGTH, so this can only trip
    # the 72-byte ceiling, not the length-in-characters minimum.
    over_long = "é" * 37
    assert len(over_long) < 72  # characters: would pass the minimum alone
    assert len(over_long.encode()) > 72  # bytes: trips bcrypt's ceiling
    response = app_client.post(
        "/api/auth/password",
        json={"current": "bootstrap password", "new": over_long},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "password_too_long"


def test_password_change_revokes_old_token_immediately(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    old_headers = auth_headers(client)
    assert client.get("/api/auth/me", headers=old_headers).status_code == 200
    response = client.post(
        "/api/auth/password",
        json={"current": TEST_ADMIN_PASSWORD, "new": "a-brand-new-password"},
        headers=old_headers,
    )
    assert response.status_code == 204
    # No sleep: the epoch makes revocation exact, same-second included.
    assert client.get("/api/auth/me", headers=old_headers).status_code == 401
    token = client.post(
        "/api/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": "a-brand-new-password"},
    ).json()["token"]
    assert (
        client.get(
            "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 200
    )


def test_epochless_verifier_falls_back_to_password_changed_at(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    app = create_app(settings)
    client = TestClient(app)
    auth_headers(client)  # forces admin bootstrap
    admin = app.state.user_store.get_by_email(TEST_ADMIN_EMAIL)
    app.state.user_store.set_password(admin.id, "changed-since-issuance")

    class EpochlessVerifier:
        def verify(self, token: str) -> VerifiedToken:
            return VerifiedToken(
                user_id=admin.id,
                issued_at=datetime.now(UTC) - timedelta(hours=1),
                epoch=None,
            )

    app.state.token_verifier = EpochlessVerifier()
    response = client.get(
        "/api/auth/me", headers={"Authorization": "Bearer anything"}
    )
    assert response.status_code == 401


def test_throttle_blocks_after_repeated_failures_then_recovers():
    now = [0.0]
    throttle = LoginThrottle(threshold=3, base_delay=2.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    assert throttle.blocked_for(key) == 0
    for _ in range(3):
        throttle.record_failure(key)
    assert throttle.blocked_for(key) > 0
    now[0] += 2.0
    assert throttle.blocked_for(key) == 0


def test_extreme_failure_count_saturates_to_max_delay_without_hanging():
    """Regression test for unbounded exponentiation in the backoff.

    `record_failure` used to compute `base_delay * 2 ** (failures -
    threshold)` with an *integer* exponent. `failures` cannot realistically
    reach an unsafe value via real logins (it only increments once per
    block window, and each increment costs a full bcrypt hash), so this
    drives it directly by mutating the stored entry rather than issuing
    thousands of real logins.

    The fix caps the exponent (see `_MAX_SAFE_EXPONENT` in
    `app/api/auth.py`) rather than merely switching to a float base: a
    float base alone does not save you in CPython — `2.0 ** 1024` raises
    OverflowError instead of returning `inf`, so an uncapped float
    exponent would trade a hang for a crash. This test would fail either
    way: by hanging/OOMing on unbounded int exponentiation, or by raising
    OverflowError on an uncapped float one.
    """
    now = [0.0]
    throttle = LoginThrottle(threshold=3, base_delay=1.0, max_delay=60.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    throttle.record_failure(key)
    entry = throttle._state[key]
    entry.failures = 10**9  # far beyond anything reachable via real logins

    start = time.monotonic()
    throttle.record_failure(key)
    elapsed = time.monotonic() - start

    assert throttle.blocked_for(key) == pytest.approx(60.0)
    assert elapsed < 1.0  # promptly, not after allocating a giant bigint


def test_throttle_backoff_grows_and_success_clears_it():
    now = [0.0]
    throttle = LoginThrottle(threshold=1, base_delay=2.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    throttle.record_failure(key)
    first = throttle.blocked_for(key)
    throttle.record_failure(key)
    assert throttle.blocked_for(key) > first
    throttle.record_success(key)
    assert throttle.blocked_for(key) == 0


def test_throttle_expires_stale_entries():
    # Keys come from unauthenticated input, so the table must not keep an
    # entry alive forever on the strength of one ancient failure.
    now = [0.0]
    throttle = LoginThrottle(threshold=1, entry_ttl=100.0, clock=lambda: now[0])
    stale = ("ada@example.com", "127.0.0.1")
    throttle.record_failure(stale)
    now[0] += 500.0
    throttle.record_failure(("other@example.com", "127.0.0.1"))
    assert throttle.entry_count() == 1
    assert throttle.blocked_for(stale) == 0


def test_throttle_table_is_bounded():
    # An attacker spraying distinct addresses must not be able to grow the
    # table without limit — that would trade a brute-force defense for a
    # memory-exhaustion vector. Threshold is set above the single failure
    # each key gets here so none of them become actively blocked: the cap
    # must hold when nothing is protected from eviction. A blocked entry's
    # protection from the cap is covered separately by
    # test_actively_blocked_entry_survives_the_size_cap.
    throttle = LoginThrottle(threshold=5, max_entries=8, clock=lambda: 0.0)
    for index in range(100):
        throttle.record_failure((f"user{index}@example.com", "127.0.0.1"))
    assert throttle.entry_count() <= 8


def test_actively_blocked_entry_survives_the_size_cap():
    # An attacker who has already triggered a block on one victim key must
    # not be able to discard its accumulated backoff by spraying max_entries
    # failed logins from disposable, unrelated addresses. Threshold is above
    # 1 so the attacker's single-failure keys stay evictable while the
    # victim, having reached threshold, does not.
    throttle = LoginThrottle(threshold=3, base_delay=50.0, max_entries=8, clock=lambda: 0.0)
    victim = ("victim@example.com", "127.0.0.1")
    for _ in range(3):
        throttle.record_failure(victim)
    expected_delay = throttle.blocked_for(victim)
    assert expected_delay > 0

    for index in range(100):
        throttle.record_failure((f"attacker{index}@example.com", "127.0.0.1"))

    assert throttle.entry_count() <= 8
    # Still blocked for exactly the delay computed from the original 3
    # failures. If the size cap had evicted the victim's entry (or it had
    # been recreated with a lower failure count), this would read 0.0 (entry
    # gone) or a different delay (fewer failures), not the original value.
    assert throttle.blocked_for(victim) == expected_delay


def test_blocked_attempts_refresh_recency_so_ttl_does_not_prune_them():
    # A key under sustained attack must not age out of the table just
    # because every attempt against it is rejected before ever reaching
    # record_failure again. The login handler calls record_blocked_attempt
    # on every rejected-while-blocked attempt for exactly this reason.
    now = [0.0]
    throttle = LoginThrottle(threshold=1, base_delay=5.0, entry_ttl=100.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    throttle.record_failure(key)

    for _ in range(20):
        now[0] += 40.0
        throttle.record_blocked_attempt(key)

    assert now[0] > 100.0  # sanity: we are well past entry_ttl by now
    # Force a prune sweep (any record_failure call triggers one) at a time
    # far past entry_ttl relative to the original failure.
    throttle.record_failure(("other@example.com", "127.0.0.1"))
    assert throttle.entry_count() == 2  # both `key` and `other` survived
    # The block itself is not extended by the touches — only recency is.
    assert throttle.blocked_for(key) == 0


def test_concurrent_failures_on_one_key_produce_an_exact_count():
    # login and password-change handlers are plain `def`s, so Starlette runs
    # them in a threadpool: record_failure is called on the same key from
    # multiple OS threads concurrently. A non-atomic read-modify-write would
    # lose updates under contention. threshold is set to the exact number of
    # calls made per trial, so the entry becomes blocked (blocked_for reads
    # exactly base_delay) if and only if every one of them was actually
    # counted — a lost update would leave it short of threshold and
    # unblocked.
    #
    # A single trial is not a reliable regression test on its own: measured
    # against a deliberately unlocked build of this class, CPython 3.13's
    # specializing interpreter shrinks the usual GIL-preemption window
    # inside a bare `x += 1` enough that any one trial only loses an update
    # 5-20% of the time. Repeating the trial drives the chance of a real
    # regression slipping through to well under 1%, at a cost of well under
    # a second: 60 repeats reproduced the loss on every one of 14 out of 15
    # independent checks against the unlocked class (worst case, one check
    # took 43 of the 60 repeats to trigger), while the locked implementation
    # below passed all 60 repeats with zero failures across dozens of runs.
    #
    # The 24 / 40 / 60 numbers were fit empirically on one machine (CPython
    # 3.13, macOS, 12 cores) and are not principled. If this test behaves
    # differently on other CI hardware (flakes, or stops catching a real
    # regression), re-measure the detection rate there rather than just
    # raising `trials` — the right numbers may differ, not just be bigger.
    thread_count = 24
    iterations = 40
    total = thread_count * iterations
    trials = 60

    def run_once() -> float:
        throttle = LoginThrottle(threshold=total, base_delay=3.0, clock=lambda: 0.0)
        key = ("ada@example.com", "127.0.0.1")
        barrier = threading.Barrier(thread_count)

        def hammer() -> None:
            barrier.wait()
            for _ in range(iterations):
                throttle.record_failure(key)

        threads = [threading.Thread(target=hammer) for _ in range(thread_count)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return throttle.blocked_for(key)

    original_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)  # maximise thread interleaving to expose races
    try:
        for _ in range(trials):
            assert run_once() == 3.0
    finally:
        sys.setswitchinterval(original_interval)


def test_concurrent_failures_across_many_keys_do_not_raise():
    # _prune used to iterate-and-delete from the OrderedDict with no lock;
    # concurrent inserts/deletes from other threads could raise RuntimeError
    # or KeyError out of the login handler — a 500 triggerable by
    # unauthenticated concurrent traffic. max_entries is small relative to
    # the number of distinct keys generated, so eviction runs on nearly
    # every call. threshold is above the single failure each key gets so
    # none of them become actively blocked and all stay evictable — this
    # test is about crash-safety under concurrent pruning, not about the
    # blocked-entry protection (covered by
    # test_actively_blocked_entry_survives_the_size_cap).
    throttle = LoginThrottle(threshold=5, max_entries=50, clock=lambda: 0.0)
    errors: list[BaseException] = []

    def hammer(offset: int) -> None:
        try:
            for i in range(200):
                throttle.record_failure((f"user{offset}-{i}@example.com", "127.0.0.1"))
        except BaseException as exc:  # capture to fail the test, not to hide it
            errors.append(exc)

    original_interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        threads = [threading.Thread(target=hammer, args=(offset,)) for offset in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        sys.setswitchinterval(original_interval)

    assert errors == []
    assert throttle.entry_count() <= 50


def test_throttled_login_is_rejected_even_with_the_right_password(app_client):
    for _ in range(5):
        login(app_client, "root@example.com", "wrong password")
    blocked = login(app_client, "root@example.com", "bootstrap password")
    assert blocked.status_code == 401
    assert blocked.json()["detail"] == "Invalid email or password"


def test_overlong_login_email_is_rejected_without_growing_the_throttle_table(app_client):
    # A 200,012-character email must not reach _throttle_key at all:
    # LoginRequest.email's max_length=320 rejects it at the Pydantic layer,
    # before the handler (and therefore the throttle) ever sees it.
    huge_email = "a" * 200_012 + "@example.com"
    response = login(app_client, huge_email, "whatever password")
    assert response.status_code == 422
    assert app_client.app.state.login_throttle.entry_count() == 0


def test_throttle_key_length_is_bounded_regardless_of_input_size():
    # Defense in depth: even if some future caller invokes _throttle_key
    # directly with unvalidated input (bypassing LoginRequest's max_length),
    # the key it produces must stay bounded, since it is retained for
    # entry_ttl seconds per unique key.
    fake_request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    huge_email = "b" * 200_012 + "@example.com"
    key = _throttle_key(fake_request, huge_email)
    assert len(key[0]) <= 320
