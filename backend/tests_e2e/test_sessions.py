"""Flow 3+4: refresh-token rotation and logout, against real GoTrue.

Reuse semantics (probed live, Task 4): GoTrue deliberately honors the
IMMEDIATE parent refresh token as retry tolerance — regardless of
refresh_token_reuse_interval, 0 included — but degenerates it to the SAME
session family: the reuse response carries the identical child refresh
token, never a fork. That no-forking property is the security guarantee
worth pinning; a 401-on-reuse assertion is unachievable against GoTrue.
"""

import httpx

from .helpers import bearer, login

TIMEOUT = 30.0


def _refresh(app_url: str, refresh_token: str) -> httpx.Response:
    return httpx.post(
        f"{app_url}/api/auth/refresh",
        json={"refresh_token": refresh_token},
        timeout=TIMEOUT,
    )


def test_refresh_rotates_and_reuse_cannot_fork_a_second_family(app_url, admin_creds):
    session = login(app_url, *admin_creds)
    first = _refresh(app_url, session["refresh_token"])
    assert first.status_code == 200
    rotated = first.json()
    assert rotated["token"] and rotated["refresh_token"]
    assert rotated["refresh_token"] != session["refresh_token"]
    # the rotated access token is honored by the app
    me = httpx.get(
        f"{app_url}/api/auth/me", headers=bearer(rotated["token"]), timeout=TIMEOUT
    )
    assert me.status_code == 200
    # reusing the consumed parent degenerates to the same family
    again = _refresh(app_url, session["refresh_token"])
    assert again.status_code == 200
    assert again.json()["refresh_token"] == rotated["refresh_token"]


def test_logout_kills_the_refresh_pair(app_url, admin_creds):
    session = login(app_url, *admin_creds)
    resp = httpx.post(
        f"{app_url}/api/auth/logout",
        headers=bearer(session["token"]),
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204
    after = _refresh(app_url, session["refresh_token"])
    assert after.status_code == 401
