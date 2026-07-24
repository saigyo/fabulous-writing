# Multi-User M1 — Auth Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user accounts, local email/password authentication, an admin
user-management API and an operator CLI to the backend — without applying
authentication to any existing endpoint, so the current frontend keeps
working unchanged.

**Architecture:** A `users` table in the existing SQLite file, a `UserStore`
alongside the other stores, and a pluggable `TokenVerifier` whose local
implementation issues and verifies HS256 JWTs. Request identity resolves
through one FastAPI dependency that re-reads the user row on every request,
so deactivation and de-admin take effect immediately without token
revocation. The `/api/admin` router carries `require_admin` at the router
level so admin endpoints added later inherit the check by construction.

**Tech Stack:** Python 3.13, FastAPI, SQLite (stdlib `sqlite3`), pydantic v2,
`bcrypt` for password hashing, `PyJWT` for tokens, pytest. All backend
commands run from `backend/` via `uv run`.

Spec: `docs/superpowers/specs/2026-07-24-multi-user-auth-design.md`.
Roadmap: `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md`.

## Global Constraints

- Branch `multi-user-auth-core`, branched from `main`. Open a PR at the end;
  request a Copilot review; **resolve every review thread** (the `main`
  ruleset blocks merge while any thread is unresolved). `main` is PR-only.
- **This milestone applies authentication to nothing.** Existing routers
  (`documents`, `folders`, `checks`, `profiles`, `terminology`, `rules`,
  `providers`, `routing`, `suggestions`, `languages`) must remain
  unauthenticated so `main` keeps working. Enforcement is M2.
- The live database `backend/data/fabulous.db` is never read or written by
  tests. Every test uses `tmp_path`.
- Secrets and credentials come from the environment only
  (`FW_AUTH_SECRET`, `FW_ADMIN_EMAIL`, `FW_ADMIN_PASSWORD`). Never write
  them to the repository, the database, or a log line.
- The PyJWT and bcrypt APIs used below were verified against the installed
  versions before this plan was written: `jwt.decode(..., algorithms=["HS256"],
  issuer=..., audience=..., options={"require": [...]})` raises
  `InvalidAlgorithmError` for a foreign algorithm and `InvalidIssuerError`
  for a foreign issuer; `bcrypt.hashpw` / `checkpw` behave as used.
- JWT verification pins exactly one algorithm (`["HS256"]`) and validates
  `exp`, `iss`, `aud`, and `iat` (the last with 60 seconds of future
  leeway). Issuer and audience are both the literal string
  `fabulous-writing`.
- Token TTL is 24 hours. There are no refresh tokens.
- Password minimums: **8** characters for a self-chosen password,
  **12** for any admin-set or bootstrap password.
- `TokenVerifier.verify()` returns the **local `users.id`** in every auth
  mode. No caller ever keys off an external identity.
- The `User` model never carries `password_hash`; no API response may
  include password material.
- Login failures return HTTP **401** with one generic message for every
  cause (unknown email, wrong password, deactivated account), and spend
  bcrypt time even when the account does not exist.
- The login throttle keys on `(email, client IP)` where client IP is
  `request.client.host` — forwarded headers (`X-Forwarded-For`,
  `Forwarded`) are **ignored** in this milestone.
- Gates before opening the PR, from `backend/`: `uv run pytest -q` passes
  with zero warnings.

## File Structure

| File | Responsibility |
|---|---|
| `backend/app/core/auth.py` (new) | Password hashing/verification, password rules, auth-secret resolution, token issuing, `TokenVerifier` protocol, `LocalTokenVerifier`, `InvalidToken`, `AuthConfigError`. |
| `backend/app/core/config.py` (modify) | `AuthSettings` + `Settings.auth`. |
| `backend/app/services/users.py` (new) | `users` + `admin_audit` schema, `User` model, `UserStore` CRUD, credential verification, audit writes. |
| `backend/app/services/seed_admin.py` (new) | Bootstrap the first admin from env vars while `users` is empty. |
| `backend/app/api/deps.py` (new) | `CurrentUser`, `get_current_user`, `require_admin`. |
| `backend/app/api/auth.py` (new) | `LoginThrottle`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/password`. |
| `backend/app/api/admin.py` (new) | `/api/admin/users` list/create/patch, audit writes, admin-creation switch. |
| `backend/app/manage.py` (new) | Operator CLI (`python -m app.manage`). |
| `backend/app/main.py` (modify) | Wire the store, secret, verifier, throttle, bootstrap, and the two new routers. |
| `backend/app/services/_sqlite.py` (modify) | Optional `timeout` on `connect()` for the CLI. |
| `backend/tests/conftest.py` (new) | Autouse fixture supplying bootstrap env vars to the whole suite. |
| `backend/tests/test_auth_core.py` (new) | Secret resolution, password rules, token issue/verify. |
| `backend/tests/test_users_store.py` (new) | `UserStore` CRUD, credential verification, audit rows. |
| `backend/tests/test_auth_api.py` (new) | Dependencies, login (incl. throttle and enumeration defenses), `/me`, password change. |
| `backend/tests/test_admin_api.py` (new) | Admin endpoints, switch, self-lockout, audit. |
| `backend/tests/test_seed_admin.py` (new) | Bootstrap rules. |
| `backend/tests/test_manage_cli.py` (new) | Operator CLI commands. |

---

### Task 1: Auth configuration and secret resolution

**Files:**
- Create: `backend/app/core/auth.py`
- Modify: `backend/app/core/config.py`
- Modify: `backend/pyproject.toml`
- Test: `backend/tests/test_auth_core.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `AuthSettings(mode, ephemeral_secret, allow_additional_admins)`
  on `Settings.auth`; `AuthConfigError`;
  `resolve_auth_secret(*, ephemeral_ok: bool, env: Mapping[str,str] | None = None) -> str`;
  `MIN_SECRET_LENGTH = 32`.

- [ ] **Step 1: Add the runtime dependencies**

Run from `backend/`:

```bash
uv add "bcrypt>=4.2.0" "pyjwt>=2.10.0"
```

Expected: `pyproject.toml` gains both entries under `[project] dependencies`
and `uv.lock` updates.

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_auth_core.py`:

```python
import pytest

from app.core.auth import AuthConfigError, resolve_auth_secret


def test_secret_from_env_is_returned():
    secret = "x" * 32
    assert resolve_auth_secret(ephemeral_ok=False, env={"FW_AUTH_SECRET": secret}) == secret


def test_short_secret_is_rejected():
    with pytest.raises(AuthConfigError, match="at least 32"):
        resolve_auth_secret(ephemeral_ok=False, env={"FW_AUTH_SECRET": "tooshort"})


def test_missing_secret_fails_closed():
    with pytest.raises(AuthConfigError, match="FW_AUTH_SECRET"):
        resolve_auth_secret(ephemeral_ok=False, env={})


def test_missing_secret_is_generated_when_ephemeral_allowed(caplog):
    with caplog.at_level("WARNING"):
        secret = resolve_auth_secret(ephemeral_ok=True, env={})
    assert len(secret) >= 32
    # The warning must announce the fact without ever printing the value.
    assert "ephemeral" in caplog.text.lower()
    assert secret not in caplog.text
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `uv run pytest tests/test_auth_core.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.core.auth'`.

- [ ] **Step 4: Write the implementation**

Create `backend/app/core/auth.py`:

```python
"""Authentication primitives: secrets, passwords, and tokens.

The verifier indirection is what lets Supabase Auth replace local login
later without touching the request path: every implementation returns the
LOCAL users.id, so lookups never change shape.
"""

import logging
import os
import secrets
from collections.abc import Mapping

logger = logging.getLogger(__name__)

MIN_SECRET_LENGTH = 32


class AuthConfigError(RuntimeError):
    """Authentication cannot be configured safely; startup must not continue."""


def resolve_auth_secret(
    *, ephemeral_ok: bool, env: Mapping[str, str] | None = None
) -> str:
    """Return the HS256 signing secret (local mode only).

    Length is the mechanical gate; the requirement that the value be
    randomly generated (`openssl rand -base64 32`) is documented in
    config.example.yaml and the README, since entropy cannot be checked.
    """
    environ = os.environ if env is None else env
    raw = environ.get("FW_AUTH_SECRET", "")
    if raw:
        if len(raw) < MIN_SECRET_LENGTH:
            raise AuthConfigError(
                f"FW_AUTH_SECRET must be at least {MIN_SECRET_LENGTH} characters"
            )
        return raw
    if ephemeral_ok:
        # States the fact, never the value: a secret in a log file is a
        # credential at rest.
        logger.warning(
            "FW_AUTH_SECRET is unset; using an ephemeral secret. Every token "
            "becomes invalid on restart. Never do this outside development."
        )
        return secrets.token_urlsafe(48)
    raise AuthConfigError(
        "FW_AUTH_SECRET is unset. Generate one with `openssl rand -base64 32`, "
        "or set auth.ephemeral_secret: true for local development."
    )
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `uv run pytest tests/test_auth_core.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Add the config section**

In `backend/app/core/config.py`, add near the other settings models (after
`NlpSettings`, before `class Settings`):

