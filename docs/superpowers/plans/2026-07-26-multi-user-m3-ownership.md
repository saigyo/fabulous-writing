# Multi-User M3 — Ownership Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-owned resource (documents, folders, private profiles/domains/terms, check jobs) is visible and mutable only by its owner; built-ins become global rows every user can read and only admins can change; a password change revokes every outstanding token exactly, via a per-user token epoch.

**Architecture:** Ownership lives in the store APIs, not the routers: every store method touching an owned table takes the caller's identity as a **required, non-defaulted keyword parameter**, so a forgotten scope is a `TypeError` at the call site rather than a cross-tenant read. Visibility is enforced in SQL (`owner_id IS NULL OR owner_id = ?` for shared tables, `owner_id = ?` for never-global tables). Routers only translate: invisible → 404, global-mutation-as-non-admin → 403. The in-memory check-job registry gets the same treatment (jobs remember their owner; a foreign id is indistinguishable from an unknown one). Migration turns the single-user database into "admin (id 1) owns everything private; seed rows become global", with two guarded table rebuilds to make name uniqueness per-owner.

**Tech Stack:** Python 3.13 / FastAPI / SQLite (backend, `uv` from `backend/`), React 19 / TypeScript / zustand / vitest (frontend, from `frontend/`).

**Spec:** `docs/superpowers/specs/2026-07-24-multi-user-auth-design.md` §5.2 (ownership semantics), §7.2 (endpoint changes), §9 (migration steps 3 and 5). Roadmap: `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md` (M3 row, the check-jobs section, and the dated-comment audit).

## Global Constraints

Binding for every task; copied from the spec/roadmap where they originate.

- **Store API ownership guarantee** (spec §5.2): every store method touching `documents`/`folders` takes `owner_id` as a *required, non-defaulted* parameter. Profiles/domains/terms methods take the caller identity the same way. No method gets a default owner.
- **404, not 403** (spec §7.2): requesting another user's resource returns **404 — indistinguishable from nonexistent**. 403 is reserved for exactly one case: a non-admin mutating a global (`owner_id IS NULL`) profile/domain/term.
- **Admins are ordinary callers for private data**: an admin sees global rows plus *their own* rows — never another user's private items. `is_admin` only unlocks mutating global rows. (The admin UI over users arrives in M6 and reads the `users` table, not these stores.)
- **Seeders are the only writers of global rows** (spec §5.2): `seed_profiles` and `seed_terminology` create rows with `owner_id NULL` and their presence checks query only `owner_id IS NULL` rows. API create endpoints always create as the caller.
- **Terms inherit ownership through their domain** (spec §5.2): every term read/mutation resolves the parent domain and checks its ownership **in the store API, not the router**.
- **Migrations** (spec §9): idempotent (column-presence guards / rebuild-only-if-old-shape), rehearsed on a **copy** of the live DB before the PR. The name-match backfill runs **exactly once** — only in the step that adds the `owner_id` column. Every unique-index creation is preceded by the duplicate pre-scan + skip-with-warning pattern already used for `idx_folders_name_nocase`.
- **The live database `backend/data/fabulous.db` is never read or written by tests**, and `create_app()` is never called with default settings in tests — every test passes `tmp_path`-based `Settings`. The owner's dev servers on ports **5173/8000** are never killed or restarted.
- **Token epoch** (owner decision 2026-07-26, M2 ledger): password change revokes outstanding tokens by an integer epoch compared **for equality** — no time window. This changes the token claims and `VerifiedToken`; the roadmap's Cross-milestone interfaces section must be updated in this PR (Task 8).
- **Gates before every commit**: backend `uv run pytest -q` from `backend/` with **zero warnings**; frontend `npx vitest run && npm run lint && npm run build` from `frontend/`. (`npm run build` runs `tsc -b`; bare `tsc --noEmit` checks zero files in this solution-style setup and is **not** a gate.)
- **One home per requirement**: each requirement lives in exactly one snippet in this plan; the snippet is canonical and the prose explains only why. If a fix changes a requirement, the snippet changes, not a prose echo.
- **Mutation-verify every guard test**: for each test that pins a guard, delete the guard, watch the test fail, restore, and state in the report which mutation was applied and what was observed. Reviewers re-run at least two claimed mutations independently.
- **Subagents never run `git commit --amend`, `git rebase`, or force-push.**
- **Secrets from the environment only** (`FW_AUTH_SECRET`, `FW_ADMIN_EMAIL`, `FW_ADMIN_PASSWORD`); never in the repo, the DB, or a log line. Tokens never appear in URLs.
- **UI copy**: match the current impersonal register in all seven locales (en, de, fr, es, it, ja, zh); every new key lands in `messages.ts` and all seven catalogs in the same commit.

## File Structure

| File | Change |
|---|---|
| `backend/app/services/ownership.py` | **Create**: `GlobalReadOnlyError` (the one shared ownership exception) |
| `backend/app/services/users.py` | `token_epoch` column + model field; `set_password` bumps it |
| `backend/app/core/auth.py` | `issue_token(..., epoch=...)`; `VerifiedToken.epoch`; verifier requires the claim |
| `backend/app/api/deps.py` | epoch equality check in `get_current_user` |
| `backend/app/api/auth.py` | login passes the user's epoch into `issue_token` |
| `backend/app/services/documents.py` | required `owner_id` on every method; owner-scoped SQL |
| `backend/app/services/folders.py` | required `owner_id`; **guarded table rebuild** (drop inline `UNIQUE` + `DEFAULT 1`); per-owner NOCASE unique index |
| `backend/app/services/profiles.py` | nullable `owner_id` + backfill; **guarded rebuild** (drop `UNIQUE(language, name)`); two partial unique indexes; visibility-scoped methods; `is_global` |
| `backend/app/services/terminology.py` | nullable `owner_id` on `domains` + backfill; two partial unique indexes; visibility-scoped domain/term methods; `is_global`; `terms_for_check` |
| `backend/app/services/seed.py`, `seed_profiles.py` | create global rows; global-scoped presence checks |
| `backend/app/services/jobs.py` | jobs carry `owner_id`; `get` takes the caller |
| `backend/app/api/documents.py`, `folders.py`, `profiles.py`, `terminology.py`, `checks.py` | thread `CurrentUser`; 404/403 mapping; visible-set validation |
| `backend/app/checkers/terminology.py` | switch to `terms_for_check` |
| `backend/tests/conftest.py` | `second_user_headers` helper |
| `backend/tests/test_ownership.py` | **Create**: cross-user isolation sweep |
| `frontend/src/types.ts`, `api/client.ts` | `is_global` on `Domain`/`Profile` |
| `frontend/src/App.tsx` | generation guard on the domains fetch; rewrite the expired safety comment |
| `frontend/src/terminology/TerminologyView.tsx` | generation guard; global read-only affordances |
| `frontend/src/profiles/ProfilesView.tsx` | global read-only affordances |
| `frontend/src/i18n/messages.ts` + 7 catalogs | `globalBadge`, `globalBadgeTitle` |
| `docs/LOGBOOK.md`, `docs/backend-architecture.md`, `docs/frontend-architecture.md`, roadmap | Task 8 |

**Task order and why:** Task 1 (epoch) is independent. Task 2 (documents/folders) precedes Tasks 3–4 because documents/folders routers *consume* the profile/domain stores — changing those store signatures first would break routers that do not yet carry a `CurrentUser`. Task 3 (profiles) then updates its callers in `documents.py`/`folders.py` (which have the user threaded by then); Task 4 (terminology) updates its callers in `folders.py`/`profiles.py`/`checks.py`. Task 5 needs Task 4's visible-set filter already in place. Task 6 sweeps everything; Task 7 is frontend; Task 8 is rehearsal + docs.

---

### Task 1: Per-user token epoch

Exact revocation for password changes: a counter on `users`, incremented by `set_password`, carried as a token claim, compared **for equality** — replacing the same-second `iat < password_changed_at` residual documented in M2. The frontend already silently re-logs-in with the new password after a change (`AccountMenu.tsx`), so no frontend change is needed. **Deploy note (goes in the PR description): pre-M3 tokens carry no `epoch` claim and are rejected — every session is signed out once on upgrade.** That is acceptable: tokens live 24h anyway.

**Files:**
- Modify: `backend/app/services/users.py` (schema comment, `_migrate`, `User`, `set_password`, `_row_to_user`)
- Modify: `backend/app/core/auth.py` (`issue_token`, `VerifiedToken`, `LocalTokenVerifier.verify`)
- Modify: `backend/app/api/auth.py:320` (login call), `backend/app/api/deps.py` (epoch check)
- Test: `backend/tests/test_users_store.py`, `backend/tests/test_auth_core.py`, `backend/tests/test_auth_api.py`

**Interfaces:**
- Produces: `User.token_epoch: int` (serialization-excluded); `issue_token(user_id: int, secret: str, *, epoch: int, now: datetime | None = None) -> str`; `VerifiedToken(user_id: int, issued_at: datetime, epoch: int | None)` — `epoch=None` means "this verifier has no epoch concept" (the future Supabase verifier); `LocalTokenVerifier` always returns an int epoch.

- [ ] **Step 1: Failing store test** — in `test_users_store.py`:

```python
def test_set_password_bumps_token_epoch(tmp_path):
    store = UserStore(tmp_path / "u.db")
    user = store.create_user("epoch@example.com", "password-one")
    assert user.token_epoch == 0
    store.set_password(user.id, "password-two")
    assert store.get_user(user.id).token_epoch == 1
    store.set_password(user.id, "password-three")
    assert store.get_user(user.id).token_epoch == 2


def test_token_epoch_is_not_serialized(tmp_path):
    store = UserStore(tmp_path / "u.db")
    user = store.create_user("epoch2@example.com", "password-one")
    assert "token_epoch" not in user.model_dump()
```

Run: `uv run pytest tests/test_users_store.py -q` — expect FAIL (`token_epoch` unknown).

- [ ] **Step 2: Store implementation** — in `users.py`:
  - `_SCHEMA` users table gains `token_epoch INTEGER NOT NULL DEFAULT 0` (after `password_changed_at`).
  - `_migrate` adds `("token_epoch", "INTEGER NOT NULL DEFAULT 0")` to the `migrate_columns` list.
  - `User` gains `token_epoch: int = Field(default=0, exclude=True)` (`from pydantic import BaseModel, Field`) — excluded so admin-API `User` responses don't grow a field the client has no use for; attribute access is unaffected.
  - `_row_to_user` maps `token_epoch=row["token_epoch"]`.
  - `set_password` becomes:

```python
    def set_password(self, user_id: int, password: str) -> bool:
        # token_epoch bump = exact token revocation: every outstanding token
        # carries the pre-change epoch and fails the equality check in
        # get_current_user, with no same-second window (M2's documented
        # residual with the iat comparison).
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE users SET password_hash = ?, password_changed_at = ?,"
                " token_epoch = token_epoch + 1 WHERE id = ?",
                (hash_password(password), _utcnow(), user_id),
            )
        return cursor.rowcount > 0
```

Run the two tests — PASS. Run `uv run pytest tests/test_users_store.py -q` — all green.

- [ ] **Step 3: Failing token tests** — in `test_auth_core.py`:

