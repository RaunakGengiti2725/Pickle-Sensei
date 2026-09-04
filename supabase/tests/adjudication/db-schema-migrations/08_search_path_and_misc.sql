-- Candidates: client-executable functions without SET search_path = '';
-- pg_cron sweep definitions (static only — pg_cron is unavailable locally);
-- free_rating_ledger client exposure; sequences/other objects reachable by anon.
\echo '== 08a: public functions executable by anon/authenticated and their search_path setting =='
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       p.prosecdef as definer,
       coalesce((select string_agg(c, ' ') from unnest(p.proconfig) c where c like 'search_path=%'), '<none>') as search_path
from pg_proc p
where p.pronamespace = 'public'::regnamespace
order by auth_exec desc, p.proname;

\echo '== 08b: anything anon can still touch in public =='
select table_name, string_agg(privilege_type, ',') from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon' group by table_name;
select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute');

\echo '== 08c: free_rating_ledger exposure =='
select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'free_rating_ledger';
select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.free_rating_ledger'::regclass;
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select count(*) from public.free_rating_ledger;
rollback;

\echo '== 08d: pg_cron schedule statements as written in the migrations (static; extension absent locally) =='
\! grep -n "cron.schedule" /migrations/*.sql