```python
class AuthSettings(BaseModel):
    # Startup-only knobs. None of these is reachable through the API: a
    # stolen admin session must not be able to lift its own constraints.
    mode: Literal["local", "supabase"] = "local"
    # Dev-only escape hatch for a missing FW_AUTH_SECRET (tokens die on restart).
    ephemeral_secret: bool = False
    # When false, no API path may create or promote an admin (§7.1).
    allow_additional_admins: bool = False
```

Add `Literal` to the existing `typing` import at the top of the file, and
add this field to `class Settings`:

```python
    auth: AuthSettings = Field(default_factory=AuthSettings)
```

- [ ] **Step 7: Test the config section**

Append to `backend/tests/test_auth_core.py`:

```python
from app.core.config import Settings


def test_auth_settings_defaults_are_closed():
    settings = Settings()
    assert settings.auth.mode == "local"
    assert settings.auth.ephemeral_secret is False
    assert settings.auth.allow_additional_admins is False


def test_auth_settings_load_from_mapping():
    settings = Settings.model_validate(
        {"auth": {"mode": "local", "ephemeral_secret": True, "allow_additional_admins": True}}
    )
    assert settings.auth.ephemeral_secret is True
    assert settings.auth.allow_additional_admins is True
```

- [ ] **Step 8: Run the tests**

Run: `uv run pytest tests/test_auth_core.py -q`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add pyproject.toml uv.lock app/core/auth.py app/core/config.py tests/test_auth_core.py
git commit -m "feat(auth): auth settings and fail-closed secret resolution"
```

---

### Task 2: Password hashing and rules

**Files:**
- Modify: `backend/app/core/auth.py`
- Test: `backend/tests/test_auth_core.py`

**Interfaces:**
- Consumes: `app.core.auth` from Task 1.
- Produces: `hash_password(password: str) -> str`;
  `check_password(password: str, password_hash: str | None) -> bool`;
  `validate_password(password: str, *, min_length: int) -> str` (raises
  `ValueError`); `SELF_MIN_PASSWORD_LENGTH = 8`;
  `ADMIN_SET_MIN_PASSWORD_LENGTH = 12`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_auth_core.py`:

```python
from app.core.auth import (
    ADMIN_SET_MIN_PASSWORD_LENGTH,
    SELF_MIN_PASSWORD_LENGTH,
    check_password,
    hash_password,
    validate_password,
)


def test_hash_and_check_roundtrip():
    stored = hash_password("correct horse battery")
    assert stored != "correct horse battery"  # never stored in the clear
    assert check_password("correct horse battery", stored) is True
    assert check_password("wrong password", stored) is False


def test_check_password_against_missing_hash_is_false():
    # An account with no local password (Supabase-managed, or never set)
    # must not authenticate, and must still cost bcrypt time so response
    # timing cannot distinguish it from a wrong password.
    assert check_password("anything", None) is False


def test_password_length_rules():
    assert validate_password("12345678", min_length=SELF_MIN_PASSWORD_LENGTH) == "12345678"
    with pytest.raises(ValueError, match="at least 8"):
        validate_password("1234567", min_length=SELF_MIN_PASSWORD_LENGTH)
    with pytest.raises(ValueError, match="at least 12"):
        validate_password("12345678", min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_auth_core.py -q`
Expected: FAIL with `ImportError: cannot import name 'hash_password'`.

- [ ] **Step 3: Write the implementation**

Append to `backend/app/core/auth.py`:

```python
import bcrypt

SELF_MIN_PASSWORD_LENGTH = 8
ADMIN_SET_MIN_PASSWORD_LENGTH = 12


@lru_cache(maxsize=1)
def _dummy_hash() -> str:
    """A real hash to verify against when no account matches.

    Computed once, lazily: without it an unknown email would skip bcrypt
    entirely and answer measurably faster than a known one, re-enabling the
    account enumeration the generic 401 is meant to prevent.
    """
    return hash_password("timing-equalisation-placeholder")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def check_password(password: str, password_hash: str | None) -> bool:
    candidate = password_hash if password_hash else _dummy_hash()
    matched = bcrypt.checkpw(password.encode(), candidate.encode())
    return matched and password_hash is not None


def validate_password(password: str, *, min_length: int) -> str:
    if len(password) < min_length:
        raise ValueError(f"Password must be at least {min_length} characters")
    return password
```

Add `from functools import lru_cache` to the imports at the top of the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_auth_core.py -q`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add app/core/auth.py tests/test_auth_core.py
git commit -m "feat(auth): bcrypt password hashing with timing-equalised verification"
```

---

### Task 3: Token issuing and verification

**Files:**
- Modify: `backend/app/core/auth.py`
- Test: `backend/tests/test_auth_core.py`

**Interfaces:**
- Consumes: `app.core.auth` from Tasks 1–2.
- Produces: `issue_token(user_id: int, secret: str, *, now: datetime | None = None) -> str`;
  `TokenVerifier` protocol with `verify(token: str) -> int`;
  `LocalTokenVerifier(secret: str)`; `InvalidToken`; constants
  `TOKEN_ISSUER = TOKEN_AUDIENCE = "fabulous-writing"`,
  `TOKEN_TTL = timedelta(hours=24)`, `IAT_LEEWAY_SECONDS = 60`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_auth_core.py`:

```python
from datetime import UTC, datetime, timedelta

import jwt

from app.core.auth import (
    TOKEN_AUDIENCE,
    TOKEN_ISSUER,
    InvalidToken,
    LocalTokenVerifier,
    issue_token,
)

# 64 bytes, not merely the 32-byte minimum: the foreign-algorithm test
# below signs with HS512, and PyJWT emits InsecureKeyLengthWarning for a
# SHA512 key under 64 bytes — which would break the zero-warnings gate.
SECRET = "s" * 64


def test_issued_token_verifies_to_the_local_user_id():
    verifier = LocalTokenVerifier(SECRET)
    assert verifier.verify(issue_token(42, SECRET)) == 42


def test_token_signed_with_another_secret_is_rejected():
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(issue_token(1, "other" * 10))


def test_expired_token_is_rejected():
    long_ago = datetime.now(UTC) - timedelta(hours=25)
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(issue_token(1, SECRET, now=long_ago))


def test_token_with_foreign_algorithm_is_rejected():
    # The classic JWT bugs: 'alg: none' and RS256->HS256 confusion. A
    # permissive decode accepts them; a pinned single-algorithm decode
    # does not.
    forged = jwt.encode(
        {"sub": "1", "iss": TOKEN_ISSUER, "aud": TOKEN_AUDIENCE,
         "iat": int(datetime.now(UTC).timestamp()),
         "exp": int((datetime.now(UTC) + timedelta(hours=1)).timestamp())},
        SECRET,
        algorithm="HS512",
    )
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(forged)


@pytest.mark.parametrize("claim", ["iss", "aud"])
def test_token_for_another_project_is_rejected(claim):
    payload = {
        "sub": "1",
        "iss": TOKEN_ISSUER,
        "aud": TOKEN_AUDIENCE,
        "iat": int(datetime.now(UTC).timestamp()),
        "exp": int((datetime.now(UTC) + timedelta(hours=1)).timestamp()),
    }
    payload[claim] = "some-other-project"
    forged = jwt.encode(payload, SECRET, algorithm="HS256")
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(forged)


def test_token_issued_far_in_the_future_is_rejected_but_small_skew_is_tolerated():
    verifier = LocalTokenVerifier(SECRET)
    # 30s of clock drift must still work; 10 minutes must not.
    near = datetime.now(UTC) + timedelta(seconds=30)
    assert verifier.verify(issue_token(7, SECRET, now=near)) == 7
    far = datetime.now(UTC) + timedelta(minutes=10)
    with pytest.raises(InvalidToken):
        verifier.verify(issue_token(7, SECRET, now=far))


def test_garbage_token_is_rejected():
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify("not-a-token")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_auth_core.py -q`
Expected: FAIL with `ImportError: cannot import name 'issue_token'`.

- [ ] **Step 3: Write the implementation**

Append to `backend/app/core/auth.py`:

```python
TOKEN_ISSUER = "fabulous-writing"
TOKEN_AUDIENCE = "fabulous-writing"
TOKEN_TTL = timedelta(hours=24)
# Tolerated clock drift between this server and the token issuer. Without
# it, a slightly fast issuer (notably Supabase's signing service later)
# would cause intermittent 401s.
IAT_LEEWAY_SECONDS = 60


class InvalidToken(Exception):
    """The token is absent, malformed, expired, or not ours."""


class TokenVerifier(Protocol):
    def verify(self, token: str) -> int:
        """Return the LOCAL users.id, or raise InvalidToken.

        Every implementation returns a local id — the Supabase verifier
        will resolve its subject UUID to users.external_id internally and
        fail closed when unlinked — so the request path never changes
        lookup keys between auth modes.
        """


def issue_token(user_id: int, secret: str, *, now: datetime | None = None) -> str:
    issued = now or datetime.now(UTC)
    return jwt.encode(
        {
            "sub": str(user_id),
            "iat": int(issued.timestamp()),
            "exp": int((issued + TOKEN_TTL).timestamp()),
            "iss": TOKEN_ISSUER,
            "aud": TOKEN_AUDIENCE,
        },
        secret,
        algorithm="HS256",
    )


