# Supabase Auth Backend (B14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosted Supabase Auth as a configuration-selectable authentication backend (`auth.mode: "supabase"`), server-proxied, with local JWKS verification, invitation-only user entry, and password-reset emails — local mode unchanged.

**Architecture:** The frontend talks only to our FastAPI in both modes. In supabase mode the backend proxies GoTrue through the official `supabase-auth` package (publishable key for user flows, secret key for admin calls), verifies bearer JWTs locally against the project's JWKS (ES256/RS256), and keeps the SQLite `users` table as the sole authorization authority via `external_id` shadow rows. The M2 eviction guarantee holds at our verification layer (`iat` vs `password_changed_at`) plus GoTrue global sign-out.

**Tech Stack:** FastAPI, PyJWT (`pyjwt[crypto]`, `PyJWKClient`), `supabase-auth>=2.31`, httpx, SQLite, React 19 + Zustand + Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-supabase-auth-design.md`. The spec was amended alongside this plan (verifier-internal resolution, lazy JWKS, no auto-login after reset); spec and this plan agree — if implementation reveals a conflict, stop and ask.

## Global Constraints

- Local mode behavior is byte-for-byte unchanged: same routes, same responses (new `LoginResponse` fields are `None` there), same tests passing.
- `VerifiedToken.user_id` is ALWAYS the local `users.id` (pinned contract, `core/auth.py:173`). The Supabase verifier resolves its subject UUID to `users.external_id` internally; `api/deps.py` is NOT modified by this plan.
- Authorization is never derived from Supabase JWT claims, `app_metadata`, or `user_metadata`. The local `users` table decides `is_admin`, `tier`, `is_active`.
- Env-only secrets: `FW_SUPABASE_PUBLISHABLE_KEY`, `FW_SUPABASE_SECRET_KEY` (supabase mode); `FW_AUTH_SECRET` (local mode only, resolved only there). Never in YAML, DB, logs, or responses. Log key NAMES only, never values.
- `auth.supabase.url` lives in config.yaml (not a secret). No new Settings knob for anything the spec marks env-only or fixed: bcrypt work factor stays a module constant; `auth.allow_additional_admins` and `limits.admin` stay config-only.
- Accepted JWT algorithms are pinned lists: local `["HS256"]`, supabase `["ES256", "RS256"]`. Never `none`, never mixed.
- No public self-signup exists in any configuration. User entry in supabase mode: admin create (with password) or admin invite (email link).
- No test touches the network, a live Supabase instance, or the live DB (`backend/data/fabulous.db`); `create_app()` never runs with default settings in tests — every test passes `tmp_path`-based `Settings`.
- Test gates before every commit: from `backend/`, `uv run pytest -q` green with ZERO warnings; `git status --short -- frontend/` clean (or frontend suite green for frontend tasks: `npm test -- --run` from `frontend/`). Single-file pytest runs use `-n0` (NOT `-p no:xdist`). Never add `-W error`.
- Mutation-verify every guard test (delete the guard, watch the test fail, restore). Never widen a wall-clock test bound.
- New UI strings use the informal register (Du/tu/tú/informal 2nd person) in all locales; `register.test.ts` pins it.
- Every commit ends with the two trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01JXiCFTQQmJeJt3MB8qZdGA`
- Generic error discipline: authentication failures answer exactly `"Not authenticated"` / `_INVALID_LOGIN`; GoTrue error bodies are logged server-side, never echoed to clients.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/core/config.py` | `SupabaseSettings` model, `AuthSettings.supabase` field |
| `backend/app/core/supabase_auth.py` (new) | Credentials resolution, `SupabaseTokenVerifier`, shared user-resolution helper |
| `backend/app/services/supabase_gateway.py` (new) | `SupabaseAuthGateway` over `supabase_auth`; dataclasses + error types |
| `backend/app/services/users.py` | `get_by_external_id`, `create_user(external_id=...)`, `mark_password_changed` |
| `backend/app/api/auth.py` | Mode dispatch; supabase login/refresh/logout/password/reset routes |
| `backend/app/api/admin.py` | Optional-password create → invite |
| `backend/app/services/seed_admin.py` | Supabase bootstrap branch |
| `backend/app/main.py` | Mode wiring (verifier + gateway on `app.state`), health `auth_features` |
| `backend/tests/test_supabase_auth.py` (new) | Credentials + verifier unit tests |
| `backend/tests/test_supabase_gateway.py` (new) | Gateway over `httpx.MockTransport` |
| `backend/tests/test_auth_supabase_api.py` (new) | Route tests with `FakeSupabaseGateway` |
| `backend/tests/fakes_supabase.py` (new) | `FakeSupabaseGateway` + `StaticJWKSClient` shared by test modules |
| `frontend/src/api/client.ts` | `postRefresh`, `postLogout`, `postResetRequest`, `postResetConfirm`, `getHealth`, extended `LoginResponse` |
| `frontend/src/auth/session.ts` | Refresh scheduling, token-triple persistence, logout call |
| `frontend/src/auth/ResetPasswordForm.tsx` (new) | Set-password form (recovery + invite) |
| `frontend/src/auth/ForgotPasswordForm.tsx` (new) | Reset-request form |
| `frontend/src/auth/LoginGate.tsx`, `LoginForm.tsx` | URL token_hash routing; forgot-password affordance |
| `frontend/src/state/store.ts`, `prefsStorage.ts` | `refreshToken`/`tokenExpiresAt` fields + storage |
| `frontend/src/i18n/*.ts` | New strings, all 7 locales |
| `docs/supabase-auth-setup.md` (new) | supabase.com dashboard walkthrough |
| `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `README.md`, `backend/config.example.yaml` | Documentation sync |

**Library-shape risk note (applies to Tasks 3 and 5):** the exact constructor/method signatures of `supabase_auth`'s `AsyncGoTrueClient` / `AsyncGoTrueAdminAPI` and its `Session` model fields must be verified against the *installed* package (`uv run python -c "import inspect, supabase_auth; ..."` or reading `.venv/lib/**/supabase_auth/`), not assumed from this plan. The plan's calls reflect v2.31 as published; adjust names to the installed reality, keeping the gateway's own public interface exactly as specified (that interface is what routes and tests consume).

---

### Task 1: Dependencies, SupabaseSettings, credentials resolution

**Files:**
- Modify: `backend/pyproject.toml` (dependencies list)
- Modify: `backend/app/core/config.py:212-219` (`AuthSettings`)
- Create: `backend/app/core/supabase_auth.py`
- Test: `backend/tests/test_supabase_auth.py`

**Interfaces:**
- Produces: `SupabaseSettings(url: str)` at `settings.auth.supabase`; `SupabaseCredentials(url, publishable_key, secret_key)` frozen dataclass; `resolve_supabase_credentials(settings, env=None) -> SupabaseCredentials` raising `AuthConfigError`; `SUPABASE_PUBLISHABLE_KEY_ENV = "FW_SUPABASE_PUBLISHABLE_KEY"`, `SUPABASE_SECRET_KEY_ENV = "FW_SUPABASE_SECRET_KEY"`.

- [ ] **Step 1: Add dependencies**

In `backend/pyproject.toml`, change `"pyjwt>=2.10.0"` to `"pyjwt[crypto]>=2.10.0"` and add `"supabase-auth>=2.31"` to `dependencies`. Then from `backend/`:

```bash
uv lock && uv sync
```

- [ ] **Step 2: Regenerate third-party notices**

From the repo root: `uv run --project backend python scripts/collect-licenses.py`, then `git diff --stat THIRD-PARTY-NOTICES.md`. The collector's authoritative run is linux (CI's `licenses` job); if the macOS output differs from CI expectations the CI job will say so on push — commit whatever the local run produces and reconcile on CI feedback (this matched reality for every previous dependency bump).

- [ ] **Step 3: Write the failing tests**

`backend/tests/test_supabase_auth.py`:

```python
"""Supabase-mode configuration and token verification (B14 #55)."""

import pytest

from app.core.auth import AuthConfigError
from app.core.config import Settings
from app.core.supabase_auth import (
    SUPABASE_PUBLISHABLE_KEY_ENV,
    SUPABASE_SECRET_KEY_ENV,
    SupabaseCredentials,
    resolve_supabase_credentials,
)

URL = "https://unit-test-project.invalid"

ENV_OK = {
    SUPABASE_PUBLISHABLE_KEY_ENV: "sb_publishable_unit_test",
    SUPABASE_SECRET_KEY_ENV: "sb_secret_unit_test",
}


def supabase_settings(tmp_path, url=URL):
    return Settings(
        db_path=tmp_path / "test.db",
        auth={"mode": "supabase", "supabase": {"url": url}},
    )


