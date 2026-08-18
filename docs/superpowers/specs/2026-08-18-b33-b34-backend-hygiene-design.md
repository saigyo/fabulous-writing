# B33 + B34: Backend Hygiene — DSN Leak Fix and ResourceWarning Gate — Design

**Issues:** #110 (B33), #112 (B34) · **Branch:** `b33-b34-hygiene` · **Date:** 2026-08-18

One small PR bundling two independent hygiene fixes: a log-leak fix in the
Postgres boot path and a test-suite resource-hygiene sweep with a permanent
gate pin. No behavior change for correctly configured deployments; no
frontend changes.

## Part 1 — B33: malformed `FW_DATABASE_URL` must not reach logs (#110)

### Problem

When `FW_DATABASE_URL` is syntactically malformed, `psycopg_pool`'s own
logger echoes the offending string verbatim in its connection-error line
(`error connecting in 'pool-1': missing "=" after "…" in connection info
string`). A mangled real DSN can still contain a password, so this violates
the repo's env-secret discipline (the app's own messages name only the
variable). Wrong-credential failures do NOT leak — libpq reports host/port
only; the exposure is limited to malformed-syntax values. Pre-existing since
B15 PR2; documented as a caveat in `docs/postgres-setup.md` since B15 PR3.

### Requirements

**R1 — Pre-validate the DSN before pool construction.**
`PostgresDatabase.__init__` (`app/services/db/postgres.py`) parses the DSN
with `psycopg.conninfo.conninfo_to_dict` inside `try/except
psycopg.ProgrammingError` *before* constructing the `ConnectionPool`. On
parse failure it raises:

```python
raise RuntimeError(
    f"{DATABASE_URL_ENV} is not a valid PostgreSQL connection string"
) from None
```

- `from None`, not `from exc`: psycopg's exception message embeds the raw
  string, so the cause must not ride along in tracebacks.
- The message names the variable only — never the value, never a fragment
  of it.
- Location rationale: `__init__` is the single choke point; validation
  there covers every construction path (app boot via `create_database`,
  `init-db`, `import-to-postgres`, direct construction in tests). A
  malformed value now never reaches psycopg_pool, so its logger has
  nothing to echo.

**R2 — Fail-loud boot semantics unchanged for valid-syntax DSNs.** The
existing `wait()` + `PoolTimeout → RuntimeError` path stays exactly as is;
wrong credentials / unreachable hosts keep psycopg_pool's own host/port
diagnostics.

**R3 — Documentation.** `docs/postgres-setup.md`: replace the
malformed-DSN leak caveat with the new behavior (malformed values are
rejected by the app before the driver sees them, with a variable-name-only
error). `docs/backend-architecture.md`: one sentence in the db-seam section
if the existing text mentions the boot path's failure modes; otherwise no
change.

### Tests (default gate — parse-only, no server, no Docker)

- Malformed DSN (e.g. `not-a-dsn-at-all`) → `RuntimeError` whose message
  contains `FW_DATABASE_URL` and does NOT contain the malformed value; the
  exception has `__cause__ is None` and its `__context__` is suppressed
  (`__suppress_context__` is true), so no traceback layer carries the
  value; `caplog` captured at DEBUG across the construction attempt does
  not contain the value either.
- Valid DSN still reaches pool construction: monkeypatch `ConnectionPool`
  in `app.services.db.postgres` with a stub recording the conninfo (and
  providing a no-op `wait()`); assert the stub was called with the DSN.
  This pins that pre-validation accepts what it must accept — both
  URL form (`postgresql://…`) and key/value form (`host=… dbname=…`).
- Mutation verification per the standing rule: delete the pre-check,
  malformed-DSN test must fail; restore by re-editing.

## Part 2 — B34: unclosed sqlite connections + ResourceWarning gate (#112)

### Problem

CI shows 12 `ResourceWarning: unclosed database in <sqlite3.Connection>`
lines per run. Cause: test code using `with sqlite3.connect(...)` — which
manages only the transaction, never closes the connection (the db seam's
documented trap) — or bare connects relying on GC. Invisible in the local
macOS gate (GC timing), deterministic-ish on CI Linux, and never failing
the gate because CPython ignores ResourceWarning by default.

Audit state (verified 2026-08-18): the issue's candidate list is partly
stale. `tests/test_health.py:57` and `tests/test_manage_cli.py:168` already
close via try/finally; the bare-connect legacy-schema builders in
`test_documents.py` / `test_folders.py` / `test_profiles.py` all close
explicitly. Confirmed leaky: `tests/test_usage.py:258` and
`tests/test_check_api.py:855` (`_read_usage_rows`, called repeatedly —
likely the bulk of the 12). `tests_e2e/` has no raw sqlite connects. The
enforcement run in R5 is the authoritative sweep; the list above is the
starting point, not the boundary.

