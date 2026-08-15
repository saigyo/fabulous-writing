"""Flow 3+4: refresh-token rotation and logout, against real GoTrue.

refresh_token_reuse_interval = 0 in supabase/config.toml makes consumed-
token rejection immediate (hosted default is a 10 s grace window).
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


def test_refresh_rotates_and_consumed_token_dies(app_url, admin_creds):
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
    # the consumed token is dead (rotation, zero reuse interval)
    again = _refresh(app_url, session["refresh_token"])
    assert again.status_code == 401


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