class TestResolveCredentials:
    def test_resolves_all_three_values(self, tmp_path):
        creds = resolve_supabase_credentials(supabase_settings(tmp_path), env=ENV_OK)
        assert creds == SupabaseCredentials(
            url=URL,
            publishable_key="sb_publishable_unit_test",
            secret_key="sb_secret_unit_test",
        )

    def test_trailing_slash_is_stripped(self, tmp_path):
        creds = resolve_supabase_credentials(
            supabase_settings(tmp_path, url=URL + "/"), env=ENV_OK
        )
        assert creds.url == URL

    def test_missing_url_fails_closed(self, tmp_path):
        settings = Settings(db_path=tmp_path / "test.db", auth={"mode": "supabase"})
        with pytest.raises(AuthConfigError, match="auth.supabase.url"):
            resolve_supabase_credentials(settings, env=ENV_OK)

    @pytest.mark.parametrize("missing", [SUPABASE_PUBLISHABLE_KEY_ENV, SUPABASE_SECRET_KEY_ENV])
    def test_missing_key_names_the_variable_not_the_value(self, tmp_path, missing):
        env = {k: v for k, v in ENV_OK.items() if k != missing}
        with pytest.raises(AuthConfigError) as excinfo:
            resolve_supabase_credentials(supabase_settings(tmp_path), env=env)
        assert missing in str(excinfo.value)
        assert "sb_" not in str(excinfo.value)  # never echo key material

    def test_unknown_supabase_key_fails_loudly(self, tmp_path):
        with pytest.raises(Exception):  # pydantic ValidationError: extra="forbid"
            Settings(
                db_path=tmp_path / "test.db",
                auth={"mode": "supabase", "supabase": {"url": URL, "tpyo": 1}},
            )
```

- [ ] **Step 4: Run tests to verify they fail**

Run (from `backend/`): `uv run pytest tests/test_supabase_auth.py -n0 -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.core.supabase_auth'`.

- [ ] **Step 5: Implement settings and resolution**

`backend/app/core/config.py` — inside `AuthSettings` (after the existing three fields), plus the new nested model directly above `AuthSettings`:

```python
class SupabaseSettings(BaseModel):
    # The hosted project's URL (https://<ref>.supabase.co) — public
    # knowledge, not a secret; the two FW_SUPABASE_* keys are env-only.
    model_config = ConfigDict(extra="forbid")

    url: str
```

```python
    # Present iff mode == "supabase"; resolve_supabase_credentials enforces.
    supabase: SupabaseSettings | None = None
```

`backend/app/core/supabase_auth.py`:

```python
"""Supabase-mode authentication: configuration and token verification.

Identity only: Supabase authenticates who the caller is; every
authorization decision (is_admin, tier, is_active) stays with the local
users table, so nothing in a Supabase JWT's claims can grant privileges.
"""

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass

from app.core.auth import AuthConfigError
from app.core.config import Settings

logger = logging.getLogger(__name__)

SUPABASE_PUBLISHABLE_KEY_ENV = "FW_SUPABASE_PUBLISHABLE_KEY"
SUPABASE_SECRET_KEY_ENV = "FW_SUPABASE_SECRET_KEY"


@dataclass(frozen=True)
class SupabaseCredentials:
    url: str              # normalized: no trailing slash
    publishable_key: str  # user-flow GoTrue calls
    secret_key: str       # admin API only; never leaves the backend


def resolve_supabase_credentials(
    settings: Settings, env: Mapping[str, str] | None = None
) -> SupabaseCredentials:
    """Fail-closed startup gate for supabase mode.

    Messages name the missing variable, never any value: a config error
    report must not become a credential at rest in a log file.
    """
    supabase = settings.auth.supabase
    if supabase is None or not supabase.url.strip():
        raise AuthConfigError(
            "auth.mode is 'supabase' but auth.supabase.url is not configured"
        )
    environ = os.environ if env is None else env
    publishable = environ.get(SUPABASE_PUBLISHABLE_KEY_ENV, "")
    secret = environ.get(SUPABASE_SECRET_KEY_ENV, "")
    if not publishable:
        raise AuthConfigError(f"{SUPABASE_PUBLISHABLE_KEY_ENV} is unset")
    if not secret:
        raise AuthConfigError(f"{SUPABASE_SECRET_KEY_ENV} is unset")
    return SupabaseCredentials(
        url=supabase.url.strip().rstrip("/"),
        publishable_key=publishable,
        secret_key=secret,
    )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_supabase_auth.py -n0 -q` — expected PASS. Then the full gate: `uv run pytest -q` (zero warnings).

- [ ] **Step 7: Mutation-verify**

Comment out the `rstrip("/")` call → `test_trailing_slash_is_stripped` fails. Comment out the `if not publishable` guard → `test_missing_key_names_the_variable_not_the_value[FW_SUPABASE_PUBLISHABLE_KEY]` fails. Restore both, re-run, green.

- [ ] **Step 8: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock THIRD-PARTY-NOTICES.md backend/app/core/config.py backend/app/core/supabase_auth.py backend/tests/test_supabase_auth.py
git commit -m "feat(auth): supabase-mode settings + fail-closed credential resolution (B14, #55)"
```

---

### Task 2: UserStore external-id support + SupabaseTokenVerifier

**Files:**
- Modify: `backend/app/services/users.py` (`create_user`, new `get_by_external_id`, new `mark_password_changed`)
- Modify: `backend/app/core/supabase_auth.py` (verifier + resolution helper)
- Test: `backend/tests/test_supabase_auth.py` (extend), `backend/tests/fakes_supabase.py` (create `StaticJWKSClient`)

**Interfaces:**
- Consumes: `SupabaseCredentials` (Task 1); `VerifiedToken`, `InvalidToken`, `IAT_LEEWAY_SECONDS` (`core/auth.py`); `UserStore` (`services/users.py`).
- Produces:
  - `UserStore.get_by_external_id(external_id: str) -> User | None`
  - `UserStore.create_user(..., external_id: str | None = None)` (INSERT carries the column)
  - `UserStore.mark_password_changed(user_id: int) -> bool` (sets `password_changed_at=_utcnow()`, bumps `token_epoch`, touches no hash)
  - `resolve_supabase_user(store: UserStore, *, subject: str, email: str | None) -> User` (module function; raises `InvalidToken`) — shared by the verifier and Task 4's login route
  - `SupabaseTokenVerifier(url: str, user_store: UserStore, *, jwks_client=None)` with `verify(token) -> VerifiedToken` (satisfies the `TokenVerifier` protocol; `epoch=None` always)

- [ ] **Step 1: Write the failing store tests** (append to `test_supabase_auth.py`)

```python
from app.services.users import UserStore


class TestUserStoreExternalId:
    def test_create_and_get_by_external_id(self, tmp_path):
        store = UserStore(tmp_path / "u.db")
        created = store.create_user(
            "a@example.com", None, external_id="uuid-1", tier="basic"
        )
        fetched = store.get_by_external_id("uuid-1")
        assert fetched is not None and fetched.id == created.id
        assert store.get_by_external_id("uuid-absent") is None

    def test_mark_password_changed_sets_timestamp_without_hash(self, tmp_path):
        store = UserStore(tmp_path / "u.db")
        user = store.create_user("a@example.com", None, external_id="uuid-1")
        assert user.password_changed_at is None
        assert store.mark_password_changed(user.id) is True
        after = store.get_user(user.id)
        assert after.password_changed_at is not None
        assert store.verify_credentials("a@example.com", "anything") is None
```

(`User.password_changed_at` is already exposed on the model — confirm; if not, expose it read-only alongside `external_id`.)

- [ ] **Step 2: Run to verify failure**

`uv run pytest tests/test_supabase_auth.py -n0 -q` → FAIL: `create_user() got an unexpected keyword argument 'external_id'`.

- [ ] **Step 3: Implement the store changes**

In `users.py` `create_user`: add keyword-only `external_id: str | None = None`; extend the INSERT column list with `external_id` and the values tuple with `external_id` (keep order aligned). Add:

```python
    def get_by_external_id(self, external_id: str) -> User | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE external_id = ?", (external_id,)
            ).fetchone()
        return _row_to_user(row) if row is not None else None

    def mark_password_changed(self, user_id: int) -> bool:
        # Supabase-mode revocation lever: the password itself lives with
        # Supabase; locally only the timestamp (checked by deps.py's
        # epoch-less fallback) and the epoch (harmless here, exact for any
        # residual local tokens) move.
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_changed_at = ?,"
                " token_epoch = token_epoch + 1 WHERE id = ?",
                (_utcnow(), user_id),
            )
        return cursor.rowcount > 0
