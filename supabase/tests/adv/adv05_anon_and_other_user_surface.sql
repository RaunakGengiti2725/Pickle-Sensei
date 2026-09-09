-- ADV-05 — anonymous and other-account surface of every table/RPC the edge
-- function touches since the handoff (offline devices/grants/ledger,
-- settlement receipts, permit tombstones, permits, shots, sessions,
-- profiles, consent, evaluation, feedback, deletion feedback).
--
-- Expected: anon holds no EXECUTE on any public/api_private function and no
-- privilege on any public table; with a live API key but NO JWT subject every
-- client RPC answers auth.required / raises and every table reads empty;
-- another signed-in account (own live session, own API key) sees zero rows
-- of the owner's data on every table and cannot write rows naming the owner.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000005a1','kim@example.com','{"full_name":"Kim"}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000005b1','lee@example.com','{"full_name":"Lee"}','{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv05-kim','00000000-0000-4000-8000-0000000005a1','{"sub":"adv05-kim"}'),
 ('google','adv05-lee','00000000-0000-4000-8000-0000000005b1','{"sub":"adv05-lee"}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000005a2','00000000-0000-4000-8000-0000000005a1'),
 ('00000000-0000-4000-8000-0000000005b2','00000000-0000-4000-8000-0000000005b1');

