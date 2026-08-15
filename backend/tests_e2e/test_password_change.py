"""Flow 5: self-service password change with M2 eviction, live.

What is asserted — and what deliberately is not: the local iat-based access-
token eviction backdates password_changed_at by a 60 s clock-skew leeway, so
an access token minted seconds before the change survives that check by
design. Testing it would need a >60 s wall-clock wait. The e2e-observable
eviction guarantees are the ones asserted here: every outstanding REFRESH
token dies (GoTrue global sign-out) and the old password stops working.
The iat cutoff itself is pinned in the unit suite with controlled clocks.
"""

import httpx

from .helpers import admin_create_user, bearer, expect_login_failure, login

TIMEOUT = 30.0


def test_password_change_rotates_credential_and_kills_other_sessions(
    app_url, admin_creds, runid
):
    email = f"changer-{runid}@e2e.local"
    old_password = f"e2e-old-password-{runid}"
    new_password = f"e2e-new-password-{runid}"

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email, old_password)
    assert created["invited"] is False

    session_a = login(app_url, email, old_password)
    session_b = login(app_url, email, old_password)

    resp = httpx.post(
        f"{app_url}/api/auth/password",
        json={"current": old_password, "new": new_password},
        headers=bearer(session_a["token"]),
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204

    # every outstanding refresh pair is dead (global sign-out) ...
    for refresh_token in (session_a["refresh_token"], session_b["refresh_token"]):
        after = httpx.post(
            f"{app_url}/api/auth/refresh",
            json={"refresh_token": refresh_token},
            timeout=TIMEOUT,
        )
        assert after.status_code == 401

    # ... the old credential is dead, the new one works
    assert expect_login_failure(app_url, email, old_password) == 401
    assert login(app_url, email, new_password)["user"]["email"] == email