class LocalTokenVerifier:
    """Verifies tokens this backend issued (auth.mode: local)."""

    def __init__(self, secret: str) -> None:
        self._secret = secret

    def verify(self, token: str) -> int:
        try:
            claims = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],  # exactly one: never 'none', never asymmetric
                issuer=TOKEN_ISSUER,
                audience=TOKEN_AUDIENCE,
                options={"require": ["sub", "exp", "iat", "iss", "aud"]},
            )
        except jwt.PyJWTError as exc:
            raise InvalidToken(str(exc)) from exc
        # iat is checked here rather than left to the library so the leeway
        # is explicit and does not depend on PyJWT's version-specific
        # treatment of future issue times.
        drift = float(claims["iat"]) - datetime.now(UTC).timestamp()
        if drift > IAT_LEEWAY_SECONDS:
            raise InvalidToken("token issued too far in the future")
        try:
            return int(claims["sub"])
        except (TypeError, ValueError) as exc:
            raise InvalidToken("sub is not a user id") from exc
```

Extend the imports at the top of the file:

```python
from datetime import UTC, datetime, timedelta
from typing import Protocol

import jwt
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_auth_core.py -q`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add app/core/auth.py tests/test_auth_core.py
git commit -m "feat(auth): HS256 token issuing and pinned verification"
```

---

### Task 4: UserStore and the audit table

**Files:**
- Create: `backend/app/services/users.py`
- Test: `backend/tests/test_users_store.py`

**Interfaces:**
- Consumes: `hash_password`, `check_password` (Task 2); `connect` from
  `app.services._sqlite`.
- Produces: `User` model (fields `id, email, display_name, tier, is_admin,
  is_active, created_at, external_id` — **no password material**);
  `DuplicateEmailError`; `UserStore(db_path)` with `create_user`,
  `get_user`, `get_by_email`, `list_users`, `count`, `verify_credentials`,
  `set_password`, `update_user`, `record_audit`, `list_audit`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_users_store.py`:

```python
from pathlib import Path

import pytest

from app.services.users import DuplicateEmailError, UserStore


@pytest.fixture()
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "test.db")


def test_create_and_read_back(store):
    user = store.create_user("Ada@example.com", "correct horse battery", display_name="Ada")
    assert user.id == 1 and user.email == "Ada@example.com"
    assert user.tier == "basic" and user.is_admin is False and user.is_active is True
    assert user.created_at
    assert store.get_user(user.id) == user
    assert store.get_user(999) is None


def test_user_model_never_exposes_password_material(store):
    user = store.create_user("ada@example.com", "correct horse battery")
    assert "password" not in user.model_dump()


def test_email_lookup_and_uniqueness_are_case_insensitive(store):
    store.create_user("ada@example.com", "correct horse battery")
    assert store.get_by_email("ADA@Example.com") is not None
    with pytest.raises(DuplicateEmailError):
        store.create_user("ADA@example.com", "another password")


def test_verify_credentials(store):
    store.create_user("ada@example.com", "correct horse battery")
    assert store.verify_credentials("ADA@example.com", "correct horse battery") is not None
    assert store.verify_credentials("ada@example.com", "wrong") is None
    assert store.verify_credentials("nobody@example.com", "correct horse battery") is None


def test_deactivated_user_cannot_authenticate(store):
    user = store.create_user("ada@example.com", "correct horse battery")
    store.update_user(user.id, is_active=False)
    assert store.verify_credentials("ada@example.com", "correct horse battery") is None


def test_update_user_changes_only_named_fields(store):
    user = store.create_user("ada@example.com", "correct horse battery", display_name="Ada")
    updated = store.update_user(user.id, tier="premium", is_admin=True)
    assert updated.tier == "premium" and updated.is_admin is True
    assert updated.display_name == "Ada" and updated.is_active is True
    assert store.update_user(999, tier="premium") is None


def test_set_password_replaces_the_credential(store):
    user = store.create_user("ada@example.com", "old password here")
    assert store.set_password(user.id, "new password here") is True
    assert store.verify_credentials("ada@example.com", "old password here") is None
    assert store.verify_credentials("ada@example.com", "new password here") is not None
    assert store.set_password(999, "irrelevant") is False


def test_count_and_list(store):
    assert store.count() == 0
    store.create_user("b@example.com", "correct horse battery")
    store.create_user("a@example.com", "correct horse battery")
    assert store.count() == 2
    assert [u.email for u in store.list_users()] == ["a@example.com", "b@example.com"]


def test_audit_rows_record_the_actor_or_none_for_cli(store):
    admin = store.create_user("admin@example.com", "correct horse battery", is_admin=True)
    target = store.create_user("ada@example.com", "correct horse battery")
    store.record_audit(actor_id=admin.id, target_id=target.id, field="tier",
                       old_value="basic", new_value="premium")
    store.record_audit(actor_id=None, target_id=target.id, field="password")
    rows = store.list_audit()
    assert [(r["actor_id"], r["field"]) for r in rows] == [
        (admin.id, "tier"),
        (None, "password"),  # None marks an out-of-band operator CLI action
    ]
    assert all(r["created_at"] for r in rows)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_users_store.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.users'`.

- [ ] **Step 3: Write the implementation**

Create `backend/app/services/users.py`:

```python
"""User accounts and the admin audit trail.

Authorization (tier, is_admin, is_active) lives here rather than with the
identity provider, so it survives the later switch to Supabase Auth
unchanged.
"""

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel

from app.core.auth import check_password, hash_password
from app.services._sqlite import connect

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT,
    password_hash TEXT,
    tier TEXT NOT NULL DEFAULT 'basic',
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    target_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at TEXT NOT NULL
);
"""

# Fields update_user accepts. Anything else is a programming error, not a
# silently ignored write.
_UPDATABLE = ("display_name", "tier", "is_admin", "is_active", "external_id")


class User(BaseModel):
    """A user as every caller sees them: no password material, ever."""

    id: int
    email: str
    display_name: str | None = None
    tier: str = "basic"
    is_admin: bool = False
    is_active: bool = True
    created_at: str
    external_id: str | None = None


class DuplicateEmailError(ValueError):
    """An account with that email already exists (case-insensitively)."""


def _utcnow() -> str:
    return datetime.now(UTC).isoformat()


def _row_to_user(row: sqlite3.Row) -> User:
    return User(
        id=row["id"],
        email=row["email"],
        display_name=row["display_name"],
        tier=row["tier"],
        is_admin=bool(row["is_admin"]),
        is_active=bool(row["is_active"]),
        created_at=row["created_at"],
        external_id=row["external_id"],
    )


class UserStore:
    def __init__(self, db_path: Path, *, timeout: float | None = None) -> None:
        self.db_path = db_path
        self.timeout = timeout
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    def _connect(self):
        return connect(self.db_path, timeout=self.timeout)

    def create_user(
        self,
        email: str,
        password: str | None = None,
        *,
        display_name: str | None = None,
        tier: str = "basic",
        is_admin: bool = False,
    ) -> User:
        password_hash = hash_password(password) if password else None
        with self._connect() as conn:
            try:
                cursor = conn.execute(
                    "INSERT INTO users"
                    " (email, display_name, password_hash, tier, is_admin, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (email, display_name, password_hash, tier, int(is_admin), _utcnow()),
                )
            except sqlite3.IntegrityError as exc:
                raise DuplicateEmailError(f"A user with email {email} already exists") from exc
            row = conn.execute(
                "SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
        return _row_to_user(row)

    def get_user(self, user_id: int) -> User | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _row_to_user(row) if row is not None else None

    def get_by_email(self, email: str) -> User | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,)
            ).fetchone()
        return _row_to_user(row) if row is not None else None

    def list_users(self) -> list[User]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM users ORDER BY email COLLATE NOCASE"
            ).fetchall()
        return [_row_to_user(row) for row in rows]

    def count(self) -> int:
        with self._connect() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0])

    def verify_credentials(self, email: str, password: str) -> User | None:
        """Return the user iff the password matches and the account is active.

        bcrypt runs even when no row matches (check_password falls back to a
        dummy hash), so an unknown email cannot be distinguished from a
        wrong password by response timing.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE email = ? COLLATE NOCASE", (email,)
            ).fetchone()
        stored = row["password_hash"] if row is not None else None
        if not check_password(password, stored):
            return None
        if not row["is_active"]:
            return None
        return _row_to_user(row)

    def set_password(self, user_id: int, password: str) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(password), user_id),
            )
        return cursor.rowcount > 0

    def update_user(self, user_id: int, **fields: object) -> User | None:
        unknown = set(fields) - set(_UPDATABLE)
        if unknown:
            raise ValueError(f"Not updatable: {sorted(unknown)}")
        if not fields:
            return self.get_user(user_id)
        assignments = ", ".join(f"{name} = ?" for name in fields)
        values: list[object] = [
            int(value) if isinstance(value, bool) else value for value in fields.values()
        ]
        with self._connect() as conn:
            cursor = conn.execute(
                f"UPDATE users SET {assignments} WHERE id = ?", (*values, user_id)
            )
            if cursor.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _row_to_user(row)

    def record_audit(
        self,
        *,
        actor_id: int | None,
        target_id: int,
        field: str,
        old_value: str | None = None,
        new_value: str | None = None,
    ) -> None:
        """One row per changed field. actor_id NULL = operator CLI (§7.5)."""
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO admin_audit"
                " (actor_id, target_id, field, old_value, new_value, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (actor_id, target_id, field, old_value, new_value, _utcnow()),
            )

    def list_audit(self) -> list[sqlite3.Row]:
        with self._connect() as conn:
            return conn.execute("SELECT * FROM admin_audit ORDER BY id").fetchall()
```

