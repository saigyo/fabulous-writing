"""Flow 6: admin invite -> captured mail -> token_hash -> acceptance -> login.

This is the full production invite path: the app sends the invite through
GoTrue, GoTrue renders supabase/templates/invite.html (the committed
production fragment contract) and delivers via Mailpit, and acceptance goes
through POST /api/auth/reset-confirm, which JIT-creates the local row.
"""

import httpx

from .helpers import TIMEOUT, admin_create_user, login


def test_invite_acceptance_end_to_end(app_url, admin_creds, runid, mailpit):
    email = f"invitee-{runid}@e2e.local"
    password = f"E2e-Invitee-Password-{runid}"

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email)  # no password
    assert created["invited"] is True

    message = mailpit.wait_for_message(email)
    token_hash, link_type = mailpit.extract_token(message["HTML"])
    assert link_type == "invite"

    resp = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": token_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 204

    session = login(app_url, email, password)
    assert session["user"]["email"] == email
    assert session["user"]["is_admin"] is False


def test_stale_token_hash_is_rejected(app_url):
    resp = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={
            "token_hash": "0" * 56,
            "type": "invite",
            "new_password": "Irrelevant-Long-Password-123",
        },
        timeout=TIMEOUT,
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "invalid_or_expired_link"
