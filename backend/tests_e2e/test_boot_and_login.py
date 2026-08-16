"""Flow 1+2: real-server boot against the live stack, health, admin login.

A passing app_url fixture already proves the hard part: create_app ran the
full production startup (credential resolution, OAuth lockout probe against
live GoTrue settings, seed_admin under a running uvicorn event loop).
"""

import httpx
import jwt

from .helpers import bearer, expect_login_failure, login


def test_health_advertises_supabase_auth_features(app_url):
    body = httpx.get(f"{app_url}/api/health", timeout=10).json()
    assert body["auth_features"] == {"password_reset": True, "invites": True}


def test_admin_login_returns_full_session_and_me_works(app_url, admin_creds):
    email, password = admin_creds
    session = login(app_url, email, password)
    assert session["user"]["email"] == email
    me = httpx.get(
        f"{app_url}/api/auth/me", headers=bearer(session["token"]), timeout=30
    )
    assert me.status_code == 200
    assert me.json()["email"] == email


def test_wrong_password_is_rejected(app_url, admin_creds):
    email, _ = admin_creds
    assert expect_login_failure(app_url, email, "Definitely-Wrong-Password-1x") == 401


def test_garbage_bearer_token_is_rejected(app_url):
    resp = httpx.get(
        f"{app_url}/api/auth/me", headers=bearer("not-a-jwt"), timeout=30
    )
    assert resp.status_code == 401


def test_session_token_is_es256_with_kid(app_url, admin_creds):
    """Pins the signing-keys wiring (spec flow 2: 'verified via real JWKS').

    signing_keys_path has a surprising relative base (supabase/-relative,
    unlike content_path) — if a future config edit breaks it, local GoTrue
    silently falls back to legacy HS256 and this is the test that says so.
    """
    session = login(app_url, *admin_creds)
    header = jwt.get_unverified_header(session["token"])
    assert header["alg"] == "ES256"
    assert header["kid"]

    payload = jwt.decode(session["token"], options={"verify_signature": False})
    assert payload["amr"], "GoTrue stopped minting amr — the B30 guard would reject everything"
    assert all(entry["method"] in ("password", "otp") for entry in payload["amr"])
