"""Flow 7: password reset -> captured mail -> confirm -> eviction.

Throttle note: the app-level reset throttle blocks silently (always 204, no
gateway call), and GoTrue's own SMTP rate limit (max_frequency) can also
suppress mail — so "no mail arrived" cannot distinguish the two. The
throttle's blocking semantics are pinned in the unit suite; here we assert
only the unenumerable-response contract: every request returns 204,
including for an unknown email.
"""

import httpx

from .helpers import admin_create_user, expect_login_failure, login

TIMEOUT = 30.0


def test_password_reset_end_to_end_with_eviction(
    app_url, admin_creds, runid, mailpit
):
    email = f"resetter-{runid}@e2e.local"
    old_password = f"e2e-reset-old-{runid}-x"
    new_password = f"e2e-reset-new-{runid}-x"

    admin = login(app_url, *admin_creds)
    admin_create_user(app_url, admin["token"], email, old_password)
    pre_reset_session = login(app_url, email, old_password)

    resp = httpx.post(
        f"{app_url}/api/auth/reset-request", json={"email": email}, timeout=TIMEOUT
    )
    assert resp.status_code == 204

    message = mailpit.wait_for_message(email)
    token_hash, link_type = mailpit.extract_token(message["HTML"])
    assert link_type == "recovery"

    confirm = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={
            "token_hash": token_hash,
            "type": "recovery",
            "new_password": new_password,
        },
        timeout=TIMEOUT,
    )
    assert confirm.status_code == 204

    # pre-reset refresh pair is dead (reset-confirm eviction)
    after = httpx.post(
        f"{app_url}/api/auth/refresh",
        json={"refresh_token": pre_reset_session["refresh_token"]},
        timeout=TIMEOUT,
    )
    assert after.status_code == 401

    assert expect_login_failure(app_url, email, old_password) == 401
    assert login(app_url, email, new_password)["user"]["email"] == email


def test_reset_request_is_unenumerable(app_url, runid):
    """Unknown email must be indistinguishable from a known one."""
    resp = httpx.post(
        f"{app_url}/api/auth/reset-request",
        json={"email": f"never-existed-{runid}@e2e.local"},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204