- [ ] **Step 4: Add the `timeout` parameter to the shared connector**

In `backend/app/services/_sqlite.py`, change the `connect` signature and
body:

```python
@contextmanager
def connect(db_path: Path, *, timeout: float | None = None) -> Iterator[sqlite3.Connection]:
    # sqlite3's own context manager only wraps a transaction (commit or
    # rollback); this wrapper also closes the connection afterwards, so
    # `with connect(...) as conn:` cannot leak connections.
    # `timeout` lets the operator CLI (app/manage.py) wait out a busy
    # database owned by a running server instead of failing instantly.
    conn = (
        sqlite3.connect(db_path)
        if timeout is None
        else sqlite3.connect(db_path, timeout=timeout)
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_users_store.py -q`
Expected: PASS (9 tests).

- [ ] **Step 6: Run the whole suite to confirm the shared connector is unharmed**

Run: `uv run pytest -q`
Expected: all pre-existing tests still pass, zero warnings.

- [ ] **Step 7: Commit**

```bash
git add app/services/users.py app/services/_sqlite.py tests/test_users_store.py
git commit -m "feat(users): UserStore with case-insensitive emails and audit trail"
```

---

### Task 5: Request-identity dependencies

**Files:**
- Create: `backend/app/api/deps.py`
- Test: `backend/tests/test_auth_api.py`

**Interfaces:**
- Consumes: `LocalTokenVerifier`, `InvalidToken` (Task 3); `UserStore`
  (Task 4).
- Produces: `CurrentUser` dataclass (`id, email, display_name, tier,
  is_admin`); `get_current_user(request) -> CurrentUser`;
  `require_admin(...) -> CurrentUser`. Both read
  `request.app.state.token_verifier` and `request.app.state.user_store`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_auth_api.py`:

```python
from pathlib import Path

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import CurrentUser, get_current_user, require_admin
from app.core.auth import LocalTokenVerifier, issue_token
from app.services.users import UserStore

# 64 bytes, not merely the 32-byte minimum: the foreign-algorithm test
# below signs with HS512, and PyJWT emits InsecureKeyLengthWarning for a
# SHA512 key under 64 bytes — which would break the zero-warnings gate.
SECRET = "s" * 64


@pytest.fixture()
def probe(tmp_path: Path):
    """A minimal app exposing the dependencies, so they are tested directly
    rather than through whichever endpoint happens to use them."""
    app = FastAPI()
    app.state.user_store = UserStore(tmp_path / "test.db")
    app.state.token_verifier = LocalTokenVerifier(SECRET)

    @app.get("/probe/user")
    def probe_user(user: CurrentUser = Depends(get_current_user)) -> dict:
        return {"id": user.id, "email": user.email, "tier": user.tier,
                "is_admin": user.is_admin}

    @app.get("/probe/admin")
    def probe_admin(user: CurrentUser = Depends(require_admin)) -> dict:
        return {"id": user.id}

    return app


def auth(user_id: int) -> dict:
    return {"Authorization": f"Bearer {issue_token(user_id, SECRET)}"}


def test_valid_token_resolves_the_user(probe):
    user = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    body = TestClient(probe).get("/probe/user", headers=auth(user.id)).json()
    assert body == {"id": user.id, "email": "ada@example.com", "tier": "basic",
                    "is_admin": False}


@pytest.mark.parametrize(
    "headers",
    [{}, {"Authorization": "Bearer"}, {"Authorization": "Basic abc"},
     {"Authorization": "Bearer garbage"}],
)
def test_missing_or_malformed_credentials_are_401(probe, headers):
    assert TestClient(probe).get("/probe/user", headers=headers).status_code == 401


def test_token_for_an_unknown_user_is_401(probe):
    assert TestClient(probe).get("/probe/user", headers=auth(999)).status_code == 401


def test_deactivation_takes_effect_on_the_next_request(probe):
    # The user row is re-read per request, so revoking access does not wait
    # for the token to expire — this is the incident-response lever.
    user = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    client = TestClient(probe)
    headers = auth(user.id)
    assert client.get("/probe/user", headers=headers).status_code == 200
    probe.state.user_store.update_user(user.id, is_active=False)
    assert client.get("/probe/user", headers=headers).status_code == 401


def test_require_admin_rejects_a_normal_user_and_admits_an_admin(probe):
    normal = probe.state.user_store.create_user("ada@example.com", "correct horse battery")
    admin = probe.state.user_store.create_user(
        "root@example.com", "correct horse battery", is_admin=True
    )
    client = TestClient(probe)
    assert client.get("/probe/admin", headers=auth(normal.id)).status_code == 403
    assert client.get("/probe/admin", headers=auth(admin.id)).status_code == 200


def test_de_adminning_takes_effect_on_the_next_request(probe):
    admin = probe.state.user_store.create_user(
        "root@example.com", "correct horse battery", is_admin=True
    )
    client = TestClient(probe)
    headers = auth(admin.id)
    assert client.get("/probe/admin", headers=headers).status_code == 200
    probe.state.user_store.update_user(admin.id, is_admin=False)
    assert client.get("/probe/admin", headers=headers).status_code == 403
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_auth_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api.deps'`.

- [ ] **Step 3: Write the implementation**

Create `backend/app/api/deps.py`:

```python
"""Request identity: one dependency every authenticated route goes through."""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from app.core.auth import InvalidToken

# One message for every authentication failure: which of them occurred is
# not the caller's business.
_UNAUTHENTICATED = "Not authenticated"


@dataclass(frozen=True)
class CurrentUser:
    id: int
    email: str
    display_name: str | None
    tier: str
    is_admin: bool


def get_current_user(request: Request) -> CurrentUser:
    scheme, _, token = request.headers.get("Authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, _UNAUTHENTICATED)
    try:
        user_id = request.app.state.token_verifier.verify(token.strip())
    except InvalidToken:
        raise HTTPException(401, _UNAUTHENTICATED) from None
    # Re-read per request rather than trusting the token's claims: this is
    # what makes deactivation and de-admin effective immediately, without
    # any token revocation machinery.
    user = request.app.state.user_store.get_user(user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, _UNAUTHENTICATED)
    return CurrentUser(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        tier=user.tier,
        is_admin=user.is_admin,
    )


def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(403, "Admin privileges required")
    return user
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/test_auth_api.py -q`
Expected: PASS (9 tests, counting the parametrized cases).

- [ ] **Step 5: Commit**

```bash
git add app/api/deps.py tests/test_auth_api.py
git commit -m "feat(auth): per-request identity and admin dependencies"
```

---

### Task 6: Auth endpoints and login throttle

**Files:**
- Create: `backend/app/api/auth.py`
- Test: `backend/tests/test_auth_api.py` (append)

**Interfaces:**
- Consumes: `CurrentUser`, `get_current_user` (Task 5); `issue_token`,
  `validate_password`, `SELF_MIN_PASSWORD_LENGTH` (Tasks 2–3); `UserStore`
  (Task 4).
- Produces: `router` (prefix `/api`, no router-level auth — `login` must be
  reachable unauthenticated); `LoginThrottle`;
  `MeResponse` (M4 and M5 extend this same model).
  App state consumed: `settings`, `user_store`, `auth_secret`,
  `login_throttle`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_auth_api.py`:

```python
from app.api.auth import LoginThrottle
from app.core.config import Settings
from app.main import create_app


@pytest.fixture()
def app_client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("FW_AUTH_SECRET", SECRET)
    monkeypatch.setenv("FW_ADMIN_EMAIL", "root@example.com")
    monkeypatch.setenv("FW_ADMIN_PASSWORD", "bootstrap password")
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=tmp_path / "rules")
    return TestClient(create_app(settings))