```

- [ ] **Step 4: Run store tests** → PASS.

- [ ] **Step 5: Write the failing verifier tests**

`backend/tests/fakes_supabase.py`:

```python
"""Shared supabase-mode test doubles: static JWKS + fake gateway (Task 4)."""

import jwt


class StaticJWKSClient:
    """Duck-types PyJWKClient.get_signing_key_from_jwt for a fixed key set.

    Keys: mapping kid -> public-key object. Unknown kid raises
    PyJWKClientError exactly like the real client after a failed refetch.
    """

    def __init__(self, keys):
        self.keys = keys
        self.calls = 0

    def get_signing_key_from_jwt(self, token: str):
        self.calls += 1
        kid = jwt.get_unverified_header(token).get("kid")
        if kid not in self.keys:
            raise jwt.exceptions.PyJWKClientError(f"Unable to find kid {kid!r}")

        class _Key:
            def __init__(self, key):
                self.key = key

        return _Key(self.keys[kid])
```

Append to `test_supabase_auth.py`:

```python
import time

from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, generate_private_key

from app.core.auth import InvalidToken
from app.core.supabase_auth import SupabaseTokenVerifier
from tests.fakes_supabase import StaticJWKSClient


def es256_keypair():
    private = generate_private_key(SECP256R1())
    return private, private.public_key()


def mint(private, *, kid="kid-1", url=URL, sub="uuid-1", email="a@example.com", **over):
    claims = {
        "sub": sub,
        "email": email,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
        "iss": f"{url}/auth/v1",
        "aud": "authenticated",
    }
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, private, algorithm="ES256", headers={"kid": kid})


@pytest.fixture()
def verifier_setup(tmp_path):
    private, public = es256_keypair()
    store = UserStore(tmp_path / "v.db")
    jwks = StaticJWKSClient({"kid-1": public})
    verifier = SupabaseTokenVerifier(URL, store, jwks_client=jwks)
    return private, store, verifier


class TestSupabaseTokenVerifier:
    def test_valid_token_resolves_linked_user(self, verifier_setup):
        private, store, verifier = verifier_setup
        user = store.create_user("a@example.com", None, external_id="uuid-1")
        verified = verifier.verify(mint(private))
        assert verified.user_id == user.id
        assert verified.epoch is None

    def test_unknown_subject_jit_provisions_default_tier_non_admin(self, verifier_setup):
        private, store, verifier = verifier_setup
        verified = verifier.verify(mint(private, sub="uuid-new", email="new@example.com"))
        row = store.get_by_external_id("uuid-new")
        assert row is not None and verified.user_id == row.id
        assert row.tier == "basic" and row.is_admin is False and row.is_active is True
        assert row.email == "new@example.com"

    def test_jit_links_existing_unlinked_local_user_by_email(self, verifier_setup):
        # A pre-existing local-mode account adopting its Supabase identity.
        private, store, verifier = verifier_setup
        local = store.create_user("a@example.com", "local-password-1", tier="premium")
        verified = verifier.verify(mint(private, sub="uuid-9"))
        assert verified.user_id == local.id
        assert store.get_user(local.id).external_id == "uuid-9"
        assert store.get_user(local.id).tier == "premium"  # authority untouched

    def test_email_collision_with_different_subject_fails_closed(self, verifier_setup):
        private, store, verifier = verifier_setup
        store.create_user("a@example.com", None, external_id="uuid-other")
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, sub="uuid-1"))

    def test_missing_email_claim_on_unknown_subject_fails_closed(self, verifier_setup):
        private, store, verifier = verifier_setup
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, sub="uuid-new", email=None))

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"exp": int(time.time()) - 10},
            {"iss": "https://evil.invalid/auth/v1"},
            {"aud": "anon"},
            {"iat": int(time.time()) + 3600},  # beyond IAT_LEEWAY_SECONDS
        ],
    )
    def test_bad_claims_rejected(self, verifier_setup, kwargs):
        private, store, verifier = verifier_setup
        store.create_user("a@example.com", None, external_id="uuid-1")
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, **kwargs))

    def test_hs256_token_rejected(self, verifier_setup):
        _, store, verifier = verifier_setup
        store.create_user("a@example.com", None, external_id="uuid-1")
        forged = jwt.encode(
            {"sub": "uuid-1", "iat": int(time.time()), "exp": int(time.time()) + 60,
             "iss": f"{URL}/auth/v1", "aud": "authenticated"},
            "any-shared-secret", algorithm="HS256", headers={"kid": "kid-1"},
        )
        with pytest.raises(InvalidToken):
            verifier.verify(forged)

    def test_unknown_kid_rejected(self, verifier_setup):
        private, store, verifier = verifier_setup
        with pytest.raises(InvalidToken):
            verifier.verify(mint(private, kid="kid-unknown"))

    def test_wrong_key_signature_rejected(self, verifier_setup):
        _, store, verifier = verifier_setup
        other_private, _ = es256_keypair()
        with pytest.raises(InvalidToken):
            verifier.verify(mint(other_private))
```

- [ ] **Step 6: Run to verify failure** → FAIL: `ImportError: cannot import name 'SupabaseTokenVerifier'`.

- [ ] **Step 7: Implement the verifier** (append to `core/supabase_auth.py`)

```python
from datetime import UTC, datetime

import jwt

from app.core.auth import IAT_LEEWAY_SECONDS, InvalidToken, VerifiedToken
from app.services.users import DuplicateEmailError, UserStore

SUPABASE_AUDIENCE = "authenticated"
_JWKS_CACHE_SECONDS = 600  # matches Supabase's own edge-cache guidance


def resolve_supabase_user(
    store: UserStore, *, subject: str, email: str | None
) -> "User":
    """Map a verified Supabase subject UUID to the local user row.

    Order matters: external_id first (the common case), then adopt-by-email
    (a pre-Supabase local account logging in through Supabase for the first
    time), then JIT-create (an invited user's first login). An email owned
    by a row already linked to a DIFFERENT subject fails closed — one local
    account never serves two Supabase identities.
    """
    user = store.get_by_external_id(subject)
    if user is not None:
        return user
    if email:
        existing = store.get_by_email(email)
        if existing is not None:
            if existing.external_id is not None:
                raise InvalidToken("email belongs to a different subject")
            return store.update_user(existing.id, external_id=subject)
    if not email:
        raise InvalidToken("token carries no email; cannot provision")
    try:
        return store.create_user(email, None, external_id=subject)
    except DuplicateEmailError as exc:  # lost a concurrent-provision race
        raced = store.get_by_external_id(subject)
        if raced is not None:
            return raced
        raise InvalidToken("provisioning race lost") from exc


class SupabaseTokenVerifier:
    """Verifies Supabase-issued JWTs locally (auth.mode: supabase).

    JWKS is fetched lazily on first use and cached (PyJWKClient); a
    misconfigured URL therefore surfaces on the first login attempt, in the
    server log, not at startup — a Supabase outage must not wedge container
    restarts. Requests fail closed (401) until the key set is reachable.
    """

    def __init__(self, url: str, user_store: UserStore, *, jwks_client=None) -> None:
        self._issuer = f"{url}/auth/v1"
        self._store = user_store
        self._jwks = jwks_client or jwt.PyJWKClient(
            f"{url}/auth/v1/.well-known/jwks.json",
            cache_keys=True,
            lifespan=_JWKS_CACHE_SECONDS,
        )

    def verify(self, token: str) -> VerifiedToken:
        try:
            key = self._jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                key.key,
                algorithms=["ES256", "RS256"],  # asymmetric only, never HS256
                issuer=self._issuer,
                audience=SUPABASE_AUDIENCE,
                options={
                    "require": ["sub", "exp", "iat", "iss", "aud"],
                    "verify_iat": False,  # explicit leeway check below
                },
            )
        except (jwt.PyJWTError, RecursionError) as exc:
            # PyJWKClientError (unknown kid, unreachable JWKS) subclasses
            # PyJWTError, so network failure fails closed right here.
            raise InvalidToken(str(exc)) from exc
        try:
            issued_at = datetime.fromtimestamp(float(claims["iat"]), UTC)
        except (TypeError, ValueError, OverflowError, OSError) as exc:
            raise InvalidToken("iat is not a usable timestamp") from exc
        if issued_at.timestamp() - datetime.now(UTC).timestamp() > IAT_LEEWAY_SECONDS:
            raise InvalidToken("token issued too far in the future")
        subject = claims["sub"]
        if not isinstance(subject, str) or not subject:
            raise InvalidToken("sub is not a subject id")
        email = claims.get("email")
        if email is not None and not isinstance(email, str):
            raise InvalidToken("email claim is not a string")
        user = resolve_supabase_user(self._store, subject=subject, email=email)
        # epoch=None routes deps.py to its iat-vs-password_changed_at
        # fallback — the revocation contract for this verifier.
        return VerifiedToken(user_id=user.id, issued_at=issued_at, epoch=None)
