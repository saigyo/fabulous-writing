-- Runtime role for the Fabulous Writing backend (B36, #114): DML-only on
-- the public schema. Created NOLOGIN and without a password so this file
-- is committable; activation is out-of-band:
--   remote: ALTER ROLE fabwriting_app WITH LOGIN PASSWORD '<generated>';
--           (SQL editor / psql, never a migration)
--   local:  supabase/seed.sql sets a dev password on every `db reset`.
-- Guarded by an existence check: roles are cluster-wide, so this must
-- survive both a fresh local `db reset` and a `db push` to a remote where
-- the role may already exist.
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

comment on role fabwriting_app is
  'Fabulous Writing backend runtime role: DML-only on public. Password set out-of-band, never in migrations.';
