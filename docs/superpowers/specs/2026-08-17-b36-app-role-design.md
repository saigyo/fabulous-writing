# B36: Least-Privilege Postgres Application Role — Design

**Issue:** #114 · **Branch:** `b36-app-role` · **Date:** 2026-08-17

## Problem

In postgres mode (B15, #56) the backend connects with the Supabase admin role
(`postgres`), which owns every schema in the database — including `auth`
(GoTrue user records and tokens), `storage`, and `extensions`. A compromised
app process, or a bug in our own SQL, could read or modify Supabase Auth's
internal tables. Before the fly.io deployment (B16, #57) goes to production,
the app must connect with a dedicated role that can touch nothing but its own
data.

## Verified constraint that shapes the design

Probed against the local Supabase stack (Postgres 17, throwaway schema and
role): `CREATE TABLE IF NOT EXISTS` fails with `permission denied for schema`
**even when the table already exists** — Postgres checks the schema `CREATE`
privilege before the already-exists short-circuit. `CREATE INDEX IF NOT
EXISTS` likewise fails with `must be owner of table`. The app's startup DDL
(`executescript(_SCHEMA)` plus `migrate_columns` in every store constructor)
therefore cannot run under a DML-only role at all, not even as a no-op.
Runtime paths are unaffected: plain DML, `pg_advisory_xact_lock`, and
`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` all work under the
restricted role.

Consequence: B36 is grants **plus** a small backend change that makes schema
DDL skippable, with DDL running out-of-band under the admin role.

## Approaches considered

- **Config-gated schema management (chosen):** explicit
  `database.manage_schema` switch, DDL runs via a new `init-db` manage
  subcommand under the admin DSN.
- **Privilege auto-detection** (`has_schema_privilege` at connect): rejected
  — an accidentally-admin runtime DSN silently keeps self-migrating, a
  misconfigured app role silently skips migrations; both failure modes are
  quiet.
- **Moving table DDL into Supabase CLI migrations:** rejected — it would
  create a second schema source competing with the seam's dialect-rendered
  DDL, which sqlite mode still needs. CLI migrations stay role/grants-only.

## Requirements

### R1 — Role and grants as Supabase CLI migrations

New directory `supabase/migrations/` (first use of the CLI migration
workflow in this repo) with two files, comments in English:

1. `<timestamp>_create_app_role.sql` — creates role `fabwriting_app`
   guarded by a `pg_roles` existence check (roles are cluster-wide; the
   migration must survive both a fresh local `supabase db reset` and a
   `db push` against a remote where the role may already exist). Role
   attributes: `NOLOGIN` (login and password are granted out-of-band, never
   in the repo), `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
   `NOREPLICATION`, `NOBYPASSRLS`, `CONNECTION LIMIT 10` (app pool is 1–5
   per instance; 10 leaves deploy-overlap headroom). Plus `COMMENT ON ROLE`
   describing its purpose.
2. `<timestamp>_app_role_grants.sql` — all statements idempotent:
   - `GRANT USAGE ON SCHEMA public` — deliberately **no `CREATE`**;
   - `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`;
   - `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public`;
   - `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public`;
   - `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT …`
     for tables, sequences, and functions — objects created later by the
     admin role (`init-db`, `import-to-postgres`, future migrations) become
     usable by the app role automatically;
   - isolation from Supabase's schemas — amended after a live probe
     (plan review, 2026-08-17): `auth` gets an **assertion**, not a
     revoke. On Supabase the migration runs as `postgres`, which holds
     only plain `USAGE` (no grant option) on the `supabase_admin`-owned
     `auth` schema, so `REVOKE … FROM fabwriting_app` there can revoke
     nothing and merely floods `db push` with ~140 "no privileges could
     be revoked" warnings; a fresh role has no `auth` access anyway. The
     migration instead raises an exception if
     `has_schema_privilege('fabwriting_app','auth','USAGE')` is ever
     true. `storage`/`extensions` keep real `REVOKE ALL` statements
     (those work — `postgres` holds grant option there). Never a blanket
     `REVOKE … FROM PUBLIC` on Supabase schemas — internal Supabase
     roles depend on those grants. All branches are schema-existence-
     guarded so the migration also applies cleanly on plain Postgres
     (CI service container, non-Supabase deployments).

`supabase/seed.sql` (executed only by local `supabase db reset`, never by
`db push`) activates the role for local development:
`ALTER ROLE fabwriting_app WITH LOGIN PASSWORD 'fabwriting_dev';` and a
comment documenting the local DSN
(`postgresql://fabwriting_app:fabwriting_dev@127.0.0.1:54322/postgres`).
The dev password is a documented constant like the local admin DSN; the
production password never appears anywhere in the repo or in logs.

### R2 — `database.manage_schema` setting

`DatabaseSettings` gains `manage_schema: bool = True` (`extra="forbid"`
unchanged). Semantics are backend-uniform: when `True` (default, today's
behavior) store construction runs schema DDL as before; when `False` the
app never issues DDL — store construction instead **verifies** the schema
(R3). The setting is orthogonal to `backend`; its intended use is postgres
mode with the app role, and the docs say so. Single-admin-DSN postgres mode
(`manage_schema: true`) remains fully supported.

### R3 — Startup schema verification (fail fast, name the remedy)

With `manage_schema: false`, each store constructor checks — via the
existing `table_columns` seam helper — that its tables exist and that every
column its `migrate_columns` calls would ensure is present. On the first
missing table or column it raises `RuntimeError` naming the missing
item(s) and the remedy, e.g.:

```
database schema is missing table 'documents' (or columns thereof);
run the 'init-db' manage command with an admin FW_DATABASE_URL first
```

This turns a forgotten migration step into a clear startup failure instead
of an `UndefinedColumn` error mid-request. The check issues only reads; it
must work under the restricted role.

### R4 — `init-db` manage subcommand

New subcommand `init-db` in `app/manage.py` (same dispatch pattern as
`import-to-postgres`): builds `Settings`, creates the `Database` from
`FW_DATABASE_URL` as usual, constructs all stores **with DDL forced on**
(ignoring `manage_schema` from config — running DDL is its purpose), closes
the database in a `finally`, prints a completion line. Idempotent; works on
both backends (on sqlite it simply initializes the file). This command *is*
the production schema-migration step: run it with the **admin** DSN before
deploying a release that changes the schema. The app's DDL is additive
(`CREATE TABLE IF NOT EXISTS`, add-column-if-missing), so migrating before
the old version stops serving is safe.

### R5 — Two-DSN discipline (procedural, no new code)

`FW_DATABASE_URL` remains the only database environment variable. The
runtime deployment secret carries the **app-role** DSN; the operator
supplies the **admin** DSN only when running privileged commands (`init-db`,
`import-to-postgres`). The admin DSN never goes into runtime deployment
secrets (and later, per the B16 discussion, lives at most in CI deploy
secrets — not in Fly's app environment, whose secrets are readable by the
running app; for this reason Fly's `release_command` is explicitly not the
recommended migration hook).

### R6 — Tests

Default suite stays Docker/network-free and zero-warning; PG tests skip
without `FW_TEST_DATABASE_URL`.

Unit (sqlite-backed, fast):
- `manage_schema: false` skips DDL — spy proves `executescript` is not
  called (mutation-verified: force the flag on, test fails);
- verification failure path: fresh empty database + `manage_schema: false`
  → `RuntimeError` mentioning `init-db` (mutation-verified: disable the
  check, test fails);
- `init-db` initializes an empty database and is idempotent on a second
  run;
- `init-db` forces DDL even when config says `manage_schema: false`.

PG integration (real server):
- fixture creates a throwaway restricted role (unique
  `fw_test_role_<hex>` name — roles are cluster-wide and tests run in
  parallel — with `LOGIN` and a throwaway password) whose grants on the
  per-test schema mirror the migration's grants; teardown drops the schema
  and then the role, with the role drop still *attempted* even if the
  schema drop fails — a teardown bug must never silently skip it, since a
  leaked role is cluster-wide. (No `DROP OWNED BY`: it needs the role's
  own privileges, which the non-superuser local `postgres` lacks; the
  schema drop already removes every schema-scoped grant.) The real
  `fabwriting_app` role is never touched by tests;
- API smoke through the restricted role: admin DSN runs `init-db`-style
  schema creation, app connects with `manage_schema: false` as the
  restricted role, exercises signup-free basics (login, document create,
  term CRUD);
- privilege boundaries: under the restricted role, `CREATE TABLE` in the
  granted schema is denied, and access to a second, ungranted schema
  (created by the fixture; the portable stand-in for Supabase's `auth`,
  which the CI service container does not have) is denied;
- stale-schema detection: admin drops a column, app startup with
  `manage_schema: false` fails naming it.

Every guard test is mutation-verified per the standing rule.

### R7 — Documentation

- `docs/postgres-setup.md`: new "Least-privilege application role" section
  with the full fresh-Supabase runbook — `supabase link`, `supabase db
  push`, one-time out-of-band `ALTER ROLE fabwriting_app WITH LOGIN
  PASSWORD '…'` in the SQL editor (generated secret, e.g.
  `secrets.token_urlsafe(32)`; never committed or logged), the `SET ROLE`
  verification block (`SELECT` from `auth.users` must fail with
  *permission denied for schema auth*; `CREATE TABLE public.x` must fail;
  on a database that already holds app tables, DML must work — on a fresh
  project `has_schema_privilege` checks stand in), Supavisor username form
  `fabwriting_app.<projectref>`, two-DSN discipline, `manage_schema:
  false` config, `init-db` migration flow for releases, and the local-dev
  parity setup. Existing import walkthrough gains a note that the import
  runs under the admin DSN (its schema creation and `ALTER … RESTART` are
  owner-level DDL).
- `docs/backend-architecture.md`: db-seam section updated with
  `manage_schema`, schema verification, and `init-db`.

### R8 — Application to real environments (part of this story)

- **Local stack** (running, holds live dev data — no `supabase db reset`):
  apply the same role+grants statements plus the seed's dev-password
  `ALTER ROLE` directly via `psql` in the db container. Markus then flips
  his dev `FW_DATABASE_URL` to the app role and sets
  `manage_schema: false`. Existing tables are owned by `postgres`, so the
  `ON ALL TABLES` grants cover them; a future local `db reset` replays
  migrations + seed identically. (The running stack won't have
  `supabase_migrations` bookkeeping until its next reset — harmless.)
- **Hosted project**: `supabase link` (Markus authenticates), `supabase db
  push` applies both migrations, Markus sets the production password
  out-of-band, verification per the runbook. The hosted `public` schema
  holds no app tables yet — B16's `init-db` will create them under the
  admin role, covered by the default-privileges grants.

> **Amendment (final review, 2026-08-18):** the local-stack bullet's premise
> above — "existing tables are owned by `postgres`, so the `ON ALL TABLES`
> grants cover them" — is factually wrong for this stack: probed, `public`
> on the running stack holds 0 relations and 0 functions. The `ON ALL
> TABLES`/`SEQUENCES`/`FUNCTIONS` grants therefore cover nothing locally
> either; the correct step order is the same as the hosted bullet's: apply
> the role + grants migrations, run `init-db` (or the importer) under the
> admin DSN so the tables land under the `alter default privileges`
> coverage, and only THEN flip the local `FW_DATABASE_URL` to the app role
> and set `manage_schema: false`.

## Out of scope

- Moving table DDL into CLI migrations (rejected above).
- RLS in `public` (the app role is created `NOBYPASSRLS` so it stays
  possible later).
- CI deploy workflow that runs `init-db` (later, with or after B16).
- #110 (conninfo logging) — unchanged by this story.

## Delivery

One PR (`b36-app-role`, closes #114) through the usual pipeline: planned
tasks with per-task review, Opus whole-branch final review, Copilot rounds,
LOGBOOK entry as last commit, owner rebase-merge.
