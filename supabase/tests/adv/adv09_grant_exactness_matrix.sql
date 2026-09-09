-- ADV-09 — grant exactness, read straight from the catalog of the built
-- database (fresh AND every upgrade history the harness builds):
--   anon holds nothing; every client-reachable table has RLS + the restrictive
--   api_requests_only policy + owner-scoped permissive policies only; the
--   client's UPDATE surface is column-level and exactly the edge function's
--   writes; no client DELETE except user_saved_drills; no TRUNCATE / TRIGGER /
--   REFERENCES anywhere for clients; service-only tables have no client DML;
--   the SECURITY DEFINER functions clients may execute are exactly the audited
--   readers/RPCs and every client-callable function pins search_path; no
--   client-callable function or table lives outside public.
-- Live tail: cross-account child rows (a phase/checkpoint on another
-- account's shot, a shot in another account's session) under an intact
-- session.
\set ON_ERROR_STOP on
begin;

create temp table adv09_bad (item text);

-- 1. anon: nothing at all
insert into adv09_bad
select 'anon_table:' || table_schema || '.' || table_name || ':' || privilege_type
from information_schema.role_table_grants where grantee = 'anon';
insert into adv09_bad
select 'anon_column:' || table_schema || '.' || table_name || '.' || column_name || ':' || privilege_type
from information_schema.column_privileges where grantee = 'anon';
insert into adv09_bad
select 'anon_function:' || n.nspname || '.' || p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'api_private') and has_function_privilege('anon', p.oid, 'EXECUTE');
insert into adv09_bad
select 'anon_schema_usage:' || nspname from pg_namespace
where nspname in ('api_private') and has_schema_privilege('anon', nspname, 'USAGE');
insert into adv09_bad
select 'anon_sequence:' || sequence_schema || '.' || sequence_name
from information_schema.sequences
where sequence_schema in ('public', 'api_private')
  and has_sequence_privilege('anon', quote_ident(sequence_schema) || '.' || quote_ident(sequence_name), 'USAGE');

-- 2. every table a client can touch: public schema only, RLS on, api_requests_only restrictive, owner-scoped permissive policies
insert into adv09_bad
select distinct 'client_table_outside_public:' || table_schema || '.' || table_name
from information_schema.role_table_grants where grantee = 'authenticated' and table_schema <> 'public';
with client_tables as (
  select distinct table_name from information_schema.role_table_grants
  where grantee = 'authenticated' and table_schema = 'public'
  union
  select distinct table_name from information_schema.column_privileges
  where grantee = 'authenticated' and table_schema = 'public'
)
insert into adv09_bad
select 'rls_off:' || t.table_name from client_tables t
join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
where c.relkind in ('r', 'p') and not c.relrowsecurity
union all
select 'view_not_security_invoker:' || t.table_name from client_tables t
join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
where c.relkind = 'v' and not coalesce('security_invoker=true' = any(c.reloptions), false)
union all
select 'no_api_requests_only:' || t.table_name from client_tables t
join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace
where c.relkind in ('r', 'p') and not exists (
  select 1 from pg_policies p
  where p.schemaname = 'public' and p.tablename = t.table_name
    and p.policyname = 'api_requests_only' and p.permissive = 'RESTRICTIVE'
    and p.roles @> array['authenticated']::name[]
    and p.qual ilike '%api_private.is_api_request()%'
    and (p.cmd in ('SELECT') or p.with_check ilike '%api_private.is_api_request()%'))
union all
select 'policy_not_owner_scoped:' || p.tablename || '.' || p.policyname
from pg_policies p
where p.schemaname = 'public' and p.permissive = 'PERMISSIVE'
  and (p.roles @> array['authenticated']::name[] or p.roles @> array['public']::name[])
  and coalesce(p.qual, '') not ilike '%auth.uid()%' and coalesce(p.with_check, '') not ilike '%auth.uid()%'
union all
select 'policy_for_anon:' || p.tablename || '.' || p.policyname
from pg_policies p where p.schemaname = 'public' and (p.roles @> array['anon']::name[] or p.roles @> array['public']::name[]);

-- 3. exact client DML surface
insert into adv09_bad
select 'client_table_update:' || table_name from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'UPDATE';
insert into adv09_bad
select 'client_table_' || lower(privilege_type) || ':' || table_name from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES');
insert into adv09_bad
select 'client_delete:' || table_name from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'DELETE'
  and table_name <> 'user_saved_drills';
