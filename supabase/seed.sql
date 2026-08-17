-- Executed ONLY by local `supabase db reset` (never by `db push`):
-- activates the app role for local development with a dev-only password.
-- Local backend DSN (a documented constant, like the local admin DSN):
--   postgresql://fabwriting_app:fabwriting_dev@127.0.0.1:54322/postgres
alter role fabwriting_app with login password 'fabwriting_dev';