```

(Import `User` under `TYPE_CHECKING` for the annotation, or quote it as shown.)

- [ ] **Step 8: Run tests** → PASS; then full `uv run pytest -q` (zero warnings).

- [ ] **Step 9: Mutation-verify**

(a) In `resolve_supabase_user`, drop the `existing.external_id is not None` guard → `test_email_collision_with_different_subject_fails_closed` fails. (b) In `verify`, change `algorithms=["ES256", "RS256"]` to `["ES256", "RS256", "HS256"]` → `test_hs256_token_rejected` fails. (c) Remove `issuer=self._issuer` → wrong-`iss` param case fails. Restore all, green.

- [ ] **Step 10: Commit**

```bash
git add backend/app/services/users.py backend/app/core/supabase_auth.py backend/tests/test_supabase_auth.py backend/tests/fakes_supabase.py
git commit -m "feat(auth): SupabaseTokenVerifier — local JWKS verification, external_id resolution, JIT shadow rows (B14, #55)"
```

---

### Task 3: SupabaseAuthGateway service

**Files:**
- Create: `backend/app/services/supabase_gateway.py`
- Test: `backend/tests/test_supabase_gateway.py`

**Interfaces:**
- Consumes: `SupabaseCredentials` (Task 1); `supabase_auth` package.
- Produces (this exact surface is what Tasks 4-5 and the fake implement):

```python
@dataclass(frozen=True)
class SupabaseSession:
    access_token: str
    refresh_token: str
    expires_at: int | None   # epoch seconds
    user_id: str             # Supabase UUID
    email: str | None

class SupabaseAuthError(Exception): ...        # invalid credentials/token/link
class SupabaseUnavailableError(Exception): ... # network / 5xx / timeouts

class SupabaseAuthGateway:
    def __init__(self, credentials: SupabaseCredentials) -> None: ...
    async def sign_in(self, email: str, password: str) -> SupabaseSession
    async def refresh(self, refresh_token: str) -> SupabaseSession
    async def sign_out(self, access_token: str) -> None            # scope="local"
    async def global_sign_out(self, access_token: str) -> None     # scope="global"
    async def change_password(self, user_id: str, new_password: str) -> None
    async def send_reset_email(self, email: str) -> None
    async def confirm_with_token_hash(
        self, token_hash: str, type_: str, new_password: str
    ) -> SupabaseSession   # verify_otp then password update; session returned for revocation
    async def create_user(self, email: str, password: str) -> str  # returns UUID
    async def invite_user(self, email: str) -> str                 # returns UUID
    async def get_user_id_by_email(self, email: str) -> str | None # bootstrap link path
```

**Design rules:**
- Per-operation GoTrue client instances (`persist_session=False`, `auto_refresh_token=False`) and per-operation `httpx.AsyncClient` (async-context-managed) — never a client shared across event loops, because `seed_admin` (Task 5) drives this gateway from `asyncio.run()` in a different loop than uvicorn's.
- User-flow client: base URL `f"{credentials.url}/auth/v1"`, headers `{"apikey": credentials.publishable_key}`. Admin API: same base URL, headers `{"apikey": credentials.secret_key, "Authorization": f"Bearer {credentials.secret_key}"}`.
- Error mapping in ONE private helper: the library's `AuthApiError` (4xx semantics) → `SupabaseAuthError(str(exc))`; `AuthRetryableError`, `httpx.HTTPError`, timeouts → `SupabaseUnavailableError(str(exc))`. Callers log; messages never reach HTTP responses (Task 4 maps to generic 401/503).
- `confirm_with_token_hash`: `verify_otp({"token_hash": token_hash, "type": type_})` → session; then admin `update_user_by_id(session.user_id, {"password": new_password})`; return the session (Task 4 revokes it via `global_sign_out`).
- `get_user_id_by_email`: page through admin `list_users` (`per_page=100`) comparing case-insensitively; return `None` when exhausted. Bootstrap-only path — an O(pages) walk is fine.
- Verify every library call name/signature against the installed package first (see the risk note in File Structure) and adjust mechanically if needed.

- [ ] **Step 1: Write the failing tests**

`backend/tests/test_supabase_gateway.py` — the real library exercised against canned GoTrue responses via `httpx.MockTransport`; no sockets. Verify with the installed package how to inject the transport (both `AsyncGoTrueClient` and `AsyncGoTrueAdminAPI` accept an `http_client: httpx.AsyncClient`; construct those with `httpx.AsyncClient(transport=mock_transport)`). The gateway constructor therefore accepts a test-only `transport: httpx.AsyncTransport | None = None` keyword it threads into every client it builds.

```python
"""SupabaseAuthGateway over canned GoTrue responses (httpx.MockTransport)."""

import json

import httpx
import pytest

from app.core.supabase_auth import SupabaseCredentials
from app.services.supabase_gateway import (
    SupabaseAuthError,
    SupabaseAuthGateway,
    SupabaseSession,
    SupabaseUnavailableError,
)

CREDS = SupabaseCredentials(
    url="https://gw-test.invalid",
    publishable_key="sb_publishable_gw",
    secret_key="sb_secret_gw",
)

SESSION_JSON = {
    "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600,
    "expires_at": 1_900_000_000, "token_type": "bearer",
    "user": {"id": "uuid-1", "email": "a@example.com", "aud": "authenticated",
             "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"},
}


def gateway_with(handler):
    return SupabaseAuthGateway(CREDS, transport=httpx.MockTransport(handler))


class TestSignIn:
    @pytest.mark.anyio
    async def test_success_maps_session(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["apikey"] = request.headers.get("apikey")
            return httpx.Response(200, json=SESSION_JSON)

        session = await gateway_with(handler).sign_in("a@example.com", "pw")
        assert session == SupabaseSession(
            access_token="at-1", refresh_token="rt-1",
            expires_at=1_900_000_000, user_id="uuid-1", email="a@example.com",
        )
        assert "/auth/v1/token" in seen["url"] and "grant_type=password" in seen["url"]
        assert seen["apikey"] == "sb_publishable_gw"  # user flow: publishable key

    @pytest.mark.anyio
    async def test_invalid_credentials_raise_auth_error(self):
        def handler(request):
            return httpx.Response(400, json={
                "error_code": "invalid_credentials",
                "code": 400, "msg": "Invalid login credentials",
            })

        with pytest.raises(SupabaseAuthError):
            await gateway_with(handler).sign_in("a@example.com", "wrong")

    @pytest.mark.anyio
    async def test_network_failure_raises_unavailable(self):
        def handler(request):
            raise httpx.ConnectError("boom")

        with pytest.raises(SupabaseUnavailableError):
            await gateway_with(handler).sign_in("a@example.com", "pw")


class TestAdminCalls:
    @pytest.mark.anyio
    async def test_create_user_uses_secret_key_and_returns_uuid(self):
        seen = {}

        def handler(request):
            seen["auth"] = request.headers.get("Authorization")
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json=SESSION_JSON["user"])

        uuid = await gateway_with(handler).create_user("a@example.com", "pw-12chars-min")
        assert uuid == "uuid-1"
        assert seen["auth"] == "Bearer sb_secret_gw"
        assert seen["body"].get("email_confirm") is True

    @pytest.mark.anyio
    async def test_invite_user_returns_uuid(self):
        def handler(request):
            assert request.url.path.endswith("/invite")
            return httpx.Response(200, json=SESSION_JSON["user"])

        assert await gateway_with(handler).invite_user("a@example.com") == "uuid-1"

    @pytest.mark.anyio
    async def test_get_user_id_by_email_pages_until_found(self):
        calls = []

        def handler(request):
            page = int(dict(request.url.params).get("page", "1"))
            calls.append(page)
            users = (
                [{**SESSION_JSON["user"], "id": "uuid-x", "email": "x@example.com"}]
                if page == 1
                else [{**SESSION_JSON["user"], "id": "uuid-1", "email": "A@example.com"}]
                if page == 2
                else []
            )
            return httpx.Response(200, json={"users": users, "aud": "authenticated"})

        found = await gateway_with(handler).get_user_id_by_email("a@example.com")
        assert found == "uuid-1" and calls == [1, 2]

    @pytest.mark.anyio
    async def test_get_user_id_by_email_exhausts_to_none(self):
        def handler(request):
            return httpx.Response(200, json={"users": [], "aud": "authenticated"})

        assert await gateway_with(handler).get_user_id_by_email("a@example.com") is None


