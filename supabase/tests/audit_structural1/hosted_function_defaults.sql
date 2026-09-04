-- Audit-only fidelity extension for supabase/tests/shim_auth.sql.
--
-- shim_auth.sql mirrors hosted Supabase's default privileges for TABLES and
-- SEQUENCES only. Hosted projects additionally grant EXECUTE on every new
-- FUNCTION in public to anon / authenticated / service_role by default
-- (supabase/postgres init: `alter default privileges in schema public grant
-- all on functions to ...`). Without this line a migration that revokes a
-- function only `from public` (leaving the explicit hosted grant in place)
-- passes the matrix vacuously. This file is applied AFTER shim_auth.sql and
-- BEFORE the migrations by run_probes.sh in "hosted-fn" mode.
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
