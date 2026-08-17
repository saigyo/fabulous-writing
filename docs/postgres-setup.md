# Running on Postgres

`database.backend: postgres` moves storage from the bundled SQLite file to a
plain managed Postgres database instead of this backend's default
`database.backend: sqlite` (still the default and fully supported for a
single-container deployment). Postgres mode exists for hosted deployments —
anywhere the data needs to live outside the container's own volume, or
survive a redeploy that doesn't carry the volume with it. The backend has no
Supabase-specific dependency: it treats the target as ordinary managed
Postgres (an advisory lock for the usage-reservation transaction,
`REPEATABLE READ` for the multi-window credit-usage read — nothing
Supabase-only), and
[supabase.com](https://supabase.com) is simply the hosted instance this
project documents and tests against.

## Connection string

Set `database.backend: postgres` in `config.yaml`. The DSN itself never goes
in `config.yaml` or any other settings source — it carries the database
password, and config files get logged, committed, and shared far more
casually than a process environment. Instead the backend reads it from a
single environment variable, `FW_DATABASE_URL`, and only from there
(`create_database` in `app/services/db/__init__.py`); on any connection
failure the app's own error names the variable, never its value.

**On Supabase, use the direct connection or Supavisor session mode — never
transaction mode.** The app issues server-side prepared statements
(psycopg's default `prepare_threshold`), and transaction-mode pooling
doesn't support those: a prepared statement created on one backend
connection can be handed a different one on the next round-trip, since
transaction mode hands out a fresh backend connection per transaction. The
app also already runs its own fixed-size connection pool
(`psycopg_pool.ConnectionPool`, 1–5 connections; see
the db-seam section of [`docs/backend-architecture.md`](backend-architecture.md)),
so an external transaction pooler in front of that
pool adds nothing — it would only be relevant for a client that opens a
fresh connection per request, which this app doesn't do. (The app's own use
of advisory locks, for the LLM-usage reservation transaction, uses the
transaction-scoped `pg_advisory_xact_lock` — those survive transaction
pooling fine and are not the reason to avoid it.)

## How the password reaches the app

Normally as the DSN's userinfo component —
`postgresql://user:password@host:port/dbname` — with any special character
in the password percent-encoded: `@`→`%40`, `:`→`%3A`, `/`→`%2F`, `%`→`%25`.

The app hands `FW_DATABASE_URL` to psycopg/libpq verbatim, so every other
libpq mechanism for supplying a password works too, if you'd rather not put
it in the DSN at all:

- a password-less DSN plus the `PGPASSWORD` environment variable;
- a password-less DSN plus a `~/.pgpass` file (or `PGPASSFILE` pointing
  somewhere else);
- the `key=value` conninfo format (`host=... user=... password=...`)
  instead of a URL.

Deployment example, the container form this project ships today (see the
[quickstart](../README.md#run-it-in-a-container-quickstart)'s plain
`docker run` invocation):

```sh
docker run --rm -v fabulous-config:/config -v fabulous-data:/data -p 8080:8000 \
  -e FW_DATABASE_URL='postgresql://user:pass@host:5432/dbname' \
  ghcr.io/saigyo/fabulous-writing:latest serve
```

Forward-looking, not yet shipped: B16 (fly.io deployment) is expected to use
`fly secrets set FW_DATABASE_URL=...` instead, once that deployment target
exists.

## Migrating an existing SQLite deployment

`uv run python -m app.manage import-to-postgres` (run from `backend/` —
`uv run` provides the project environment; a bare `python3` will fail with
`ModuleNotFoundError`) does a one-time, all-or-nothing copy of an existing
SQLite database into the Postgres target named by `FW_DATABASE_URL`.

1. Stop the server.
2. **Copy the `.db` file first.** Constructing the importer's stores runs
   the same idempotent schema migrations the server itself would run on
   next start, against both the source and the target — the source file's
   *content* is preserved, but the file is not byte-frozen, so keep a copy
   made before the import runs.
3. Set `FW_DATABASE_URL` to the target database. Leave
   `database.backend: sqlite` in `config.yaml` for now — the import tool
   reads the target from the environment variable regardless of what
   `backend` says, so this keeps the running config truthful until the
   import is verified.
4. Run:

   ```sh
   cd backend
   uv run python -m app.manage --db /path/to/fabulous.db import-to-postgres
   ```

   `--db` is a **top-level** option and must come *before* the subcommand
   (`... app.manage --db ... import-to-postgres`, not
   `import-to-postgres --db ...`) — omit it entirely to import the database
   at the configured `db_path` instead.

5. The tool refuses to run if:
   - the source carries a column the current schema no longer has (a
     pre-migration file column that was since dropped from the schema);
   - two SQLite rows in `users` have distinct emails that collide once
     folded under Postgres' full-Unicode `LOWER()` (SQLite's own `LOWER()`
     is ASCII-only, so such a pair can exist there without ever violating
     anything);
   - the target database already holds rows in any of the tables being
     copied.

   Any refusal prints the offending tables, columns, or rows and exits
   without copying anything.
6. On success, it copies every table in foreign-key order with the
   source's own ids, resets each identity sequence past the imported
   ids, verifies the target's per-table row counts against the source
   inside the same transaction, and prints them:

   ```
     users: 3 rows
     folders: 12 rows
     documents: 47 rows
     ...
   import complete and verified; set database.backend to 'postgres'.
   ```

7. Flip `database.backend: postgres` in `config.yaml` and start the server.

Two failure modes worth knowing in advance:

- **A refused run** (step 5) leaves the target with its freshly-created,
  still-empty schema and nothing else — safe to fix the cause and re-run
  the same command.
- **Duplicate folder/domain/profile *names*** that an old SQLite database
  may legally hold (their unique indexes were introduced later and were
  skipped-with-warning rather than enforced retroactively) surface during
  the copy as a unique-constraint error; the whole transaction rolls back
  cleanly, so nothing is left half-imported. Resolve the duplicates in the
  running SQLite-backed app, then re-run the import.

For very large ledgers (a big `documents` or `llm_usage` table), run the
import from a machine close to the target: rows copy one at a time, each a
separate round-trip, so total duration scales with row count times
round-trip latency.

## Backup

Once running on Postgres, your provider's own backup story (point-in-time
recovery, scheduled snapshots, etc.) replaces copying the SQLite data
directory — there's no longer a single file to copy. The pre-import copy of
the SQLite file from step 2 above remains a point-in-time fallback for as
long as you keep it around; once you're confident in the Postgres backups
and no longer need to fall back, it's safe to delete.

## Known logging caveat

On a **malformed** `FW_DATABASE_URL` (a syntax error in the DSN itself, not
merely wrong credentials), psycopg's connection-pool logger may echo the
offending connection string — password included — in its own error line
before the app's variable-name-only message ever prints; treat any such log
line as sensitive until this is closed off (tracked as a follow-up, #110).