```python
def test_issue_token_carries_epoch_and_verify_returns_it():
    token = issue_token(7, SECRET, epoch=3)
    verified = LocalTokenVerifier(SECRET).verify(token)
    assert verified.user_id == 7
    assert verified.epoch == 3


def test_token_without_epoch_claim_is_rejected():
    # A pre-M3 token: same claims minus epoch. Must die at 'require'.
    issued = datetime.now(UTC)
    legacy = jwt.encode(
        {
            "sub": "7",
            "iat": int(issued.timestamp()),
            "exp": int((issued + TOKEN_TTL).timestamp()),
            "iss": TOKEN_ISSUER,
            "aud": TOKEN_AUDIENCE,
        },
        SECRET,
        algorithm="HS256",
    )
    with pytest.raises(InvalidToken):
        LocalTokenVerifier(SECRET).verify(legacy)


def test_malformed_epoch_claim_is_rejected():
    issued = datetime.now(UTC)
    # True/False are load-bearing cases: bool is an int subclass, so
    # without the implementation's explicit bool guard they would pass an
    # isinstance check and compare equal to epochs 1/0.
    for bad in (["1"], {"n": 1}, "not-a-number", None, True, False):
        token = jwt.encode(
            {
                "sub": "7",
                "iat": int(issued.timestamp()),
                "exp": int((issued + TOKEN_TTL).timestamp()),
                "iss": TOKEN_ISSUER,
                "aud": TOKEN_AUDIENCE,
                "epoch": bad,
            },
            SECRET,
            algorithm="HS256",
        )
        with pytest.raises(InvalidToken):
            LocalTokenVerifier(SECRET).verify(token)
```

(Reuse the module's existing `SECRET` constant/imports; add what's missing.) Run — FAIL.

- [ ] **Step 4: Token implementation** — in `core/auth.py`:
  - `VerifiedToken` gains a third field:

```python
    epoch: int | None    # per-user token epoch; None = this verifier has no
                         # epoch concept (the future Supabase verifier), in
                         # which case get_current_user falls back to the
                         # password_changed_at comparison.
```

  - `issue_token` signature becomes `def issue_token(user_id: int, secret: str, *, epoch: int, now: datetime | None = None) -> str:` and the payload gains `"epoch": epoch`. `epoch` is keyword-required with no default for the same reason the store owner params have none: a call site that forgets it must not compile.
  - `LocalTokenVerifier.verify`: add `"epoch"` to the `"require"` list; after the `sub` parsing block:

```python
        raw_epoch = claims["epoch"]
        # bool is an int subclass; True would silently pass an isinstance
        # check and compare equal to epoch 1.
        if isinstance(raw_epoch, bool) or not isinstance(raw_epoch, int):
            raise InvalidToken("epoch is not an integer")
        return VerifiedToken(user_id=user_id, issued_at=issued_at, epoch=raw_epoch)
```

Run Step 3 tests — PASS. Then fix the callers the change breaks: `app/api/auth.py:320` becomes `token=issue_token(user.id, app.state.auth_secret, epoch=user.token_epoch)`; any test calling `issue_token` gains `epoch=0`; and any existing test that hand-crafts claims with `jwt.encode` (M1/M2 wrote several in `test_auth_core.py` / `test_health.py`-adjacent modules) gains `"epoch": 0` — unless the test's very point is a missing/invalid claim. Run `uv run pytest tests/test_auth_core.py tests/test_auth_api.py -q`.

- [ ] **Step 5: Failing enforcement test** — in `test_auth_api.py`:

```python
def test_password_change_revokes_old_token_immediately(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    old_headers = auth_headers(client)
    assert client.get("/api/auth/me", headers=old_headers).status_code == 200
    response = client.post(
        "/api/auth/password",
        json={"current": TEST_ADMIN_PASSWORD, "new": "a-brand-new-password"},
        headers=old_headers,
    )
    assert response.status_code == 204
    # No sleep: the epoch makes revocation exact, same-second included.
    assert client.get("/api/auth/me", headers=old_headers).status_code == 401
    token = client.post(
        "/api/auth/login",
        json={"email": TEST_ADMIN_EMAIL, "password": "a-brand-new-password"},
    ).json()["token"]
    assert (
        client.get(
            "/api/auth/me", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 200
    )
```

Run — expect FAIL at the 401 assertion (old token still accepted, because `iat`-vs-`changed_at` at second granularity lets the same-second token through — exactly the M2 residual).

- [ ] **Step 6: deps implementation** — in `deps.py`, replace the `password_changed_at` block's *placement* (keep its content) with an epoch-first check:

```python
    if verified.epoch is not None:
        # Local tokens always carry an epoch. Equality, not ordering: exact
        # revocation with no clock or granularity coupling.
        if verified.epoch != user.token_epoch:
            raise HTTPException(401, _UNAUTHENTICATED)
    elif user.password_changed_at:
        ...  # the existing fromisoformat / tzinfo / issued_at < changed_at
             # block, moved under this elif unchanged. It remains the
             # revocation contract for epoch-less verifiers (the future
             # Supabase verifier — pinned in the roadmap's interfaces).
```

Run Step 5's test — PASS. Add the epoch-less fallback test (a stub verifier keeps the old path honest):

```python
def test_epochless_verifier_falls_back_to_password_changed_at(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    app = create_app(settings)
    client = TestClient(app)
    auth_headers(client)  # forces admin bootstrap
    admin = app.state.user_store.get_by_email(TEST_ADMIN_EMAIL)
    app.state.user_store.set_password(admin.id, "changed-since-issuance")

    class EpochlessVerifier:
        def verify(self, token: str) -> VerifiedToken:
            return VerifiedToken(
                user_id=admin.id,
                issued_at=datetime.now(UTC) - timedelta(hours=1),
                epoch=None,
            )

    app.state.token_verifier = EpochlessVerifier()
    response = client.get(
        "/api/auth/me", headers={"Authorization": "Bearer anything"}
    )
    assert response.status_code == 401
```

- [ ] **Step 7: Mutation verification.** Delete the `verified.epoch != user.token_epoch` comparison (make the branch `pass`); `test_password_change_revokes_old_token_immediately` must FAIL. Restore. Delete the `elif` fallback; `test_epochless_verifier_falls_back_to_password_changed_at` must FAIL. Restore. Record both observations in the report.

- [ ] **Step 8: Full gate + commit**

Run: `uv run pytest -q` (zero warnings).

```bash
git add -A backend
git commit -m "feat(auth): per-user token epoch makes password-change revocation exact"
```

---

### Task 2: Owner-scoped documents and folders

