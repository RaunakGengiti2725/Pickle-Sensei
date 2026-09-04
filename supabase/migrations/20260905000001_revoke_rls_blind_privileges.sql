-- 20260905000001_revoke_rls_blind_privileges.sql
--
-- Hosted Supabase installs default privileges that hand `all` table
-- privileges to anon, authenticated and service_role on every new table in
-- public (the RLS test shim mirrors this). 20260831160000_defense_in_depth
-- sized INSERT/UPDATE/DELETE/EXECUTE to the writes the edge fn performs but
-- never touched the three privileges row-level security does not see:
--
--   TRUNCATE   — wipes every row of every user; no policy is consulted and no
--                row-level trigger fires, so the append-only guards on
--                consent_records / evaluation_trials / analysis_feedback and
--                the service-only rule for billing_entitlements did not
--                apply to it. Verified in the shim: an authenticated session
--                could truncate shots, consent_records, analysis_permits and
--                billing_entitlements.
--   TRIGGER    — lets a client session attach its own function to a table
--                (`create trigger … execute function pg_temp.f()`), i.e. run
--                code inside other roles' writes.
--   REFERENCES — lets a client-owned table pin rows in ours via FK.
--
-- No shipped surface reaches these (PostgREST exposes no TRUNCATE/DDL), so
-- this is defense in depth — but the blast radius of any future SQL
-- primitive is total cross-user data loss, and the certification's "grant
-- layer" claim assumed they were gone. Revoke them from both client roles on
-- every existing public relation AND from the default privileges, so tables
-- added by later migrations inherit the same shape. service_role keeps them
-- (it is the server, bypasses RLS anyway, and pg_dump/maintenance need them).
--
-- Static pin: supabase/functions/api/__wf__/db_migrations_rls_indexes.test.ts
-- ("grants: anon/authenticated lose TRUNCATE/TRIGGER/REFERENCES …").
-- Live: supabase/tests/security_regression.sql K1–K4 (every public relation,
-- a table created after all migrations, live 42501 on TRUNCATE and CREATE
-- TRIGGER); supabase/tests/adjudication_db_rls_grants_isolation.sql
-- ADJ-B1..B6.

-- ---------------------------------------------------------------------------
-- 1. Every existing relation in public (tables, partitioned tables, views,
--    materialized views, foreign tables — everything a table grant can name).
-- ---------------------------------------------------------------------------
do $$
declare
  rel record;
begin
  for rel in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by c.relname
  loop
    execute format(
      'revoke truncate, trigger, references on public.%I from anon, authenticated',
      rel.relname
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Future tables: migrations run as the same role that owns the hosted
--    default-privilege entry (postgres), so this alters exactly the defaults
--    that would otherwise re-grant the three privileges on the next
--    `create table`.
-- ---------------------------------------------------------------------------
alter default privileges in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Captures hygiene (same grant-layer pass): no client path updates or
--    deletes public.captures — the edge fn never touches the table and the
--    mobile app only talks to the edge fn — so the hosted-default UPDATE and
--    DELETE grants (and the policies that would let them through) are
--    surface with no consumer. Reads and inserts are unchanged.
-- ---------------------------------------------------------------------------
revoke update, delete on public.captures from authenticated;
drop policy if exists captures_update_own on public.captures;
drop policy if exists captures_delete_own on public.captures;