class TestConfirm:
    @pytest.mark.anyio
    async def test_confirm_verifies_then_updates_password(self):
        order = []

        def handler(request):
            if request.url.path.endswith("/verify"):
                order.append("verify")
                return httpx.Response(200, json=SESSION_JSON)
            order.append("update")
            assert request.url.path.endswith("/admin/users/uuid-1")
            assert json.loads(request.content)["password"] == "new-password-1"
            return httpx.Response(200, json=SESSION_JSON["user"])

        session = await gateway_with(handler).confirm_with_token_hash(
            "hash-1", "recovery", "new-password-1"
        )
        assert order == ["verify", "update"]
        assert session.access_token == "at-1"
```

Add `anyio_backend` fixture (or reuse the repo's existing async-test convention — check how other async tests run; if none exists, add `pytest.ini`-free `@pytest.mark.anyio` with the `anyio` plugin that FastAPI already ships, pinning backend to asyncio via a module-level `anyio_backend` fixture returning `"asyncio"`).

- [ ] **Step 2: Run to verify failure** → FAIL: module not found.

- [ ] **Step 3: Implement the gateway** per the Design rules above. Skeleton:

```python
"""Server-side Supabase Auth gateway (auth.mode: supabase).

Every method builds its own short-lived GoTrue client around a fresh
httpx.AsyncClient: seed_admin drives this from its own event loop via
asyncio.run(), so no connection pool may outlive one operation. Auth
operations are rare; the per-call handshake is irrelevant next to bcrypt.
"""
import logging
from dataclasses import dataclass

import httpx
from supabase_auth import AsyncGoTrueAdminAPI, AsyncGoTrueClient
from supabase_auth.errors import AuthApiError, AuthError, AuthRetryableError

from app.core.supabase_auth import SupabaseCredentials

logger = logging.getLogger(__name__)
```

with `_user_client()` / `_admin_client()` async-context helpers, the error-mapping helper wrapping every library call, and `_to_session(response) -> SupabaseSession` translating the library's `Session` model. Adjust library names to the installed package where they differ; the tests above pin the wire behavior, not the library internals.

- [ ] **Step 4: Run tests** → PASS; full suite `uv run pytest -q` zero warnings.

- [ ] **Step 5: Mutation-verify**

(a) Swap the admin header to the publishable key → `test_create_user_uses_secret_key_and_returns_uuid` fails. (b) Make the error mapper raise `SupabaseAuthError` for `httpx.ConnectError` → `test_network_failure_raises_unavailable` fails. Restore, green.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/supabase_gateway.py backend/tests/test_supabase_gateway.py
git commit -m "feat(auth): SupabaseAuthGateway over supabase-auth — per-op clients, typed errors (B14, #55)"
```

---

### Task 4: Mode wiring + supabase auth routes

**Files:**
- Modify: `backend/app/main.py:132-141` (mode dispatch), health route
- Modify: `backend/app/api/auth.py` (routes + `LoginResponse`)
- Modify: `backend/tests/test_auth_enforcement.py` (allowlist)
- Modify: `backend/tests/fakes_supabase.py` (add `FakeSupabaseGateway`)
- Test: `backend/tests/test_auth_supabase_api.py`

**Interfaces:**
- Consumes: Tasks 1-3 surfaces verbatim.
- Produces: routes per the table below; `LoginResponse` gains `refresh_token: str | None = None`, `expires_at: int | None = None`; `/api/health` gains `"auth_features": {"password_reset": bool, "invites": bool}` (both `true` iff supabase mode); `app.state.supabase_gateway` in supabase mode.

**main.py wiring** (replaces the `auth.mode != "local"` guard at `main.py:132-135`):

```python
    app.state.user_store = UserStore(settings.db_path)
    if settings.auth.mode == "supabase":
        credentials = resolve_supabase_credentials(settings)
        app.state.supabase_gateway = SupabaseAuthGateway(credentials)
        app.state.token_verifier = SupabaseTokenVerifier(
            credentials.url, app.state.user_store
        )
    else:
        app.state.auth_secret = resolve_auth_secret(
            ephemeral_ok=settings.auth.ephemeral_secret
        )
        app.state.token_verifier = LocalTokenVerifier(app.state.auth_secret)
    app.state.login_throttle = LoginThrottle()
```

Health route becomes:

```python
    @app.get("/api/health")
    def health() -> dict[str, object]:
        supabase = settings.auth.mode == "supabase"
        return {
            "status": "ok",
            "name": APP_NAME,
            "version": os.environ.get("FW_APP_VERSION", "dev"),
            "auth_features": {"password_reset": supabase, "invites": supabase},
        }
```

**Route table (auth.py).** `_require_supabase_mode(request)` mirrors `_require_local_mode` (404 when mode is `"local"`). All new handlers are `async def` (the gateway is async); existing local handlers stay sync.