`documents`/`folders` are **never global** — `owner_id INTEGER NOT NULL`. Every store method gains a required, non-defaulted `owner_id` keyword; every query is scoped. `folders` gets the guarded rebuild that drops the inline `UNIQUE` on `name` and the legacy `DEFAULT 1`, replaced by a per-owner NOCASE unique index. `documents` needs no rebuild and keeps its legacy `DEFAULT 1` (spec §5.2's honest caveat: its guarantee rests on the store API signature).

**Files:**
- Modify: `backend/app/services/documents.py`, `backend/app/services/folders.py`
- Modify: `backend/app/api/documents.py`, `backend/app/api/folders.py`
- Modify: `backend/tests/conftest.py` (add `second_user_headers`)
- Test: `backend/tests/test_documents.py`, `test_folders.py`, `test_documents_api.py`, `test_folders_api.py`

**Interfaces:**
- Consumes: `CurrentUser` from `app/api/deps.py` (M1/M2).
- Produces (later tasks and routers rely on these exact signatures):
  - `DocumentStore.create_document(name, language, *, owner_id: int, ...)`, `list_documents(*, owner_id: int)`, `get_document(document_id, *, owner_id: int)`, `update_document(document_id, base_revision, *, owner_id: int, **fields)`, `set_name(document_id, name, name_source, *, owner_id: int, only_if_source=None)`, `set_folder(document_id, folder_id, *, owner_id: int)`, `delete_document(document_id, *, owner_id: int)`
  - `FolderStore.list_folders(*, owner_id: int)`, `get_folder(folder_id, *, owner_id: int)`, `create_folder(name, *, owner_id: int)`, `rename_folder(folder_id, name, *, owner_id: int)`, `set_defaults(folder_id, defaults, *, owner_id: int)`, `delete_folder(folder_id, *, owner_id: int)`
- Note for the implementer: with a scoped `get_document(id, owner_id=...)`, a foreign document is `None` — the routers' existing `None → 404` branches deliver the 404-not-403 semantics without new code.

- [ ] **Step 1: conftest helper** — append to `backend/tests/conftest.py`:

```python
SECOND_USER_EMAIL = "second@example.com"
SECOND_USER_PASSWORD = "second user password"  # >= 12 chars (admin-set floor)


def second_user_headers(client: TestClient) -> dict[str, str]:
    """Bearer header for a second, non-admin user, created via the real
    admin API + login — the same honest path auth_headers takes."""
    admin = auth_headers(client)
    client.post(
        "/api/admin/users",
        json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
        headers=admin,
    )
    token = client.post(
        "/api/auth/login",
        json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
    ).json()["token"]
    return {"Authorization": f"Bearer {token}"}
```

- [ ] **Step 2: Failing store tests** — in `test_documents.py` and `test_folders.py` (adjust every existing call in these files to pass `owner_id=1`; then add):

```python
def test_documents_are_invisible_across_owners(tmp_path):
    store = DocumentStore(tmp_path / "d.db")
    doc = store.create_document("Mine", Language.EN, owner_id=1)
    assert store.get_document(doc.id, owner_id=2) is None
    assert store.list_documents(owner_id=2) == []
    assert store.update_document(doc.id, doc.revision, owner_id=2, text="x") is None
    assert store.set_name(doc.id, "Stolen", "user", owner_id=2) is None
    assert store.set_folder(doc.id, None, owner_id=2) is None
    assert store.delete_document(doc.id, owner_id=2) is False
    assert store.get_document(doc.id, owner_id=1) is not None  # unharmed


def test_folders_are_invisible_across_owners_and_names_are_per_owner(tmp_path):
    store = FolderStore(tmp_path / "f.db")
    folder = store.create_folder("Projects", owner_id=1)
    assert store.get_folder(folder.id, owner_id=2) is None
    assert store.list_folders(owner_id=2) == []
    assert store.rename_folder(folder.id, "X", owner_id=2) is None
    assert store.delete_folder(folder.id, owner_id=2) is False
    # Per-owner uniqueness: owner 2 may reuse owner 1's name...
    store.create_folder("Projects", owner_id=2)
    # ...but not their own, case-insensitively.
    with pytest.raises(ValueError):
        store.create_folder("projects", owner_id=2)


def test_folder_rebuild_drops_inline_unique_and_default(tmp_path):
    FolderStore(tmp_path / "f.db")
    with connect(tmp_path / "f.db") as conn:
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='folders'"
        ).fetchone()[0]
        assert "UNIQUE" not in sql.upper()
        assert "DEFAULT 1" not in sql
        index_names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
    assert "idx_folders_owner_name" in index_names


def test_folder_rebuild_migrates_a_legacy_table(tmp_path):
    # Build the pre-M3 shape by hand, then let FolderStore migrate it.
    db = tmp_path / "legacy.db"
    with connect(db) as conn:
        conn.execute(
            """CREATE TABLE folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            )"""
        )
        conn.execute(
            "INSERT INTO folders (name, created_at) VALUES ('Kept', '2026-01-01T00:00:00+00:00')"
        )
    store = FolderStore(db)
    kept = store.list_folders(owner_id=1)
    assert [f.name for f in kept] == ["Kept"]
    # Idempotent: a second open must not rebuild again or fail.
    FolderStore(db)
    assert [f.name for f in store.list_folders(owner_id=1)] == ["Kept"]


def test_delete_folder_only_unfiles_the_owners_documents(tmp_path):
    # delete_folder's documents UPDATE must carry the owner scope too:
    # ids are per-table counters, so another owner's folder can share the
    # numeric id and their documents must not be unfiled by our delete.
    db = tmp_path / "d.db"
    docs = DocumentStore(db)
    folders = FolderStore(db)
    mine = folders.create_folder("Mine", owner_id=1)
    doc = docs.create_document("Doc", Language.EN, owner_id=2)
    docs.set_folder(doc.id, mine.id, owner_id=2)  # same numeric id, owner 2
    folders.delete_folder(mine.id, owner_id=1)
    assert docs.get_document(doc.id, owner_id=2).folder_id == mine.id
```

Run: `uv run pytest tests/test_documents.py tests/test_folders.py -q` — FAIL (TypeError on the new keyword).

- [ ] **Step 3: DocumentStore implementation** — in `services/documents.py`:
  - Every public method gains keyword-only `*, owner_id: int` (signatures above). No SQL default is relied on: `create_document`'s INSERT lists `owner_id` explicitly; every SELECT/UPDATE/DELETE appends `AND owner_id = ?` (for `update_document`, the optimistic `WHERE id = ? AND revision = ?` becomes `WHERE id = ? AND revision = ? AND owner_id = ?`, and its internal `get_document` calls pass the owner through, so a foreign id keeps returning `None`, never `RevisionConflictError`).
  - `set_name` keeps its `only_if_source` guard; the owner predicate joins it.
  - The `Document.owner_id` model field loses its `= 1` default (it is always read from the row).

- [ ] **Step 4: FolderStore implementation** — in `services/folders.py`:
  - `_SCHEMA` becomes the born-right shape (this is what fresh databases get; the rebuild below converts legacy ones):

```python
_SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    default_language TEXT,
    default_profile_id INTEGER,
    default_domain_ids TEXT,
    default_llm_provider TEXT,
    default_llm_model TEXT,
    default_llm_tier TEXT,
    default_llm_auto INTEGER
);
"""
```

  - `_migrate` becomes (replacing the old NOCASE-index block entirely — `idx_folders_name_nocase` dies with the rebuild and must not be recreated):

```python
    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        migrate_columns(
            conn,
            "folders",
            [
                ("default_language", "TEXT"),
                ("default_profile_id", "INTEGER"),
                ("default_domain_ids", "TEXT"),
                ("default_llm_provider", "TEXT"),
                ("default_llm_model", "TEXT"),
                ("default_llm_tier", "TEXT"),
                ("default_llm_auto", "INTEGER"),
            ],
        )
        # M3 rebuild, guarded by shape: the legacy table carries an inline
        # UNIQUE on name (global uniqueness — wrong once folders are
        # per-user) and a DEFAULT 1 on owner_id (would let an INSERT that
        # forgets the owner silently file under the admin). SQLite cannot
        # drop either without the documented table rebuild.
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='folders'"
        ).fetchone()[0]
        if "UNIQUE" in sql.upper() or "DEFAULT 1" in sql:
            columns = (
                "id, owner_id, name, created_at, default_language,"
                " default_profile_id, default_domain_ids, default_llm_provider,"
                " default_llm_model, default_llm_tier, default_llm_auto"
            )
            conn.execute(_SCHEMA.replace("IF NOT EXISTS folders", "folders_new"))
            conn.execute(
                f"INSERT INTO folders_new ({columns}) SELECT {columns} FROM folders"
            )
            conn.execute("DROP TABLE folders")
            conn.execute("ALTER TABLE folders_new RENAME TO folders")
        # Per-owner NOCASE uniqueness, with the house duplicate pre-scan.
        duplicates = conn.execute(
            "SELECT owner_id, name FROM folders"
            " GROUP BY owner_id, lower(name) HAVING count(*) > 1"
        ).fetchall()
        if duplicates:
            logger.warning(
                "folders table has per-owner case-duplicate names %s; "
                "skipping unique index",
                [(row[0], row[1]) for row in duplicates],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_owner_name "
                "ON folders(owner_id, name COLLATE NOCASE)"
            )
```

  - Every method gains keyword-only `*, owner_id: int`; INSERT lists `owner_id`; every WHERE gains `AND owner_id = ?`. `delete_folder` scopes **both** statements:

```python
    def delete_folder(self, folder_id: int, *, owner_id: int) -> bool:
        """Folders never take documents with them: members drop back to the
        ungrouped list in the same transaction as the folder row's removal.
        Both statements carry the owner: folder ids are just integers, so
        without the scope a caller could unfile another owner's documents."""
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM folders WHERE id = ? AND owner_id = ?",
                (folder_id, owner_id),
            )
            if cursor.rowcount:
                conn.execute(
                    "UPDATE documents SET folder_id = NULL"
                    " WHERE folder_id = ? AND owner_id = ?",
                    (folder_id, owner_id),
                )
        return cursor.rowcount > 0
```

  - `Folder.owner_id` loses its `= 1` default.

Run Step 2's tests — PASS. Whole store suites green.

- [ ] **Step 5: Failing API tests** — in `test_documents_api.py` / `test_folders_api.py`:

```python
def test_documents_api_is_owner_scoped(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    doc = client.post(
        "/api/documents",
        json={"name": "Mine", "language": "en"},
        headers=admin,
    ).json()
    # Foreign id: indistinguishable from nonexistent -- 404 on every verb.
    assert client.get(f"/api/documents/{doc['id']}", headers=other).status_code == 404
    assert (
        client.put(
            f"/api/documents/{doc['id']}",
            json={"revision": 0, "name": "Stolen"},
            headers=other,
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/documents/{doc['id']}", headers=other).status_code == 404
    )
    assert (
        client.post(
            f"/api/documents/{doc['id']}/move",
            json={"folder_id": None},
            headers=other,
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/documents/{doc['id']}/generate-name", headers=other
        ).status_code
        == 404
    )
    listed = client.get("/api/documents", headers=other).json()
    assert listed == []
    # And the owner still sees it untouched.
    assert (
        client.get(f"/api/documents/{doc['id']}", headers=admin).json()["name"]
        == "Mine"
    )


def test_folders_api_is_owner_scoped(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    folder = client.post("/api/folders", json={"name": "Mine"}, headers=admin).json()
    assert (
        client.put(
            f"/api/folders/{folder['id']}", json={"name": "Stolen"}, headers=other
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"/api/folders/{folder['id']}/defaults", json={}, headers=other
        ).status_code
        == 404
    )
    assert client.delete(f"/api/folders/{folder['id']}", headers=other).status_code == 404
    assert client.get("/api/folders", headers=other).json() == []
    # Both owners may hold the same folder name.
    assert (
        client.post("/api/folders", json={"name": "Mine"}, headers=other).status_code
        == 201
    )
    # A document may not be filed into another owner's folder.
    assert (
        client.post(
            "/api/documents",
            json={"name": "D", "language": "en", "folder_id": folder["id"]},
            headers=other,
        ).status_code
        == 422
    )
```

Run — FAIL.

- [ ] **Step 6: Router implementation** — in `api/documents.py` and `api/folders.py`: every handler gains `user: CurrentUser = Depends(get_current_user)` (imports: `from fastapi import Depends`, `from app.api.deps import CurrentUser, get_current_user`; FastAPI caches the dependency per request, so the router-level guard from `main.py` does not run twice) and threads `owner_id=user.id` into every store call, including the folder-existence checks at `documents.py:84` and `:165` (a foreign folder is `None` → the existing 422 "Unknown folder"). No handler grows new logic beyond the threading; the `None → 404` branches that exist today now fire for foreign ids too.

Run Step 5's tests — PASS. Adjust the remaining existing API tests in these two modules (they use `authed_client`, whose admin owns everything it creates — most pass unchanged).

- [ ] **Step 7: Mutation verification.** (1) Remove `AND owner_id = ?` from `DocumentStore.get_document` — `test_documents_are_invisible_across_owners` and `test_documents_api_is_owner_scoped` must FAIL. Restore. (2) Remove the owner predicate from `delete_folder`'s documents UPDATE — `test_delete_folder_only_unfiles_the_owners_documents` must FAIL. Restore. Record.

- [ ] **Step 8: Full gate + commit**

Run: `uv run pytest -q` (zero warnings).

```bash
git add -A backend
git commit -m "feat(ownership): owner-scoped documents and folders with per-owner folder names"
```

---

### Task 3: Profiles — nullable owner, global built-ins, guarded rebuild

`profiles.owner_id` is nullable: NULL = global built-in (visible to all, mutable only by admins), integer = private. Migration: add the column, backfill by name-match against the seed sets (exactly once), rebuild to drop `UNIQUE(language, name)`, then two partial unique indexes. The `language` dimension stays in both indexes — global built-ins repeat names per language (`Standard` × 7), and a user may hold the same profile name in several languages.

**Files:**
- Create: `backend/app/services/ownership.py`
- Modify: `backend/app/services/profiles.py`, `backend/app/services/seed_profiles.py`
- Modify: `backend/app/api/profiles.py`; caller threading in `backend/app/api/documents.py:110`, `backend/app/api/folders.py:45,88`
- Test: `backend/tests/test_profiles.py`, `test_profiles_api.py`, `test_seed_profiles.py` (extend existing seed tests where they live), `test_register_consistency.py`-style seed-name consistency test in `test_profiles.py`

**Interfaces:**
- Produces:
  - `app/services/ownership.py`: `class GlobalReadOnlyError(Exception)` — raised by any store when a non-admin mutates a global row; routers map it to `HTTPException(403, "Only admins can change built-in items")`.
  - `ProfileStore.list_profiles(language, *, owner_id: int)`, `get_profile(profile_id, *, owner_id: int)`, `create_profile(language, name, *, owner_id: int | None, ...)` (`None` is written **only** by `seed_profiles` / migration), `update_profile(profile_id, *, owner_id: int, is_admin: bool, **fields)`, `delete_profile(profile_id, *, owner_id: int, is_admin: bool) -> bool`, `standard_profile(language)` (now global-scoped: `WHERE owner_id IS NULL AND is_standard = 1`).
  - `Profile` model: `owner_id: int | None = Field(default=None, exclude=True)` plus serialized `is_global`:

```python
    @computed_field  # appears in every API response; owner_id itself does not
    @property
    def is_global(self) -> bool:
        return self.owner_id is None
```

  - `_SEED_EXAMPLE_NAMES: tuple[str, ...] = ("Marketing", "Technical Documentation", "Blog")` — module constant in `profiles.py`, the migration's single source for the name-match backfill.

- [ ] **Step 1: `ownership.py`**

```python
"""The one ownership exception shared by the resource stores."""


class GlobalReadOnlyError(Exception):
    """A non-admin tried to mutate a global (owner_id NULL) row."""
```

- [ ] **Step 2: Failing store tests** — in `test_profiles.py` (thread `owner_id=`/`is_admin=` through existing calls: reads get `owner_id=1`, seeder-style creates get `owner_id=None`, mutations get `owner_id=1, is_admin=True`; then add):

```python
def test_profile_visibility_global_plus_own(tmp_path):
    store = ProfileStore(tmp_path / "p.db")
    builtin = store.create_profile(Language.EN, "Standard", owner_id=None, is_standard=True)
    mine = store.create_profile(Language.EN, "Mine", owner_id=1)
    theirs = store.create_profile(Language.EN, "Theirs", owner_id=2)
    visible = {p.name for p in store.list_profiles(Language.EN, owner_id=1)}
    assert visible == {"Standard", "Mine"}
    assert store.get_profile(theirs.id, owner_id=1) is None
    assert store.get_profile(builtin.id, owner_id=1).is_global is True
    assert store.get_profile(mine.id, owner_id=1).is_global is False


def test_global_profile_mutation_requires_admin(tmp_path):
    store = ProfileStore(tmp_path / "p.db")
    builtin = store.create_profile(Language.EN, "Standard", owner_id=None, is_standard=True)
    with pytest.raises(GlobalReadOnlyError):
        store.update_profile(builtin.id, owner_id=1, is_admin=False, example_text="x")
    with pytest.raises(GlobalReadOnlyError):
        store.delete_profile(builtin.id, owner_id=1, is_admin=False)
    assert (
        store.update_profile(
            builtin.id, owner_id=1, is_admin=True, example_text="x"
        ).example_text
        == "x"
    )


def test_profile_names_unique_per_owner_and_global_partition(tmp_path):
    store = ProfileStore(tmp_path / "p.db")
    store.create_profile(Language.EN, "Casual", owner_id=None)
    # A user may shadow a global name...
    store.create_profile(Language.EN, "Casual", owner_id=1)
    # ...and another user may hold it too...
    store.create_profile(Language.EN, "casual", owner_id=2)
    # ...but neither partition tolerates its own duplicate (NOCASE).
    with pytest.raises(ValueError):
        store.create_profile(Language.EN, "casual", owner_id=1)
    with pytest.raises(ValueError):
        store.create_profile(Language.EN, "CASUAL", owner_id=None)
    # The language dimension is load-bearing: same name, other language, fine.
    store.create_profile(Language.DE, "Casual", owner_id=1)


def test_owner_id_not_serialized_but_is_global_is(tmp_path):
    store = ProfileStore(tmp_path / "p.db")
    profile = store.create_profile(Language.EN, "Mine", owner_id=1)
    dumped = profile.model_dump()
    assert "owner_id" not in dumped
    assert dumped["is_global"] is False


def test_migration_backfills_ownership_by_seed_name_match(tmp_path):
    # Legacy pre-M3 shape with the table-level UNIQUE and no owner_id.
    db = tmp_path / "legacy.db"
    with connect(db) as conn:
        conn.execute(
            """CREATE TABLE profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                language TEXT NOT NULL,
                name TEXT NOT NULL,
                is_standard INTEGER NOT NULL DEFAULT 0,
                categories_off TEXT NOT NULL DEFAULT '[]',
                rule_exceptions TEXT NOT NULL DEFAULT '[]',
                packs_on TEXT NOT NULL DEFAULT '[]',
                domain_ids TEXT NOT NULL DEFAULT '[]',
                llm_provider TEXT,
                llm_model TEXT,
                llm_tier TEXT,
                llm_instructions TEXT NOT NULL DEFAULT '',
                example_text TEXT NOT NULL DEFAULT '',
                UNIQUE(language, name)
            )"""
        )
        conn.execute("CREATE TABLE profile_seed_markers (language TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO profile_seed_markers VALUES ('en')")
        rows = [
            ("en", "Standard", 1),   # standard -> global
            ("en", "Marketing", 0),  # seed name + seeded language -> global
            ("en", "My Style", 0),   # user row -> admin (1)
            ("de", "Marketing", 0),  # seed name, UNseeded language -> admin
        ]
        for language, name, std in rows:
            conn.execute(
                "INSERT INTO profiles (language, name, is_standard) VALUES (?, ?, ?)",
                (language, name, std),
            )
    store = ProfileStore(db)
    with connect(db) as conn:
        owners = {
            (row["language"], row["name"]): row["owner_id"]
            for row in conn.execute("SELECT language, name, owner_id FROM profiles")
        }
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='profiles'"
        ).fetchone()[0]
    assert owners == {
        ("en", "Standard"): None,
        ("en", "Marketing"): None,
        ("en", "My Style"): 1,
        ("de", "Marketing"): 1,
    }
    assert "UNIQUE" not in sql.upper()  # rebuild dropped the constraint
    ProfileStore(db)  # idempotent second open


def test_backfill_runs_exactly_once(tmp_path):
    # A post-migration rename onto a seed name must NOT be re-globalized.
    db = tmp_path / "p.db"
    store = ProfileStore(db)
    mine = store.create_profile(Language.EN, "My Style", owner_id=1)
    store.update_profile(mine.id, owner_id=1, is_admin=False, name="Marketing")
    ProfileStore(db)  # reopen: migration guard must skip the backfill
    assert store.get_profile(mine.id, owner_id=1).is_global is False


def test_seed_name_constant_matches_the_seeder():
    from app.services import seed_profiles
    import inspect

    source = inspect.getsource(seed_profiles.seed_profiles)
    for name in _SEED_EXAMPLE_NAMES:
        assert f'"{name}"' in source, name
```

Run — FAIL.

- [ ] **Step 3: Store implementation** — in `services/profiles.py`:
  - `_SCHEMA`: drop `UNIQUE(language, name)`, add `owner_id INTEGER` (nullable, no default) to the fresh-create DDL.
  - `Profile` model changes as in Interfaces (`from pydantic import computed_field`); `_row_to_profile` maps `owner_id=row["owner_id"]`.
  - `_migrate` (full replacement; `_SEED_EXAMPLE_NAMES` at module top):

```python
    def _migrate(self, conn: sqlite3.Connection) -> None:
        # Pre-existing databases lack columns added later; guard by name.
        migrate_columns(
            conn,
            "profiles",
            [("llm_tier", "TEXT"), ("packs_on", "TEXT NOT NULL DEFAULT '[]'")],
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(profiles)")}
        if "owner_id" not in columns:
            # One-shot backfill against the pre-auth single-owner DB (spec
            # §9 step 3): seed rows (name-matched, since there are no
            # per-row seed markers) become global, everything else belongs
            # to the admin (id 1). Never re-run: a later rename onto a seed
            # name must not re-globalize a private row.
            conn.execute("ALTER TABLE profiles ADD COLUMN owner_id INTEGER")
            placeholders = ", ".join("?" for _ in _SEED_EXAMPLE_NAMES)
            conn.execute(
                f"""UPDATE profiles SET owner_id = 1
                    WHERE is_standard = 0
                      AND NOT (name IN ({placeholders})
                               AND language IN
                                   (SELECT language FROM profile_seed_markers))""",
                _SEED_EXAMPLE_NAMES,
            )
            # is_standard rows and marker-matched seed names keep NULL.
        # Rebuild, guarded by shape: the legacy table-level
        # UNIQUE(language, name) enforces global cross-owner uniqueness and
        # SQLite cannot drop it without the documented table rebuild.
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='profiles'"
        ).fetchone()[0]
        if "UNIQUE" in sql.upper():
            cols = (
                "id, language, name, is_standard, categories_off,"
                " rule_exceptions, packs_on, domain_ids, llm_provider,"
                " llm_model, llm_tier, llm_instructions, example_text, owner_id"
            )
            conn.execute(_SCHEMA_TABLE.replace("IF NOT EXISTS profiles", "profiles_new"))
            conn.execute(
                f"INSERT INTO profiles_new ({cols}) SELECT {cols} FROM profiles"
            )
            conn.execute("DROP TABLE profiles")
            conn.execute("ALTER TABLE profiles_new RENAME TO profiles")
        # Two partial unique indexes (SQLite treats NULLs as distinct, so a
        # single composite index would let duplicate global names pass),
        # each preceded by the house duplicate pre-scan.
        user_dupes = conn.execute(
            "SELECT owner_id, language, name FROM profiles"
            " WHERE owner_id IS NOT NULL"
            " GROUP BY owner_id, language, lower(name) HAVING count(*) > 1"
        ).fetchall()
        if user_dupes:
            logger.warning(
                "profiles has per-owner duplicates %s; skipping owner index",
                [tuple(row) for row in user_dupes],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_owner_lang_name"
                " ON profiles(owner_id, language, name COLLATE NOCASE)"
                " WHERE owner_id IS NOT NULL"
            )
        global_dupes = conn.execute(
            "SELECT language, name FROM profiles WHERE owner_id IS NULL"
            " GROUP BY language, lower(name) HAVING count(*) > 1"
        ).fetchall()
        if global_dupes:
            logger.warning(
                "profiles has global duplicates %s; skipping global index",
                [tuple(row) for row in global_dupes],
            )
        else:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_global_lang_name"
                " ON profiles(language, name COLLATE NOCASE)"
                " WHERE owner_id IS NULL"
            )
```

    Note: split `_SCHEMA` into `_SCHEMA_TABLE` (the profiles DDL, reused by the rebuild) plus the marker-table DDL, keeping `executescript(_SCHEMA)` behavior identical. `logger = logging.getLogger(__name__)` joins the module.
  - Methods (visibility in SQL, admin rule in the store):

```python
    def list_profiles(self, language: Language, *, owner_id: int) -> list[Profile]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM profiles WHERE language = ?"
                " AND (owner_id IS NULL OR owner_id = ?)"
                " ORDER BY is_standard DESC, name",
                (language.value, owner_id),
            ).fetchall()
        return [_row_to_profile(row) for row in rows]

    def get_profile(self, profile_id: int, *, owner_id: int) -> Profile | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM profiles WHERE id = ?"
                " AND (owner_id IS NULL OR owner_id = ?)",
                (profile_id, owner_id),
            ).fetchone()
        return _row_to_profile(row) if row else None
```

    `create_profile(language, name, *, owner_id: int | None, ...)`: INSERT lists `owner_id`. `update_profile(profile_id, *, owner_id: int, is_admin: bool, **fields)` and `delete_profile(profile_id, *, owner_id: int, is_admin: bool)`: fetch via the scoped `get_profile` (invisible → `None`/`False`), then `if current.is_global and not is_admin: raise GlobalReadOnlyError(...)`, then the existing UPDATE/DELETE by bare id (safe: visibility was just proven). `standard_profile` adds `AND owner_id IS NULL`. `remove_domain_everywhere` stays deliberately unscoped, with this comment: a domain deletion must drop the id from **every** owner's profiles — it removes a dangling integer, reveals nothing, and leaving foreign references would resurrect meaning if ids are ever reused.
  - `seed_profiles.py`: both `_create_ignoring_collision` call paths pass `owner_id=None` (add the parameter to `_create_ignoring_collision` and thread it); the presence checks are already global-scoped via the changed `standard_profile` and the marker table.

Run Step 2's tests — PASS.

- [ ] **Step 4: Failing API tests** — in `test_profiles_api.py`:

```python
def test_profiles_api_ownership(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    listed = client.get("/api/profiles?language=en", headers=other).json()
    # Non-admin sees the seeded globals, flagged as such.
    assert listed and all(p["is_global"] for p in listed)
    assert all("owner_id" not in p for p in listed)
    standard = next(p for p in listed if p["name"] == "Standard")
    # Global mutation as non-admin: 403 (the one non-404 case).
    body = {k: v for k, v in standard.items() if k not in ("id", "is_standard", "is_global")}
    assert (
        client.put(
            f"/api/profiles/{standard['id']}", json={**body, "example_text": "x"},
            headers=other,
        ).status_code
        == 403
    )
    assert client.delete(f"/api/profiles/{standard['id']}", headers=other).status_code == 403
    assert client.post(f"/api/profiles/{standard['id']}/reset", headers=other).status_code == 403
    # Admin may still edit and reset the global Standard.
    assert client.post(f"/api/profiles/{standard['id']}/reset", headers=admin).status_code == 200
    # Creation is always as the caller; shadowing a global name is fine.
    created = client.post(
        "/api/profiles", json={**body, "name": "Standard"}, headers=other
    ).json()
    assert created["is_global"] is False
    # The other user's private profile is invisible to the admin — admins
    # are ordinary callers for private data (Global Constraints): absent
    # from the listing, 404 on direct access.
    admin_names = {
        p["name"] for p in client.get("/api/profiles?language=en", headers=admin).json()
    }
    assert "Standard" in admin_names          # the global one
    assert created["id"] not in {
        p["id"] for p in client.get("/api/profiles?language=en", headers=admin).json()
    }
    assert (
        client.put(
            f"/api/profiles/{created['id']}", json=body, headers=admin
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/profiles/{created['id']}", headers=admin).status_code
        == 404
    )
```

Run — FAIL.

- [ ] **Step 5: Router implementation** — in `api/profiles.py`: thread `user` (`Depends(get_current_user)`) into every handler; `list_profiles`/`get` pass `owner_id=user.id`; create passes `owner_id=user.id`; update/delete/reset pass `owner_id=user.id, is_admin=user.is_admin` and wrap the store call:

```python
    except GlobalReadOnlyError:
        raise HTTPException(403, "Only admins can change built-in items") from None
```

  Reset keeps its `is_standard` gate; the Standard rename/delete guards keep their 409s (they fire only for callers who may mutate the row at all). Update the two **caller sites outside this router** the signature change breaks: `api/documents.py:110` → `profile_store.get_profile(document.profile_id, owner_id=user.id)` (a foreign/private profile referenced by a document now prunes to `None`, same as deleted — correct); `api/folders.py:45` and `:88` likewise (foreign profile default → pruned / 422 "Unknown profile"). Both routers already carry `user` from Task 2.

Run Step 4's tests — PASS.

- [ ] **Step 6: Mutation verification.** (1) Remove the `(owner_id IS NULL OR owner_id = ?)` predicate from `get_profile` — `test_profile_visibility_global_plus_own` and the API 404 assertions must FAIL. Restore. (2) Remove the `GlobalReadOnlyError` raise in `update_profile` — `test_global_profile_mutation_requires_admin` and the 403 assertions must FAIL. Restore. (3) In `_migrate`, drop the `NOT (...)` clause from the backfill UPDATE — `test_migration_backfills_ownership_by_seed_name_match` must FAIL. Restore. Record all three.

- [ ] **Step 7: Full gate + commit**

Run: `uv run pytest -q` (zero warnings).

```bash
git add -A backend
git commit -m "feat(ownership): profiles gain nullable owner_id, global built-ins, per-owner names"
```

---

### Task 4: Terminology — domains, terms-through-domains, check-request filtering

Domains mirror profiles (nullable `owner_id`, no rebuild needed — no existing unique constraint; two partial unique indexes make names per-owner **for the first time**, so the duplicate pre-scan genuinely matters here). Terms have no own column: every term operation resolves the parent domain in the store. `POST /api/checks` filters `domain_ids` to the caller's visible set **in this task**, because this is what makes the checker's unscoped read safe.

**Files:**
- Modify: `backend/app/services/terminology.py`, `backend/app/services/seed.py`
- Modify: `backend/app/api/terminology.py`, `backend/app/api/checks.py` (filter only), `backend/app/checkers/terminology.py:87`
- Modify (caller threading): `backend/app/api/folders.py:48,98`, `backend/app/api/profiles.py:52`
- Modify: `backend/app/main.py:109-135` (startup reorder, Step 4a)
- Test: `backend/tests/test_terminology.py`, `test_terminology_api.py`, `test_seed.py`, `test_check_api.py`, `test_main.py`

**Interfaces:**
- Produces:
  - `TerminologyStore.list_domains(*, owner_id: int)`, `get_domain(domain_id, *, owner_id: int)`, `create_domain(name, description="", *, owner_id: int | None)` (raises `ValueError` on a per-owner duplicate — new), `update_domain(domain_id, *, owner_id: int, is_admin: bool, name=None, description=None)`, `delete_domain(domain_id, *, owner_id: int, is_admin: bool) -> bool`
  - `has_global_domains() -> bool` — the seeder's presence check (spec: seeders query only `owner_id IS NULL` rows)
  - `list_terms(domain_id, *, owner_id: int, language=None) -> list[Term] | None` — **`None` means the domain is invisible** (router: 404), `[]` means visible-but-empty
  - `get_term(term_id, *, owner_id: int)`, `create_term(domain_id, *, owner_id: int, is_admin: bool, ...) -> Term | None` (`None` = invisible domain; `GlobalReadOnlyError` = global domain, non-admin), `update_term(term_id, *, owner_id: int, is_admin: bool, ...)`, `delete_term(term_id, *, owner_id: int, is_admin: bool) -> bool`
  - `terms_for_check(domain_id, language=None) -> list[Term]` — deliberately unscoped read for the checker; its docstring states the contract: *callers must have validated domain visibility first* (`api/checks.py` does, in this task).
  - `Domain` model: `owner_id` excluded + `is_global` computed, exactly like `Profile`.

- [ ] **Step 1: Failing store tests** — in `test_terminology.py` (thread the new keywords through existing calls as in Task 3; then add):

```python
def test_domain_visibility_and_admin_rule(tmp_path):
    store = TerminologyStore(tmp_path / "t.db")
    shared = store.create_domain("Shared", owner_id=None)
    mine = store.create_domain("Mine", owner_id=1)
    store.create_domain("Theirs", owner_id=2)
    assert {d.name for d in store.list_domains(owner_id=1)} == {"Shared", "Mine"}
    assert store.get_domain(mine.id, owner_id=2) is None
    with pytest.raises(GlobalReadOnlyError):
        store.update_domain(shared.id, owner_id=1, is_admin=False, name="X")
    with pytest.raises(GlobalReadOnlyError):
        store.delete_domain(shared.id, owner_id=1, is_admin=False)
    assert store.update_domain(shared.id, owner_id=1, is_admin=True, name="X").name == "X"


def test_domain_names_unique_per_owner(tmp_path):
    store = TerminologyStore(tmp_path / "t.db")
    store.create_domain("Docs", owner_id=1)
    store.create_domain("docs", owner_id=2)      # other owner: fine
    store.create_domain("Docs", owner_id=None)   # global partition: fine
    with pytest.raises(ValueError):
        store.create_domain("DOCS", owner_id=1)  # own duplicate, NOCASE
    with pytest.raises(ValueError):
        store.create_domain("docs", owner_id=None)


def test_terms_inherit_domain_ownership(tmp_path):
    store = TerminologyStore(tmp_path / "t.db")
    shared = store.create_domain("Shared", owner_id=None)
    theirs = store.create_domain("Theirs", owner_id=2)
    term = store.create_term(
        theirs.id, owner_id=2, is_admin=False,
        language=Language.EN, preferred="ok",
    )
    # Foreign domain: everything is invisible/404-shaped.
    assert store.list_terms(theirs.id, owner_id=1) is None
    assert store.get_term(term.id, owner_id=1) is None
    assert store.create_term(
        theirs.id, owner_id=1, is_admin=False,
        language=Language.EN, preferred="x",
    ) is None
    assert store.update_term(term.id, owner_id=1, is_admin=False, preferred="x") is None
    assert store.delete_term(term.id, owner_id=1, is_admin=False) is False
    # Global domain: reads for everyone, writes for admins.
    with pytest.raises(GlobalReadOnlyError):
        store.create_term(
            shared.id, owner_id=1, is_admin=False,
            language=Language.EN, preferred="x",
        )
    ok = store.create_term(
        shared.id, owner_id=1, is_admin=True,
        language=Language.EN, preferred="sign in",
    )
    assert store.list_terms(shared.id, owner_id=1) == [ok]


def test_migration_backfills_domain_ownership(tmp_path):
    db = tmp_path / "legacy.db"
    with connect(db) as conn:
        conn.execute(
            """CREATE TABLE domains (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT ''
            )"""
        )
        conn.execute("INSERT INTO domains (name) VALUES ('Product docs')")
        conn.execute("INSERT INTO domains (name) VALUES ('My own domain')")
    store = TerminologyStore(db)
    by_name = {d.name: d for d in store.list_domains(owner_id=1)}
    assert by_name["Product docs"].is_global is True   # seed-name match
    assert by_name["My own domain"].is_global is False # -> admin (1)
    TerminologyStore(db)  # idempotent


def test_seeder_presence_check_is_global_only(tmp_path):
    store = TerminologyStore(tmp_path / "t.db")
    store.create_domain("User domain", owner_id=1)
    assert store.has_global_domains() is False   # a user domain must not
    assert seed_terminology(store) is True       # ...suppress seeding: it runs
    assert store.has_global_domains() is True
    seeded = next(d for d in store.list_domains(owner_id=1) if d.name == DOMAIN_NAME)
    assert seeded.is_global is True
```

Run — FAIL.

- [ ] **Step 2: Store + seeder implementation** — in `services/terminology.py`:
  - `_SCHEMA` domains DDL gains `owner_id INTEGER` (nullable, no default). `Domain` model changes as in Interfaces; `import logging` + module `logger`.
  - `_migrate` (new method, called from `__init__` after `executescript`):

```python
    def _migrate(self, conn: sqlite3.Connection) -> None:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(domains)")}
        if "owner_id" not in columns:
            # One-shot backfill (spec §9 step 3): the seed domain (matched
            # by name — seed.DOMAIN_NAME, asserted equal by a test) becomes
            # global; every other pre-auth row belongs to the admin (id 1).
            conn.execute("ALTER TABLE domains ADD COLUMN owner_id INTEGER")
            conn.execute(
                "UPDATE domains SET owner_id = 1 WHERE name <> ?",
                (_SEED_DOMAIN_NAME,),
            )
        # domains never had a uniqueness guarantee, so legal duplicates may
        # exist: pre-scan and skip-with-warning before each partial index.
        ...  # same two-partition pattern as profiles._migrate, on
             # (owner_id, name) / (name): idx_domains_owner_name WHERE
             # owner_id IS NOT NULL, idx_domains_global_name WHERE owner_id IS NULL
```

    with `_SEED_DOMAIN_NAME = "Product docs"` as a module constant and this consistency test added to `test_seed.py`:

```python
def test_seed_domain_name_constant_matches_the_seeder():
    from app.services.seed import DOMAIN_NAME
    from app.services.terminology import _SEED_DOMAIN_NAME

    assert _SEED_DOMAIN_NAME == DOMAIN_NAME
```

    (The literal lives in `terminology.py` because `seed.py` imports `TerminologyStore` — importing back would be a cycle. The test is the tie.)
  - Domain methods: same shapes as `ProfileStore` (visibility predicate in SQL; scoped fetch → global/admin check → mutate by bare id). `create_domain` wraps its INSERT in `try/except sqlite3.IntegrityError` → `raise ValueError(f"Domain '{name}' already exists")`; `update_domain` renames get the same wrap (the rename can now collide).
  - `has_global_domains`: `SELECT 1 FROM domains WHERE owner_id IS NULL LIMIT 1`.
  - Term methods per Interfaces; the visibility resolution is one helper:

```python
    def _visible_domain_row(
        self, conn: sqlite3.Connection, domain_id: int, owner_id: int
    ) -> sqlite3.Row | None:
        return conn.execute(
            "SELECT * FROM domains WHERE id = ?"
            " AND (owner_id IS NULL OR owner_id = ?)",
            (domain_id, owner_id),
        ).fetchone()
```

    `get_term` joins: `SELECT t.* FROM terms t JOIN domains d ON d.id = t.domain_id WHERE t.id = ? AND (d.owner_id IS NULL OR d.owner_id = ?)`. Mutations fetch the term's parent row, apply invisible→`None`/`False`, global-and-not-admin→`GlobalReadOnlyError`, then mutate by bare id.
  - `terms_for_check(domain_id, language=None)`: the old unscoped `list_terms` body, renamed, with the caller-must-validate docstring. `app/checkers/terminology.py:87` switches to it.
  - `seed.py`: `seed_terminology` presence check becomes `if store.has_global_domains(): return False`; `create_domain(DOMAIN_NAME, DOMAIN_DESCRIPTION, owner_id=None)`; `create_term(domain.id, owner_id=1, is_admin=True, ...)` — wait, no: the seeder writes global rows without a caller. Give it the honest path: terms under the global domain are created by the seeder as the global maintainer — call `create_term(domain.id, owner_id=0, is_admin=True, ...)`? No. **Decision:** the seeder uses `terms_for_check`'s sibling, a plain internal write — but that reintroduces an unscoped mutator. Simplest correct call: `create_term(domain.id, owner_id=1, is_admin=True, ...)` is wrong (hardcodes a user). Instead `create_term` accepts the seeder's case naturally: `owner_id` is only used for *visibility* of the parent domain, and a global domain is visible to every owner — so any owner value works when `is_admin=True`. Call it with `owner_id=1, is_admin=True` and this comment in `seed.py`: "owner_id here is only a visibility key; the domain is global (visible to all), and is_admin=True authorizes the global write — no ownership is recorded on terms."

Run Step 1's tests — PASS.

- [ ] **Step 3: Failing API + checks tests** — in `test_terminology_api.py`:

```python
def test_terminology_api_ownership(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    mine = client.post("/api/domains", json={"name": "Mine"}, headers=admin).json()
    assert mine["is_global"] is False and "owner_id" not in mine
    term = client.post(
        f"/api/domains/{mine['id']}/terms",
        json={"language": "en", "preferred": "secret term"},
        headers=admin,
    ).json()
    # Foreign domain and its terms: 404 everywhere.
    assert all(d["id"] != mine["id"] for d in client.get("/api/domains", headers=other).json())
    assert client.get(f"/api/domains/{mine['id']}/terms", headers=other).status_code == 404
    assert (
        client.post(
            f"/api/domains/{mine['id']}/terms",
            json={"language": "en", "preferred": "x"},
            headers=other,
        ).status_code
        == 404
    )
    assert (
        client.put(f"/api/terms/{term['id']}", json={"preferred": "x"}, headers=other).status_code
        == 404
    )
    assert client.delete(f"/api/terms/{term['id']}", headers=other).status_code == 404
    assert (
        client.put(f"/api/domains/{mine['id']}", json={"name": "X"}, headers=other).status_code
        == 404
    )
    assert client.delete(f"/api/domains/{mine['id']}", headers=other).status_code == 404
    # Global domain (the seeded one): readable by all, writable by admins only.
    seeded = next(d for d in client.get("/api/domains", headers=other).json() if d["is_global"])
    assert client.get(f"/api/domains/{seeded['id']}/terms", headers=other).status_code == 200
    assert (
        client.put(f"/api/domains/{seeded['id']}", json={"name": "X"}, headers=other).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/domains/{seeded['id']}/terms",
            json={"language": "en", "preferred": "x"},
            headers=other,
        ).status_code
        == 403
    )
    global_term = client.get(f"/api/domains/{seeded['id']}/terms", headers=admin).json()[0]
    assert (
        client.delete(f"/api/terms/{global_term['id']}", headers=other).status_code == 403
    )
    # Duplicate own domain name: now 409.
    client.post("/api/domains", json={"name": "Dup"}, headers=other)
    assert client.post("/api/domains", json={"name": "dup"}, headers=other).status_code == 409
```

  And in `test_check_api.py`:

```python
def test_check_request_ignores_foreign_domain_ids(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    domain = client.post("/api/domains", json={"name": "Private"}, headers=admin).json()
    client.post(
        f"/api/domains/{domain['id']}/terms",
        json={"language": "en", "preferred": "sign in", "forbidden_variants": ["login"]},
        headers=admin,
    )
    # The owner's check flags the forbidden variant...
    owner_check = client.post(
        "/api/checks",
        json={"text": "please login here", "language": "en",
              "domain_ids": [domain["id"]], "checkers": ["terminology"]},
        headers=admin,
    ).json()
    assert any(f["source"] == "terminology" for f in owner_check["findings"])
    # ...the same request from another user yields nothing: the foreign id
    # is filtered before the checker runs, exactly like a deleted domain.
    foreign_check = client.post(
        "/api/checks",
        json={"text": "please login here", "language": "en",
              "domain_ids": [domain["id"]], "checkers": ["terminology"]},
        headers=other,
    ).json()
    assert not any(f["source"] == "terminology" for f in foreign_check["findings"])
```

Run — FAIL.

- [ ] **Step 4: Router implementation** — `api/terminology.py`: thread `user`; map store results: `None` → 404 (`"Domain not found"` / `"Term not found"` — never a different message for foreign vs missing), `GlobalReadOnlyError` → the same 403 constant as profiles, `ValueError` on create/rename → 409. `list_terms` handles the new `None`. `delete_domain` keeps calling `remove_domain_everywhere` after a successful delete. In `api/checks.py` `create_check`, add `user: CurrentUser = Depends(get_current_user)` and immediately before the terminology block:

```python
    # Ownership filter, not validation: a foreign domain id behaves exactly
    # like a deleted one (the codebase's pruning idiom) — no existence leak,
    # and the unscoped terms_for_check below only ever sees vetted ids.
    if body.domain_ids:
        visible = {
            d.id
            for d in app.state.terminology_store.list_domains(owner_id=user.id)
        }
        body = body.model_copy(
            update={"domain_ids": [i for i in body.domain_ids if i in visible]}
        )
```

  Update the remaining `list_domains()` callers: `api/folders.py:48` and `:98`, `api/profiles.py:52` → `list_domains(owner_id=user.id)` (both routers already carry `user`). A foreign domain id in folder defaults now 422s as "Unknown domain ids", indistinguishable from nonexistent; in profile payloads it prunes silently — both are the pre-existing behaviors for unknown ids, inherited correctly.

Run Step 3's tests — PASS.

- [ ] **Step 4a: Startup order per spec §9.** `main.py` currently runs `seed_terminology` (`main.py:111-112`) and `seed_profiles` (`:120-124`) *before* the `UserStore`/admin bootstrap (`:129-135`); spec §9 requires migrations → admin seeding → global seeders, so a failing admin bootstrap must abort startup **before** any global row is written. M3 owns the seeders, so M3 fixes the order. Failing test first, in `test_main.py`:

```python
def test_seeders_run_after_admin_bootstrap(tmp_path, monkeypatch):
    # Spec §9 startup order: migrations -> admin seeding -> global
    # seeders. With bootstrap credentials missing and no users, create_app
    # must fail BEFORE the seeders write any global row.
    monkeypatch.delenv("FW_ADMIN_EMAIL", raising=False)
    monkeypatch.delenv("FW_ADMIN_PASSWORD", raising=False)
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    with pytest.raises(AuthConfigError):
        create_app(settings)
    with connect(tmp_path / "t.db") as conn:
        assert conn.execute("SELECT count(*) FROM domains").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM profiles").fetchone()[0] == 0
```

  Run — FAIL (rows exist: the seeders ran first). Then reorder `create_app`: keep every store constructor where it is (constructors are the migrations), move the two seeder calls to after `seed_admin(...)`, with this comment: `# Global seeders last (spec §9): migrations (store constructors) -> admin bootstrap -> seeders, so a failing bootstrap aborts before any global row is written.` Run — PASS. — `test_terms_inherit_domain_ownership` and the API 404s must FAIL. Restore. (2) Remove the `create_check` filter — `test_check_request_ignores_foreign_domain_ids` must FAIL. Restore. (3) Change `has_global_domains` back to "any domains" — `test_seeder_presence_check_is_global_only` must FAIL. Restore. Record.

- [ ] **Step 6: Full gate + commit**

Run: `uv run pytest -q` (zero warnings).

```bash
git add -A backend
git commit -m "feat(ownership): domains and terms are owner-scoped; check requests filter to visible domains"
```

---

### Task 5: Check jobs remember their owner

`app/services/jobs.py` has no owner concept; both id-addressable endpoints look a job up by id alone and return findings carrying quoted document spans (roadmap, decided 2026-07-26). A UUID is obscurity, not authorization. Jobs record their creator; a foreign id is `None` — the same 404 as an unknown id. No admin override: spec §7.2 names none, and a check is an ephemeral view of a private document.

**Files:**
- Modify: `backend/app/services/jobs.py`, `backend/app/api/checks.py:52,132-136,146-150`
- Test: `backend/tests/test_check_api.py`

**Interfaces:**
- Produces: `CheckJob.__init__(job_id: str, owner_id: int)` with `self.owner_id = owner_id`; `JobManager.create(owner_id: int) -> CheckJob`; `JobManager.get(job_id: str, *, owner_id: int) -> CheckJob | None` (mismatch → `None`).

- [ ] **Step 1: Failing tests** — in `test_check_api.py`:

```python
def test_check_results_are_invisible_to_other_users(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    check = client.post(
        "/api/checks",
        json={"text": "the secret launch date is May", "language": "en",
              "checkers": ["rules"]},
        headers=admin,
    ).json()
    check_id = check["check_id"]
    assert client.get(f"/api/checks/{check_id}", headers=admin).status_code == 200
    # Foreign caller: 404 on status and on the SSE stream, indistinguishable
    # from an unknown id.
    assert client.get(f"/api/checks/{check_id}", headers=other).status_code == 404
    assert (
        client.get(f"/api/checks/{check_id}/events", headers=other).status_code
        == 404
    )
    unknown = client.get(f"/api/checks/{uuid.uuid4()}", headers=other)
    assert unknown.status_code == 404
    assert (
        unknown.json()
        == client.get(f"/api/checks/{check_id}", headers=other).json()
    )
```

Run — FAIL (200 for the foreign caller today).

- [ ] **Step 2: Implementation.** `jobs.py` per Interfaces:

```python
    def get(self, job_id: str, *, owner_id: int) -> CheckJob | None:
        job = self._jobs.get(job_id)
        # A foreign job answers exactly like a missing one: check results
        # quote spans of the document text, and a UUID in a URL is not an
        # authorization boundary.
        if job is None or job.owner_id != owner_id:
            return None
        return job
```

  `api/checks.py`: `create_check` calls `app.state.jobs.create(user.id)` (`user` was threaded in Task 4); `get_check` and `check_events` gain `user: CurrentUser = Depends(get_current_user)` and call `jobs.get(check_id, owner_id=user.id)` — their existing `None → 404` branches do the rest.

Run Step 1's test — PASS.

- [ ] **Step 3: Mutation verification.** Change `get` to ignore `owner_id` (return `self._jobs.get(job_id)`) — the test must FAIL on both the status and events assertions. Restore. Record.

- [ ] **Step 4: Full gate + commit**

Run: `uv run pytest -q` (zero warnings).

```bash
git add -A backend
git commit -m "feat(ownership): check jobs are scoped to their creator"
```

---

### Task 6: The ownership sweep

M2's recurring defect shape was *a rule applied to one directory and never its neighbour* — four times, never caught twice by the same layer. This task is the structural answer for M3's rule ("every owned read/write is caller-scoped"): one test module that sweeps **every** resource endpoint pair-wise, plus an audit table in the report listing every store method with "scoped" or "safe because X". The per-task tests above prove each vertical; this module proves nobody skipped one.

**Files:**
- Create: `backend/tests/test_ownership.py`

**Interfaces:**
- Consumes: everything Tasks 2–5 produced; `second_user_headers` from conftest.

- [ ] **Step 1: Write the sweep** — `tests/test_ownership.py`:

```python
"""Cross-user isolation, endpoint by endpoint.

The per-resource test modules prove each vertical slice; this module proves
the *rule* — every id-addressable endpoint answers 404 for a foreign id,
listings never leak, and 403 appears exactly once (non-admin mutating a
global row). Table-driven so that a new endpoint added without a row here
is a visible review question, not a silent gap.
"""

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers, second_user_headers


@pytest.fixture()
def two_users(tmp_path):
    settings = Settings(db_path=tmp_path / "t.db", rules_dir=tmp_path / "rules")
    client = TestClient(create_app(settings))
    admin = auth_headers(client)
    other = second_user_headers(client)
    # One private resource of every kind, owned by the admin.
    doc = client.post("/api/documents", json={"name": "D", "language": "en"}, headers=admin).json()
    folder = client.post("/api/folders", json={"name": "F"}, headers=admin).json()
    profile_body = {
        "language": "en", "name": "P", "categories_off": [], "rule_exceptions": [],
        "packs_on": [], "domain_ids": [], "llm_provider": None, "llm_model": None,
        "llm_tier": None, "llm_instructions": "", "example_text": "",
    }
    profile = client.post("/api/profiles", json=profile_body, headers=admin).json()
    domain = client.post("/api/domains", json={"name": "Dom"}, headers=admin).json()
    term = client.post(
        f"/api/domains/{domain['id']}/terms",
        json={"language": "en", "preferred": "t"},
        headers=admin,
    ).json()
    check = client.post(
        "/api/checks",
        json={"text": "hello", "language": "en", "checkers": ["rules"]},
        headers=admin,
    ).json()
    return client, admin, other, {
        "doc": doc, "folder": folder, "profile": profile,
        "domain": domain, "term": term, "check": check,
        "profile_body": profile_body,
    }


# (method, path-template, json-body-or-None) for every id-addressable
# endpoint over an ownable resource. Adding an endpoint without adding a
# row here should fail review, not slip through.
FOREIGN_404 = [
    ("GET",    "/api/documents/{doc}", None),
    ("PUT",    "/api/documents/{doc}", {"revision": 0, "name": "X"}),
    ("DELETE", "/api/documents/{doc}", None),
    ("POST",   "/api/documents/{doc}/move", {"folder_id": None}),
    ("POST",   "/api/documents/{doc}/generate-name", None),
    ("PUT",    "/api/folders/{folder}", {"name": "X"}),
    ("PUT",    "/api/folders/{folder}/defaults", {}),
    ("DELETE", "/api/folders/{folder}", None),
    ("PUT",    "/api/profiles/{profile}", "profile_body"),
    ("DELETE", "/api/profiles/{profile}", None),
    # Reset on a foreign PRIVATE profile must be 404 (invisible), not the
    # 409 "not Standard" an unscoped lookup would answer with.
    ("POST",   "/api/profiles/{profile}/reset", None),
    ("PUT",    "/api/domains/{domain}", {"name": "X"}),
    ("DELETE", "/api/domains/{domain}", None),
    ("GET",    "/api/domains/{domain}/terms", None),
    ("POST",   "/api/domains/{domain}/terms", {"language": "en", "preferred": "x"}),
    ("PUT",    "/api/terms/{term}", {"preferred": "x"}),
    ("DELETE", "/api/terms/{term}", None),
    ("GET",    "/api/checks/{check}", None),
    ("GET",    "/api/checks/{check}/events", None),
]


@pytest.mark.parametrize("method,template,body", FOREIGN_404)
def test_foreign_id_is_404(two_users, method, template, body):
    client, _admin, other, items = two_users
    ids = {
        "doc": items["doc"]["id"], "folder": items["folder"]["id"],
        "profile": items["profile"]["id"], "domain": items["domain"]["id"],
        "term": items["term"]["id"], "check": items["check"]["check_id"],
    }
    path = template.format(**ids)
    json_body = items["profile_body"] if body == "profile_body" else body
    response = client.request(method, path, json=json_body, headers=other)
    assert response.status_code == 404, (method, path, response.status_code)


def test_listings_never_leak(two_users):
    client, _admin, other, items = two_users
    assert client.get("/api/documents", headers=other).json() == []
    assert client.get("/api/folders", headers=other).json() == []
    assert all(
        p["is_global"]
        for p in client.get("/api/profiles?language=en", headers=other).json()
    )
    assert all(
        d["is_global"] or d["name"] != "Dom"
        for d in client.get("/api/domains", headers=other).json()
    )


def test_global_mutation_as_non_admin_is_403_everywhere(two_users):
    """Every global-mutation route, not a sample: profile PUT/DELETE/reset,
    domain PUT/DELETE, term POST/PUT/DELETE. The two pinned exceptions are
    below the loop."""
    client, admin, other, items = two_users
    g_profiles = {
        p["name"]: p
        for p in client.get("/api/profiles?language=en", headers=other).json()
        if p["is_global"]
    }
    standard = g_profiles["Standard"]
    marketing = g_profiles["Marketing"]  # seed_example_profiles defaults on
    g_domain = next(
        d for d in client.get("/api/domains", headers=other).json() if d["is_global"]
    )
    g_term = client.post(
        f"/api/domains/{g_domain['id']}/terms",
        json={"language": "en", "preferred": "gterm"},
        headers=admin,
    ).json()
    same_name_edit = dict(items["profile_body"], name=standard["name"])
    cases = [
        # (method, path, body) — every route that can mutate a global row.
        ("PUT",    f"/api/profiles/{standard['id']}", same_name_edit),
        ("DELETE", f"/api/profiles/{marketing['id']}", None),
        ("POST",   f"/api/profiles/{standard['id']}/reset", None),
        ("PUT",    f"/api/domains/{g_domain['id']}", {"name": "X"}),
        ("DELETE", f"/api/domains/{g_domain['id']}", None),
        ("POST",   f"/api/domains/{g_domain['id']}/terms",
                   {"language": "en", "preferred": "x"}),
        ("PUT",    f"/api/terms/{g_term['id']}", {"preferred": "x"}),
        ("DELETE", f"/api/terms/{g_term['id']}", None),
    ]
    for method, path, body in cases:
        response = client.request(method, path, json=body, headers=other)
        assert response.status_code == 403, (method, path, response.status_code)
    # Pinned exceptions: for Standard, the router's own guards fire before
    # the store's admin check, so rename and delete answer 409 for EVERY
    # caller. That ordering is deliberate and leaks nothing — Standard is
    # global and visible to all, and the refusal reason ("cannot be
    # renamed/deleted") is equally true for admins.
    rename = dict(items["profile_body"], name="Renamed Standard")
    assert client.put(
        f"/api/profiles/{standard['id']}", json=rename, headers=other
    ).status_code == 409
    assert client.delete(
        f"/api/profiles/{standard['id']}", headers=other
    ).status_code == 409
    # And the same mutations as admin are permitted, not 403.
    assert client.put(
        f"/api/terms/{g_term['id']}", json={"preferred": "y"}, headers=admin
    ).status_code == 200
    assert client.put(
        f"/api/domains/{g_domain['id']}", json={"name": "Renamed"}, headers=admin
    ).status_code == 200
    assert client.post(
        f"/api/profiles/{standard['id']}/reset", headers=admin
    ).status_code == 200
```

- [ ] **Step 2: Run and reconcile.** `uv run pytest tests/test_ownership.py -q`. Every failure here is a Task 2–5 gap: fix it in the store/router it belongs to (not by weakening the row), and note in the report which rows failed on first run — that list is the sweep's yield.

- [ ] **Step 3: The audit table.** In the task report, list **every public method** of `DocumentStore`, `FolderStore`, `ProfileStore`, `TerminologyStore`, `JobManager` with one of: "scoped (owner param)" / "global-check (admin param)" / "safe because X" (e.g. `remove_domain_everywhere`, `terms_for_check`, `has_global_domains`, `standard_profile` — each with its stated reason). An audit that omits a method is a failed step; M2's `folders.ts` omission is the precedent.

- [ ] **Step 4: Full gate + commit**

Run: `uv run pytest -q` (zero warnings).

```bash
git add backend/tests/test_ownership.py
git commit -m "test(ownership): cross-user sweep over every id-addressable endpoint"
```

---

### Task 7: Frontend — is_global affordances, generation guards, expired comments

Three concerns: (1) `is_global` reaches the types and the two management views render read-only affordances for non-admins; (2) the two domain writes behind unguarded awaits get generation guards — the M2 comments justifying their absence are now false; (3) the dated-comment audit the roadmap demands. For the admin (the only existing user) every affordance stays exactly as it was — that is the milestone's "leaves main working" property.

**Files:**
- Modify: `frontend/src/types.ts` (Domain, Profile), `frontend/src/App.tsx:87-99`, `frontend/src/terminology/TerminologyView.tsx`, `frontend/src/profiles/ProfilesView.tsx`
- Modify: `frontend/src/i18n/messages.ts` + `en.ts`, `de.ts`, `fr.ts`, `es.ts`, `it.ts`, `ja.ts`, `zh.ts`
- Test: `frontend/src/terminology/TerminologyView.ownership.test.tsx` (create), `frontend/src/profiles/ProfilesView.ownership.test.tsx` (create), `frontend/src/App.domains-guard.test.tsx` (create)

**Interfaces:**
- Consumes: `is_global: boolean` on `Domain`/`Profile` API responses (Tasks 3–4); `sessionGeneration()` from `auth/session.ts` (M2); `useStore((s) => s.user?.is_admin)`.
- Produces: i18n keys `globalBadge`, `globalBadgeTitle` in all seven catalogs.

- [ ] **Step 1: Types.** `types.ts`: `Domain` gains `is_global: boolean`; `Profile` gains `is_global: boolean`. Fix every test fixture the compiler now flags (`npm run build` is the check — bare `tsc --noEmit` checks nothing here).

- [ ] **Step 2: i18n keys.** `messages.ts` gains two keys; all seven catalogs in the same commit, impersonal register:

| key | en | de | fr | es | it | ja | zh |
|---|---|---|---|---|---|---|---|
| `globalBadge` | Built-in | Mitgeliefert | Intégré | Integrado | Integrato | 標準 | 内置 |
| `globalBadgeTitle` | Built-in item — only admins can change it | Mitgelieferter Eintrag — nur Administratoren können ihn ändern | Élément intégré — seuls les administrateurs peuvent le modifier | Elemento integrado — solo los administradores pueden modificarlo | Elemento integrato — solo gli amministratori possono modificarlo | 標準項目 — 変更できるのは管理者のみ | 内置项 — 仅管理员可修改 |

  The existing i18n consistency test (`i18n.test.ts` / `test_register_consistency` pattern) must stay green — run `npx vitest run src/i18n`.

- [ ] **Step 3: Failing guard test** — `App.domains-guard.test.tsx`, following the harness pattern of the existing view tests (happy-dom + real store). Core assertion:

```tsx
it('discards a domains fetch that resolves after a session turnover', async () => {
  let resolveFetch!: (domains: Domain[]) => void
  vi.spyOn(client, 'getDomains').mockReturnValue(
    new Promise((resolve) => { resolveFetch = resolve }),
  )
  render(<Header />)                      // mount fires the fetch
  logout()                                 // session ends while it is in flight
  resolveFetch([{ id: 9, name: 'Foreign', description: '', is_global: false }])
  // Drain the .then chain before asserting. logout() already resets
  // domains to [] synchronously, so a waitFor here would succeed on its
  // immediate first probe — before the resolved fetch's write runs — and
  // the test would stay green with the guard deleted.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useStore.getState().domains).toEqual([])   // nothing landed
})
```

  (Mock the other three fetches to resolved defaults so the effect runs clean; `logout` from `auth/session`.) Run: `npx vitest run src/App.domains-guard.test.tsx` — FAIL (the foreign list lands today).

- [ ] **Step 4: Guard implementation** — `App.tsx`, replacing the effect body and its comment (the M2 comment's justification is *expired* for domains — that is the point of this edit):

```tsx
  useEffect(() => {
    // Mount-only fetch; grab the actions off the store object directly so
    // the effect has no reactive dependencies. providers/languages/routing
    // are app-wide catalogs (app/api/providers.py, languages.py,
    // routing.py) — a write landing after a session turnover writes the
    // same data the incoming session would fetch, so they stay unguarded.
    // domains are per-user since M3 (owner-scoped in
    // app/services/terminology.py): a fetch started under user A must not
    // land in user B's store.
    const { setProviders, setDomains, setLanguages, setRouting } = useStore.getState()
    const gen = sessionGeneration()
    getProviders().then(setProviders).catch(() => setProviders([]))
    getDomains()
      .then((domains) => { if (sessionGeneration() === gen) setDomains(domains) })
      .catch(() => { if (sessionGeneration() === gen) setDomains([]) })
    getLanguages().then(setLanguages).catch(() => {})
    getRouting().then(setRouting).catch(() => setRouting(null))
  }, [])
```

  (`import { sessionGeneration } from './auth/session'`.) In `TerminologyView.tsx`, `refreshDomains` gets the same guard:

```tsx
  const refreshDomains = useCallback(() => {
    const gen = sessionGeneration()
    return getDomains().then((domains) => {
      if (sessionGeneration() === gen) setDomains(domains)
    })
  }, [setDomains])
```

  Run Step 3's test — PASS. Add the mirror test for `refreshDomains` in `TerminologyView.ownership.test.tsx`.

- [ ] **Step 5: Failing affordance tests** — `TerminologyView.ownership.test.tsx` (extend) and `ProfilesView.ownership.test.tsx`. Assertions, with the store seeded to a non-admin user (`useStore.setState({ user: { ...fixtureUser, is_admin: false }, domains: [...] })`):
  - a global domain row shows the `globalBadge` text, and has **no** rename (✎) or delete (✕) button, and double-clicking its name does not open the rename input;
  - a private domain row keeps both buttons;
  - with a global domain active, the term table renders no add-term row and no per-term ✎/✕ buttons;
  - flipping `is_admin: true` restores every control on the same fixtures;
  - `ProfilesView`: a global profile card as non-admin renders the badge; its name input, domain select, tier buttons, provider/model selects and both textareas are `disabled`; no delete and no reset button. A private card is fully editable. As admin, global cards behave exactly as in M2 (Standard: name disabled + reset; examples: editable + delete).

  Run — FAIL.

- [ ] **Step 6: Affordance implementation.**
  - `TerminologyView`: `const isAdmin = useStore((s) => s.user?.is_admin ?? false)`; per domain `const editable = !domain.is_global || isAdmin`; render ✎/✕ and the `onDoubleClick` rename only when `editable`; render `<span className="global-badge" title={m.globalBadgeTitle}>{m.globalBadge}</span>` when `domain.is_global`. Pass `readOnly={activeDomain.is_global && !isAdmin}` into `TermTable` (it needs the active `Domain`, not just the id — change the prop) and gate the add-term row and the ✎/✕ cells on it.
  - `ProfilesView`: in the profile card component, `const readOnly = profile.is_global && !isAdmin`; thread `disabled={readOnly || ...existing conditions}` into every control (the name input keeps its `is_standard` disable for admins), early-return from `onSave` handlers when `readOnly` (belt for the disabled braces), hide ✕/↺ when `readOnly`, render the badge beside the title when `profile.is_global`.
  - `App.css`: one `.global-badge` rule matching the existing `.case-badge` pattern (small, muted, uppercase); check specificity against `.domain-row` / `.profile-card-title` children — M2 shipped a white-on-white button because no test covers CSS, so **manually verify both views in the running dev app** (owner's servers on 5173/8000 — look, don't restart).

  Run Step 5's tests — PASS.

- [ ] **Step 7: The dated-comment audit** (roadmap: "Audit by symbol"). Run `grep -rn "getDomains(" frontend/src` and `grep -rn "No generation guard" frontend/src`; for every hit, record in the report: file:line → guarded now / already guarded / not a store write (with reason). The two known writes (`App.tsx:96`, `TerminologyView.tsx:37`) must show as guarded by Steps 4's diffs. Also re-check `ProfilesView.tsx:34`'s "Every caller below has already checked its own generation guard" comment still holds — it is an assumption this task's edits could invalidate.

- [ ] **Step 8: Mutation verification.** Delete the `sessionGeneration() === gen` condition in `App.tsx` — the Step 3 test must FAIL. Restore. Delete it in `refreshDomains` — its mirror test must FAIL. Restore. Set `readOnly` to `false` unconditionally in `ProfilesView` — the affordance test must FAIL. Restore. Record.

- [ ] **Step 9: Full gate + commit**

Run from `frontend/`: `npx vitest run && npm run lint && npm run build`.

```bash
git add -A frontend
git commit -m "feat(ownership): is_global affordances, per-user domain fetch guards"
```

---

### Task 8: Migration rehearsal, docs, PR

**Files:**
- Modify: `docs/LOGBOOK.md`, `docs/backend-architecture.md`, `docs/frontend-architecture.md`, `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md`
- Rehearsal script: scratchpad only — **never committed, never pointed at the live DB**

- [ ] **Step 1: Rehearse the migration on a copy.** Copy `backend/data/fabulous.db` to the session scratchpad (`cp`, read-only source). From `backend/`, run a scratch script (via `uv run python`) that: opens the copy with `Settings(db_path=<copy>)` through `create_app` (env: `FW_AUTH_SECRET` + admin creds set, as the real server would have), then asserts on the copy:
  - `users` id 1 exists and `is_admin`;
  - `profiles`: every `is_standard=1` row and every marker-language seed-name row has `owner_id IS NULL`; every other row `owner_id = 1`; `sqlite_master` shows no `UNIQUE` in the profiles DDL; both partial indexes exist **or** a duplicate-skip warning was logged for that partition — legacy uniqueness was case-*sensitive*, so `Blog`/`blog` may legally coexist and the NOCASE index is then intentionally absent (the pre-scan pattern; record which partitions skipped);
  - `domains`: `Product docs` → NULL, all others → 1; both partial indexes exist or a logged skip (same rule — domains never had any uniqueness, so this is the likeliest table to skip; record which);
  - `folders`: DDL free of `UNIQUE` and `DEFAULT 1`; `idx_folders_owner_name` exists or a logged skip (same rule); row count unchanged;
  - `documents`: row count and per-row `owner_id = 1` unchanged;
  - `PRAGMA integrity_check` → ok; **run the app factory a second time** against the copy → no changes (idempotence);
  - row counts per table identical before/after except for schema objects.
  Record every command and output in the report and the ledger. If any assertion fails, stop: fix the migration task, re-run the rehearsal from a fresh copy.
- [ ] **Step 2: Roadmap contract update.** In `2026-07-25-multi-user-roadmap.md` Cross-milestone interfaces, update **both** changed signatures: `VerifiedToken` is now `user_id: int`, `issued_at: datetime`, **`epoch: int | None`** — local tokens always carry an integer epoch (equality-checked against `users.token_epoch`); `None` is reserved for verifiers without an epoch concept, which fall back to the `password_changed_at` comparison. And `issue_token` (roadmap line 72) becomes `issue_token(user_id: int, secret: str, *, epoch: int) -> str`. Keep the M2 history note; append rather than rewrite.
- [ ] **Step 3: Architecture docs.** `backend-architecture.md`: ownership semantics (owner-scoped stores, global rows, `GlobalReadOnlyError`, job ownership, the two rebuilds, epoch revocation). `frontend-architecture.md`: `is_global` affordances and the domains-fetch guard. Update, don't append-only — stale text is worse than none.
- [ ] **Step 4: Final gates, docs commit, open the PR.** The PR number must exist before the LOGBOOK entry can reference it, so the PR opens *before* the logbook lands (a follow-up commit on the open PR — not an amend):

Run: backend `uv run pytest -q` (zero warnings); frontend `npx vitest run && npm run lint && npm run build`.

```bash
git add docs
git commit -m "docs: M3 ownership — architecture docs and roadmap contract update"
git push -u origin <implementation-branch>
```

Open the PR against `main` and request a Copilot review. PR description must include the deploy note from Task 1 (one-time global sign-out) and the rehearsal summary from Step 1.

- [ ] **Step 5: LOGBOOK follow-up commit.** Now the PR number exists: run `date`, append the M3 entry per convention — date, title, **PR reference**, distilled why/what/verification/observations — as a follow-up commit on the same branch:

```bash
git add docs/LOGBOOK.md
git commit -m "docs(logbook): M3 multi-user ownership entry"
git push
```

Resolve every review thread before merge (the ruleset blocks merging otherwise).

---

## Verification (whole-milestone)

- Backend: full suite green with zero warnings; `test_ownership.py` sweep green; migration rehearsed on a live-DB copy with recorded output.
- Frontend: vitest + lint + build green; the two management views manually inspected in the dev app as admin (affordances unchanged) — the CSS badge checked visually.
- The M2 deliverable check, inverted: log in as the admin against a migrated copy — documents, folders, profiles, domains, terms and checks look **exactly** as before M3.
- Review shape (M2 scorecard): per-task reviews for in-diff defects, a cross-task review pass focused on *unapplied instances of the rule* (any store method or endpoint the sweep table missed), Copilot rounds on the PR, and a run of the real app.