### Requirements

**R4 — Fix the leaky sites.** Convert to the house pattern already used in
`tests/test_import_postgres.py` / `tests/test_manage_init_db.py`:
`with closing(sqlite3.connect(path)) as conn:` (plus the inner `with conn:`
transaction scope only where the site actually writes). Reads need no
transaction manager.

**R5 — Authoritative sweep via the gate itself.** Run the full suite with
ResourceWarning promoted to error (both gates: with and without
`FW_TEST_DATABASE_URL`) and fix every finding it surfaces, whatever the
source — the run is the audit (guard-rules-need-a-directory-sweep rule).
Two mechanism facts govern how the sweep is run (live-probed during plan
review, 2026-08-18): (a) GC-time findings are attributed to whichever
test happens to run when collection fires, not the leaking one — every
sweep/verification run uses `PYTHONTRACEMALLOC=15` so the report carries
the true allocation stack; (b) on a SMALL selection, xdist workers
swallow the GC-time unraisable error entirely — a real leak ran green
three times under `-n auto` — so any single-file verification MUST use
`-n0` (the full suite under `-n auto` does surface the findings).

One third-party finding is known and expected: `spylls` never closes its
dictionary file handles (`spylls/hunspell/readers/file_reader.py`,
reached via `app/checkers/llm/vetting.py:84` `Dictionary.from_files`;
the `_hunspell` cache keeps the Dictionary alive, so the leak is bounded
to one handle set per language per process). Not fixable at our call
site; it gets a narrowly scoped, commented `ignore` entry that matches
only unclosed-FILE warnings from the dictionaries path, and the sweep
must prove the ignore does NOT mask sqlite connection leaks.

**R6 — Pin the gate.** `pyproject.toml` `[tool.pytest.ini_options]` gains:

```toml
filterwarnings = [
    "error::ResourceWarning",
    "error::pytest.PytestUnraisableExceptionWarning",
    # + the narrowly scoped spylls ignore from R5, placed after the error
    #   entries (later entries take precedence in pytest)
]
```

The pin lives in `[tool.pytest.ini_options]` and therefore also governs
explicit `pytest tests_e2e` invocations (testpaths only sets the default
target). The e2e suite is browser/network-heavy, run manually, and out
of B34's scope: `tests_e2e/conftest.py` neutralizes the pin for e2e runs
(appends `default::ResourceWarning` / `default::pytest.
PytestUnraisableExceptionWarning` via `config.addinivalue_line`, with a
comment), so a future manual e2e run cannot hard-fail on a browser
socket nobody has triaged.

The second entry is load-bearing, not scope creep: a ResourceWarning
raised at GC time inside `__del__` cannot propagate as an exception and
reaches pytest through the unraisable-exception hook, wrapped as
`PytestUnraisableExceptionWarning` — without promoting the wrapper, the
exact leak class B34 targets would still pass the gate. Scoped
deliberately beyond that: no blanket promotion, so dependency bumps
emitting DeprecationWarnings cannot break CI; promoting all warnings was
considered and rejected as out of scope (PR #109 measured ~14 findings
under blanket `-W error`).

**R7 — No production-code changes in Part 2.** The sweep touches tests
and pytest config only (the spylls leak is bounded and handled by the R5
ignore, not by patching production code). The pin is self-testing;
mutation verification = temporarily reintroduce one unclosed connection
(e.g. revert the `test_usage.py` site), run the file with `-n0`, and
judge by EXIT CODE — the GC-time error can surface AFTER the summary
line (e.g. `N passed` followed by a traceback, exit 1), so grepping for
"failed" gives a false all-clear. Restore by re-editing.

## Out of scope

- Promoting all warnings to error (rejected above).
- B35 (#113) — separate story, next PR.
- Any change to production connection handling (sqlite stores already
  close deterministically; guarded by existing `test_connection_is_closed_
  after_use` tests).

## Delivery

One PR (`b33-b34-hygiene`) through the usual pipeline: plan with per-task
review, final review, Copilot rounds, LOGBOOK entry as last commit on cue,
owner rebase-merge. PR closes both issues via separate `Closes #110.` /
`Closes #112.` lines. Gates: `rtk proxy uv run pytest -q` green with zero
warnings, both without and with `FW_TEST_DATABASE_URL`.
