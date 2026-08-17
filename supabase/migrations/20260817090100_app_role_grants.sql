-- Least-privilege grants for fabwriting_app (B36, #114). DML on public
-- only; no CREATE — DDL stays with the admin role (init-db, migrations).
-- All statements are idempotent.

grant usage on schema public to fabwriting_app;

-- Existing objects.
grant select, insert, update, delete on all tables    in schema public to fabwriting_app;
grant usage, select                  on all sequences in schema public to fabwriting_app;
grant execute                        on all functions in schema public to fabwriting_app;

-- Future objects created by the admin role (init-db, import-to-postgres,
-- later migrations) become usable without per-object grants.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to fabwriting_app;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to fabwriting_app;
alter default privileges for role postgres in schema public
  grant execute on functions to fabwriting_app;

-- Isolation from Supabase's own schemas. Deliberately NOT a blanket
-- `revoke ... from public` on Supabase schemas -- internal Supabase roles
-- depend on those grants. Schema-existence-guarded so the migration also
-- applies to plain Postgres (CI service container, non-Supabase).
--
-- auth is an ASSERTION, not a revoke: on Supabase the migration runs as
-- `postgres`, which holds only plain USAGE (no grant option) on the
-- supabase_admin-owned auth schema, so `revoke ... from fabwriting_app`
-- cannot revoke anything there -- it just floods `db push` with
-- "no privileges could be revoked" warnings (probed on PG 17). A fresh
-- role has no auth access to begin with; the assertion fails the
-- migration loudly if that ever stops being true.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    if has_schema_privilege('fabwriting_app', 'auth', 'USAGE') then
      raise exception 'fabwriting_app unexpectedly has USAGE on schema auth';
    end if;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    revoke all on schema storage from fabwriting_app;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    revoke all on schema extensions from fabwriting_app;
  end if;
end
$$;