def login(client: TestClient, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_login_returns_a_token_and_the_user(app_client):
    response = login(app_client, "root@example.com", "bootstrap password")
    assert response.status_code == 200
    body = response.json()
    assert body["token"]
    assert body["user"]["email"] == "root@example.com"
    assert body["user"]["is_admin"] is True
    assert "password_hash" not in str(body)


def test_login_is_case_insensitive_on_email(app_client):
    assert login(app_client, "ROOT@Example.com", "bootstrap password").status_code == 200


@pytest.mark.parametrize(
    ("email", "password"),
    [("root@example.com", "wrong password"), ("nobody@example.com", "bootstrap password")],
)
def test_login_failures_are_indistinguishable(app_client, email, password):
    response = login(app_client, email, password)
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid email or password"


def test_deactivated_account_cannot_log_in(app_client):
    store = app_client.app.state.user_store
    store.update_user(1, is_active=False)
    assert login(app_client, "root@example.com", "bootstrap password").status_code == 401


def test_me_requires_authentication_and_returns_the_caller(app_client):
    assert app_client.get("/api/auth/me").status_code == 401
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    body = app_client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert body["email"] == "root@example.com" and body["is_admin"] is True
    assert body["tier"] == "premium"


def test_password_change_requires_the_current_password(app_client):
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    wrong = app_client.post(
        "/api/auth/password",
        json={"current": "not it", "new": "a new long password"},
        headers=headers,
    )
    assert wrong.status_code == 401
    ok = app_client.post(
        "/api/auth/password",
        json={"current": "bootstrap password", "new": "a new long password"},
        headers=headers,
    )
    assert ok.status_code == 204
    assert login(app_client, "root@example.com", "bootstrap password").status_code == 401
    assert login(app_client, "root@example.com", "a new long password").status_code == 200


def test_password_change_enforces_the_self_chosen_minimum(app_client):
    token = login(app_client, "root@example.com", "bootstrap password").json()["token"]
    response = app_client.post(
        "/api/auth/password",
        json={"current": "bootstrap password", "new": "short"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422
    assert "at least 8" in response.json()["detail"]


def test_throttle_blocks_after_repeated_failures_then_recovers():
    now = [0.0]
    throttle = LoginThrottle(threshold=3, base_delay=2.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    assert throttle.blocked_for(key) == 0
    for _ in range(3):
        throttle.record_failure(key)
    assert throttle.blocked_for(key) > 0
    now[0] += 2.0
    assert throttle.blocked_for(key) == 0


def test_throttle_backoff_grows_and_success_clears_it():
    now = [0.0]
    throttle = LoginThrottle(threshold=1, base_delay=2.0, clock=lambda: now[0])
    key = ("ada@example.com", "127.0.0.1")
    throttle.record_failure(key)
    first = throttle.blocked_for(key)
    throttle.record_failure(key)
    assert throttle.blocked_for(key) > first
    throttle.record_success(key)
    assert throttle.blocked_for(key) == 0


def test_throttled_login_is_rejected_even_with_the_right_password(app_client):
    for _ in range(5):
        login(app_client, "root@example.com", "wrong password")
    blocked = login(app_client, "root@example.com", "bootstrap password")
    assert blocked.status_code == 401
    assert blocked.json()["detail"] == "Invalid email or password"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_auth_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api.auth'`.

- [ ] **Step 3: Write the implementation**

Create `backend/app/api/auth.py`:

```python
"""Local authentication endpoints (auth.mode: local)."""

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user
from app.core.auth import SELF_MIN_PASSWORD_LENGTH, issue_token, validate_password
from app.services.users import User

router = APIRouter(prefix="/api", tags=["auth"])

# Never say which of "no such account", "wrong password" or "deactivated"
# applied: any distinction is an account-enumeration oracle.
_INVALID_LOGIN = "Invalid email or password"


@dataclass
class _Attempts:
    failures: int = 0
    blocked_until: float = 0.0


@dataclass
class LoginThrottle:
    """Exponential backoff per (email, client IP) after repeated failures.

    In-process state, which is correct for the single-process deployment the
    spec requires; it is not shared across processes. Supabase's own rate
    limiting replaces this in sub-project 2.
    """

    threshold: int = 5
    base_delay: float = 1.0
    max_delay: float = 60.0
    clock: Callable[[], float] = time.monotonic
    _state: dict[tuple[str, str], _Attempts] = field(default_factory=dict)

    def blocked_for(self, key: tuple[str, str]) -> float:
        entry = self._state.get(key)
        if entry is None:
            return 0.0
        return max(0.0, entry.blocked_until - self.clock())

    def record_failure(self, key: tuple[str, str]) -> None:
        entry = self._state.setdefault(key, _Attempts())
        entry.failures += 1
        if entry.failures >= self.threshold:
            delay = min(self.max_delay, self.base_delay * 2 ** (entry.failures - self.threshold))
            entry.blocked_until = self.clock() + delay

    def record_success(self, key: tuple[str, str]) -> None:
        self._state.pop(key, None)


class LoginRequest(BaseModel):
    email: str
    password: str


class MeResponse(BaseModel):
    """The caller's own account. Later milestones extend this model with the
    LLM policy (M4) and quota/size/concurrency limits (M5)."""

    id: int
    email: str
    display_name: str | None = None
    tier: str
    is_admin: bool

    @classmethod
    def from_user(cls, user: User) -> "MeResponse":
        return cls(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            tier=user.tier,
            is_admin=user.is_admin,
        )


class LoginResponse(BaseModel):
    token: str
    user: MeResponse


class PasswordChange(BaseModel):
    current: str
    new: str


def _require_local_mode(request: Request) -> None:
    """Local login does not exist in supabase mode: a leaked FW_AUTH_SECRET
    must not be able to forge tokens against a Supabase-mode instance."""
    if request.app.state.settings.auth.mode != "local":
        raise HTTPException(404, "Not found")


def _throttle_key(request: Request, email: str) -> tuple[str, str]:
    # Forwarded headers are deliberately ignored: trusting them unverified
    # would let an attacker mint a fresh spoofed IP per request and bypass
    # the throttle entirely. A deployment behind a proxy must configure a
    # trusted-proxy list first (sub-project 3).
    client_ip = request.client.host if request.client else "unknown"
    return (email.strip().lower(), client_ip)


@router.post("/auth/login")
def login(request: Request, body: LoginRequest) -> LoginResponse:
    _require_local_mode(request)
    app = request.app
    key = _throttle_key(request, body.email)
    if app.state.login_throttle.blocked_for(key) > 0:
        raise HTTPException(401, _INVALID_LOGIN)
    user = app.state.user_store.verify_credentials(body.email, body.password)
    if user is None:
        app.state.login_throttle.record_failure(key)
        raise HTTPException(401, _INVALID_LOGIN)
    app.state.login_throttle.record_success(key)
    return LoginResponse(
        token=issue_token(user.id, app.state.auth_secret),
        user=MeResponse.from_user(user),
    )


@router.get("/auth/me")
def me(request: Request, current: CurrentUser = Depends(get_current_user)) -> MeResponse:
    user = request.app.state.user_store.get_user(current.id)
    if user is None:  # pragma: no cover - get_current_user already rejected this
        raise HTTPException(401, "Not authenticated")
    return MeResponse.from_user(user)


@router.post("/auth/password", status_code=204)
def change_password(
    request: Request, body: PasswordChange, current: CurrentUser = Depends(get_current_user)
) -> Response:
    _require_local_mode(request)
    store = request.app.state.user_store
    if store.verify_credentials(current.email, body.current) is None:
        raise HTTPException(401, "Current password is incorrect")
    try:
        validate_password(body.new, min_length=SELF_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    store.set_password(current.id, body.new)
    return Response(status_code=204)
```

- [ ] **Step 4: Run the test to verify it fails on wiring, not on this module**

Run: `uv run pytest tests/test_auth_api.py -q`
Expected: the `LoginThrottle` tests PASS; the `app_client` tests FAIL
because `create_app` does not yet wire `user_store`, `auth_secret`,
`login_throttle` or the router. Task 7 completes them.

- [ ] **Step 5: Commit**

```bash
git add app/api/auth.py tests/test_auth_api.py
git commit -m "feat(auth): login, me and password-change endpoints with backoff"
```

---

### Task 7: Startup wiring and admin bootstrap

**Files:**
- Create: `backend/app/services/seed_admin.py`
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_seed_admin.py`
- Modify: `backend/app/main.py`
- Modify: `backend/config.example.yaml`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `seed_admin(store: UserStore, env: Mapping[str,str] | None = None) -> None`;
  app state `user_store`, `auth_secret`, `token_verifier`, `login_throttle`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_seed_admin.py`:

```python
from pathlib import Path

import pytest

from app.core.auth import AuthConfigError
from app.services.seed_admin import seed_admin
from app.services.users import UserStore

ENV = {"FW_ADMIN_EMAIL": "root@example.com", "FW_ADMIN_PASSWORD": "bootstrap password"}


@pytest.fixture()
def store(tmp_path: Path) -> UserStore:
    return UserStore(tmp_path / "test.db")


def test_seeds_the_first_admin_as_id_one(store):
    seed_admin(store, env=ENV)
    admin = store.get_user(1)
    # id 1 matters: existing documents and folders already carry
    # owner_id = 1, so M3's backfill assigns them to this account.
    assert admin.email == "root@example.com"
    assert admin.is_admin is True and admin.tier == "premium"
    assert store.verify_credentials("root@example.com", "bootstrap password") is not None


def test_is_a_bootstrap_not_an_ongoing_sync(store):
    seed_admin(store, env=ENV)
    store.set_password(1, "a rotated password")
    # Re-running must not reset the password: the env vars would otherwise
    # be a standing backdoor for anyone who can read the environment.
    seed_admin(store, env=ENV)
    assert store.count() == 1
    assert store.verify_credentials("root@example.com", "a rotated password") is not None
    assert store.verify_credentials("root@example.com", "bootstrap password") is None


def test_fails_closed_when_no_users_and_no_env(store):
    with pytest.raises(AuthConfigError, match="FW_ADMIN_EMAIL"):
        seed_admin(store, env={})


def test_rejects_a_short_bootstrap_password(store):
    with pytest.raises(ValueError, match="at least 12"):
        seed_admin(store, env={"FW_ADMIN_EMAIL": "root@example.com",
                               "FW_ADMIN_PASSWORD": "short"})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_seed_admin.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.seed_admin'`.

- [ ] **Step 3: Write the bootstrap**

Create `backend/app/services/seed_admin.py`:

```python
"""Bootstrap the first admin account (auth.mode: local only)."""

import logging
import os
from collections.abc import Mapping

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, AuthConfigError, validate_password
from app.services.users import UserStore

logger = logging.getLogger(__name__)


def seed_admin(store: UserStore, env: Mapping[str, str] | None = None) -> None:
    """Create the initial admin from the environment while `users` is empty.

    There is deliberately no API path for this: an unauthenticated bootstrap
    endpoint either stays open forever or depends on someone remembering to
    disable it. Once any user exists the variables are ignored entirely, so
    they can never serve as a standing password reset.
    """
    if store.count() > 0:
        return
    environ = os.environ if env is None else env
    email = environ.get("FW_ADMIN_EMAIL", "").strip()
    password = environ.get("FW_ADMIN_PASSWORD", "")
    if not email or not password:
        raise AuthConfigError(
            "No users exist and FW_ADMIN_EMAIL / FW_ADMIN_PASSWORD are unset: "
            "the instance would have no way to authenticate anyone."
        )
    validate_password(password, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
    store.create_user(
        email, password, display_name="Administrator", tier="premium", is_admin=True
    )
    logger.info("Seeded the initial admin account (%s)", email)
```

- [ ] **Step 4: Wire it into the app factory**

In `backend/app/main.py`, add the imports:

```python
from app.api.auth import LoginThrottle, router as auth_router
from app.core.auth import AuthConfigError, LocalTokenVerifier, resolve_auth_secret
from app.services.seed_admin import seed_admin
from app.services.users import UserStore
```

Inside `create_app`, after `app.state.profile_store = ProfileStore(...)` and
the `seed_profiles(...)` call, add:

```python
    app.state.user_store = UserStore(settings.db_path)
    if settings.auth.mode != "local":
        raise AuthConfigError(
            "auth.mode 'supabase' is not implemented yet (sub-project 2)"
        )
    app.state.auth_secret = resolve_auth_secret(
        ephemeral_ok=settings.auth.ephemeral_secret
    )
    app.state.token_verifier = LocalTokenVerifier(app.state.auth_secret)
    app.state.login_throttle = LoginThrottle()
    seed_admin(app.state.user_store)
```

and register the router alongside the others:

```python
    app.include_router(auth_router)
```

- [ ] **Step 5: Give the whole test suite bootstrap credentials**

Every existing API test builds an app through `create_app`, which now
requires a secret and bootstrap credentials. Create
`backend/tests/conftest.py`:

```python
"""Session-wide test environment.

create_app() now refuses to start without a signing secret and bootstrap
admin credentials (both deliberately fail-closed). Supplying them here
keeps every existing test building apps the way it always did, instead of
threading env vars through fifteen test modules.
"""

import os

import pytest

TEST_SECRET = "test-secret-value-that-is-long-enough-32"
TEST_ADMIN_EMAIL = "root@example.com"
TEST_ADMIN_PASSWORD = "bootstrap password"


@pytest.fixture(autouse=True, scope="session")
def _auth_env():
    previous = {
        key: os.environ.get(key)
        for key in ("FW_AUTH_SECRET", "FW_ADMIN_EMAIL", "FW_ADMIN_PASSWORD")
    }
    os.environ["FW_AUTH_SECRET"] = TEST_SECRET
    os.environ["FW_ADMIN_EMAIL"] = TEST_ADMIN_EMAIL
    os.environ["FW_ADMIN_PASSWORD"] = TEST_ADMIN_PASSWORD
    yield
    for key, value in previous.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
```

- [ ] **Step 6: Document the new configuration**

In `backend/config.example.yaml`, add at the top (above the existing
sections), keeping the file's existing comment style:

```yaml
# Authentication. These are startup-only: none of them can be changed
# through the API, so a stolen admin session cannot lift its own limits.
auth:
  mode: local                   # 'supabase' arrives with sub-project 2
  # Dev-only: allow a generated, per-start signing secret when
  # FW_AUTH_SECRET is unset. Tokens then die on every restart.
  ephemeral_secret: false
  # When false, no API call may create or promote an admin account.
  allow_additional_admins: false

# Required environment variables (never stored in this file):
#   FW_AUTH_SECRET     signing secret, >= 32 chars, randomly generated:
#                      openssl rand -base64 32
#   FW_ADMIN_EMAIL     bootstrap admin, used only while the users table is empty
#   FW_ADMIN_PASSWORD  bootstrap admin password, >= 12 chars
```

- [ ] **Step 7: Run the full suite**

Run: `uv run pytest -q`
Expected: PASS — the new auth tests plus every pre-existing test, zero
warnings. The `app_client` tests from Task 6 now pass.

- [ ] **Step 8: Commit**

```bash
git add app/main.py app/services/seed_admin.py config.example.yaml \
        tests/conftest.py tests/test_seed_admin.py
git commit -m "feat(auth): wire auth into the app factory with fail-closed bootstrap"
```

---

### Task 8: Admin user-management API

**Files:**
- Create: `backend/app/api/admin.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_admin_api.py`

**Interfaces:**
- Consumes: `require_admin`, `CurrentUser` (Task 5); `UserStore`,
  `DuplicateEmailError`, `User` (Task 4); `validate_password`,
  `ADMIN_SET_MIN_PASSWORD_LENGTH` (Task 2); `settings.auth.allow_additional_admins`
  (Task 1).
- Produces: `router` with prefix `/api/admin` carrying `require_admin` as a
  **router-level** dependency.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_admin_api.py`:

```python
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def build(tmp_path: Path, *, allow_additional_admins: bool = False) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        auth={"allow_additional_admins": allow_additional_admins},
    )
    return TestClient(create_app(settings))


@pytest.fixture()
def client(tmp_path: Path) -> TestClient:
    return build(tmp_path)


def admin_headers(client: TestClient) -> dict:
    token = client.post(
        "/api/auth/login",
        json={"email": "root@example.com", "password": "bootstrap password"},
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def make_user(client: TestClient, email="ada@example.com", **extra) -> dict:
    response = client.post(
        "/api/admin/users",
        json={"email": email, "password": "an initial password", **extra},
        headers=admin_headers(client),
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_endpoints_require_an_admin(client):
    assert client.get("/api/admin/users").status_code == 401
    make_user(client)
    normal = client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "an initial password"},
    ).json()["token"]
    response = client.get(
        "/api/admin/users", headers={"Authorization": f"Bearer {normal}"}
    )
    assert response.status_code == 403


def test_list_and_create(client):
    created = make_user(client, display_name="Ada", tier="premium")
    assert created["email"] == "ada@example.com" and created["tier"] == "premium"
    assert "password" not in str(created)
    listing = client.get("/api/admin/users", headers=admin_headers(client)).json()
    assert [u["email"] for u in listing] == ["ada@example.com", "root@example.com"]


def test_create_rejects_duplicates_and_weak_passwords(client):
    make_user(client)
    duplicate = client.post(
        "/api/admin/users",
        json={"email": "ADA@example.com", "password": "an initial password"},
        headers=admin_headers(client),
    )
    assert duplicate.status_code == 422
    weak = client.post(
        "/api/admin/users",
        json={"email": "new@example.com", "password": "short"},
        headers=admin_headers(client),
    )
    assert weak.status_code == 422
    assert "at least 12" in weak.json()["detail"]


def test_patch_updates_fields_and_writes_one_audit_row_per_field(client):
    user = make_user(client)
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"tier": "premium", "is_active": False},
        headers=admin_headers(client),
    )
    assert response.status_code == 200
    assert response.json()["tier"] == "premium"
    assert response.json()["is_active"] is False
    rows = client.app.state.user_store.list_audit()
    changed = {(r["field"], r["old_value"], r["new_value"]) for r in rows}
    assert ("tier", "basic", "premium") in changed
    assert ("is_active", "True", "False") in changed
    assert all(r["actor_id"] == 1 for r in rows)


def test_patch_can_reset_a_password_without_logging_it(client):
    user = make_user(client)
    response = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"password": "a replacement password"},
        headers=admin_headers(client),
    )
    assert response.status_code == 200
    assert client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "a replacement password"},
    ).status_code == 200
    rows = [r for r in client.app.state.user_store.list_audit() if r["field"] == "password"]
    assert len(rows) == 1
    assert rows[0]["old_value"] is None and rows[0]["new_value"] is None


