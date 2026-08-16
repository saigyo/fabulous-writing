"""B28+B29 flows against the live stack: invite resend and the
verify-once-retry-many weak-password recovery.

The weak_password rejection is reachable because supabase/config.toml sets
password_requirements = "lower_upper_letters_digits": an all-lowercase
>=8-char password passes the app's own pre-validation but fails GoTrue.

Mail budget: these tests add ~5 mails per run to GoTrue's 30/hour ceiling
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


def test_deactivated_user_reset_and_resend_guards(app_url, admin_creds, runid, mailpit):
    """B32 (#106): a deactivated user's mailbox stays silent on
    reset-request, and resend-invite answers user_inactive. The admin's
    own recovery mail is the control: its ARRIVAL bounds the wait, so no
    sleep has to guess at delivery time (the sleep below only clears
    GoTrue's per-address max_frequency)."""
    email = f"dormant-{runid}@e2e.local"
    password = f"E2e-Dormant-Password-{runid}"
    admin_email = admin_creds[0]

    admin = login(app_url, *admin_creds)
    created = admin_create_user(app_url, admin["token"], email)
    message = mailpit.wait_for_message(email)
    token_hash, _ = mailpit.extract_token(message["HTML"])
    confirm = httpx.post(
        f"{app_url}/api/auth/reset-confirm",
        json={"token_hash": token_hash, "type": "invite", "new_password": password},
        timeout=TIMEOUT,
    )
    assert confirm.status_code == 204

    deact = httpx.patch(
        f"{app_url}/api/admin/users/{created['id']}",
        json={"is_active": False},
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert deact.status_code == 200

    # Clear GoTrue's per-address max_frequency (1 s): without this the
    # dormant mailbox could stay empty even with the guard REMOVED
    # (GoTrue itself suppressing the mail), passing the test vacuously.
    time.sleep(1.5)

    dormant_before = mailpit.count_messages(email)
    admin_before = mailpit.count_messages(admin_email)
    resp = httpx.post(
        f"{app_url}/api/auth/reset-request", json={"email": email}, timeout=TIMEOUT
    )
    assert resp.status_code == 204
    resp = httpx.post(
        f"{app_url}/api/auth/reset-request", json={"email": admin_email}, timeout=TIMEOUT
    )
    assert resp.status_code == 204

    # The control mail (admin recovery) arriving bounds the common delivery
    # path (routing, request handling) both requests share -- but not the
    # background-task delivery itself; see the settle window below.
    mailpit.wait_for_message(admin_email, min_count=admin_before + 1)

    # Since 998cb74 delivery runs in a post-response BackgroundTask, so the
    # control mail's arrival no longer strictly orders a (hypothetical)
    # dormant delivery before it -- both tasks run concurrently. The
    # in-flight window is milliseconds (one localhost GoTrue call); 2 s is
    # a generous upper bound for it, restoring the mutation sensitivity of
    # the absence assertion below.
    time.sleep(2.0)
    assert mailpit.count_messages(email) == dormant_before

    resend = httpx.post(
        f"{app_url}/api/admin/users/{created['id']}/resend-invite",
        headers=bearer(admin["token"]),
        timeout=TIMEOUT,
    )
    assert resend.status_code == 422
    assert resend.json()["detail"]["code"] == "user_inactive"
