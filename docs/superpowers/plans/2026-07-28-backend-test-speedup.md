# Backend Test-Suite Speedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the backend suite from the measured 245 s (1,080 tests, serial) to under 30 s locally without changing what any test asserts.

**Architecture:** Three independent levers from the spec (`docs/superpowers/specs/2026-07-28-backend-test-speedup-design.md`): a test-process-only bcrypt work-factor override, a monkeypatched document clock replacing real 1.1 s sleeps, and pytest-xdist parallelism switched on by default via `addopts`. No fixture-architecture or schema changes; the per-test `tmp_path` isolation model is untouched.

**Tech Stack:** Python 3.13, pytest, bcrypt, pytest-xdist (new dev dependency), uv.

## Global Constraints

- All backend commands run from `backend/` via `uv run …`.
- The live database `backend/data/fabulous.db` is never read or written by tests; every test app is built from `tmp_path`-based `Settings`. Nothing in this plan may change that.
- The bcrypt work factor must NOT become a `Settings`/config/env knob — production hashing strength gets no configuration surface. The override lives only in `tests/conftest.py` (spec §Design 1).
- Production behavior must be bit-for-bit unchanged: `bcrypt.gensalt(12)` is the library default cost, so hashes on a real instance are identical before and after.
- Test count: 1,080 at baseline plus exactly the two tests Task 1 adds = **1,082 passed** from Task 1 on; any other delta is a silently lost test or scope creep. The zero-warnings gate (`uv run pytest -q` output clean) holds after every task.
- No test assertion may be loosened to survive parallelism. A test that fails under `-n auto` but passes under `-n0` is a STOP-and-report, not a fix-in-place.
- Never kill or start anything on ports 5173/8000. Never force-push or amend published history.
- rtk note: plain `pytest` output is filtered by the rtk hook (only the pass/fail line survives). When a task needs timings or the durations table, prefix the command with `rtk proxy `.
- Every commit message ends with exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QG5RSDiRACnzQgN89FceuQ`

---

### Task 1: Test-time bcrypt work factor

**Files:**
- Modify: `backend/app/core/auth.py` (the `hash_password` function, ~line 93)
- Modify: `backend/tests/conftest.py`
- Test: `backend/tests/test_auth_core.py`

**Interfaces:**
- Consumes: `app.core.auth.hash_password(password: str) -> str` (existing).
- Produces: module constant `app.core.auth._BCRYPT_ROUNDS: int` (production value 12); session-autouse fixture `_fast_bcrypt` in `tests/conftest.py` that sets it to 4. Later tasks rely only on the suite being fast, not on these names.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_auth_core.py`. The module imports functions directly (`from app.core.auth import (…)`), so add this import as well: `from app.core import auth as auth_module`.

Deviation note (intentional): the spec says "no test changes follow from this lever alone" and asks for a one-off manual slowdown check. These two tests are deliberately stronger — a permanent assertion pair replacing the manual spot-check.

```python
def test_hash_password_honors_module_work_factor(monkeypatch):
    monkeypatch.setattr(auth_module, "_BCRYPT_ROUNDS", 5)
    assert auth_module.hash_password("some password").startswith("$2b$05$")


def test_suite_runs_at_reduced_work_factor():
    # Mutation guard for the session-wide _fast_bcrypt fixture in
    # conftest.py: delete that fixture and this fails, because hashes
    # would carry the production cost (12) again — and the suite would
    # silently be ~250x slower per hash.
    assert auth_module.hash_password("some password").startswith("$2b$04$")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/test_auth_core.py -q -k "work_factor" `
