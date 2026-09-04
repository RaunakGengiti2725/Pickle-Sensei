\set QUIET on
-- P3 candidates: RLS-blind privileges, hosted function defaults, malformed uuid in apply_synced_shot
select string_agg(table_name || ':' || privilege_type, ' ' order by table_name, privilege_type) as rls_blind
from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES') \gset
\echo RESULT|M1-rls-blind-privs-authenticated|INFO|:rls_blind
select count(*) as anon_exec_fns from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE') \gset
select string_agg(p.proname, ',') as anon_exec_list from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE') \gset
\echo RESULT|M2-anon-executable-functions|INFO|count=:anon_exec_fns list=:'anon_exec_list'
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000aa', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'g-alice', '00000000-0000-4000-8000-0000000000aa', '{"sub":"g-alice"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';
do $$
declare v text;
begin
  begin
    v := public.apply_synced_shot('{"id":"not-a-uuid","analysisPermitId":"also-bad","resultKind":"scored"}'::jsonb);
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  raise notice 'RESULT|M3-malformed-uuid-payload|INFO|apply_synced_shot=% (raises instead of returning shot.* code; edge fn maps thrown errors to 5xx)', v;
end $$;
rollback;