-- column UPDATE grants == the edge function's writes (20260831160000 + 20260906 profile/account rows)
with expected(col) as (values
  ('sessions.ended_at'),
  ('analysis_permits.status'), ('analysis_permits.outcome'),
  ('account_deletion_requests.user_id'), ('account_deletion_requests.challenge'),
  ('account_deletion_requests.created_at'), ('account_deletion_requests.expires_at'),
  ('profiles.first_name'), ('profiles.gender'), ('profiles.handedness'), ('profiles.skill_level'),
  ('profiles.primary_goal'), ('profiles.biggest_problem'), ('profiles.focus_checkpoint'),
  ('profiles.onboarding_state'), ('profiles.provider')),
actual as (
  select table_name || '.' || column_name as col from information_schema.column_privileges
  where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'UPDATE'
    and not exists (select 1 from information_schema.role_table_grants g
      where g.grantee = 'authenticated' and g.table_schema = 'public'
        and g.table_name = column_privileges.table_name and g.privilege_type = 'UPDATE'))
insert into adv09_bad
select 'unexpected_column_update:' || col from actual where col not in (select col from expected)
union all
select 'missing_column_update:' || col from expected where col not in (select col from actual);
-- column INSERT grants: analysis_permits only (reserve_analysis_permit runs as the caller)
insert into adv09_bad
select 'unexpected_column_insert:' || table_name || '.' || column_name from information_schema.column_privileges
where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'INSERT'
  and not exists (select 1 from information_schema.role_table_grants g
      where g.grantee = 'authenticated' and g.table_schema = 'public'
        and g.table_name = column_privileges.table_name and g.privilege_type = 'INSERT')
  and (table_name, column_name) not in (('analysis_permits', 'user_id'), ('analysis_permits', 'idempotency_key'),
    ('analysis_permits', 'status'), ('analysis_permits', 'outcome'));
-- service-only / append-only tables: client DML forbidden
insert into adv09_bad
select 'service_only_client_dml:' || table_name || ':' || privilege_type from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public' and privilege_type <> 'SELECT'
  and table_name in ('billing_entitlements', 'webhook_events', 'free_rating_ledger', 'settlement_receipts',
    'analysis_permit_tombstones', 'account_external_credentials', 'offline_allocation_ledger',
    'offline_allocation_identity_links', 'offline_devices', 'offline_grants', 'captures',
    'player_rank_state', 'player_technique_rating', 'practice_days', 'progress_daily',
    'shot_measurements');
insert into adv09_bad
select 'hidden_table_client_read:' || table_name from information_schema.role_table_grants
where grantee = 'authenticated' and table_schema = 'public'
  and table_name in ('webhook_events', 'free_rating_ledger', 'analysis_permit_tombstones',
    'account_external_credentials', 'offline_allocation_identity_links');
insert into adv09_bad
select 'client_sequence:' || sequence_schema || '.' || sequence_name
from information_schema.sequences
where sequence_schema in ('public', 'api_private')
  and has_sequence_privilege('authenticated', quote_ident(sequence_schema) || '.' || quote_ident(sequence_name), 'USAGE');

-- 4. functions: definer allow-list, search_path pinned, no client functions outside public (except the two policy predicates)
with callable as (
  select n.nspname, p.proname, p.oid, p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid) args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'api_private', 'extensions', 'auth')
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and not (n.nspname = 'auth' and p.proname in ('uid', 'jwt', 'role', 'email'))
)
insert into adv09_bad
select 'client_definer_not_allowlisted:' || nspname || '.' || proname from callable
where prosecdef and nspname || '.' || proname not in (
  'api_private.is_api_request', 'api_private.is_active_session',
  'public.identity_scored_count', 'public.offline_hold_count', 'public.permit_tombstoned',
  'public.register_offline_device', 'public.issue_offline_grant',
  'public.consume_offline_ticket', 'public.release_offline_ticket')
union all
select 'client_function_no_search_path:' || nspname || '.' || proname from callable
where nspname in ('public', 'api_private')
  and not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')
union all
select 'client_function_outside_public:' || nspname || '.' || proname from callable
where nspname not in ('public', 'auth') and nspname || '.' || proname not in ('api_private.is_api_request', 'api_private.is_active_session')
union all
select 'client_internal_helper:' || nspname || '.' || proname from callable
where nspname || '.' || proname in ('public.get_api_request_key', 'public.free_rating_identity_hash',
  'public.enforce_scored_shot_permit', 'public.record_scored_shot_in_ledger', 'public.inherit_free_rating_ledger',
  'public.guard_analysis_permit_lifecycle', 'public.guard_analysis_permit_delete', 'public.guard_analysis_permit_resurrection',
  'public.guard_settlement_receipt_lifecycle', 'public.record_settlement_receipt', 'public.guard_offline_grant',
  'public.guard_offline_identity_link', 'public.guard_offline_ledger_append_only', 'public.guard_offline_ledger_event',
  'public.inherit_offline_allocation_holds', 'public.handle_new_user', 'public.recompute_player_rank',
  'public.read_analysis_release_policy', 'public.billing_transfer_recovery', 'public.enqueue_billing_transfer',
  'public.persist_billing_verdict', 'public.begin_billing_verification', 'public.complete_billing_webhook',
  'public.claim_billing_webhook_delivery', 'public.release_billing_webhook_delivery', 'public.store_account_apple_credential',
  'public.begin_account_deletion_operation', 'public.claim_account_deletion_work', 'public.checkpoint_account_deletion_operation',
  'public.confirm_account_deletion_operation', 'public.fail_account_deletion_operation', 'public.purge_account_deletion_operations',
  'public.read_account_deletion_receipt', 'public.read_account_deletion_status', 'public.set_account_deletion_auth_intent',
  'public.account_deletion_allows_apple_bootstrap');