-- 0. catalog: anon executes nothing, owns nothing
do $$
declare bad text[] := '{}';
begin
  select coalesce(array_agg(p.oid::regprocedure::text order by 1), '{}') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'api_private')
    and has_function_privilege('anon', p.oid, 'execute');
  if cardinality(bad) > 0 then
    raise exception 'ADV-05 BREAK: anon can execute %', bad;
  end if;
  select coalesce(array_agg(c.oid::regclass::text order by 1), '{}') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'api_private') and c.relkind in ('r', 'v', 'p')
    and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
      or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'));
  if cardinality(bad) > 0 then
    raise exception 'ADV-05 BREAK: anon holds table privileges on %', bad;
  end if;
  -- api_private: anon never reaches it; authenticated only sees the two policy predicates, no tables
  if has_schema_privilege('anon', 'api_private', 'usage') then
    raise exception 'ADV-05 BREAK: anon has USAGE on api_private';
  end if;
  select coalesce(array_agg(c.oid::regclass::text order by 1), '{}') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'api_private' and c.relkind in ('r', 'v', 'p')
    and (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
      or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'));
  if cardinality(bad) > 0 then
    raise exception 'ADV-05 BREAK: authenticated holds privileges on api_private tables %', bad;
  end if;
  select coalesce(array_agg(p.oid::regprocedure::text order by 1), '{}') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_private' and has_function_privilege('authenticated', p.oid, 'execute')
    and p.proname not in ('is_api_request', 'is_active_session');
  if cardinality(bad) > 0 then
    raise exception 'ADV-05 BREAK: authenticated can execute api_private internals %', bad;
  end if;
end $$;

-- 1. owner state to be protected
do $$ begin perform set_config('request.headers',
  jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000005a1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000005a2"}';
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('adv05-k1');
  perform set_config('adv05.permit_id', r.permit_id::text, true);
  select * into r from public.register_offline_device('adv05-inst', 'production', true);
  select * into r from public.issue_offline_grant('adv05-inst', 1);
  if r.result <> 'accepted' then raise exception 'ADV-05 precondition: grant refused (%)', r.result; end if;
  perform set_config('adv05.ticket_id', (r.ticket_ids)[1]::text, true);
  insert into public.sessions (id, user_id, started_at) values ('00000000-0000-4000-8000-0000000005d1', '00000000-0000-4000-8000-0000000005a1', now());
end $$;

-- 2. authenticated role with the API key but no subject (a token the gateway did not resolve)
reset request.jwt.claim.sub;
reset request.jwt.claims;
do $$
declare bad text[] := '{}'; t text; n bigint; v text; r record;
begin
  foreach t in array array['public.profiles','public.sessions','public.shots','public.analysis_permits',
    'public.settlement_receipts','public.analysis_permit_tombstones','public.offline_devices','public.offline_grants',
    'public.offline_allocation_ledger','public.consent_records','public.evaluation_trials','public.analysis_feedback',
    'public.account_deletion_feedback'] loop
    begin
      execute format('select count(*) from %s', t) into n;
      if n <> 0 then bad := bad || (t || '=' || n); end if;
    exception when insufficient_privilege then null; -- no SELECT at all is the stricter answer
    end;
  end loop;
  v := public.apply_synced_shot('{}'::jsonb);
  if v <> 'auth.required' then bad := bad || ('apply_synced_shot=' || v); end if;
  select * into r from public.reserve_analysis_permit('adv05-anon');
  if r.result <> 'auth.required' then bad := bad || ('reserve=' || r.result); end if;
  begin
    select * into r from public.issue_offline_grant('adv05-inst', 1);
    bad := bad || ('issue_offline_grant=' || r.result);
  exception when insufficient_privilege then null;
  end;
  begin
    select * into r from public.register_offline_device('adv05-anon', 'production', true);
    bad := bad || ('register_offline_device=' || r.result);
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.consume_offline_ticket(gen_random_uuid(), '{}'::jsonb);
    bad := bad || ('consume_offline_ticket=' || v);
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.release_offline_ticket(gen_random_uuid(), 'unused_ticket_returned');
    bad := bad || ('release_offline_ticket=' || v);
  exception when insufficient_privilege then null;
  end;
  if cardinality(bad) > 0 then raise exception 'ADV-05 BREAK (no subject): %', bad; end if;
end $$;

-- 3. another live account
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000005b1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000005b2"}';
do $$
declare
  kim uuid := '00000000-0000-4000-8000-0000000005a1';
  bad text[] := '{}'; t text; n bigint; v text; r record;
begin
  foreach t in array array['public.profiles','public.sessions','public.shots','public.analysis_permits',
    'public.settlement_receipts','public.analysis_permit_tombstones','public.offline_devices','public.offline_grants',
    'public.offline_allocation_ledger','public.consent_records','public.evaluation_trials','public.analysis_feedback',
    'public.account_deletion_feedback'] loop
    begin
      execute format('select count(*) from %s where %s = $1', t,
        case when t = 'public.profiles' then 'id' else 'user_id' end) into n using kim;
      if n <> 0 then bad := bad || (t || '=' || n); end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  -- writes that name the owner
  begin
    insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), kim, now());
    bad := bad || 'insert_session_for_owner';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sessions set ended_at = now() where id = '00000000-0000-4000-8000-0000000005d1';
    if found then bad := bad || 'update_owner_session'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set status = 'released', outcome = 'abandoned'
      where id = current_setting('adv05.permit_id')::uuid;
    if found then bad := bad || 'update_owner_permit'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.consent_records (user_id, scope, action, consent_version, source)
      values (kim, 'model_training', 'grant', 'v1', 'mobile_settings');
    bad := bad || 'insert_consent_for_owner';
  exception when insufficient_privilege then null;
  end;
  -- the owner's permit through the RPC
  v := public.apply_synced_shot(jsonb_build_object('id', gen_random_uuid(), 'analysisPermitId', current_setting('adv05.permit_id')::uuid,
        'resultKind', 'low_confidence', 'shotType', 'drive', 'capturedAt', '2026-09-08T10:00:00Z',
        'startMs', 0, 'endMs', 1000, 'confidence', 0.2,
        'versionVector', jsonb_build_object('appVersion', '1.0.0', 'modelBundleVersion', 'b', 'poseModelVersion', 'p',
          'paddleModelVersion', 'p', 'strokeDetectorVersion', 's', 'phaseModelVersion', 'p', 'scoringModelVersion', 's',
          'shotConfigVersion', 'c')));
  if v <> 'access.permit_not_found' then bad := bad || ('sync_owner_permit=' || v); end if;
  -- the owner's device / tickets through the offline RPCs
  select * into r from public.issue_offline_grant('adv05-inst', 1);
  if r.result <> 'offline.device_not_registered' then bad := bad || ('grant_on_owner_device=' || r.result); end if;
  begin
    v := public.consume_offline_ticket(current_setting('adv05.ticket_id')::uuid,
      jsonb_build_object('id', gen_random_uuid(), 'resultKind', 'scored'));
    if v <> 'offline.ticket_not_found' then bad := bad || ('consume_owner_ticket=' || v); end if;
    v := public.release_offline_ticket(current_setting('adv05.ticket_id')::uuid, 'unused_ticket_returned');
    if v <> 'offline.ticket_not_found' then bad := bad || ('release_owner_ticket=' || v); end if;
  exception when insufficient_privilege then null;
  end;
  if cardinality(bad) > 0 then raise exception 'ADV-05 BREAK (other account): %', bad; end if;
  raise notice 'ADV-05: PASS';
end $$;
rollback;