| Route | Public | Body model | Behavior |
|---|---|---|---|
| `POST /auth/login` | yes | existing `LoginRequest` | supabase branch: throttle check exactly as local → `await gateway.sign_in` → `SupabaseAuthError` ⇒ `record_failure` + 401 `_INVALID_LOGIN`; `SupabaseUnavailableError` ⇒ 503 `"Authentication service unavailable"` → `resolve_supabase_user(...)` → inactive user ⇒ `record_failure` + 401 → `record_success`, respond `LoginResponse(token=s.access_token, refresh_token=s.refresh_token, expires_at=s.expires_at, user=MeResponse.from_user(...))` |
| `POST /auth/refresh` | yes | `RefreshRequest(refresh_token: str, max_length=8192)` | supabase-only. `gateway.refresh` → auth error ⇒ generic 401; unavailable ⇒ 503 → resolve user (NO JIT here — refresh of a never-logged-in subject is a 401: pass `email=None`... no: reuse `resolve_supabase_user` with the session's email; a refreshed session implies a prior login, JIT is harmless and keeps one code path) → inactive ⇒ 401 → `LoginResponse`. No throttle: refresh tokens are 256-bit random, GoTrue rate-limits, and a throttle keyed by IP would let one NAT starve a building. |
| `POST /auth/logout` | bearer | none | supabase-only. Raw token from the `Authorization` header (`request.headers`); `await gateway.sign_out(raw)` inside `try/except (SupabaseAuthError, SupabaseUnavailableError): pass` — revocation is best-effort, the frontend clears locally regardless. 204 always. |
| `POST /auth/password` | bearer | existing `PasswordChange` | supabase branch: `gateway.sign_in(current.email, body.current)` → `SupabaseAuthError` ⇒ 422 `{"code": "wrong_current_password"}`; unavailable ⇒ 503 → `validate_password(body.new, min_length=SELF_MIN_PASSWORD_LENGTH)` with the same 422 code recovery as local → `user = store.get_user(current.id)`; `gateway.change_password(user.external_id, body.new)` → `store.mark_password_changed(current.id)` → `gateway.global_sign_out(raw_token)` best-effort (`except SupabaseUnavailableError: logger.warning(...)` — the local `password_changed_at` bump already revoked every outstanding access token at our layer) → 204 |
| `POST /auth/reset-request` | yes | `ResetRequest(email: str, max_length=320)` | supabase-only. Throttle: if `blocked_for(key) > 0` ⇒ `record_blocked_attempt`, respond 204 WITHOUT calling the gateway (silent — enumeration-resistant and mail-bomb-resistant); else `record_failure(key)` unconditionally (each request costs one slot; success never resets — resets are rare) then `gateway.send_reset_email` with both error types swallowed to 204. Always 204. |
| `POST /auth/reset-confirm` | yes | `ResetConfirm(token_hash: str (max_length=1024), type: Literal["recovery", "invite"], new_password: str)` | supabase-only. `validate_password(new_password, min_length=SELF_MIN_PASSWORD_LENGTH)` ⇒ 422 codes as local → `session = await gateway.confirm_with_token_hash(...)` → `SupabaseAuthError` ⇒ 422 `{"code": "invalid_or_expired_link"}`; unavailable ⇒ 503 → `resolve_supabase_user(store, subject=session.user_id, email=session.email)` (JIT: this IS the invite-acceptance materialization point) → `store.mark_password_changed(user.id)` → `gateway.global_sign_out(session.access_token)` best-effort → 204. The user then signs in normally with the new password. |

`LoginResponse`:

```python
class LoginResponse(BaseModel):
    token: str
    # Supabase mode only; local mode leaves both None and the frontend
    # treats their absence as "this session never refreshes".
    refresh_token: str | None = None
    expires_at: int | None = None
    user: MeResponse
```

**Enforcement allowlist** (`test_auth_enforcement.py`): extend the public set to

```python
{("/api/health", "GET"), ("/api/auth/login", "POST"), ("/api/auth/refresh", "POST"),
 ("/api/auth/reset-request", "POST"), ("/api/auth/reset-confirm", "POST")}
```

**`FakeSupabaseGateway`** (append to `tests/fakes_supabase.py`): in-memory `dict[email → (password, uuid)]` plus counters; deterministic tokens `f"fake-access-{n}"`/`f"fake-refresh-{n}"`; `expires_at=2_000_000_000`; records `global_sign_out_calls`, `sign_out_calls`, `reset_emails: list[str]`, `invites: list[str]`; `confirm_with_token_hash` accepts any token_hash present in its `valid_token_hashes: dict[hash → (uuid, email)]` map and updates the stored password; raises `SupabaseAuthError` otherwise. Async methods (`async def`) mirroring the Task 3 interface exactly.

**Test fixture** (`test_auth_supabase_api.py`):

```python
@pytest.fixture()
def supabase_app(tmp_path, monkeypatch):
    monkeypatch.setenv("FW_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_t")
    monkeypatch.setenv("FW_SUPABASE_SECRET_KEY", "sb_secret_t")
    settings = Settings(
        db_path=tmp_path / "t.db",
        auth={"mode": "supabase", "supabase": {"url": "https://api-test.invalid"}},
    )
    app = create_app(settings)
    fake = FakeSupabaseGateway()
    app.state.supabase_gateway = fake
    # Route tests authenticate via the fake's tokens; swap the verifier for
    # one that resolves them (no network: the real verifier is never given
    # a chance to fetch JWKS).
    app.state.token_verifier = FakeSupabaseVerifier(fake, app.state.user_store)
    return app, fake
```

with `FakeSupabaseVerifier.verify(token)` looking the token up in the fake's issued-session map and returning `VerifiedToken(user_id=resolve_supabase_user(...).id, issued_at=<the fake's per-token mint time>, epoch=None)`. **Note:** `create_app` in supabase mode reaches `seed_admin` (Task 5 makes it supabase-aware; until then it would try the local path). To keep Task 4 self-contained, this fixture also sets `FW_ADMIN_EMAIL`/`FW_ADMIN_PASSWORD` (conftest already does session-wide) and tolerates the seeded local-style admin row — tests here operate on additional users created directly via `app.state.user_store`. Task 5 revisits.

**Tests to write** (each is a small focused test in classes by route): login success returns triple + user; login wrong password → 401 generic + throttle counted; login while throttled → 401 without gateway call (`fake.sign_in_calls` unchanged); login when unavailable → 503; inactive user login → 401; refresh success rotates tokens; refresh invalid → 401; logout → 204 + `sign_out_calls == [token]`; logout with gateway down → still 204; password change happy path → 204, `mark_password_changed` visible (`password_changed_at` set), `global_sign_out_calls` non-empty, wrong current → 422 `wrong_current_password`, short new → 422 `password_too_short`; reset-request → always 204 (unknown email too), throttled → 204 with `fake.reset_emails` unchanged; reset-confirm valid recovery hash → 204 + password updated in fake + `password_changed_at` set + global sign-out called; invalid hash → 422 `invalid_or_expired_link`; invite-type hash for unknown subject JIT-creates the row; **mode dispatch**: every supabase-only route → 404 in a local-mode app; `POST /auth/login`'s local behavior in a local-mode app unchanged (existing tests cover; add one probe that supabase fields are `None` in local `LoginResponse`); `/api/health` `auth_features` false/false in local mode, true/true in supabase mode; **eviction integration**: authenticate with fake token minted at T, `mark_password_changed` via the password route, then the SAME token → 401 from `/api/auth/me` (this exercises deps.py's fallback with `epoch=None` end-to-end).

- [ ] **Step 1: Write the failing tests** (the list above; write them all first)
- [ ] **Step 2: Run** `uv run pytest tests/test_auth_supabase_api.py -n0 -q` → FAIL (`create_app` raises `AuthConfigError: not implemented yet`).
- [ ] **Step 3: Implement** main.py wiring, then the routes per the table, then the allowlist additions.
- [ ] **Step 4: Run the new file, then the FULL suite** — zero warnings; the enforcement walk must pass with exactly the three new allowlist entries.
- [ ] **Step 5: Mutation-verify** (a) drop the throttle check in the supabase login branch → throttled-login test fails; (b) drop `mark_password_changed` from the password route → the eviction integration test fails; (c) drop one allowlist entry → enforcement test fails (proving the walk sees the new routes). Restore, green.
- [ ] **Step 6: Commit**

```bash
git add backend/app/main.py backend/app/api/auth.py backend/tests/test_auth_enforcement.py backend/tests/fakes_supabase.py backend/tests/test_auth_supabase_api.py
git commit -m "feat(auth): supabase-mode wiring + proxied login/refresh/logout/password/reset routes (B14, #55)"
```

---

### Task 5: seed_admin supabase branch + admin invitations

**Files:**
- Modify: `backend/app/services/seed_admin.py`
- Modify: `backend/app/main.py` (seed call site)
- Modify: `backend/app/api/admin.py` (optional-password create)
- Modify: `frontend/src/api/client.ts` (`AdminUserCreate.password` optional, `AdminUser.invited?`) — type-only, admin UI affordance in Task 7
- Test: `backend/tests/test_auth_supabase_api.py` (extend), existing `backend/tests/test_admin_api.py` conventions

**Interfaces:**
- Consumes: `SupabaseAuthGateway.create_user/invite_user/get_user_id_by_email`; `UserStore.create_user(external_id=...)`.
- Produces: `seed_admin(store, env=None, *, gateway=None)` — gateway `None` = local mode (unchanged path); admin create response model gains `invited: bool = False`.

**seed_admin supabase branch** (after the env validation, replacing the single `store.create_user` call when `gateway is not None`):

```python
    if gateway is None:
        store.create_user(
            email, password, display_name="Administrator", tier="premium", is_admin=True
        )
    else:
        # Supabase owns the credential; the local row owns authority.
        # asyncio.run is safe here: create_app runs before uvicorn's loop
        # exists, and the gateway builds per-operation clients (no pool
        # crosses loops).
        import asyncio

        async def _bootstrap() -> str:
            try:
                return await gateway.create_user(email, password)
            except SupabaseAuthError:
                # Already registered (a re-run against an existing project):
                # link instead of failing.
                existing = await gateway.get_user_id_by_email(email)
                if existing is None:
                    raise
                return existing

        try:
            external_id = asyncio.run(_bootstrap())
        except (SupabaseAuthError, SupabaseUnavailableError) as exc:
            raise AuthConfigError(
                f"Supabase admin bootstrap failed: {type(exc).__name__}"
            ) from exc
        store.create_user(
            email, None, display_name="Administrator", tier="premium",
            is_admin=True, external_id=external_id,
        )
    logger.info("Seeded the initial admin account (%s)", email)
