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
--
-- Membership risk: NOINHERIT only stops fabwriting_app from automatically
-- USING the privileges of roles it belongs to -- membership still lets it
-- SET ROLE into them explicitly, regardless of NOINHERIT. A pre-existing
-- fabwriting_app (hand-created, restored from a dump, a leftover from an
-- earlier manual attempt) could already BELONG TO some other role, which
-- would hand it SET ROLE access to whatever that role can do. Direction
-- matters: pg_auth_members.member is the role gaining membership, so
-- `member = fabwriting_app's oid` means fabwriting_app is a MEMBER of
-- (belongs to) some other role -- that's the risk this checks for. The
-- other direction is fine and expected: the runbook's
-- `grant fabwriting_app to postgres with set true` (docs/postgres-setup.md)
-- makes postgres a member OF fabwriting_app -- member = postgres's oid,
-- roleid = fabwriting_app's oid -- and must NOT trip this assertion.
--
-- Ownership risk: object OWNERSHIP is a separate authority path from both
-- role attributes and ACLs -- an owner can ALTER or DROP its own relations,
-- functions, and schemas even with none of the grants above and even under
-- NOINHERIT, because ownership checks bypass the privilege system entirely
-- (see PostgreSQL's object-ownership rules). A pre-existing fabwriting_app
-- (hand-created, restored from a dump, an earlier manual attempt that ran
-- some DDL) could already own objects created before this migration ever
-- ran. The oid is resolved once, above, and reused for every check in this
-- block.
--
-- Database-level risk: schema-level CREATE (asserted absent in
-- 20260817090100_app_role_grants.sql) isn't the only way to create a new
-- schema -- CREATE at the DATABASE level grants that too, independent of
-- any per-schema ACL, and would let fabwriting_app spin up a schema of its
-- own to own and operate in freely. Owning the database itself is a further
-- step past that: the DATABASE owner can rename, drop, or reassign it, and
-- (like the object-ownership risk above) that authority bypasses the
-- privilege system entirely. Neither is granted by anything in this
-- migration or its grants file, but a pre-existing/restored fabwriting_app
-- could hold either. PUBLIC is never granted database CREATE by default
-- (probed: `has_database_privilege('public', current_database(), 'CREATE')`
-- is false on this stack), so this cannot false-fire on a normal apply.
do $$
declare
  app_oid oid := (select oid from pg_roles where rolname = 'fabwriting_app');
begin
  if exists (select 1 from pg_roles where oid = app_oid and rolsuper) then
    raise exception 'fabwriting_app has the SUPERUSER attribute; only an actual superuser can revoke it (ALTER ROLE ... NOSUPERUSER fails for a mere CREATEROLE actor) -- fix by hand, then re-run this migration';
  end if;

  if exists (select 1 from pg_auth_members where member = app_oid) then
    raise exception 'fabwriting_app unexpectedly belongs to another role (a pg_auth_members row has it as member) -- NOINHERIT does not block SET ROLE into that role -- fix by hand (revoke the membership from fabwriting_app), then re-run this migration';
  end if;

  if exists (select 1 from pg_class where relowner = app_oid)
     or exists (select 1 from pg_proc where proowner = app_oid)
     or exists (select 1 from pg_namespace where nspowner = app_oid)
  then
    raise exception 'fabwriting_app unexpectedly OWNS a relation, function, or schema -- an object owner keeps implicit ALTER/DROP authority over it regardless of the role''s own attributes or any ACL, so ownership is a privilege-escalation path NOINHERIT and the grant recipe above cannot close -- fix by hand (reassign the object(s) to another owner), then re-run this migration';
  end if;

  if has_database_privilege(app_oid, current_database(), 'CREATE') then
    raise exception 'fabwriting_app unexpectedly has CREATE on the current database -- that lets it create schemas of its own regardless of any per-schema ACL -- fix by hand (revoke database CREATE from fabwriting_app), then re-run this migration';
  end if;

  if exists (select 1 from pg_database where datname = current_database() and datdba = app_oid) then
    raise exception 'fabwriting_app unexpectedly OWNS the current database -- database ownership bypasses the privilege system entirely, the same as object ownership above -- fix by hand (reassign the database to another owner), then re-run this migration';
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