Expected: both FAIL — the first with `AttributeError: … has no attribute '_BCRYPT_ROUNDS'` (monkeypatch refuses to set a name that doesn't exist), the second because the hash starts with `$2b$12$`.

- [ ] **Step 3: Introduce the constant in production code**

In `backend/app/core/auth.py`, near the other module constants:

```python
_BCRYPT_ROUNDS = 12  # bcrypt's library default, kept explicit so the test
# suite can lower it (tests/conftest.py); deliberately not a Settings knob.
```

and change the last line of `hash_password` from
`return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode()` to:

```python
    return bcrypt.hashpw(encoded, bcrypt.gensalt(_BCRYPT_ROUNDS)).decode()
```

- [ ] **Step 4: Add the session fixture**

In `backend/tests/conftest.py` (top-level, next to `_auth_env`):

```python
@pytest.fixture(autouse=True, scope="session")
def _fast_bcrypt():
    """Cost-4 bcrypt for the whole test session (~0.7 ms vs ~173 ms/hash).

    Every test app pays one hash in seed_admin and one verify per login;
    at production cost that alone dominates suite runtime. Production
    keeps cost 12 — this override exists only inside the test process,
    which is exactly why it is not a Settings knob.
    """
    from app.core import auth

    previous = auth._BCRYPT_ROUNDS
    auth._BCRYPT_ROUNDS = 4
    yield
    auth._BCRYPT_ROUNDS = previous
```

- [ ] **Step 5: Run the auth modules to verify green**

Run: `uv run pytest tests/test_auth_core.py tests/test_auth_api.py -q`
Expected: PASS, zero warnings.

- [ ] **Step 6: Mutation-verify the fixture (delete the guard, watch it fail)**

Temporarily comment out the whole `_fast_bcrypt` fixture in `tests/conftest.py`, run `uv run pytest tests/test_auth_core.py -q -k reduced_work_factor`, and confirm it FAILS (hash starts with `$2b$12$`). Restore the fixture, re-run, confirm PASS. This is the repo's standing delete-the-guard rule applied to the fixture itself.

- [ ] **Step 7: Spot-check the speedup**

Run: `rtk proxy uv run pytest tests/test_auth_api.py -q` and note the elapsed time in the report (baseline for this module was part of a 245 s suite; it should now run in a small fraction of its previous time).

- [ ] **Step 8: Commit**

```bash
git add backend/app/core/auth.py backend/tests/conftest.py backend/tests/test_auth_core.py
git commit -m "perf(tests): run bcrypt at cost 4 inside the test process"
```

---

### Task 2: Deterministic document clock instead of 1.1 s sleeps

**Files:**
- Modify: `backend/tests/conftest.py`
- Modify: `backend/tests/test_documents.py` (six tests, sleeps at ~lines 90, 215, 232, 242, 246, 253, 263)
- Modify: `backend/tests/test_documents_api.py` (one test, sleep at ~line 524)

**Interfaces:**
- Consumes: `app.services.documents._utcnow() -> str` (module-private, returns UTC ISO timestamp truncated to seconds — the reason the sleeps exist).
- Produces: fixture `document_clock` in `tests/conftest.py` returning a `DocumentClock` with `advance(seconds: int = 2) -> None`. Used only by the seven tests below.

- [ ] **Step 1: Add the clock fixture**

In `backend/tests/conftest.py` (add `from datetime import UTC, datetime, timedelta` to the imports):

```python
class DocumentClock:
    """Deterministic stand-in for app.services.documents._utcnow."""

    def __init__(self) -> None:
        self.current = datetime(2026, 1, 1, tzinfo=UTC)

    def advance(self, seconds: int = 2) -> None:
        self.current += timedelta(seconds=seconds)

    def now_iso(self) -> str:
        return self.current.isoformat(timespec="seconds")


@pytest.fixture()
def document_clock(monkeypatch: pytest.MonkeyPatch) -> DocumentClock:
    """Second-precision document timestamps under test control.

    Replaces the real clock so ordering tests advance time explicitly
    instead of sleeping 1.1 s. No fixture writes document rows (`store`
    only constructs the DocumentStore; `authed_client` only builds the
    app and logs in), so the patch merely has to be active before the
    test body runs — every row then carries clock time, never a mix of
    real and patched timestamps.
    """
    clock = DocumentClock()
    monkeypatch.setattr("app.services.documents._utcnow", clock.now_iso)
    return clock
```

- [ ] **Step 2: Rewrite the six store-level tests**

In `backend/tests/test_documents.py`, for each test below: add `document_clock` as the FIRST parameter (before `store` — a style convention; correctness doesn't depend on fixture order, see the fixture docstring), and replace each `time.sleep(1.1)` line with `document_clock.advance()`. The comments explaining second precision can go — the fixture's docstring now carries that. Affected tests:

- `test_list_orders_by_recency` (sleep at ~line 90)
- `test_check_only_update_does_not_bump_edited_at` (~line 215)
- `test_text_change_bumps_edited_at` (~line 232)
- `test_rename_bumps_edited_at_but_settings_do_not` (~lines 242, 246 — two sleeps)
- `test_set_name_and_set_folder_never_bump_edited_at` (~line 253)
- `test_list_orders_by_edited_at` (~line 263)

Example (`test_list_orders_by_recency`):

```python
def test_list_orders_by_recency(document_clock, store):
    a = store.create_document("A", Language.EN, owner_id=1)
    b = store.create_document("B", Language.EN, owner_id=1)
    listing = store.list_documents(owner_id=1)
    assert [d.id for d in listing] == [b.id, a.id]  # same timestamp: id DESC
    assert listing[0].name == "B"
    # Updating A moves it to the front.
    document_clock.advance()
    store.update_document(a.id, 0, text="changed", owner_id=1)
    assert [d.id for d in store.list_documents(owner_id=1)] == [a.id, b.id]
```

If `import time` in `test_documents.py` has no remaining users afterwards, remove it.

- [ ] **Step 3: Rewrite the API-level test**

In `backend/tests/test_documents_api.py`, `test_summaries_expose_timestamps_and_order_by_edited` (line 521): change the signature to `(document_clock, authed_client)` and replace the `time.sleep(1.1)` line with `document_clock.advance()`. Remove `import time` if now unused.

- [ ] **Step 4: Run the two modules to verify green and fast**

Run: `rtk proxy uv run pytest tests/test_documents.py tests/test_documents_api.py -q`
Expected: PASS, zero warnings, and the two modules together drop by roughly 9 s versus before (eight 1.1 s sleeps gone).

- [ ] **Step 5: Mutation-verify the clock actually drives the assertions**

Temporarily change `advance()` in one rewritten test (e.g. `test_text_change_bumps_edited_at`) to `advance(0)` and run that single test: it must FAIL (timestamp no longer "later"). Revert. This proves the assertions still depend on time moving, now under test control.

- [ ] **Step 6: Commit**

```bash
git add backend/tests/conftest.py backend/tests/test_documents.py backend/tests/test_documents_api.py
git commit -m "perf(tests): deterministic document clock replaces 1.1s sleeps"
```

---

### Task 3: pytest-xdist on by default + full-suite measurement + docs

**Files:**
- Modify: `backend/pyproject.toml` (dev dependency + `[tool.pytest.ini_options]`)
- Modify: `docs/backend-architecture.md` (testing section)

**Interfaces:**
- Consumes: the green, fast-serial suite from Tasks 1–2.
- Produces: `uv run pytest -q` runs parallel by default; `-n0` is the serial escape hatch. Final measured numbers for the wrap-up (LOGBOOK/roadmap are updated by the controller at PR time, not in this task).

- [ ] **Step 1: Add the dependency**

Run from `backend/`: `uv add --dev pytest-xdist`
Expected: `pyproject.toml` dev group and `uv.lock` updated.

- [ ] **Step 2: Switch parallelism on by default**

In `backend/pyproject.toml`:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
addopts = "-n auto --dist loadfile"
```

`--dist loadfile` keeps every test of a file on one worker — a conservative guard against intra-file coupling.

- [ ] **Step 3: Measure the serial baseline after Tasks 1–2, and the loadfile floor**

Run: `rtk proxy uv run pytest -q -n0` and record the elapsed time (expected: roughly 90 s or less; this is the "bcrypt+sleeps only" number for the record).

Then time the slowest single file — with `--dist loadfile` it is the hard floor no amount of parallelism can beat: `rtk proxy uv run pytest tests/test_check_api.py -q -n0` (this file contains a deliberate 1.0 s pause, a 0.5 s pause, and a 5 s-deadline poll). Record its time. If the floor alone exceeds ~30 s, report it — switching to a finer distribution mode would be a spec deviation and is the controller's call, not yours.

- [ ] **Step 4: Run the full suite in parallel, three times**

Run `rtk proxy uv run pytest -q` three times. Expected every time: **1082 passed**, zero warnings, no flaky failures, elapsed well under 60 s (target < 30 s). Record all three times. Also run `rtk proxy uv run pytest -q -n 8` once and record it — xdist's `auto` counts efficiency cores on Apple silicon, and 8 workers (performance cores) can beat `auto`; report both so the controller can decide whether `auto` stays.

If any test fails under parallelism but passes with `-n0`: STOP and report the test name and both outcomes to the controller — assertions are not to be loosened to make parallelism stick (Global Constraints).

- [ ] **Step 5: Probe the known timing-sensitive tests under worst-case contention**

Six wall-clock assertions exist in the suite: `tests/test_check_api.py:1177` (`< 0.3`), `:1225` (`< 0.3`), `:1260` (`< 0.5`), `:1351-1357` (5 s deadline poll), `tests/test_auth_api.py:598-603` (`< 1.0`), `tests/test_terminology.py:315-317` (`< 5.0`). The three parallel full-suite runs above already exercise them under load; additionally run them while a full suite saturates the cores:

```bash
rtk proxy uv run pytest -q & rtk proxy uv run pytest tests/test_check_api.py tests/test_auth_api.py tests/test_terminology.py -q -n0 -p no:cacheprovider; wait
```

Expected: all pass in both processes. If a timing assertion fails here, report it with the measured margin — do not widen the bound; CI's 2–4 core runners are the environment this step is a proxy for.

- [ ] **Step 6: Verify the CI command still works under xdist**

CI does not run plain `pytest -q`; `.github/workflows/backend.yml` runs a coverage variant that now inherits `-n auto` from `addopts`. Run it locally once from `backend/`:

```bash
rtk proxy uv run pytest --cov=app --cov-report=json --cov-report=html --cov-report=term --junitxml=test-results.xml
```

Expected: 1082 passed, and `coverage.json`, `htmlcov/`, and `test-results.xml` all produced with sane contents (coverage percentage in the plausible range of the pre-change runs, junit file lists 1082 tests) — the badge job and `scripts/ci-summary.py` depend on these artifacts. Delete the generated artifacts afterwards; do not commit them.

- [ ] **Step 7: Document the new testing reality**

In `docs/backend-architecture.md`, extend the testing section with this paragraph (adapt heading level to the surrounding document):

```markdown
**Suite performance.** `uv run pytest -q` runs parallel by default
(`pytest-xdist`, `-n auto --dist loadfile` via `addopts`); pass `-n0`
for serial runs when debugging (`--pdb`) or bisecting a suspected
parallelism issue. Per-test isolation is structural — every app is
built on a test-unique `tmp_path` — which is what makes parallelism
safe. Two test-only accelerators keep the fixed cost per test low:
`tests/conftest.py` runs bcrypt at cost 4 inside the test process
(production stays at 12; deliberately not a config knob), and the
`document_clock` fixture replaces real sleeps for second-precision
timestamp ordering.
```

- [ ] **Step 8: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock docs/backend-architecture.md
git commit -m "perf(tests): pytest-xdist parallel suite by default"
```

---

## Completion (controller, not a task)

After the final review: create the PR, then update `docs/LOGBOOK.md` (entry referenced by PR number, with the measured before/after numbers: 245.28 s baseline → serial-after and parallel-after) and condense the roadmap's B8 row to its remaining deferred levers (fixture/schema scoping, CI dependency caching, `ResourceWarning` cleanups), marking the delivered part done with the PR number.
