-- Applied after shim_auth.sql for the `hosted_defaults` history only.
--
-- Hosted Supabase installs
--   alter default privileges in schema public grant all on tables to
--     postgres, anon, authenticated, service_role;
-- (supabase/postgres migrations/db/init-scripts/00000000000000-initial-schema.sql).
-- The canonical shim gives service_role only truncate/references/trigger by
-- default, so a migration that forgets to revoke service_role DML on a
-- service-only or append-only table passes the canonical matrix vacuously.
-- This shim restores the hosted default so that gap is visible.
alter default privileges in schema public
  grant all on tables to service_role;
