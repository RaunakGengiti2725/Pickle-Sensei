-- Hosted-fidelity extension of shim_auth.sql.
--
-- supabase/postgres runs its init scripts as the `postgres` role
-- (migrations/README.md "Run all db/init-scripts with postgres superuser
-- role") and 00000000000000-initial-schema.sql:40-42 declares
--
--   alter default privileges in schema public grant all on tables    to postgres, anon, authenticated, service_role;
--   alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
--   alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
--
-- shim_auth.sql mirrors the TABLE and SEQUENCE lines only. On hosted Supabase
-- every function a migration creates therefore also carries EXPLICIT
-- anon=X / authenticated=X ACL entries, so a migration that only does
-- `revoke execute ... from public` leaves the client roles executable. This
-- file adds the missing FUNCTIONS line so the matrix runs against the same
-- ACL shape production has. Apply right after shim_auth.sql, before any
-- migration.
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
