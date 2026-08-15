"""Request helpers shared by the e2e flow files."""

import httpx

TIMEOUT = 30.0  # first verify() fetches JWKS; be generous


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(app_url: str, email: str, password: str) -> dict:
    resp = httpx.post(
        f"{app_url}/api/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    assert resp.status_code == 200, f"login failed: {resp.status_code} {resp.text}"
    body = resp.json()
    assert body["token"] and body["refresh_token"] and body["expires_at"]
    return body


def expect_login_failure(app_url: str, email: str, password: str) -> int:
    resp = httpx.post(
        f"{app_url}/api/auth/login",
        json={"email": email, "password": password},
        timeout=TIMEOUT,
    )
    assert resp.status_code != 200, "login unexpectedly succeeded"
    return resp.status_code


def admin_create_user(
    app_url: str, admin_token: str, email: str, password: str | None = None
) -> dict:
    payload: dict = {"email": email}
    if password is not None:
        payload["password"] = password
    resp = httpx.post(
        f"{app_url}/api/admin/users",
        json=payload,
        headers=bearer(admin_token),
        timeout=TIMEOUT,
    )
    assert resp.status_code == 201, f"create failed: {resp.status_code} {resp.text}"
    return resp.json()