```

main.py call site: `seed_admin(app.state.user_store, gateway=getattr(app.state, "supabase_gateway", None))`.

**Admin create** (`admin.py`): the create body's `password` becomes `str | None = None`. When `None`: local mode ⇒ 422 `{"code": "password_required"}`; supabase mode ⇒ `uuid = await gateway.invite_user(body.email)` (auth error ⇒ 502 is wrong — map `SupabaseAuthError` to 422 `{"code": "invite_failed"}`, unavailable ⇒ 503), then `store.create_user(body.email, None, ..., external_id=uuid)`, audit action `"invite"`, response `invited=True`. When set: validate as today (min 12); in supabase mode `uuid = await gateway.create_user(body.email, body.password)` then local row with `external_id=uuid` and NO local hash (the credential lives with Supabase; a local hash would resurrect local login semantics); local mode unchanged. The route becomes `async def`.

**Tests:** supabase-mode `create_app` with `FakeSupabaseGateway` pre-injected is impossible for seeding (seed runs inside `create_app` before the fixture swaps state). Restructure the fixture: `seed_admin` is invoked from `create_app` — give `create_app` no seam; instead the fixture creates the supabase app with a `monkeypatch.setattr("app.main.SupabaseAuthGateway", lambda creds: FakeSupabaseGateway())` so the fake is in place from the start (and the fixture then reads it back from `app.state.supabase_gateway`). Update the Task 4 fixture to this pattern in this task. Tests: fresh supabase app seeds admin through the fake (fake records `create_user` call; local row has `external_id`, `is_admin=True`, no usable password — `verify_credentials` returns `None`); re-run against existing project (fake raises already-registered on `create_user`, returns UUID from `get_user_id_by_email`) links; bootstrap failure (fake raises unavailable) aborts `create_app` with `AuthConfigError`; admin invite: POST `/api/admin/users` without password → 204/200 with `invited=True`, fake records invite, row `external_id` set; local mode without password → 422 `password_required`; audit row action recorded; with password in supabase mode → fake `create_user` called, no local hash.

- [ ] **Step 1: failing tests** → **Step 2: run (FAIL)** → **Step 3: implement** → **Step 4: full suite green, zero warnings** → **Step 5: mutation-verify** (drop the local-row `external_id=` kwarg in seeding → link test fails; make invite path store a local hash... skip — instead drop the `invited=True` response field → invite test fails; restore) → **Step 6: commit**

```bash
git add backend/app/services/seed_admin.py backend/app/main.py backend/app/api/admin.py backend/tests/ frontend/src/api/client.ts
git commit -m "feat(auth): supabase admin bootstrap + invitation-only user entry (B14, #55)"
```

---

### Task 6: Frontend session — token triple, refresh scheduling, logout call

**Files:**
- Modify: `frontend/src/api/client.ts`, `frontend/src/state/prefsStorage.ts`, `frontend/src/state/store.ts`, `frontend/src/auth/session.ts`
- Test: `frontend/src/auth/session.test.ts` (extend), `frontend/src/state/store.test.ts` if present

**Interfaces:**
- Consumes: `LoginResponse` with `refresh_token`/`expires_at` (Task 4).
- Produces:
  - `client.ts`: `postRefresh(refreshToken: string): Promise<LoginResponse>` (`keepSessionOn401: true` — a dead refresh token must surface to the caller, which decides to expire); `postLogout(): Promise<void>`; `LoginResponse` type extended (`refresh_token: string | null`, `expires_at: number | null`).
  - `prefsStorage.ts`: `REFRESH_TOKEN_KEY = 'fabulous-writing-refresh-token'`, `TOKEN_EXPIRES_KEY = 'fabulous-writing-token-expires'`; `readRefreshToken/writeRefreshToken/clearRefreshToken`, `readTokenExpiresAt/writeTokenExpiresAt/clearTokenExpiresAt` (same try/catch localStorage pattern as the token trio; expiry stored as decimal string, read via `Number(...)` with `NaN → null`).
  - `store.ts`: `refreshToken: string | null`, `tokenExpiresAt: number | null` initialized from storage; both added to the auth-field exclusion union so `resetSessionState()` leaves them to explicit management; `setSessionTokens(token: string, refreshToken: string | null, expiresAt: number | null): void` action that writes store fields only (persistence stays in session.ts).
  - `session.ts`: `scheduleRefresh()` (module-private), exported `__testing` hooks if the existing file has that convention (it does not — drive tests through fake timers + fetch mocks instead).

**session.ts changes:**
- `login()`: destructure `{ token, refresh_token, expires_at, user }`; persist via `writeToken(token)` + `writeRefreshToken(refresh_token ?? null)` + `writeTokenExpiresAt(expires_at ?? null)` (null clears); `setAuth(token, user)` then `setSessionTokens(token, refresh_token, expires_at)`; call `scheduleRefresh()`.
- `logout()`: capture `hadToken = !!useStore.getState().token`; if `hadToken`, fire `void postLogout().catch(() => {})` BEFORE `clearToken()` (the request reads the store token at fetch time — it must still be there); then existing teardown plus `clearRefreshToken()`, `clearTokenExpiresAt()`, `cancelScheduledRefresh()`.
- `expireSession()`: existing teardown plus the two clears and `cancelScheduledRefresh()`.
- Refresh engine:

```typescript
const REFRESH_MARGIN_MS = 120_000
const REFRESH_RETRY_MS = 60_000
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<void> | null = null

function cancelScheduledRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = null
}

function scheduleRefresh(): void {
  cancelScheduledRefresh()
  const { tokenExpiresAt, refreshToken } = useStore.getState()
  if (!refreshToken || tokenExpiresAt === null) return  // local mode: never
  const delay = Math.max(tokenExpiresAt * 1000 - Date.now() - REFRESH_MARGIN_MS, 0)
  refreshTimer = setTimeout(() => { void refreshSession() }, delay)
}

/** Single-flight, generation-guarded (same discipline as runRestore). On a
 * 401 the refresh token is dead — the session ends through the same
 * expireSession() path as any other credential failure. Any other failure
 * (offline laptop waking up) retries on a fixed cadence; a request-level
 * 401 in the meantime ends the session anyway. */
export function refreshSession(): Promise<void> {
  if (!refreshInFlight) {
    const run = doRefresh().finally(() => {
      if (refreshInFlight === run) refreshInFlight = null
    })
    refreshInFlight = run
  }
  return refreshInFlight
}

async function doRefresh(): Promise<void> {
  const startedAt = generation
  const { refreshToken } = useStore.getState()
  if (!refreshToken) return
  try {
    const { token, refresh_token, expires_at } = await postRefresh(refreshToken)
    if (startedAt !== generation) return
    writeToken(token)
    writeRefreshToken(refresh_token ?? null)
    writeTokenExpiresAt(expires_at ?? null)
    useStore.getState().setSessionTokens(token, refresh_token ?? null, expires_at ?? null)
    scheduleRefresh()
  } catch (error) {
    if (startedAt !== generation) return
    if (error instanceof HttpError && error.status === 401) {
      expireSession()
      return
    }
    refreshTimer = setTimeout(() => { void refreshSession() }, REFRESH_RETRY_MS)
  }
}
```

- `runRestore()`: before `getMe()`, if `tokenExpiresAt !== null && refreshToken && tokenExpiresAt * 1000 - Date.now() < REFRESH_MARGIN_MS`, `await refreshSession()` first (then read the possibly-rotated token from the store for the generation guard — restructure minimally: capture token AFTER the refresh); after a successful restore call `scheduleRefresh()`.

**Tests** (vitest, `vi.useFakeTimers()` + mocked client functions, following the file's existing patterns): login with triple persists all three and schedules (advance to `expiry - 120s` → `postRefresh` called once); login without triple (nulls) never schedules; refresh success rotates store + storage and reschedules; refresh 401 → `expireSession` effects (`sessionExpired === true`, storage cleared); refresh network error → retry after 60s (advance timers twice); logout fires `postLogout` before token clear (assert mock called while store token non-null — capture inside the mock) and clears both new storage keys; concurrent `refreshSession()` calls share one in-flight promise (`postRefresh` called once); restore with stale expiry refreshes before `getMe`.

- [ ] **Step 1: failing tests** → **Step 2: run** `npm test -- --run src/auth/session.test.ts` (FAIL) → **Step 3: implement** → **Step 4: full frontend suite** `npm test -- --run` green → **Step 5: mutation-verify** (drop the `startedAt !== generation` guard in `doRefresh` → the logout-during-refresh test fails if written; otherwise drop `scheduleRefresh()` from the success path → the reschedule test fails; restore) → **Step 6: commit**

```bash
git add frontend/src/api/client.ts frontend/src/state/prefsStorage.ts frontend/src/state/store.ts frontend/src/auth/session.ts frontend/src/auth/session.test.ts
git commit -m "feat(frontend): mode-agnostic session refresh — token triple, scheduling, proxied logout (B14, #55)"
```

---

### Task 7: Frontend reset/invite UI + i18n

**Files:**
- Create: `frontend/src/auth/ForgotPasswordForm.tsx`, `frontend/src/auth/ResetPasswordForm.tsx`
- Modify: `frontend/src/auth/LoginGate.tsx`, `LoginForm.tsx`, `frontend/src/api/client.ts`, `frontend/src/state/store.ts` (authFeatures), admin create form (password-optional affordance — locate via `grep -rn "postAdminUser" frontend/src/admin/`)
- Modify: `frontend/src/i18n/messages.ts` + all of `en.ts de.ts fr.ts es.ts it.ts ja.ts zh.ts`
- Test: `frontend/src/auth/ResetPasswordForm.test.tsx` (new), `LoginGate.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 4's endpoints + `auth_features`.
- Produces: `client.ts` additions:

```typescript
export interface AuthFeatures { password_reset: boolean; invites: boolean }
export interface HealthResponse {
  status: string; name: string; version: string; auth_features?: AuthFeatures
}
export const getHealth = () => request<HealthResponse>('/api/health')
export const postResetRequest = (email: string) =>
  requestWithOptions<void>('/api/auth/reset-request', {
    method: 'POST', body: JSON.stringify({ email }), keepSessionOn401: true,
  })
export const postResetConfirm = (tokenHash: string, type: 'recovery' | 'invite', newPassword: string) =>
  requestWithOptions<void>('/api/auth/reset-confirm', {
    method: 'POST',
    body: JSON.stringify({ token_hash: tokenHash, type, new_password: newPassword }),
    keepSessionOn401: true,
  })
```

  Store: `authFeatures: AuthFeatures | null` (NOT persisted, NOT in the reset exclusion — it re-fetches), `setAuthFeatures(f: AuthFeatures): void`.