def test_admin_cannot_lock_itself_out(client):
    headers = admin_headers(client)
    for payload in ({"is_admin": False}, {"is_active": False}):
        response = client.patch("/api/admin/users/1", json=payload, headers=headers)
        assert response.status_code == 409


def test_switch_blocks_admin_creation_and_promotion(client, caplog):
    with caplog.at_level("WARNING"):
        created = client.post(
            "/api/admin/users",
            json={"email": "second@example.com", "password": "an initial password",
                  "is_admin": True},
            headers=admin_headers(client),
        )
    assert created.status_code == 403
    assert "admin" in caplog.text.lower()
    user = make_user(client)
    promoted = client.patch(
        f"/api/admin/users/{user['id']}",
        json={"is_admin": True},
        headers=admin_headers(client),
    )
    assert promoted.status_code == 403


def test_demotion_is_allowed_even_while_the_switch_is_off(tmp_path):
    # Demotion only ever reduces privilege, so the switch must not block it.
    client = build(tmp_path, allow_additional_admins=True)
    second = client.post(
        "/api/admin/users",
        json={"email": "second@example.com", "password": "an initial password",
              "is_admin": True},
        headers=admin_headers(client),
    ).json()
    locked = build(tmp_path)  # same DB, switch now off
    response = locked.patch(
        f"/api/admin/users/{second['id']}",
        json={"is_admin": False},
        headers=admin_headers(locked),
    )
    assert response.status_code == 200 and response.json()["is_admin"] is False


