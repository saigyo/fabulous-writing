# Backend Test-Suite Speedup — Design

**Date:** 2026-07-28
**Origin:** Backlog item B8 (roadmap `docs/superpowers/plans/2026-07-25-multi-user-roadmap.md`), pulled forward as an emergency intervention before further feature work.

## Problem

The backend suite has grown to 1,080 tests and takes ~4 minutes locally
(baseline measured 2026-07-28: **1,080 passed in 245.28 s**; ~10 minutes
on GitHub Actions runners). Agents executing implementation plans run
the full suite many times per task, so suite time multiplies into every
milestone. The duration distribution is flat — the 40th-slowest test
still takes 1.19 s and the top of the table only reaches 2.9 s — so the
cost is a per-test fixed overhead, not a few slow outliers. The slowest
tests are precisely the ones that build several apps or log in several
users, which points at a fixed cost per app construction and per login. No test may ever touch the live
database; every test builds its app on `tmp_path`. That per-test isolation
model is correct and stays.

## Measured causes

1. **bcrypt at production work factor.** `hash_password()` uses
   `bcrypt.gensalt()` at the library default cost (12). Measured on the
   dev machine: **173 ms per hash**; at cost 4 it is **0.7 ms**. Every
   test app construction pays one hash (`seed_admin` on the fresh
   `tmp_path` database), and every real login in a fixture pays one
   verify — and `bcrypt.checkpw` derives its cost from the factor
   embedded in the stored hash, so cheap hashes make verification cheap
   automatically. With hundreds of app constructions and ~95
   login-helper call sites, this is the dominant fixed cost.
2. **Real sleeps for second-precision timestamps.** Eight `sleep(1.1)`
   calls across seven tests (~9 s total: seven calls in six tests in
   `tests/test_documents.py`, one in `tests/test_documents_api.py`)
   exist only because
   `app/services/documents._utcnow()` truncates to whole seconds and the
   tests must observe `updated_at`/`edited_at` change.
3. **Strictly serial execution.** The suite runs on one core although
   test isolation is already structural: every app lives on a
   test-unique `tmp_path`, `TestClient` is in-process (no ports), and
   the environment fixture is session-scoped per process.

The remaining per-test overhead (schema creation, app construction,
spaCy/rule loading) is real but secondary; it stays in B8 for a possible
later round if the levers below prove insufficient.

## Design

### 1. Test-time bcrypt work factor

`app/core/auth.py` gains a module constant:

```python
_BCRYPT_ROUNDS = 12  # bcrypt library default, kept explicit so tests can lower it
```

and `hash_password()` passes it: `bcrypt.gensalt(_BCRYPT_ROUNDS)`.

`tests/conftest.py` gains a session-scoped autouse fixture that sets
`app.core.auth._BCRYPT_ROUNDS = 4` (bcrypt's minimum) for the whole test
process and restores it on teardown.

**Deliberately not a `Settings` knob.** A config field would create a
production surface through which password hashing could be silently
weakened on a real instance. A test-process-only module override cannot
be reached by any deployment configuration. The production diff is the
constant plus one changed call — behavior at runtime is identical
(gensalt's default cost is 12).

No existing test asserts on hash format or cost factor (verified by
grep). The plan adds two permanent guard tests — one asserting the
constant is honored, one asserting the test session runs at cost 4 —
replacing the one-off manual slowdown spot-check originally envisioned
here.

### 2. Deterministic clock instead of sleeps

The eight sleeping tests get a monkeypatched clock: a small fixture
(`document_clock` in `tests/conftest.py`) replaces
`app.services.documents._utcnow`
with a callable returning strictly increasing second-precision
timestamps, advanced explicitly by the test where "later" matters. The
`time.sleep(1.1)` calls are removed. Assertions stay behavioral
(timestamps changed / ordered), not implementation-bound.

The one backpressure test that sets `concurrency_reject_delay=1.0` to
measure the deliberate pause keeps its delay — it is the subject of the
test, not overhead.

### 3. Parallel execution by default

- `pytest-xdist` is added to the dev dependency group.
- `[tool.pytest.ini_options]` gains `addopts = "-n auto --dist load"`,
  so the canonical `uv run pytest -q` — what every agent runs — is
  parallel with no invocation change. CI runs a coverage variant
  (`--cov… --junitxml=…`) that inherits the same `addopts`; that exact
  command must be verified locally under xdist, including its artifacts
  (`coverage.json`, `htmlcov/`, `test-results.xml`), which the badge job
  and `scripts/ci-summary.py` consume.
- As-built: `--dist loadfile` (one worker per file, a conservative guard
  against intra-file coupling) was measured first and found to have a
  hard floor — 47.2 s full-suite, with `test_check_api.py` alone taking
  ~40 s serial, since loadfile can never split a file's tests across
  workers. `--dist load` (dynamic work-stealing across all workers) was
  then measured three times at ~28.5 s (28.40 s / 28.58 s / 28.97 s),
  all green, with no failures. Per-test `tmp_path` isolation means the
  intra-file coupling loadfile guarded against is structurally absent
  here, so the finer `load` mode was adopted instead.
- Escape hatch: `uv run pytest -n0 …` restores serial execution (for
  `--pdb`, debugging, or bisecting a suspected parallelism issue). This
  gets a line in `docs/backend-architecture.md`'s testing section.
- The zero-warnings gate is unaffected: xdist workers forward warnings
  to the controller and the summary still reports them.

## Verification

- Test count stays exactly at the baseline plus the two permanent bcrypt
  work-factor guard tests (1,080 + 2 = 1,082 passing; any other delta is
  a silently lost test or scope creep).
- Zero warnings, unchanged gate command: `uv run pytest -q`.
- Wall time measured before and after on the same machine, recorded in
  the LOGBOOK entry; the B8 roadmap row is updated with the achieved
  numbers and reduced to its remaining (deferred) levers.
- The bcrypt override is mutation-verified once: with the conftest
  fixture deleted, the suite must measurably slow down (spot-check a
  single auth-heavy module, not the full 4-minute run).

## Non-goals

- No session/module-scoped app or schema-cache refactor (stays in B8).
- No CI workflow restructuring beyond inheriting the faster suite; CI
  levers (dependency caching etc.) stay in B8.
- No change to the per-test `tmp_path` isolation model, ever.
- The eight known test-helper `ResourceWarning` leaks (visible only
  under `-W error`) are untouched here.

## Expected outcome

bcrypt + sleeps: ~244 s → roughly 90 s serial. With `-n auto` on the
8-performance-core dev machine: **target < 30 s** locally. CI inherits
both improvements (~10 min → expected 2–3 min); if CI still exceeds
~3 minutes after this lands, the remaining CI levers in B8 get their own
round.
