-- P07 — Client roles hold only the table privileges the edge function uses.
--
-- Suspect: shim_auth.sql:61-64 mirrors hosted Supabase's default privileges
-- (ALL on tables to anon/authenticated/service_role) and the migrations
-- revoke INSERT/UPDATE/DELETE selectively — TRUNCATE, TRIGGER and REFERENCES
-- are never revoked, and the two aggregate views keep INSERT/UPDATE/DELETE.
-- PostgREST exposes none of those verbs, so this is latent surface — but
-- TRUNCATE ignores RLS and row triggers entirely and needs only the
-- privilege, so any non-PostgREST path (a future RPC, a leaked connection
-- string) wipes every user's rows. Hosted default privileges are UNKNOWN
-- from here; the shim's are documented as hosted-like.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

-- 1. TRUNCATE: the one dangerous verb — bypasses RLS and every trigger.
select pg_temp.check('authenticated cannot TRUNCATE any public table → ' ||
  coalesce((select string_agg(table_name, ',' order by table_name) from information_schema.role_table_grants
            where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'TRUNCATE'), 'none'),
  not exists (select 1 from information_schema.role_table_grants
              where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'TRUNCATE'));

-- Behavioural confirmation: an authenticated JWT wipes another user's ledger.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
select permit_id as pb from public.reserve_analysis_permit('bob-1') \gset
select pg_temp.check('bob has a reserved permit', (select count(*) from public.analysis_permits) = 1);
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select pg_temp.check('alice (authenticated) cannot truncate analysis_permits',
  pg_temp.raises('truncate public.analysis_permits'));
reset role;
select pg_temp.check('bob''s permit survived alice''s truncate attempt',
  exists (select 1 from public.analysis_permits where id = :'pb'));

-- 2. TRIGGER / REFERENCES are not client verbs either.
select pg_temp.check('authenticated holds no TRIGGER privilege on public tables',
  not exists (select 1 from information_schema.role_table_grants
              where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'TRIGGER'));
select pg_temp.check('authenticated holds no REFERENCES privilege on public tables',
  not exists (select 1 from information_schema.role_table_grants
              where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'REFERENCES'));

-- 3. Aggregate views are read-only for clients.
select pg_temp.check('progress_daily / practice_days grant only SELECT to authenticated → ' ||
  coalesce((select string_agg(table_name || ':' || privilege_type, ',' order by 1) from information_schema.role_table_grants
            where grantee = 'authenticated' and table_schema = 'public'
              and table_name in ('progress_daily', 'practice_days') and privilege_type <> 'SELECT'), 'none'),
  not exists (select 1 from information_schema.role_table_grants
              where grantee = 'authenticated' and table_schema = 'public'
                and table_name in ('progress_daily', 'practice_days') and privilege_type <> 'SELECT'));

-- 4. anon has nothing in public (this one the migrations DO enforce).
select pg_temp.check('anon holds no privilege on any public table or view',
  not exists (select 1 from information_schema.role_table_grants
              where grantee = 'anon' and table_schema = 'public'));

select pg_temp.finish();
rollback;