def test_switch_on_permits_creation(tmp_path):
    client = build(tmp_path, allow_additional_admins=True)
    response = client.post(
        "/api/admin/users",
        json={"email": "second@example.com", "password": "an initial password",
              "is_admin": True},
        headers=admin_headers(client),
    )
    assert response.status_code == 201 and response.json()["is_admin"] is True
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_admin_api.py -q`
Expected: FAIL — `/api/admin/users` returns 404 because the router does not
exist yet.

- [ ] **Step 3: Write the implementation**

Create `backend/app/api/admin.py`:

```python
"""Admin user management.

`require_admin` is attached to the ROUTER, not to individual endpoints, so
an admin endpoint added later inherits the check by construction and cannot
be shipped without it.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.api.deps import CurrentUser, require_admin
from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, validate_password
from app.services.users import DuplicateEmailError, User

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])

logger = logging.getLogger(__name__)


class UserCreate(BaseModel):
    email: str
    password: str
    display_name: str | None = None
    tier: str = "basic"
    is_admin: bool = False


class UserPatch(BaseModel):
    display_name: str | None = None
    tier: str | None = None
    is_admin: bool | None = None
    is_active: bool | None = None
    password: str | None = None


def _store(request: Request):
    return request.app.state.user_store


def _check_password_strength(password: str) -> None:
    try:
        validate_password(password, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _guard_admin_creation(request: Request, actor: CurrentUser, target_email: str) -> None:
    """With the switch off, no API call may mint an admin.

    A stolen admin session can do damage until the account is deactivated or
    its password rotated — but it must not be able to create a *second*
    admin that survives that response. The switch is config-only for exactly
    that reason.
    """
    if request.app.state.settings.auth.allow_additional_admins:
        return
    logger.warning(
        "Denied admin grant for %s by user %s: auth.allow_additional_admins is off",
        target_email,
        actor.id,
    )
    raise HTTPException(403, "Creating additional admins is disabled")


@router.get("/users")
def list_users(request: Request) -> list[User]:
    return _store(request).list_users()


@router.post("/users", status_code=201)
def create_user(
    request: Request, body: UserCreate, actor: CurrentUser = Depends(require_admin)
) -> User:
    _check_password_strength(body.password)
    if body.is_admin:
        _guard_admin_creation(request, actor, body.email)
    store = _store(request)
    try:
        user = store.create_user(
            body.email,
            body.password,
            display_name=body.display_name,
            tier=body.tier,
            is_admin=body.is_admin,
        )
    except DuplicateEmailError as exc:
        raise HTTPException(422, str(exc)) from exc
    store.record_audit(actor_id=actor.id, target_id=user.id, field="created",
                       new_value=user.email)
    return user


@router.patch("/users/{user_id}")
def patch_user(
    request: Request,
    user_id: int,
    body: UserPatch,
    actor: CurrentUser = Depends(require_admin),
) -> User:
    store = _store(request)
    existing = store.get_user(user_id)
    if existing is None:
        raise HTTPException(404, "User not found")

    if user_id == actor.id and (body.is_admin is False or body.is_active is False):
        # Prevents an ordinary mistake from bricking the deployment. The
        # deliberate version of this action lives in the operator CLI.
        raise HTTPException(409, "An admin cannot remove their own access")
    if body.is_admin and not existing.is_admin:
        _guard_admin_creation(request, actor, existing.email)

    changes = {
        name: value
        for name, value in (
            ("display_name", body.display_name),
            ("tier", body.tier),
            ("is_admin", body.is_admin),
            ("is_active", body.is_active),
        )
        if value is not None and value != getattr(existing, name)
    }
    updated = store.update_user(user_id, **changes) if changes else existing
    for name, value in changes.items():
        store.record_audit(
            actor_id=actor.id,
            target_id=user_id,
            field=name,
            old_value=str(getattr(existing, name)),
            new_value=str(value),
        )
    if body.password is not None:
        _check_password_strength(body.password)
        store.set_password(user_id, body.password)
        # Never record password material, not even its length.
        store.record_audit(actor_id=actor.id, target_id=user_id, field="password")
    return updated
```

- [ ] **Step 4: Register the router**

In `backend/app/main.py`, add the import:

```python
from app.api.admin import router as admin_router
```

and register it next to the auth router:

```python
    app.include_router(admin_router)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_admin_api.py -q`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add app/api/admin.py app/main.py tests/test_admin_api.py
git commit -m "feat(admin): user management API with audit trail and admin-creation switch"
```

---

### Task 9: Operator CLI

**Files:**
- Create: `backend/app/manage.py`
- Test: `backend/tests/test_manage_cli.py`

**Interfaces:**
- Consumes: `UserStore` (Task 4); `validate_password`,
  `ADMIN_SET_MIN_PASSWORD_LENGTH` (Task 2); `load_settings` (config).
- Produces: `main(argv: list[str] | None = None, *, read_password=None) -> int`
  and the subcommands `list-users`, `set-password`, `make-admin`,
  `revoke-admin`, `deactivate`, `activate`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_manage_cli.py`:

```python
from pathlib import Path

import pytest

from app.core.config import Settings
from app.manage import main
from app.services.users import UserStore


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    path = tmp_path / "test.db"
    store = UserStore(path)
    store.create_user("root@example.com", "bootstrap password", is_admin=True)
    store.create_user("ada@example.com", "an initial password")
    return path


def run(db: Path, *args: str, password: str | None = None) -> int:
    return main(
        ["--db", str(db), *args],
        read_password=(lambda _prompt: password) if password else None,
    )


def test_list_users(db, capsys):
    assert run(db, "list-users") == 0
    output = capsys.readouterr().out
    assert "root@example.com" in output and "ada@example.com" in output
    assert "admin" in output.lower()


def test_set_password_lets_the_account_log_in_again(db):
    assert run(db, "set-password", "ada@example.com", password="a recovered password") == 0
    store = UserStore(db)
    assert store.verify_credentials("ada@example.com", "a recovered password") is not None


def test_set_password_never_accepts_the_password_as_an_argument(db):
    # A password in argv lands in shell history and in `ps` output for every
    # other process on the machine.
    with pytest.raises(SystemExit):
        main(["--db", str(db), "set-password", "ada@example.com", "hunter2hunter2"])


def test_set_password_enforces_the_admin_minimum(db, capsys):
    assert run(db, "set-password", "ada@example.com", password="short") == 1
    assert "at least 12" in capsys.readouterr().err


def test_set_password_refuses_in_supabase_mode(db, tmp_path, capsys, monkeypatch):
    # Writing a hash nothing reads would look successful while changing
    # nothing — and would become a live credential if the mode were ever
    # switched back to local.
    monkeypatch.setattr(
        "app.manage.load_settings",
        lambda: Settings(db_path=db, auth={"mode": "supabase"}),
    )
    assert run(db, "set-password", "ada@example.com", password="a recovered password") == 1
    assert "supabase" in capsys.readouterr().err.lower()
    assert UserStore(db).verify_credentials("ada@example.com", "an initial password") is not None


def test_make_admin_grants_and_reactivates(db):
    store = UserStore(db)
    store.update_user(2, is_active=False)
    assert run(db, "make-admin", "ada@example.com") == 0
    user = store.get_user(2)
    assert user.is_admin is True and user.is_active is True


def test_revoke_admin_warns_but_proceeds_when_no_admin_remains(db, capsys):
    assert run(db, "revoke-admin", "root@example.com") == 0
    assert UserStore(db).get_user(1).is_admin is False
    # It must not refuse: freezing all admin access and then minting a fresh
    # one with make-admin is a legitimate incident response.
    assert "no admin" in capsys.readouterr().err.lower()


def test_deactivate_and_activate(db):
    store = UserStore(db)
    assert run(db, "deactivate", "ada@example.com") == 0
    assert store.get_user(2).is_active is False
    assert run(db, "activate", "ada@example.com") == 0
    assert store.get_user(2).is_active is True


def test_unknown_email_is_an_error(db, capsys):
    assert run(db, "make-admin", "nobody@example.com") == 1
    assert "not found" in capsys.readouterr().err.lower()


def test_every_mutation_is_audited_as_an_out_of_band_action(db):
    run(db, "make-admin", "ada@example.com")
    rows = UserStore(db).list_audit()
    assert rows, "CLI mutations must be recorded"
    assert all(row["actor_id"] is None for row in rows)
    assert {row["field"] for row in rows} == {"is_admin"}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_manage_cli.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.manage'`.

- [ ] **Step 3: Write the implementation**

Create `backend/app/manage.py`:

```python
"""Operator CLI: `uv run python -m app.manage <command>`.

