-- The client roles hold no privilege RLS cannot govern (2026-09-05, ADJ-B).
--
-- Defect: the hosted project (and shim_auth.sql, which mirrors it) installs
-- `alter default privileges in schema public grant all on tables to anon,
-- authenticated, service_role`. `ALL` is more than SELECT/INSERT/UPDATE/
-- DELETE: it also hands out TRUNCATE, TRIGGER and REFERENCES, and none of
-- the earlier revokes (20260831160000_defense_in_depth.sql revokes only
-- insert/update/delete/execute) ever took them back — 54 grants over 18
-- tables. Row-level security does not apply to any of the three:
--   * TRUNCATE empties a table without firing row-level triggers, so an
--     authenticated session could wipe shots, analysis_permits,
--     consent_records, evaluation_trials and billing_entitlements — every
--     user's rows — bypassing the append-only ledger triggers and the
--     "written ONLY by the edge function via service role" rule.
--   * TRIGGER lets a client attach its own trigger function to a public
--     table.
--   * REFERENCES lets a client pin rows of a public table from a foreign key.
-- Not reachable through PostgREST today (it exposes no TRUNCATE/DDL), but
-- the certification's grant-layer claim rested on privileges that were
-- never actually removed.
--
-- Fix: revoke the three from anon and authenticated on EVERY relation in
-- schema public (tables, partitions, views, materialized views, foreign
-- tables — looped over pg_class so anything an earlier migration created is
-- covered), and remove them from the schema default privileges so tables
-- added by later migrations are born without them. service_role keeps its
-- grants (it bypasses RLS by design).
--
-- Captures hygiene, in the same migration: no shipped path updates or
-- deletes public.captures (the edge fn never touches the table; the mobile
-- app only talks to the edge fn), so `authenticated` loses UPDATE/DELETE on
-- it and the matching policies go — grants sized to the writes, as for
-- every other table in 20260831160000_defense_in_depth.sql. SELECT/INSERT
-- stay.
--
-- Pins: __wf__/db_migrations_rls_indexes.test.ts (static: the loop, the
-- default-privilege revoke, the captures revoke, no later re-grant) and
-- security_regression.sql K1–K7 (live: every public relation, information_
-- schema, a table created AFTER this migration, TRUNCATE + CREATE TRIGGER
-- refused as authenticated, captures grants/policies).

-- ---------------------------------------------------------------------------
-- 1. Existing relations.
-- ---------------------------------------------------------------------------
do $$
declare
  rel record;
begin
  for rel in
    select c.oid::regclass as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by 1
  loop
    execute format('revoke truncate, trigger, references on %s from anon, authenticated', rel.name);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Future relations: the defaults for objects this role creates in schema
--    public (the migration role owns every table) no longer carry them.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke truncate, trigger, references on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Captures hygiene: no client path updates or deletes captures.
-- ---------------------------------------------------------------------------
revoke update, delete on public.captures from authenticated;
drop policy if exists "captures_update_own" on public.captures;
drop policy if exists "captures_delete_own" on public.captures;