**Behavior:**
- `LoginGate` mount effect (in the `'anonymous'` state only): `getHealth().then((h) => h.auth_features && setAuthFeatures(h.auth_features)).catch(() => {})` — anonymous visits may call `/api/health` (public); the "zero `/api/*` calls on first anonymous visit" doc promise changes and Task 8 updates it.
- `LoginGate` reads `token_hash` + `type` from `new URLSearchParams(window.location.search)` once on mount (store in component state, then `history.replaceState(null, '', window.location.pathname)` so a reload doesn't resubmit a burned hash). While anonymous and a hash is present → render `ResetPasswordForm` instead of `LoginForm`.
- `ResetPasswordForm({ tokenHash, type, onDone })`: heading `type === 'invite' ? m.inviteHeading : m.resetHeading`; one new-password field + confirm field (`MIN_PASSWORD_LENGTH` pre-validation, mismatch → `m.resetMismatch`); submit → `postResetConfirm` → success state shows `m.resetSuccess` + a button (`m.resetBackToSignIn`) calling `onDone()` (gate returns to `LoginForm`); 422 `invalid_or_expired_link` → `m.resetLinkInvalid`; other errors → `m.signInFailed`.
- `LoginForm`: when `authFeatures?.password_reset`, render below the submit button a link-style button (`m.forgotPassword`) → parent gate switches to `ForgotPasswordForm` (email field prefilled from the login form's email state — pass via callback `onForgot(email)`); `ForgotPasswordForm` submits `postResetRequest(email)` and unconditionally shows `m.resetRequestSent` (enumeration-neutral), with a back link.
- Admin create form: when `authFeatures?.invites`, the password field's label gains `m.adminPasswordOptionalHint` and empty password submits `{ password: undefined }` → invited flow; keep required client-side when invites are unavailable.

**i18n keys** (add to `messages.ts` type and every locale; informal register; translations below are the plan's copy — locales must match `register.test.ts` conventions):

| key | en | de |
|---|---|---|
| `forgotPassword` | `Forgot your password?` | `Passwort vergessen?` |
| `resetRequestSent` | `If that address has an account, a reset link is on its way.` | `Falls es zu dieser Adresse ein Konto gibt, ist ein Link zum Zurücksetzen unterwegs.` |
| `resetHeading` | `Choose a new password` | `Wähle ein neues Passwort` |
| `inviteHeading` | `Welcome! Choose your password` | `Willkommen! Wähle dein Passwort` |
| `resetNewPassword` | `New password` | `Neues Passwort` |
| `resetRepeatPassword` | `Repeat password` | `Passwort wiederholen` |
| `resetMismatch` | `The passwords don't match.` | `Die Passwörter stimmen nicht überein.` |
| `resetSubmit` | `Set password` | `Passwort speichern` |
| `resetSuccess` | `Your password is set — you can sign in now.` | `Dein Passwort ist gespeichert — du kannst dich jetzt anmelden.` |
| `resetBackToSignIn` | `Go to sign-in` | `Zur Anmeldung` |
| `resetLinkInvalid` | `This link is invalid or has expired. Request a new one.` | `Dieser Link ist ungültig oder abgelaufen. Fordere einen neuen an.` |
| `resetEmailLabel` | `Your email address` | `Deine E-Mail-Adresse` |
| `resetRequestSubmit` | `Send reset link` | `Link senden` |
| `backToSignIn` | `Back to sign-in` | `Zurück zur Anmeldung` |
| `adminPasswordOptionalHint` | `Leave empty to send an invitation email` | `Leer lassen, um eine Einladungs-E-Mail zu senden` |

fr/es/it/ja/zh: translate in the same register as each file's existing `signIn*` strings (fr `tu`, es `tú`, it `tu`, ja plain polite forms consistent with existing keys, zh 你). The i18n completeness test (`i18n.test.ts`) enforces every locale carries every key.

**Tests:** gate renders `ResetPasswordForm` when URL carries `token_hash&type=recovery` and strips the URL after mount; successful confirm shows success then returns to login form via the button; invalid-link 422 shows `resetLinkInvalid`; forgot-password link renders only when `authFeatures.password_reset` is true (both directions — mutation-verify by dropping the conditional); `ForgotPasswordForm` shows the neutral sent-message for both 204 and thrown errors.

- [ ] Steps: failing tests → run (FAIL) → implement → `npm test -- --run` green → mutation-verify (drop the `password_reset` conditional → gating test fails; drop `history.replaceState` → URL-strip test fails; restore) → commit

```bash
git add frontend/src/auth/ frontend/src/api/client.ts frontend/src/state/store.ts frontend/src/i18n/ frontend/src/admin/
git commit -m "feat(frontend): password-reset + invitation acceptance UI, feature-flagged via /api/health (B14, #55)"
```

---

### Task 8: Documentation

**Files:**
- Create: `docs/supabase-auth-setup.md`
- Modify: `README.md`, `backend/config.example.yaml`, `docs/backend-architecture.md`, `docs/frontend-architecture.md`

**Content requirements:**

`docs/supabase-auth-setup.md` — the dashboard walkthrough, written for an operator with a fresh supabase.com account, in this order: (1) create project, note `https://<ref>.supabase.co`; (2) **Settings → JWT Keys**: migrate off the legacy JWT secret and rotate to an asymmetric key — ES256 recommended; state plainly that supabase mode DOES NOT WORK on the legacy shared-secret system (the backend accepts only ES256/RS256 via JWKS); (3) **Settings → API Keys**: create publishable + secret keys → `FW_SUPABASE_PUBLISHABLE_KEY` / `FW_SUPABASE_SECRET_KEY`; (4) **Auth → Providers**: Email only; anonymous sign-ins off; every OAuth provider off; (5) **Auth → Settings**: "Allow new users to sign up" OFF (invitation-only; admin-API invites are exempt from the toggle — if a Supabase change ever makes invites respect it, revisit this page, not the app), email confirmations on; (6) **Auth → URL Configuration**: Site URL = deployment origin (`http://localhost:9090` works for local runs — links open on the operator's machine); additional redirect URLs same origin; (7) **Auth → Email (SMTP)**: custom SMTP for production, built-in sender is dev-rate-limited; (8) access-token TTL: default 1h is fine — revocation is enforced by the backend's own verification layer, not TTL; (9) container wiring example:

```yaml
# config.yaml
auth:
  mode: supabase
  supabase:
    url: https://<ref>.supabase.co
```

```
# fabulous.env
FW_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
FW_SUPABASE_SECRET_KEY=sb_secret_...
FW_ADMIN_EMAIL=you@example.com
FW_ADMIN_PASSWORD=<bootstrap password, min 12 chars>
```

plus the note that `FW_AUTH_SECRET` is NOT needed in supabase mode, and the bootstrap semantics (first start with an empty user table creates the admin in Supabase; the env vars go inert afterwards).

`README.md`: one paragraph + link under the deployment section ("Hosted authentication (Supabase)"). `backend/config.example.yaml`: commented `auth.supabase` stanza. `docs/backend-architecture.md`: extend the auth section — mode dispatch, verifier contract (local id, epoch=None fallback, lazy JWKS), gateway per-op clients, invitation-only entry, eviction layers table (local: epoch; supabase: password_changed_at + global sign-out). `docs/frontend-architecture.md`: token triple, refresh engine, reset/invite gate flow; UPDATE the "first anonymous visit makes zero `/api/*` calls" promise to "exactly one (`GET /api/health`)".

- [ ] Write all five documents → **gates** (`uv run pytest -q` zero warnings — docs shouldn't move tests, prove it; `git status --short -- frontend/` clean) → commit

```bash
git add docs/supabase-auth-setup.md README.md backend/config.example.yaml docs/backend-architecture.md docs/frontend-architecture.md
git commit -m "docs: supabase.com auth setup guide + architecture sync (B14, #55)"
```

---

## Self-review notes (already applied)

- Spec §2 said the user lookup happens in `get_current_user`; the pinned `TokenVerifier` contract (`core/auth.py:181-191`) puts resolution inside the verifier. The plan follows the code contract; the spec is amended in the same commit as this plan.
- Spec §2 said JWKS is "prefetched at startup"; the plan makes it lazy (test isolation + container restart resilience); spec amended.
- Spec §5 said the reset form "logs in with the new credentials"; auto-login would require honoring a session minted BEFORE `password_changed_at`, which the eviction fallback rightly rejects. The form returns to sign-in instead; spec amended.
- Type consistency check: `SupabaseSession` field names (`access_token/refresh_token/expires_at/user_id/email`), gateway method names, `resolve_supabase_user(store, *, subject, email)`, store method names, and the i18n key list are used identically across Tasks 2-7.

## Issue closure

PR closes: `Closes #55.`
