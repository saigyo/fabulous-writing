-- Runtime role for the Fabulous Writing backend (B36, #114): DML-only on
-- the public schema. Created NOLOGIN and without a password so this file
-- is committable; activation is out-of-band:
--   remote: ALTER ROLE fabwriting_app WITH LOGIN PASSWORD '<generated>';
--           (SQL editor / psql, never a migration)
--   local:  supabase/seed.sql sets a dev password on every `db reset`.
-- Guarded by an existence check: roles are cluster-wide, so this must
-- survive both a fresh local `db reset` and a `db push` to a remote where
-- the role may already exist.
--
-- Existence-only guards are the wrong shape here, though: a role created
-- by hand (an earlier manual attempt, a restored cluster) could hold
-- attributes this migration claims it doesn't. So after the guarded
-- CREATE, an unconditional ALTER ROLE converges every attribute below on
-- every run, including a re-push against an already-activated role.
-- LOGIN and PASSWORD are deliberately absent from that ALTER: they are
-- set out-of-band (see the file-level activation note above), and this
-- migration must never touch them, or a re-push would lock the activated
-- role out.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fabwriting_app') then
    create role fabwriting_app with
      nologin
      noinherit
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls          -- keeps future RLS in public enforceable
      connection limit 10; -- app pool is 1-5 per instance; headroom for deploy overlap
  end if;
end
$$;

-- Convergence step: runs every time, regardless of the guard above. Never
-- mention LOGIN or PASSWORD here -- see the comment above the guard.
--
-- SUPERUSER is deliberately absent from this ALTER, unlike the CREATE
-- above: Postgres lets only an actual superuser touch that attribute via
-- ALTER ROLE, in either direction -- probed live against this stack,
-- `alter role x with nosuperuser` run as `postgres` (rolsuper=f,
-- rolcreaterole=t, same shape as Supabase's migration runner) raises
-- "permission denied to alter role ... Only roles with the SUPERUSER
-- attribute may alter roles with the SUPERUSER attribute", even though
-- it's only removing the attribute, not granting it. CREATE ROLE has no
-- such restriction for the false case (only for granting true), which is
-- why the guarded CREATE above can still say `nosuperuser` safely. So if
-- a role was ever hand-created or restored WITH SUPERUSER, this migration
-- cannot silently fix that via ALTER -- the assertion below turns it into
-- a loud failure instead of a silent no-op or a confusing permission
-- error deep in `db push`.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'fabwriting_app' and rolsuper) then
    raise exception 'fabwriting_app has the SUPERUSER attribute; only an actual superuser can revoke it (ALTER ROLE ... NOSUPERUSER fails for a mere CREATEROLE actor) -- fix by hand, then re-run this migration';
  end if;
end
$$;

alter role fabwriting_app with
  noinherit
  nocreatedb
  nocreaterole
  noreplication
  nobypassrls
  connection limit 10;

comment on role fabwriting_app is
  'Fabulous Writing backend runtime role: DML-only on public. Password set out-of-band, never in migrations.';
