-- Least-privilege grants for fabwriting_app (B36, #114). DML on public
-- only; no CREATE — DDL stays with the admin role (init-db, migrations).
-- All statements are idempotent.

-- Revoke first so a re-run converges on exactly USAGE -- GRANT only adds,
-- so a pre-existing/restored fabwriting_app could still carry WITH GRANT
-- OPTION, letting it delegate schema access to other roles.
revoke usage on schema public from fabwriting_app;
grant usage on schema public to fabwriting_app;

-- Existing objects. Revoke first so a re-run converges on exactly this verb
-- set -- GRANT only adds, so a pre-existing/restored fabwriting_app could
-- carry stale extra verbs (TRUNCATE/REFERENCES/TRIGGER on tables, UPDATE on
-- sequences) that would otherwise survive every re-push untouched.
revoke all on all tables    in schema public from fabwriting_app;
revoke all on all sequences in schema public from fabwriting_app;
revoke all on all functions in schema public from fabwriting_app;

grant select, insert, update, delete on all tables    in schema public to fabwriting_app;
grant usage, select                  on all sequences in schema public to fabwriting_app;
grant execute                        on all functions in schema public to fabwriting_app;

-- Future objects created by the admin role (init-db, import-to-postgres,
-- later migrations) become usable without per-object grants. Revoke first,
-- same reasoning as above -- default-ACL entries only add too, so a stale
-- extra verb or grant option here would taint every object init-db creates
-- from then on.
alter default privileges for role postgres in schema public
  revoke all on tables from fabwriting_app;
alter default privileges for role postgres in schema public
  revoke all on sequences from fabwriting_app;
alter default privileges for role postgres in schema public
  revoke all on functions from fabwriting_app;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to fabwriting_app;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to fabwriting_app;
alter default privileges for role postgres in schema public
  grant execute on functions to fabwriting_app;

-- Assert the design's other boundary half: no CREATE on public. The grants
-- above never grant it, but that guarantee holds only by omission -- a
-- project whose public carries a legacy `grant all on schema public to
-- public` (pre-PG15 dumps, some self-hosted setups) would silently keep
-- DDL rights. public always exists, so this needs no namespace guard,
-- unlike the auth/storage/extensions checks below.
do $$
begin
  if has_schema_privilege('fabwriting_app', 'public', 'CREATE') then
    raise exception 'fabwriting_app unexpectedly has CREATE on schema public';
  end if;
end
$$;

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
    if has_schema_privilege('fabwriting_app', 'storage', 'USAGE') then
      raise exception 'fabwriting_app unexpectedly has USAGE on schema storage';
    end if;
  end if;
  if exists (select 1 from pg_namespace where nspname = 'extensions') then
    revoke all on schema extensions from fabwriting_app;
    if has_schema_privilege('fabwriting_app', 'extensions', 'USAGE') then
      raise exception 'fabwriting_app unexpectedly has USAGE on schema extensions';
    end if;
  end if;
end
$$;

-- Direct-grant sweep: auth/storage/extensions above are asserted by name,
-- but any OTHER schema could carry a grant straight to fabwriting_app too
-- (a hand-run `grant usage on schema x to fabwriting_app` never reverted, a
-- restored dump). Walk every non-system schema other than public itself
-- (pg_% and information_schema are never a legitimate DML target and
-- aren't user schemas anyway) and raise, naming the schema(s), if
-- aclexplode(nspacl) shows fabwriting_app as a direct grantee on any of
-- them.
--
-- Deliberately DIRECT grants only, not effective privilege: on Supabase,
-- schema `net` grants USAGE to PUBLIC (`=U/supabase_admin`), which every
-- role -- including this one -- inherits, and PUBLIC privileges have no
-- per-grantee ACL entry to revoke against just one role. That grant is
-- platform baseline, out of this migration's scope to change (revoking
-- PUBLIC grants on Supabase-owned schemas would break Supabase's own
-- internal roles that depend on them), and an *effective*-privilege
-- assertion (has_schema_privilege) would false-fire on it forever. A
-- direct-grant check still catches what this guards against -- someone
-- explicitly granting fabwriting_app access to a schema outside public --
-- without ever tripping on that inherited baseline.
do $$
declare
  app_oid oid := (select oid from pg_roles where rolname = 'fabwriting_app');
  hits text;
begin
  select string_agg(distinct n.nspname, ', ' order by n.nspname)
    into hits
    from pg_namespace n, aclexplode(n.nspacl) a
    where a.grantee = app_oid
      and n.nspname <> 'public'
      and n.nspname !~ '^pg_'
      and n.nspname <> 'information_schema';
  if hits is not null then
    raise exception 'fabwriting_app unexpectedly has a direct grant on schema(s): % -- only schema public is in scope for this role -- fix by hand (revoke the grant), then re-run this migration', hits;
  end if;
end
$$;
