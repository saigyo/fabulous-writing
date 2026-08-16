"""B28+B29 flows against the live stack: invite resend and the
verify-once-retry-many weak-password recovery.

The weak_password rejection is reachable because supabase/config.toml sets
password_requirements = "lower_upper_letters_digits": an all-lowercase
>=8-char password passes the app's own pre-validation but fails GoTrue.

Mail budget: these tests add ~3 mails per run to GoTrue's 30/hour ceiling
(not configurable on the Mailpit-backed stack) -- a rate-limited rerun
shows up as wait_for_message timeouts, not app bugs. GoTrue's own
max_frequency (1 s between mails per address) is why the resend below
waits briefly after the first invite mail.
"""

import time

import httpx

from .helpers import TIMEOUT, admin_create_user, bearer, login


def test_invite_resend_end_to_end(app_url, admin_creds, runid, mailpit):
    email = f"resendee-{runid}@e2e.local"
    password = f"E2e-Resendee-Password-{runid}"

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email)
    assert created["invited"] is True
    assert created["invite_emailed"] is True

    first_mail = mailpit.wait_for_message(email)
    old_hash, _ = mailpit.extract_token(first_mail["HTML"])

    # clear GoTrue's per-address max_frequency (1 s) before resending
    time.sleep(1.5)

    resend = httpx.post(
        f"{app_url}/api/admin/users/{created['id']}/resend-invite",
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert resend.status_code == 204

    second_mail = mailpit.wait_for_message(email, min_count=2)
    new_hash, link_type = mailpit.extract_token(second_mail["HTML"])
    assert link_type == "invite" and new_hash != old_hash

    # the resend invalidated the first link (GoTrue rotates the token)
    burned = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": old_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert burned.status_code == 422
    assert burned.json()["detail"]["code"] == "invalid_or_expired_link"

    fresh = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": new_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert fresh.status_code == 204
    assert login(app_url, email, password)["user"]["email"] == email

    # resend for the now-active account is answered honestly
    again = httpx.post(
        f"{app_url}/api/admin/users/{created['id']}/resend-invite",
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert again.status_code == 422
    assert again.json()["detail"]["code"] == "already_active"


def test_weak_password_retry_end_to_end(app_url, admin_creds, runid, mailpit):
    email = f"weakling-{runid}@e2e.local"
    weak = f"weakpassword{runid}"          # >=8, all lowercase+digits: app passes, GoTrue rejects
    strong = f"E2e-Strong-Password-{runid}"

    admin = login(app_url, *admin_creds)
    admin_create_user(app_url, admin["token"], email)
    message = mailpit.wait_for_message(email)
    token_hash, _ = mailpit.extract_token(message["HTML"])

    rejected = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": token_hash, "type": "invite", "new_password": weak},
        timeout=TIMEOUT,
    )
    assert rejected.status_code == 422
    detail = rejected.json()["detail"]
    assert detail["code"] == "password_weak"
    assert "characters" in detail["reasons"]
    retry_token = detail["retry_token"]

    # the link is burned -- but the retry token carries the flow forward
    retried = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"retry_token": retry_token, "new_password": strong},
        timeout=TIMEOUT,
    )
    assert retried.status_code == 204
    assert login(app_url, email, strong)["user"]["email"] == email