-- 5. service role never gets the client-facing session-gated RPCs (they are auth.uid()-scoped)
insert into adv09_bad
select 'service_role_client_rpc:' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('consume_offline_ticket', 'release_offline_ticket', 'issue_offline_grant', 'register_offline_device')
  and has_function_privilege('service_role', p.oid, 'EXECUTE');
-- 6. clients cannot disable or create triggers, and every client-reachable table with a guard trigger keeps it enabled
insert into adv09_bad
select 'trigger_disabled:' || c.relname || '.' || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgenabled = 'D';

do $$
declare bad text[];
begin
  select coalesce(array_agg(item order by item), '{}') into bad from adv09_bad;
  raise notice 'ADV-09 static findings: %', bad;
  perform set_config('adv09.bad', bad::text, true);
end $$;

-- live: cross-account child rows
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000009a1','quinn@example.com','{}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000009b1','rae@example.com','{}','{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv09-quinn','00000000-0000-4000-8000-0000000009a1','{}'),
 ('apple','adv09-rae','00000000-0000-4000-8000-0000000009b1','{}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000009a2','00000000-0000-4000-8000-0000000009a1'),
 ('00000000-0000-4000-8000-0000000009b2','00000000-0000-4000-8000-0000000009b1');
insert into public.sessions (id, user_id, started_at) values
 ('00000000-0000-4000-8000-0000000009a3','00000000-0000-4000-8000-0000000009a1', now());
insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms, result_kind, analysis_confidence, overall_score,
  app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
 values ('00000000-0000-4000-8000-0000000009a4','00000000-0000-4000-8000-0000000009a1','00000000-0000-4000-8000-0000000009a3',
  'drive', now(), 0, 1000, 'scored', 0.9, 7.2, '1.0.0', 'b', 'p', 'p', 's', 'p', 's', 'c');

do $$ begin perform set_config('request.headers',
  jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000009b1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000009b2"}';
do $$
declare bad text[] := current_setting('adv09.bad')::text[];
begin
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, end_ms, representative_ms, confidence)
      values ('00000000-0000-4000-8000-0000000009a4', '00000000-0000-4000-8000-0000000009b1', 'backswing', 0, 10, 5, 0.9);
    bad := array_append(bad, 'phase_on_other_users_shot');
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, applicable, band, direction, confidence, severity, score)
      values ('00000000-0000-4000-8000-0000000009a4', '00000000-0000-4000-8000-0000000009b1', 'paddle_prep', true, 'good', 'neutral', 0.9, 0.1, 7);
    bad := array_append(bad, 'checkpoint_on_other_users_shot');
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms, result_kind, analysis_confidence,
        app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
      values (gen_random_uuid(), '00000000-0000-4000-8000-0000000009b1', '00000000-0000-4000-8000-0000000009a3',
        'drive', now(), 0, 1000, 'low_confidence', 0.2, '1.0.0', 'b', 'p', 'p', 's', 'p', 's', 'c');
    bad := array_append(bad, 'shot_in_other_users_session');
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    update public.sessions set ended_at = now() where id = '00000000-0000-4000-8000-0000000009a3';
    if found then bad := array_append(bad, 'ended_other_users_session'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set first_name = 'pwned' where id = '00000000-0000-4000-8000-0000000009a1';
    if found then bad := array_append(bad, 'renamed_other_users_profile'); end if;
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.shots where user_id = '00000000-0000-4000-8000-0000000009a1')
     or exists (select 1 from public.sessions where user_id = '00000000-0000-4000-8000-0000000009a1')
     or exists (select 1 from public.profiles where id = '00000000-0000-4000-8000-0000000009a1') then
    bad := array_append(bad, 'other_users_rows_visible');
  end if;
  raise notice 'ADV-09 findings: %', bad;
  if cardinality(bad) > 0 then raise exception 'ADV-09 BREAK: %', bad; end if;
  raise notice 'ADV-09: PASS';
end $$;
rollback;
