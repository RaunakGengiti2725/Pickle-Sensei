-- P08 — Every function reachable by a client role pins search_path, and every
-- SECURITY DEFINER function pins search_path (the documented Supabase
-- hardening the other RPCs follow: 20260831000000_scale_and_security.sql and
-- 20260902150000_free_rating_identity_ledger.sql all carry set search_path='').
--
-- Suspect: complete_onboarding() (20260829000000_google_auth_bootstrap.sql:
-- 155-165) is granted to authenticated with no search_path, and
-- player_rank_tier(numeric) / set_updated_at() are likewise unpinned.
-- SECURITY INVOKER + unqualified `public.` references make this low impact
-- (the caller cannot create objects in pg_catalog/public), so this pins
-- consistency rather than an exploit.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

create temp view unpinned as
select p.proname,
       p.prosecdef,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

select pg_temp.check('no SECURITY DEFINER function in public lacks search_path → ' ||
  coalesce((select string_agg(proname, ',') from unpinned where prosecdef), 'none'),
  not exists (select 1 from unpinned where prosecdef));

select pg_temp.check('no client-executable function in public lacks search_path → ' ||
  coalesce((select string_agg(proname, ',') from unpinned where auth_exec or anon_exec), 'none'),
  not exists (select 1 from unpinned where auth_exec or anon_exec));

-- The four hot RPCs are INVOKER + pinned (documented invariant; must hold).
select pg_temp.check('access_state/apply_synced_shot/reserve_analysis_permit/lifetime_scored_count are INVOKER with an empty search_path',
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('access_state', 'apply_synced_shot', 'reserve_analysis_permit', 'lifetime_scored_count')
     and not p.prosecdef and 'search_path=""' = any (p.proconfig)) = 4);

-- Privileged bodies are not client-executable (documented invariant; must hold).
select pg_temp.check('recompute_player_rank / handle_* / record_scored_shot_in_ledger / identity hash not executable by authenticated',
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and (p.proname like 'handle\_%' or p.proname in ('recompute_player_rank', 'record_scored_shot_in_ledger', 'free_rating_identity_hash'))
                and has_function_privilege('authenticated', p.oid, 'execute')));

select pg_temp.finish();
rollback;