Recovery and incident response that must not depend on a working web
session — a forgotten admin password, or an admin account being misused.
It requires shell access to the machine, which already implies control of
the database, so it adds no attack surface; the alternatives (an env-var
password reset, or a recovery endpoint) would each leave a standing hole.
"""

import argparse
import getpass
import sqlite3
import sys
from collections.abc import Callable
from pathlib import Path

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, validate_password
from app.core.config import load_settings
from app.services.users import User, UserStore

# Long enough to wait out a running server's write, short enough to fail
# rather than hang. Each command performs a single write, so there is no
# read-modify-write transaction to deadlock on.
_BUSY_TIMEOUT_SECONDS = 10.0


def _prompt_password(prompt: str) -> str:
    if sys.stdin.isatty():
        return getpass.getpass(prompt)
    return sys.stdin.readline().rstrip("\n")


def _find(store: UserStore, email: str) -> User | None:
    user = store.get_by_email(email)
    if user is None:
        print(f"User not found: {email}", file=sys.stderr)
    return user


def _set_admin(store: UserStore, user: User, value: bool) -> None:
    store.update_user(user.id, is_admin=value)
    store.record_audit(
        actor_id=None,  # out-of-band operator action
        target_id=user.id,
        field="is_admin",
        old_value=str(user.is_admin),
        new_value=str(value),
    )


def _set_active(store: UserStore, user: User, value: bool) -> None:
    store.update_user(user.id, is_active=value)
    store.record_audit(
        actor_id=None,
        target_id=user.id,
        field="is_active",
        old_value=str(user.is_active),
        new_value=str(value),
    )


def _warn_if_no_admin_remains(store: UserStore) -> None:
    if any(user.is_admin and user.is_active for user in store.list_users()):
        return
    print(
        "Warning: no active admin account remains. Restore one with "
        "`python -m app.manage make-admin <email>`.",
        file=sys.stderr,
    )


def _cmd_list_users(store: UserStore, _args: argparse.Namespace) -> int:
    for user in store.list_users():
        flags = ", ".join(
            [*(["admin"] if user.is_admin else []), *([] if user.is_active else ["inactive"])]
        )
        print(f"{user.id}\t{user.email}\t{user.tier}\t{flags}")
    return 0


def _cmd_set_password(store: UserStore, args: argparse.Namespace) -> int:
    if load_settings().auth.mode != "local":
        print(
            "Refusing: auth.mode is 'supabase', where passwords live in "
            "Supabase and this hash would never be read. Use Supabase's own "
            "password reset flow.",
            file=sys.stderr,
        )
        return 1
    user = _find(store, args.email)
    if user is None:
        return 1
    password = args.read_password(f"New password for {user.email}: ")
    try:
        validate_password(password, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    store.set_password(user.id, password)
    store.record_audit(actor_id=None, target_id=user.id, field="password")
    print(f"Password updated for {user.email}")
    return 0


def _cmd_make_admin(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    _set_admin(store, user, True)
    if not user.is_active:
        _set_active(store, user, True)
    print(f"{user.email} is now an active admin")
    return 0


def _cmd_revoke_admin(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    _set_admin(store, user, False)
    print(f"Admin privileges revoked for {user.email}")
    # Warn rather than refuse: freezing all admin access during an incident
    # and then minting a fresh account is exactly what this tool is for.
    _warn_if_no_admin_remains(store)
    return 0


def _cmd_deactivate(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    _set_active(store, user, False)
    print(f"{user.email} deactivated; their next request will be rejected")
    _warn_if_no_admin_remains(store)
    return 0


def _cmd_activate(store: UserStore, args: argparse.Namespace) -> int:
    user = _find(store, args.email)
    if user is None:
        return 1
    _set_active(store, user, True)
    print(f"{user.email} reactivated")
    return 0


_COMMANDS = {
    "list-users": (_cmd_list_users, False),
    "set-password": (_cmd_set_password, True),
    "make-admin": (_cmd_make_admin, True),
    "revoke-admin": (_cmd_revoke_admin, True),
    "deactivate": (_cmd_deactivate, True),
    "activate": (_cmd_activate, True),
}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.manage")
    parser.add_argument("--db", type=Path, default=None, help="database path")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name, (_handler, needs_email) in _COMMANDS.items():
        sub = subparsers.add_parser(name)
        if needs_email:
            sub.add_argument("email")
    return parser


def main(argv: list[str] | None = None, *, read_password: Callable[[str], str] | None = None) -> int:
    # Passwords are read interactively or from stdin, never from argv: an
    # argument is visible in shell history and in `ps` to every other
    # process on the machine.
    args = _build_parser().parse_args(argv)
    args.read_password = read_password or _prompt_password
    db_path = args.db or load_settings().db_path
    store = UserStore(db_path, timeout=_BUSY_TIMEOUT_SECONDS)
    handler, _ = _COMMANDS[args.command]
    try:
        return handler(store, args)
    except sqlite3.OperationalError as exc:
        print(f"Database is busy ({exc}). Is the server writing right now?", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_manage_cli.py -q`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the full suite and check for warnings**

Run: `uv run pytest -q`
Expected: every test passes, zero warnings.

- [ ] **Step 6: Commit**

```bash
git add app/manage.py tests/test_manage_cli.py
git commit -m "feat(cli): operator commands for password and access recovery"
```

---

### Task 10: Documentation and PR

**Files:**
- Modify: `docs/backend-architecture.md`
- Modify: `docs/LOGBOOK.md`
- Modify: `backend/README.md` (if it documents environment variables; check
  first with `grep -n "ANTHROPIC_API_KEY" backend/README.md`)

- [ ] **Step 1: Document the new modules in the architecture doc**

In `docs/backend-architecture.md`, add a section describing: the `users` and
`admin_audit` tables; `app/core/auth.py` (secret resolution, password
hashing, token issue/verify, the `TokenVerifier` protocol and why it returns
a local id); `app/api/deps.py` (per-request re-read → immediate revocation);
`app/api/auth.py` (throttle, generic 401); `app/api/admin.py` (router-level
`require_admin`, the admin-creation switch); `app/manage.py`; and the
startup bootstrap. State explicitly that **no existing endpoint is
authenticated yet** and that enforcement lands in M2.

- [ ] **Step 2: Document the environment variables**

In `backend/README.md`, alongside the existing API-key documentation, add
`FW_AUTH_SECRET`, `FW_ADMIN_EMAIL` and `FW_ADMIN_PASSWORD`, including
`openssl rand -base64 32` for generating the secret and a note that the
bootstrap variables are read only while the users table is empty.

- [ ] **Step 3: Append the LOGBOOK entry**

Run `date '+%Y-%m-%d'` first and use that date. Record: what M1 delivered,
the commit range, the test counts before and after, and the fact that
authentication is not yet enforced.

- [ ] **Step 4: Run both gates**

From `backend/`: `uv run pytest -q` — expect all green, zero warnings.
From `frontend/`: `npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
— expect green (this milestone does not touch the frontend, so this is a
regression check only).

- [ ] **Step 5: Rehearse the migration against a copy of the live database**

```bash
cp backend/data/fabulous.db /tmp/fabulous-rehearsal.db
cd backend && FW_AUTH_SECRET="$(openssl rand -base64 32)" \
  FW_ADMIN_EMAIL="you@example.com" FW_ADMIN_PASSWORD="a bootstrap password" \
  uv run python -c "
from pathlib import Path
from app.core.config import Settings
from app.main import create_app
app = create_app(Settings(db_path=Path('/tmp/fabulous-rehearsal.db')))
store = app.state.user_store
print('users:', [(u.id, u.email, u.is_admin) for u in store.list_users()])
"
```

Expected: exactly one user, id 1, `is_admin=True`. **Never point this at
`backend/data/fabulous.db` itself.** Delete the rehearsal copy afterwards.

- [ ] **Step 6: Commit and open the PR**

```bash
git add docs/backend-architecture.md docs/LOGBOOK.md backend/README.md
git commit -m "docs: record the M1 auth core"
git push -u origin multi-user-auth-core
gh pr create --title "M1: multi-user auth core (users, local login, admin API, operator CLI)" --body "$(cat <<'EOF'
Milestone 1 of the multi-user work
(`docs/superpowers/plans/2026-07-25-multi-user-roadmap.md`), implementing
the auth foundation from the merged spec
(`docs/superpowers/specs/2026-07-24-multi-user-auth-design.md`).

**Scope note for reviewers: this PR authenticates no existing endpoint.**
Documents, folders, checks, profiles, terminology and the rest stay
unauthenticated exactly as before, so `main` keeps working with the
current frontend. Enforcement, together with the frontend that can satisfy
it, is M2. Read this milestone as the foundation, not as an incomplete
security change.

Delivered: `users` and `admin_audit` tables with a `UserStore`; bcrypt
password hashing with timing-equalised verification; a `TokenVerifier`
protocol whose local HS256 implementation pins one algorithm and validates
`exp`/`iss`/`aud`/`iat`; per-request identity resolution that re-reads the
user row (so deactivation and de-admin take effect immediately);
`/api/auth/login|me|password` with per-(email, IP) backoff and a single
generic failure message; `/api/admin/users` behind a router-level
`require_admin`, with an audit row per changed field and the config-only
admin-creation switch; the fail-closed startup bootstrap; and the operator
CLI for password and access recovery.

Security-relevant review focus: token verification pinning, the
enumeration and timing defenses on login, the self-lockout rule, and that
neither `auth.allow_additional_admins` nor any password material is
reachable through an API response.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh api -X POST repos/saigyo/fabulous-writing/pulls/<N>/requested_reviewers \
  -f "reviewers[]=copilot-pull-request-reviewer[bot]"
```

- [ ] **Step 7: Resolve every review thread before merging**

The `main` ruleset blocks the merge while any review thread is unresolved.
Replying to a comment does not resolve its thread.
