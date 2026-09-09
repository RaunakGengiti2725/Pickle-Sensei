\set ON_ERROR_STOP on
\set QUIET on

begin;

create temporary table w08_assertions (name text primary key);
create temporary table w08_results (name text primary key, data jsonb not null);
grant select, insert, update on w08_results to service_role;

create function pg_temp.w08_id(p_number integer) returns uuid
language sql immutable as $$
  select ('08080000-0000-4000-8000-' || lpad(p_number::text, 12, '0'))::uuid
$$;
create function pg_temp.w08_challenge(p_owner integer, p_challenge integer) returns bytea
language sql immutable as $$
  select sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/' || pg_temp.w08_id(p_owner)::text
    || '/' || pg_temp.w08_id(p_challenge)::text, 'UTF8'))
$$;
create function pg_temp.w08_cap(p_number integer) returns bytea
language sql immutable as $$ select sha256(convert_to('test-capability-hash-' || p_number, 'UTF8')) $$;
create function pg_temp.w08_assert(p_condition boolean, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_condition is distinct from true then raise exception 'W08 failure: %', p_name; end if;
  insert into pg_temp.w08_assertions values (p_name);
end;
$$;
create function pg_temp.w08_throws(p_sql text, p_state text, p_name text) returns void
language plpgsql security invoker set search_path = '' as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform pg_temp.w08_assert(v_state = p_state, p_name);
    return;
  end;
  raise exception 'W08 expected denial: %', p_name;
end;
$$;
grant execute on function pg_temp.w08_id(integer), pg_temp.w08_challenge(integer, integer),
  pg_temp.w08_cap(integer), pg_temp.w08_assert(boolean, text), pg_temp.w08_throws(text, text, text)
  to anon, authenticated, service_role;

insert into auth.users (id, email, raw_app_meta_data)
  select pg_temp.w08_id(n), 'w08-test-' || n || '@example.test',
    jsonb_build_object('provider', case when n in (1, 6) then 'apple' else 'google' end)
  from (select n from generate_series(1, 8) n union all select 10 union all select 11) s;
insert into auth.identities (provider, provider_id, user_id)
  select case when n in (1, 6) then 'apple' else 'google' end,
    'w08-test-identity-' || n, pg_temp.w08_id(n)
  from (select n from generate_series(1, 8) n union all select 10 union all select 11) s;
insert into auth.sessions (id, user_id) values (pg_temp.w08_id(9001), pg_temp.w08_id(1));
insert into public.shots (
  id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
) select pg_temp.w08_id(8000 + n), pg_temp.w08_id(1), 'drive', now(), 0, 1000, 5, 1, 'scored',
  'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1' from generate_series(1, 2) n;
insert into public.account_deletion_feedback (user_id, reason, provider)
  values (pg_temp.w08_id(1), 'not_using', 'apple');
create temporary table w08_ledger_before as table public.free_rating_ledger;

select pg_temp.w08_assert((select relrowsecurity from pg_class
  where oid = 'api_private.account_deletion_operations'::regclass), 'operations RLS enabled');
select pg_temp.w08_assert(not exists (select 1 from pg_policy
  where polrelid = 'api_private.account_deletion_operations'::regclass), 'operations have no client policies');
select pg_temp.w08_assert(not exists (select 1 from pg_constraint
  where conrelid = 'api_private.account_deletion_operations'::regclass and contype = 'f'), 'operations have no cascading foreign keys');
select pg_temp.w08_assert(not exists (select 1 from information_schema.columns
  where table_schema = 'api_private' and table_name = 'account_deletion_operations'
    and column_name in ('email', 'profile', 'provider_id', 'survey', 'challenge', 'status_capability', 'apple_refresh_token_encrypted')),
  'durable operations contain no account payloads or raw credentials');

do $$
declare v_function record; v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    perform pg_temp.w08_assert(not has_table_privilege(v_role, 'api_private.account_deletion_operations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'no direct operations grants for ' || v_role);
    perform pg_temp.w08_assert(not has_any_column_privilege(v_role, 'api_private.account_deletion_operations',
      'SELECT,INSERT,UPDATE,REFERENCES'), 'no operation column privilege bypass for ' || v_role);
    perform pg_temp.w08_assert(not has_any_column_privilege(v_role, 'public.account_external_credentials',
      'INSERT,UPDATE') and not has_table_privilege(v_role, 'public.account_external_credentials', 'DELETE'),
      'no direct credential write privilege bypass for ' || v_role);
  end loop;
  perform pg_temp.w08_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'begin_account_deletion_operation', 'confirm_account_deletion_operation', 'claim_account_deletion_work',
      'checkpoint_account_deletion_operation', 'set_account_deletion_auth_intent', 'fail_account_deletion_operation',
      'read_account_deletion_status', 'read_account_deletion_receipt', 'account_deletion_allows_apple_bootstrap',
      'store_account_apple_credential', 'purge_account_deletion_operations', 'certify_account_deletion_completion')) = 12,
    'all twelve service deletion RPCs are present for ACL inspection');
  perform pg_temp.w08_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'certify_account_deletion_completion'
      and pg_get_function_identity_arguments(p.oid) = 'p_owner_id uuid, p_operation_id uuid, p_lease_token uuid') = 1,
    'certification RPC has exactly the owner, operation and lease binding');
  for v_function in
    select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in (
        'begin_account_deletion_operation', 'confirm_account_deletion_operation', 'claim_account_deletion_work',
        'checkpoint_account_deletion_operation', 'set_account_deletion_auth_intent', 'fail_account_deletion_operation',
        'read_account_deletion_status', 'read_account_deletion_receipt', 'account_deletion_allows_apple_bootstrap',
        'store_account_apple_credential', 'purge_account_deletion_operations', 'certify_account_deletion_completion'
      )
  loop
    perform pg_temp.w08_assert(v_function.prosecdef
      and v_function.proconfig @> array['search_path=""']
      and has_function_privilege('service_role', v_function.oid, 'EXECUTE')
      and not has_function_privilege('anon', v_function.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', v_function.oid, 'EXECUTE'),
      'hardened service RPC ' || v_function.proname);
    perform pg_temp.w08_assert(not exists (select 1 from pg_proc p,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = v_function.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
      'no PUBLIC execute ' || v_function.proname);
  end loop;
  for v_function in
    select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api_private' and p.proname in (
        'acquire_account_deletion_lease', 'lock_account_deletion_lease', 'lock_account_deletion_certification',
        'record_account_deletion_auth_absence', 'account_deletion_view'
      )
  loop
    perform pg_temp.w08_assert(v_function.proconfig @> array['search_path=""']
      and not has_function_privilege('service_role', v_function.oid, 'EXECUTE')
      and not has_function_privilege('anon', v_function.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', v_function.oid, 'EXECUTE')
      and not exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = v_function.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
      'private deletion helper is unreachable ' || v_function.proname);
  end loop;
  perform pg_temp.w08_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_private' and p.proname = 'lock_account_deletion_certification') = 1,
    'certification lock helper exists exactly once');
end;
$$;

-- SET ROLE alone retains postgres as session_user and would incorrectly let
-- this test escalate back to service_role. Use a real unprivileged SQL session.
set session authorization authenticated;
set local request.jwt.claim.role = 'service_role';
select pg_temp.w08_throws('select * from api_private.account_deletion_operations', '42501', 'owner cannot enumerate operations');
select pg_temp.w08_throws('select public.begin_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1001), pg_temp.w08_challenge(1,2001), pg_temp.w08_cap(1))', '42501', 'forged service JWT claim cannot request work');
select pg_temp.w08_throws('select public.confirm_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_challenge(1,2001))', '42501', 'user cannot accept their own deletion confirmation by RPC');
select pg_temp.w08_throws('select public.read_account_deletion_status(pg_temp.w08_id(1001), pg_temp.w08_cap(1))', '42501', 'user cannot bypass Edge status capability validation');
select pg_temp.w08_throws('select api_private.record_account_deletion_auth_absence()', '42501', 'receipt trigger is not callable');
select pg_temp.w08_throws('select public.certify_account_deletion_completion(pg_temp.w08_id(1), pg_temp.w08_id(1001), gen_random_uuid())', '42501', 'forged service JWT claim cannot certify a receipt');
select pg_temp.w08_throws('set local role service_role', '42501', 'SQL role cannot be forged');
reset session authorization;
set local role anon;
select pg_temp.w08_throws('select public.read_account_deletion_receipt(pg_temp.w08_id(1), pg_temp.w08_id(1001))', '42501', 'anon cannot enumerate owner receipts');
select pg_temp.w08_throws('select public.certify_account_deletion_completion(pg_temp.w08_id(1), pg_temp.w08_id(1001), gen_random_uuid())', '42501', 'anon cannot certify a receipt');
set local role service_role;
select pg_temp.w08_throws('update api_private.account_deletion_operations set phase = ''completed''', '42501', 'service cannot forge a receipt with direct DML');
select pg_temp.w08_throws('update api_private.account_deletion_operations set completed_at = clock_timestamp()', '42501', 'service cannot forge a completion timestamp with direct DML');
select pg_temp.w08_throws('select api_private.acquire_account_deletion_lease(pg_temp.w08_id(1), pg_temp.w08_id(1001))', '42501', 'private lease helper has no service execute grant');
select pg_temp.w08_throws('select api_private.lock_account_deletion_certification(pg_temp.w08_id(1), pg_temp.w08_id(1001), gen_random_uuid())', '42501', 'private certification lock helper has no service execute grant');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(1), pg_temp.w08_id(1001), gen_random_uuid())->>'outcome' = 'stale_lease', 'certification of an unknown operation invents nothing');
select pg_temp.w08_throws('insert into public.account_external_credentials (user_id) values (pg_temp.w08_id(1))', '42501', 'service cannot bypass credential fencing with INSERT');
select pg_temp.w08_throws('update public.account_external_credentials set apple_revoked_at = null', '42501', 'service cannot bypass credential fencing with UPDATE');

select pg_temp.w08_assert(public.store_account_apple_credential(pg_temp.w08_id(1), 'v1.abcdefghijklmnop.initialEncryptedToken')->>'outcome' = 'stored', 'bootstrap stores existing-format ciphertext before confirmation');
select pg_temp.w08_assert(public.begin_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1001), pg_temp.w08_challenge(1,2001), pg_temp.w08_cap(1))->>'outcome' = 'requested', 'request creates an operation without confirming');
select pg_temp.w08_assert(public.confirm_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_challenge(1,2001), pg_temp.w08_id(1001))->>'outcome' = 'too_fast', 'database enforces three second first-confirm age');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(1), pg_temp.w08_id(1001))->>'outcome' = 'invalid', 'worker cannot accept an unconfirmed request');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1001), pg_temp.w08_cap(1)) = '{"state":"pending","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'pending status is minimal and read-only');
select pg_temp.w08_assert(public.begin_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), pg_temp.w08_challenge(1,2002), pg_temp.w08_cap(2))->>'outcome' = 'requested', 'a lost request response may safely request again');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1001), pg_temp.w08_cap(1))->>'state' = 'superseded', 'replaced unconfirmed operation is permanently superseded');
select pg_temp.w08_assert(public.confirm_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_challenge(1,2001))->>'outcome' = 'invalid', 'old challenge cannot delete after replacement');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1002), pg_temp.w08_cap(1)) is null, 'capability hash is bound to its own operation');
select pg_temp.w08_assert(public.confirm_account_deletion_operation(pg_temp.w08_id(2), pg_temp.w08_challenge(1,2002), pg_temp.w08_id(1002))->>'outcome' = 'invalid', 'operation owner and challenge hash are jointly bound');
select pg_temp.w08_assert(public.confirm_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_challenge(2,2002), pg_temp.w08_id(1002))->>'outcome' = 'invalid', 'same challenge for another owner has no authority');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where id = pg_temp.w08_id(1002);
select pg_temp.w08_assert((select confirmed_at is null and attempts = 0 from api_private.account_deletion_operations
  where id = pg_temp.w08_id(1002)), 'request and denied confirmation cause no worker side effects');
set local role service_role;
insert into w08_results values ('first', public.confirm_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_challenge(1,2002), pg_temp.w08_id(1002)));
select pg_temp.w08_assert((select data->>'outcome' = 'claimed' and data->>'appleAction' = 'revoke' from w08_results where name = 'first'), 'accepted confirm obtains one lease and the existing Apple ciphertext');
select pg_temp.w08_assert(public.confirm_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_challenge(1,2002))->>'outcome' = 'busy', 'duplicate legacy confirm cannot claim a second lease');
select pg_temp.w08_assert(public.begin_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1009), pg_temp.w08_challenge(1,2009), pg_temp.w08_cap(9))->>'outcome' = 'confirmation_in_progress', 'new request cannot supersede confirmed work');
select pg_temp.w08_assert(not public.account_deletion_allows_apple_bootstrap(pg_temp.w08_id(1)), 'bootstrap preflight refuses confirmed cleanup');
select pg_temp.w08_assert(public.store_account_apple_credential(pg_temp.w08_id(1), 'v1.abcdefghijklmnop.replacementEncryptedToken')->>'outcome' = 'confirmation_in_progress', 'atomic bootstrap store cannot replace a confirmed credential');
select pg_temp.w08_assert((select apple_refresh_token_encrypted = 'v1.abcdefghijklmnop.initialEncryptedToken' from public.account_external_credentials where user_id = pg_temp.w08_id(1)), 'fenced bootstrap leaves the original revocation credential unchanged');
select pg_temp.w08_assert(public.checkpoint_account_deletion_operation(pg_temp.w08_id(2), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='first'), 'apple', 'revoked')->>'outcome' = 'stale_lease', 'lease cannot checkpoint a different owner');
select pg_temp.w08_throws(format('select public.set_account_deletion_auth_intent(%L,%L,%L)', pg_temp.w08_id(1), pg_temp.w08_id(1002), (select data->>'leaseToken' from w08_results where name='first')), '55000', 'Auth intent requires all external checkpoints');
select pg_temp.w08_throws(format('select public.checkpoint_account_deletion_operation(%L,%L,%L,''external_complete'')', pg_temp.w08_id(1), pg_temp.w08_id(1002), (select data->>'leaseToken' from w08_results where name='first')), '55000', 'external readiness cannot be forged out of order');
select pg_temp.w08_throws(format('select public.checkpoint_account_deletion_operation(%L,%L,%L,''revenuecat'')', pg_temp.w08_id(1), pg_temp.w08_id(1002), (select data->>'leaseToken' from w08_results where name='first')), '55000', 'Apple checkpoint must precede RevenueCat checkpoint');
select pg_temp.w08_throws(format('select public.checkpoint_account_deletion_operation(%L,%L,%L,''apple'',''manual_action_required'')', pg_temp.w08_id(1), pg_temp.w08_id(1002), (select data->>'leaseToken' from w08_results where name='first')), '22023', 'stored Apple credential cannot bypass required revocation through manual fallback');
select pg_temp.w08_assert(public.checkpoint_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='first'), 'apple', 'revoked')->>'outcome' = 'checkpointed', 'successful Apple revocation is durably checkpointed');
reset role;
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second', challenge_expires_at = clock_timestamp() - interval '1 second'
  where id = pg_temp.w08_id(1002);
set local role service_role;
insert into w08_results values ('takeover', public.confirm_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_challenge(1,2002), pg_temp.w08_id(1002)));
select pg_temp.w08_assert((select data->>'outcome' = 'claimed' and (data->>'appleCompleted')::boolean from w08_results where name='takeover'), 'accepted confirm can resume after challenge expiry and reuses Apple checkpoint');
select pg_temp.w08_assert((select a.data->>'leaseToken' <> b.data->>'leaseToken' and a.data->>'confirmedAt' = b.data->>'confirmedAt'
  from w08_results a, w08_results b where a.name='first' and b.name='takeover'), 'lease takeover fences old token and preserves original confirmation timestamp');
select pg_temp.w08_assert(public.checkpoint_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='first'), 'revenuecat')->>'outcome' = 'stale_lease', 'stale lease cannot checkpoint after takeover');
select pg_temp.w08_assert(public.set_account_deletion_auth_intent(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='first'))->>'outcome' = 'stale_lease', 'stale lease cannot advance to Auth intent');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='first'), 'checkpoint_unavailable')->>'outcome' = 'stale_lease', 'stale worker cannot release the current lease');
select pg_temp.w08_throws(format('select public.fail_account_deletion_operation(%L,%L,%L,''email@example.test raw-provider-token'')', pg_temp.w08_id(1), pg_temp.w08_id(1002), (select data->>'leaseToken' from w08_results where name='takeover')), '22023', 'non-sensitive error code allowlist excludes raw provider errors');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'));
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'), 'external_complete');
reset role;
select pg_temp.w08_assert((select phase = 'auth_delete_intent' and attempts = 2 and completed_at is null
  and auth_deleted_at is null and external_completed_at is not null and auth_delete_intent_at is not null
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1002)), 'checkpoints are monotonic and intent alone is not a receipt');

create temporary table w08_forged_auth (id uuid primary key);
insert into w08_forged_auth values (pg_temp.w08_id(1));
create trigger w08_forged_auth_delete after delete on w08_forged_auth
  for each row execute function api_private.record_account_deletion_auth_absence();
select pg_temp.w08_throws('delete from pg_temp.w08_forged_auth', '42501', 'hardened receipt trigger refuses a forged table context');

savepoint auth_rollback;
delete from auth.users where id = pg_temp.w08_id(1);
do $$
begin
  if exists (select 1 from auth.users where id = pg_temp.w08_id(1))
    or exists (select 1 from public.profiles where id = pg_temp.w08_id(1))
    or exists (select 1 from public.account_external_credentials where user_id = pg_temp.w08_id(1))
    or public.read_account_deletion_status(pg_temp.w08_id(1002), pg_temp.w08_cap(2))
      <> '{"state":"in_progress","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb
    or not exists (select 1 from api_private.account_deletion_operations o, w08_results r
      where o.id = pg_temp.w08_id(1002) and r.name = 'takeover' and o.auth_deleted_at is not null
        and o.completed_at is null and o.phase = 'auth_delete_intent' and o.last_error_code is null
        and o.lease_token = (r.data->>'leaseToken')::uuid and o.lease_expires_at > clock_timestamp()) then
    raise exception 'W08 Auth transaction must see the cascade, the Auth absence and the retained lease but no receipt';
  end if;
end;
$$;
rollback to auth_rollback;
select pg_temp.w08_assert(exists (select 1 from auth.users where id = pg_temp.w08_id(1))
  and exists (select 1 from public.profiles where id = pg_temp.w08_id(1))
  and exists (select 1 from public.account_external_credentials where user_id = pg_temp.w08_id(1))
  and (select auth_deleted_at is null and completed_at is null from api_private.account_deletion_operations where id = pg_temp.w08_id(1002)),
  'Auth rollback rolls back its cascade and its observed in-transaction Auth absence together');
delete from auth.users where id = pg_temp.w08_id(1);
select pg_temp.w08_assert(not exists (select 1 from auth.sessions where user_id = pg_temp.w08_id(1))
  and not exists (select 1 from auth.identities where user_id = pg_temp.w08_id(1))
  and not exists (select 1 from public.shots where user_id = pg_temp.w08_id(1)), 'Auth deletion preserves normal account data cascades');
select pg_temp.w08_assert((select o.auth_deleted_at is not null and o.completed_at is null and o.phase = 'auth_delete_intent'
  and o.last_error_code is null and o.lease_token = (r.data->>'leaseToken')::uuid and o.lease_expires_at > clock_timestamp()
  from api_private.account_deletion_operations o, w08_results r where o.id = pg_temp.w08_id(1002) and r.name = 'takeover'),
  'real Auth deletion records Auth absence and retains the worker lease without certifying a receipt');
select pg_temp.w08_assert(exists (select 1 from public.account_deletion_feedback where user_id is null and reason='not_using'), 'existing anonymized survey retention is unchanged');
select pg_temp.w08_assert(not exists ((table public.free_rating_ledger except table w08_ledger_before)
  union all (table w08_ledger_before except table public.free_rating_ledger)), 'free-rating identity ledger is byte-for-byte unchanged after cascade');
set local role service_role;
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1002), pg_temp.w08_cap(2))
  = '{"state":"in_progress","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'uncertified Auth absence under a live sweep reports in_progress with no receipt through the status capability');
select pg_temp.w08_assert(public.read_account_deletion_receipt(pg_temp.w08_id(1), pg_temp.w08_id(1002))->>'state' = 'in_progress'
  and public.read_account_deletion_receipt(pg_temp.w08_id(1), pg_temp.w08_id(1002))->'completionReceipt' = 'null'::jsonb, 'owner receipt read withholds the receipt until certification');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(1), pg_temp.w08_id(1002))->>'outcome' = 'busy', 'acquisition under a live post-Auth lease answers busy instead of issuing a fresh lease');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='first'))->>'outcome' = 'stale_lease', 'fenced stale lease cannot certify a receipt');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(2), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'))->>'outcome' = 'stale_lease', 'certification is bound to the operation owner');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(1), pg_temp.w08_id(1002), gen_random_uuid())->>'outcome' = 'stale_lease', 'a forged lease token cannot certify a receipt');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='first'), 'completion_unverified')->>'outcome' = 'stale_lease', 'fenced stale worker cannot record residue after Auth deletion');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'), 'checkpoint_unavailable')->>'outcome' = 'stale_lease', 'only the post-Auth verdicts may be recorded against the retained post-Auth lease');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'), 'apple_cleanup_unavailable')->>'outcome' = 'stale_lease', 'a pre-Auth verdict cannot be recorded against the retained post-Auth lease');
reset role;
select pg_temp.w08_assert((select o.completed_at is null and o.last_error_code is null and o.lease_token = (r.data->>'leaseToken')::uuid
  from api_private.account_deletion_operations o, w08_results r where o.id = pg_temp.w08_id(1002) and r.name = 'takeover'),
  'refused certification and refused verdicts leave the retained lease and the uncertified row untouched');
set local role service_role;
insert into w08_results values ('certified', public.certify_account_deletion_completion(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover')));
select pg_temp.w08_assert((select data->>'state' = 'completed' and data->'completionReceipt'->>'completedAt' is not null
  and data->>'appleAuthorizationRevocation' = 'revoked' from w08_results where name='certified'), 'the worker that verified the sweep certifies completion with the retained lease');
reset role;
select pg_temp.w08_assert((select o.phase = 'completed' and o.completed_at > o.auth_deleted_at and o.lease_token is null
  and o.lease_expires_at is null and o.last_error_code is null
  and o.completed_at = (r.data->'completionReceipt'->>'completedAt')::timestamptz
  from api_private.account_deletion_operations o, w08_results r where o.id = pg_temp.w08_id(1002) and r.name = 'certified'),
  'certification is the durable receipt and follows the Auth delete');
create temporary table w08_certified_row as select * from api_private.account_deletion_operations where id = pg_temp.w08_id(1002);
set local role service_role;
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'))->>'outcome' = 'stale_lease', 'a spent lease cannot certify a second time');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1002), (select (data->>'leaseToken')::uuid from w08_results where name='takeover'), 'completion_unverified')->>'outcome' = 'stale_lease', 'a spent lease cannot unwind a certified receipt');
reset role;
select pg_temp.w08_assert(not exists ((select * from api_private.account_deletion_operations where id = pg_temp.w08_id(1002) except table w08_certified_row)
  union all (table w08_certified_row except select * from api_private.account_deletion_operations where id = pg_temp.w08_id(1002))), 'a certified receipt is immutable to later verdicts');
set local role service_role;
select pg_temp.w08_assert((public.read_account_deletion_status(pg_temp.w08_id(1002), pg_temp.w08_cap(2))
  - array['state','completionReceipt','appleAuthorizationRevocation']) = '{}'::jsonb
  and public.read_account_deletion_status(pg_temp.w08_id(1002), pg_temp.w08_cap(2))->>'appleAuthorizationRevocation' = 'revoked', 'post-cascade status reveals only operation state receipt and Apple outcome');
select pg_temp.w08_assert(public.read_account_deletion_receipt(pg_temp.w08_id(2), pg_temp.w08_id(1002)) is null, 'owner receipt cannot be rebound after cascade');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(1), pg_temp.w08_id(1002))->>'outcome' = 'completed', 'internal recovery reads completion without another Auth delete');
select pg_temp.w08_assert(public.store_account_apple_credential(pg_temp.w08_id(1), 'v1.abcdefghijklmnop.afterDeletedEncryptedToken')->>'outcome' = 'user_missing', 'credential retry after Auth deletion cannot recreate a credential row');
select pg_temp.w08_assert(public.begin_account_deletion_operation(pg_temp.w08_id(1), pg_temp.w08_id(1998), pg_temp.w08_challenge(1,2998), pg_temp.w08_cap(998))->>'outcome' = 'user_missing', 'new admission after Auth deletion does not invent completion or resurrect work');
select pg_temp.w08_assert(not public.account_deletion_allows_apple_bootstrap(pg_temp.w08_id(1)), 'Apple bootstrap remains fenced after Auth deletion');

select public.begin_account_deletion_operation(pg_temp.w08_id(2), pg_temp.w08_id(1003), pg_temp.w08_challenge(2,2003), pg_temp.w08_cap(3));
reset role;
delete from auth.users where id = pg_temp.w08_id(2);
select pg_temp.w08_assert((select auth_deleted_at is not null and completed_at is null and confirmed_at is null
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1003)), 'arbitrary Auth absence without confirmation cannot produce a receipt');

insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
  values (pg_temp.w08_id(3), pg_temp.w08_id(2004), clock_timestamp() - interval '10 seconds', clock_timestamp() + interval '1 minute');
set local role service_role;
select pg_temp.w08_assert(public.confirm_account_deletion_operation(pg_temp.w08_id(3), pg_temp.w08_challenge(3,2004), pg_temp.w08_id(1999))->>'outcome' = 'invalid', 'wrong supplied operation ID never falls back to premigration adoption');
insert into w08_results values ('legacy', public.confirm_account_deletion_operation(pg_temp.w08_id(3), pg_temp.w08_challenge(3,2004)));
select pg_temp.w08_assert((select data->>'outcome' = 'claimed' and data->>'appleAction' = 'not_applicable' from w08_results where name='legacy'), 'legacy challenge-only confirms adopt a premigration request');
reset role;
select pg_temp.w08_assert((select o.status_capability_hash is null and o.created_at = r.created_at
  and o.challenge_expires_at = r.expires_at from api_private.account_deletion_operations o
  join public.account_deletion_requests r on r.user_id = o.owner_id where o.owner_id = pg_temp.w08_id(3)), 'legacy adoption preserves original age and never invents or retains a raw capability');
delete from auth.users where id = pg_temp.w08_id(3);
select pg_temp.w08_assert((select confirmed_at is not null and external_completed_at is null and completed_at is null
  and auth_deleted_at is not null from api_private.account_deletion_operations where owner_id = pg_temp.w08_id(3)), 'accepted confirmation without required external cleanup cannot complete on Auth absence');

set local role service_role;
select public.begin_account_deletion_operation(pg_temp.w08_id(4), pg_temp.w08_id(1004), pg_temp.w08_challenge(4,2004), pg_temp.w08_cap(4));
select public.begin_account_deletion_operation(pg_temp.w08_id(5), pg_temp.w08_id(1005), pg_temp.w08_challenge(5,2005), pg_temp.w08_cap(5));
select public.begin_account_deletion_operation(pg_temp.w08_id(6), pg_temp.w08_id(1006), pg_temp.w08_challenge(6,2006), pg_temp.w08_cap(6));
select public.begin_account_deletion_operation(pg_temp.w08_id(7), pg_temp.w08_id(1007), pg_temp.w08_challenge(7,2007), pg_temp.w08_cap(7));
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where owner_id in (pg_temp.w08_id(4), pg_temp.w08_id(6), pg_temp.w08_id(7));
update api_private.account_deletion_operations
  set created_at = created_at - interval '16 minutes', challenge_expires_at = challenge_expires_at - interval '16 minutes',
    status_expires_at = status_expires_at - interval '16 minutes', retain_until = retain_until - interval '16 minutes'
  where owner_id = pg_temp.w08_id(5);
set local role service_role;
select pg_temp.w08_assert(public.confirm_account_deletion_operation(pg_temp.w08_id(5), pg_temp.w08_challenge(5,2005))->>'outcome' = 'expired', 'database rejects first confirmation after fifteen minutes');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1005), pg_temp.w08_cap(5))->>'state' = 'expired', 'status expiry view cannot resume an expired request');
insert into w08_results values ('no_intent', public.confirm_account_deletion_operation(pg_temp.w08_id(4), pg_temp.w08_challenge(4,2004)));
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(4), pg_temp.w08_id(1004), (select (data->>'leaseToken')::uuid from w08_results where name='no_intent'), 'apple', 'not_applicable');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(4), pg_temp.w08_id(1004), (select (data->>'leaseToken')::uuid from w08_results where name='no_intent'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(4), pg_temp.w08_id(1004), (select (data->>'leaseToken')::uuid from w08_results where name='no_intent'), 'external_complete');
reset role;
delete from auth.users where id = pg_temp.w08_id(4);
select pg_temp.w08_assert((select external_completed_at is not null and auth_deleted_at is not null
  and auth_delete_intent_at is null and completed_at is null from api_private.account_deletion_operations where id = pg_temp.w08_id(1004)), 'external readiness without prior Auth intent cannot create a receipt');
set local role service_role;
insert into w08_results values ('manual', public.confirm_account_deletion_operation(pg_temp.w08_id(6), pg_temp.w08_challenge(6,2006)));
select pg_temp.w08_assert((select data->>'appleAction' = 'manual_action_required' and data->>'appleRefreshTokenEncrypted' is null from w08_results where name='manual'), 'legacy Apple manual disconnect does not require a missing device credential');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(6), pg_temp.w08_id(1006), (select (data->>'leaseToken')::uuid from w08_results where name='manual'), 'apple', 'manual_action_required');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(6), pg_temp.w08_id(1006), (select (data->>'leaseToken')::uuid from w08_results where name='manual'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(6), pg_temp.w08_id(1006), (select (data->>'leaseToken')::uuid from w08_results where name='manual'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.w08_id(6), pg_temp.w08_id(1006), (select (data->>'leaseToken')::uuid from w08_results where name='manual'));
reset role;
delete from auth.users where id = pg_temp.w08_id(6);
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1006), pg_temp.w08_cap(6))
  = '{"state":"in_progress","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'legacy manual Apple outcome is withheld until the worker certifies');
set local role service_role;
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(6), pg_temp.w08_id(1006), (select (data->>'leaseToken')::uuid from w08_results where name='manual'))->>'state' = 'completed', 'legacy manual Apple operation certifies with its retained lease');
reset role;
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1006), pg_temp.w08_cap(6))->>'appleAuthorizationRevocation' = 'manual_action_required', 'completion retains only the legacy Apple manual step');
update api_private.account_deletion_operations
  set created_at = created_at - interval '24 hours', challenge_expires_at = challenge_expires_at - interval '24 hours',
    status_expires_at = status_expires_at - interval '24 hours', retain_until = retain_until - interval '24 hours'
  where id = pg_temp.w08_id(1006);
set local role service_role;
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1006), pg_temp.w08_cap(6)) is null
  and public.read_account_deletion_status(pg_temp.w08_id(1006), pg_temp.w08_cap(999)) is null, 'expired and unknown capabilities return the same absence');
select pg_temp.w08_assert(public.purge_account_deletion_operations() = 0, 'retention does not remove unexpired operation rows');
select pg_temp.w08_throws('select public.purge_account_deletion_operations(501)', '22023', 'retention batches are bounded');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '7 days', challenge_expires_at = challenge_expires_at - interval '7 days',
    status_expires_at = status_expires_at - interval '7 days', retain_until = retain_until - interval '7 days'
  where id = pg_temp.w08_id(1006);
set local role service_role;
select pg_temp.w08_assert(public.purge_account_deletion_operations(1) = 1, 'retention removes only the expired bounded operation row');

do $$
declare v_claim jsonb; v_attempt integer; v_original_confirmation text;
begin
  for v_attempt in 1..8 loop
    v_claim := public.confirm_account_deletion_operation(pg_temp.w08_id(7), pg_temp.w08_challenge(7,2007));
    if v_attempt = 1 then v_original_confirmation := v_claim->>'confirmedAt'; end if;
    if v_claim->>'outcome' <> 'claimed' or v_claim->>'confirmedAt' <> v_original_confirmation then
      raise exception 'W08 retry must claim a bounded lease without resetting confirmation';
    end if;
    perform public.fail_account_deletion_operation(pg_temp.w08_id(7), pg_temp.w08_id(1007),
      (v_claim->>'leaseToken')::uuid, 'apple_cleanup_unavailable');
  end loop;
  perform pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(7), pg_temp.w08_id(1007))->>'outcome' = 'blocked', 'worker retry attempts stop at eight without fresh confirmation');
end;
$$;
reset role;
select pg_temp.w08_assert((select attempts = 8 and lease_token is null and last_error_code = 'apple_cleanup_unavailable'
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1007)), 'bounded retries retain only non-sensitive error codes');
select pg_temp.w08_assert(not exists ((table public.free_rating_ledger except table w08_ledger_before)
  union all (table w08_ledger_before except table public.free_rating_ledger)), 'operation retention and retries do not alter historical free-rating ledger rows');
select pg_temp.w08_assert((select count(*) from public.free_rating_ledger where scored_count = 2) = 1, 'account deletion never resets lifetime free credits');

set local role service_role;
select public.store_account_apple_credential(pg_temp.w08_id(8), 'v1.abcdefghijklmnop.olderEncryptedToken');
select public.begin_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_id(1008), pg_temp.w08_challenge(8,2008), pg_temp.w08_cap(8));
select pg_temp.w08_assert(public.store_account_apple_credential(pg_temp.w08_id(8), 'v1.abcdefghijklmnop.newerEncryptedToken')->>'outcome' = 'stored', 'an unconfirmed request does not block legitimate credential replacement');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where owner_id = pg_temp.w08_id(8);
set local role service_role;
insert into w08_results values ('newer_credential', public.confirm_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_challenge(8,2008), pg_temp.w08_id(1008)));
select pg_temp.w08_assert((select data->>'appleRefreshTokenEncrypted' = 'v1.abcdefghijklmnop.newerEncryptedToken'
  and data->>'appleAction' = 'revoke' from w08_results where name = 'newer_credential'), 'confirmation snapshots the latest credential rather than the request-time credential');
select pg_temp.w08_throws('delete from public.account_external_credentials where user_id = pg_temp.w08_id(8)', '42501', 'service cannot bypass a confirmed cleanup fence by deleting its credential');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'), 'apple', 'revoked');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'));
reset role;
delete from auth.users where id = pg_temp.w08_id(8);
select pg_temp.w08_assert((select o.auth_deleted_at is not null and o.completed_at is null and o.lease_token = (r.data->>'leaseToken')::uuid
  from api_private.account_deletion_operations o, w08_results r where o.id = pg_temp.w08_id(1008) and r.name = 'newer_credential'),
  'ready intent keeps the sweeping worker lease across the Auth delete');
set local role service_role;
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'), 'completion_unverified')->>'outcome' = 'released', 'residue found after the Auth delete is recorded against the retained lease');
reset role;
select pg_temp.w08_assert((select auth_deleted_at is not null and completed_at is null and phase = 'auth_delete_intent'
  and lease_token is null and lease_expires_at is null and last_error_code = 'completion_unverified'
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1008)), 'residue leaves the durable row uncertified and blocked without a receipt');
set local role service_role;
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1008), pg_temp.w08_cap(8))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'status after residue is blocked with no receipt');
select pg_temp.w08_assert(public.read_account_deletion_receipt(pg_temp.w08_id(8), pg_temp.w08_id(1008))->'completionReceipt' = 'null'::jsonb, 'owner receipt read after residue withholds the receipt');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'))->>'outcome' = 'stale_lease', 'the released residue lease can never certify a receipt afterwards');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'), 'completion_unverified')->>'outcome' = 'stale_lease', 'a residue verdict is recorded once');
reset role;
select pg_temp.w08_assert((select completed_at is null and last_error_code = 'completion_unverified'
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1008)), 'residue verdict is durable and never becomes a receipt');
select pg_temp.w08_assert(not exists ((table public.free_rating_ledger except table w08_ledger_before)
  union all (table w08_ledger_before except table public.free_rating_ledger)), 'certification and residue verdicts do not alter the free-rating ledger');

-- Round 5: a residue verdict is not a dead end. The post-Auth phase is
-- re-acquired under the exact binding (a fresh lease, no external step
-- repeated), residue found again is recorded again, and only a clean sweep
-- certifies — exactly once.
set local role service_role;
insert into w08_results values ('residue_retry', public.claim_account_deletion_work(pg_temp.w08_id(8), pg_temp.w08_id(1008)));
select pg_temp.w08_assert((select data->>'outcome' = 'claimed' and (data->>'authDeleted')::boolean and (data->>'appleCompleted')::boolean
  and data->>'appleAction' = 'revoked' and data->'appleRefreshTokenEncrypted' = 'null'::jsonb
  and (data->>'revenueCatCompleted')::boolean and (data->>'revenueCatAlreadyDeleted')::boolean
  from w08_results where name='residue_retry'), 'the residue verdict is re-acquired as a post-Auth claim with every external step already complete');
select pg_temp.w08_assert((select a.data->>'leaseToken' <> b.data->>'leaseToken' and a.data->>'confirmedAt' = b.data->>'confirmedAt'
  and a.data->>'operationId' = b.data->>'operationId' from w08_results a, w08_results b where a.name='newer_credential' and b.name='residue_retry'),
  'post-Auth re-acquisition issues a fresh lease on the same operation and confirmation');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1008), pg_temp.w08_cap(8))
  = '{"state":"in_progress","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'a re-acquired post-Auth sweep reads in_progress with no receipt');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(8), pg_temp.w08_id(1008))->>'outcome' = 'busy', 'a live re-acquired post-Auth lease is not issued twice');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='newer_credential'))->>'outcome' = 'stale_lease', 'the released residue lease stays fenced after re-acquisition');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(2), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='residue_retry'))->>'outcome' = 'stale_lease', 'a re-acquired lease certifies only for its own owner');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='residue_retry'), 'completion_unverified')->>'outcome' = 'released', 'residue found again is recorded against the re-acquired lease');
reset role;
select pg_temp.w08_assert((select auth_deleted_at is not null and completed_at is null and phase = 'auth_delete_intent'
  and lease_token is null and attempts = 2 and last_error_code = 'completion_unverified'
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1008)), 'a second residue verdict leaves the row uncertified and blocked without a receipt');
set local role service_role;
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1008), pg_temp.w08_cap(8))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'status after a repeated residue verdict is blocked with no receipt');
insert into w08_results values ('clean_retry', public.claim_account_deletion_work(pg_temp.w08_id(8), pg_temp.w08_id(1008)));
select pg_temp.w08_assert((select data->>'outcome' = 'claimed' and (data->>'authDeleted')::boolean from w08_results where name='clean_retry'), 'the phase is re-acquired again for the clean sweep');
insert into w08_results values ('residue_certified', public.certify_account_deletion_completion(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='clean_retry')));
select pg_temp.w08_assert((select data->>'state' = 'completed' and data->'completionReceipt'->>'completedAt' is not null
  and data->>'appleAuthorizationRevocation' = 'revoked' from w08_results where name='residue_certified'), 'the clean sweep after residue certifies completion with the re-acquired lease');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(8), pg_temp.w08_id(1008), (select (data->>'leaseToken')::uuid from w08_results where name='clean_retry'))->>'outcome' = 'stale_lease', 'the re-acquired lease certifies exactly once');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(8), pg_temp.w08_id(1008))->>'outcome' = 'completed', 'recovery after the late certification reads completion');
reset role;
select pg_temp.w08_assert((select o.phase = 'completed' and o.completed_at > o.auth_deleted_at and o.lease_token is null and o.attempts = 3
  and o.last_error_code is null and o.completed_at = (r.data->'completionReceipt'->>'completedAt')::timestamptz
  from api_private.account_deletion_operations o, w08_results r where o.id = pg_temp.w08_id(1008) and r.name = 'residue_certified'),
  'the late certification is the single durable receipt and follows the Auth delete');

-- Round 5: the worker dies after the Auth delete (or its deleteUser response is
-- lost). The retained lease reads in_progress while live and is busy to others;
-- once expired, nobody certifies with it, the status is still recoverable, and
-- exactly one worker re-acquires the phase under the exact binding.
set local role service_role;
select public.begin_account_deletion_operation(pg_temp.w08_id(10), pg_temp.w08_id(1010), pg_temp.w08_challenge(10,2010), pg_temp.w08_cap(10));
select public.begin_account_deletion_operation(pg_temp.w08_id(11), pg_temp.w08_id(1011), pg_temp.w08_challenge(11,2011), pg_temp.w08_cap(11));
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where owner_id in (pg_temp.w08_id(10), pg_temp.w08_id(11));
set local role service_role;
insert into w08_results values ('crash', public.confirm_account_deletion_operation(pg_temp.w08_id(10), pg_temp.w08_challenge(10,2010), pg_temp.w08_id(1010)));
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='crash'), 'apple', 'not_applicable');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='crash'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='crash'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='crash'));
reset role;
delete from auth.users where id = pg_temp.w08_id(10);
set local role service_role;
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1010), pg_temp.w08_cap(10))
  = '{"state":"in_progress","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'a live post-Auth sweep reads in_progress, never blocked');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(10), pg_temp.w08_id(1010))->>'outcome' = 'busy', 'a live post-Auth lease is not re-issued');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(11), pg_temp.w08_id(1010))->>'outcome' = 'invalid', 'another owner cannot claim the post-Auth phase');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(10), pg_temp.w08_id(1011))->>'outcome' = 'invalid', 'another operation cannot claim the post-Auth phase');
reset role;
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.w08_id(1010);
set local role service_role;
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='crash'))->>'outcome' = 'stale_lease', 'an expired retained lease cannot certify');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='crash'), 'completion_unverified')->>'outcome' = 'stale_lease', 'an expired retained lease cannot record a verdict');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1010), pg_temp.w08_cap(10))
  = '{"state":"in_progress","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'an expired post-Auth lease without a verdict is recoverable, not blocked');
insert into w08_results values ('reacquired', public.claim_account_deletion_work(pg_temp.w08_id(10), pg_temp.w08_id(1010)));
select pg_temp.w08_assert((select b.data->>'outcome' = 'claimed' and (b.data->>'authDeleted')::boolean and (b.data->>'appleCompleted')::boolean
  and b.data->>'appleAction' = 'not_applicable' and b.data->'appleRefreshTokenEncrypted' = 'null'::jsonb
  and (b.data->>'revenueCatCompleted')::boolean and (b.data->>'revenueCatAlreadyDeleted')::boolean
  and a.data->>'leaseToken' <> b.data->>'leaseToken' and a.data->>'confirmedAt' = b.data->>'confirmedAt'
  from w08_results a, w08_results b where a.name='crash' and b.name='reacquired'), 'the expired post-Auth phase is re-acquired with a fresh lease and no external step to repeat');
reset role;
select pg_temp.w08_assert((select attempts = 2 and last_error_code is null and completed_at is null and phase = 'auth_delete_intent'
  and lease_expires_at > clock_timestamp() from api_private.account_deletion_operations where id = pg_temp.w08_id(1010)), 'post-Auth re-acquisition spends one attempt and renews the lease');
set local role service_role;
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='crash'))->>'outcome' = 'stale_lease', 'the expired lease stays fenced after re-acquisition');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(10), pg_temp.w08_id(1010))->>'outcome' = 'busy', 're-acquired post-Auth lease is exclusive');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='reacquired'), 'auth_delete_unavailable')->>'outcome' = 'released', 'a lost Auth-delete response is recorded against the post-Auth lease');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1010), pg_temp.w08_cap(10))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'a recorded post-Auth verdict reads blocked with no receipt');
insert into w08_results values ('reacquired_again', public.claim_account_deletion_work(pg_temp.w08_id(10), pg_temp.w08_id(1010)));
select pg_temp.w08_assert((select data->>'outcome' = 'claimed' and (data->>'authDeleted')::boolean from w08_results where name='reacquired_again'), 'a released post-Auth verdict is re-acquired');
insert into w08_results values ('crash_certified', public.certify_account_deletion_completion(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='reacquired_again')));
select pg_temp.w08_assert((select data->>'state' = 'completed' and data->>'appleAuthorizationRevocation' = 'not_applicable' from w08_results where name='crash_certified'), 'the recovered sweep certifies completion');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(10), pg_temp.w08_id(1010), (select (data->>'leaseToken')::uuid from w08_results where name='reacquired_again'))->>'outcome' = 'stale_lease', 'the recovered sweep certifies exactly once');
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(10), pg_temp.w08_id(1010))->>'outcome' = 'completed', 'recovery after certification reads completion');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1010), pg_temp.w08_cap(10))->>'state' = 'completed'
  and public.read_account_deletion_status(pg_temp.w08_id(1010), pg_temp.w08_cap(10))->'completionReceipt'->>'completedAt' is not null, 'status hands out the certified receipt');
reset role;
select pg_temp.w08_assert((select phase = 'completed' and completed_at > auth_deleted_at and lease_token is null and attempts = 3 and last_error_code is null
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1010)), 'the recovered receipt follows the Auth delete');

-- Round 5: post-Auth recovery keeps the retry budget and the identity binding.
set local role service_role;
insert into w08_results values ('budget', public.confirm_account_deletion_operation(pg_temp.w08_id(11), pg_temp.w08_challenge(11,2011), pg_temp.w08_id(1011)));
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(11), pg_temp.w08_id(1011), (select (data->>'leaseToken')::uuid from w08_results where name='budget'), 'apple', 'not_applicable');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(11), pg_temp.w08_id(1011), (select (data->>'leaseToken')::uuid from w08_results where name='budget'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(11), pg_temp.w08_id(1011), (select (data->>'leaseToken')::uuid from w08_results where name='budget'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.w08_id(11), pg_temp.w08_id(1011), (select (data->>'leaseToken')::uuid from w08_results where name='budget'));
reset role;
delete from auth.users where id = pg_temp.w08_id(11);
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second', attempts = 8 where id = pg_temp.w08_id(1011);
set local role service_role;
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(11), pg_temp.w08_id(1011))->>'outcome' = 'blocked', 'post-Auth re-acquisition stops at eight attempts');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1011), pg_temp.w08_cap(11))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'an exhausted post-Auth operation reads blocked with no receipt');
reset role;
update api_private.account_deletion_operations set attempts = 1 where id = pg_temp.w08_id(1011);
insert into auth.users (id, email, raw_app_meta_data) values (pg_temp.w08_id(11), 'w08-test-11@example.test', '{"provider":"google"}');
set local role service_role;
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(11), pg_temp.w08_id(1011))->>'outcome' = 'blocked', 'a recreated identity under the same id cannot re-acquire the post-Auth phase');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(11), pg_temp.w08_id(1011), (select (data->>'leaseToken')::uuid from w08_results where name='budget'))->>'outcome' = 'stale_lease', 'a recreated identity cannot be certified as deleted');
reset role;
select pg_temp.w08_assert((select completed_at is null and phase = 'auth_delete_intent' and attempts = 1 and lease_token = (r.data->>'leaseToken')::uuid
  from api_private.account_deletion_operations o, w08_results r where o.id = pg_temp.w08_id(1011) and r.name='budget'), 'refused post-Auth re-acquisition leaves the row untouched');
delete from auth.users where id = pg_temp.w08_id(11);
set local role service_role;
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(11), pg_temp.w08_id(1011))->>'outcome' = 'claimed', 'once the identity is gone again the post-Auth phase is re-acquired');
reset role;
select pg_temp.w08_assert(not exists ((table public.free_rating_ledger except table w08_ledger_before)
  union all (table w08_ledger_before except table public.free_rating_ledger)), 'post-Auth recovery does not alter the free-rating ledger');

-- Round 6: post-Auth recovery has a shipping caller that needs no owner
-- session. The deleting session is cascaded away with auth.users, so the
-- owner's retry of the confirm route is refused; the service-only
-- sweep_account_deletion_operations() (pg_cron) re-acquires every post-Auth
-- phase whose lease is not live and certifies it — exactly once, only after the
-- database itself has counted zero owner rows. Clients cannot call it.
insert into auth.users (id, email, raw_app_meta_data)
  select pg_temp.w08_id(n), 'w08-test-' || n || '@example.test', '{"provider":"google"}'::jsonb from (values (12), (13)) s(n);
insert into auth.identities (provider, provider_id, user_id)
  select 'google', 'w08-test-identity-' || n, pg_temp.w08_id(n) from (values (12), (13)) s(n);
insert into auth.sessions (id, user_id) values (pg_temp.w08_id(9012), pg_temp.w08_id(12));
set local role service_role;
select public.begin_account_deletion_operation(pg_temp.w08_id(12), pg_temp.w08_id(1012), pg_temp.w08_challenge(12,2012), pg_temp.w08_cap(12));
select public.begin_account_deletion_operation(pg_temp.w08_id(13), pg_temp.w08_id(1013), pg_temp.w08_challenge(13,2013), pg_temp.w08_cap(13));
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where owner_id in (pg_temp.w08_id(12), pg_temp.w08_id(13));
set local role service_role;
insert into w08_results values ('death', public.confirm_account_deletion_operation(pg_temp.w08_id(12), pg_temp.w08_challenge(12,2012), pg_temp.w08_id(1012)));
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(12), pg_temp.w08_id(1012), (select (data->>'leaseToken')::uuid from w08_results where name='death'), 'apple', 'not_applicable');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(12), pg_temp.w08_id(1012), (select (data->>'leaseToken')::uuid from w08_results where name='death'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(12), pg_temp.w08_id(1012), (select (data->>'leaseToken')::uuid from w08_results where name='death'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.w08_id(12), pg_temp.w08_id(1012), (select (data->>'leaseToken')::uuid from w08_results where name='death'));
insert into w08_results values ('orphan', public.confirm_account_deletion_operation(pg_temp.w08_id(13), pg_temp.w08_challenge(13,2013), pg_temp.w08_id(1013)));
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(13), pg_temp.w08_id(1013), (select (data->>'leaseToken')::uuid from w08_results where name='orphan'), 'apple', 'not_applicable');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(13), pg_temp.w08_id(1013), (select (data->>'leaseToken')::uuid from w08_results where name='orphan'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.w08_id(13), pg_temp.w08_id(1013), (select (data->>'leaseToken')::uuid from w08_results where name='orphan'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.w08_id(13), pg_temp.w08_id(1013), (select (data->>'leaseToken')::uuid from w08_results where name='orphan'));
reset role;
-- the shipping confirm route re-checks the deleting session; the Auth delete
-- cascades it, so the owner can never drive recovery
select set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.w08_id(12)::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.w08_id(12), 'session_id', pg_temp.w08_id(9012))::text, true);
select pg_temp.w08_assert(public.is_api_session_active() = true, 'the deleting session is live before the Auth delete');
reset role;
delete from auth.users where id in (pg_temp.w08_id(12), pg_temp.w08_id(13));
select set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.w08_id(12)::text, true);
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.w08_id(12), 'session_id', pg_temp.w08_id(9012))::text, true);
select pg_temp.w08_assert(public.is_api_session_active() = false, 'the Auth delete cascades the deleting session: the owner cannot retry the confirm route');
select pg_temp.w08_throws('select public.sweep_account_deletion_operations(50)', '42501', 'authenticated cannot run the deletion sweep');
reset role;
set local role anon;
select pg_temp.w08_throws('select public.sweep_account_deletion_operations(50)', '42501', 'anon cannot run the deletion sweep');
reset role;
-- rows a cascade "missed" for owner 13: written past the FK and append-only
-- triggers so the database sees durable owner residue after the Auth delete
alter table public.account_deletion_feedback disable trigger all;
insert into public.account_deletion_feedback (user_id, reason) values (pg_temp.w08_id(13), 'other');
alter table public.account_deletion_feedback enable trigger all;
set local role service_role;
select pg_temp.w08_throws('select public.sweep_account_deletion_operations(0)', '22023', 'the sweep refuses an empty batch');
select pg_temp.w08_throws('select public.sweep_account_deletion_operations(501)', '22023', 'the sweep refuses an oversized batch');
insert into w08_results values ('sweep_live', public.sweep_account_deletion_operations(50));
select pg_temp.w08_assert((select (data->>'scanned')::int = 0 and (data->>'certified')::int = 0 and (data->>'claimed')::int = 0 and data->'operations' = '[]'::jsonb
  from w08_results where name='sweep_live'), 'a live retained post-Auth lease is work in flight: the sweep leaves it alone');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1012), pg_temp.w08_cap(12))
  = '{"state":"in_progress","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'the untouched live post-Auth lease still reads in_progress');
reset role;
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id in (pg_temp.w08_id(1012), pg_temp.w08_id(1013));
set local role service_role;
insert into w08_results values ('sweep_recover', public.sweep_account_deletion_operations(50));
select pg_temp.w08_assert((select (data->>'scanned')::int = 2 and (data->>'claimed')::int = 2 and (data->>'certified')::int = 1 and (data->>'residue')::int = 1
  and (data->>'failed')::int = 0 and (data->>'skipped')::int = 0 from w08_results where name='sweep_recover'), 'the sweep re-acquires every expired post-Auth phase and certifies only the clean one');
select pg_temp.w08_assert((select exists (select 1 from jsonb_array_elements(data->'operations') op
    where op->>'operationId' = pg_temp.w08_id(1012)::text and op->>'outcome' = 'certified' and op->>'completedAt' is not null)
  and exists (select 1 from jsonb_array_elements(data->'operations') op
    where op->>'operationId' = pg_temp.w08_id(1013)::text and op->>'outcome' = 'residue'
      and op->'namespaces' = '[{"table":"account_deletion_feedback","rows":1}]'::jsonb)
  from w08_results where name='sweep_recover'), 'the sweep reports the certified operation and the residue by table and count, never row contents');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1012), pg_temp.w08_cap(12))->>'state' = 'completed'
  and public.read_account_deletion_status(pg_temp.w08_id(1012), pg_temp.w08_cap(12))->'completionReceipt'->>'completedAt' is not null
  and public.read_account_deletion_status(pg_temp.w08_id(1012), pg_temp.w08_cap(12))->>'appleAuthorizationRevocation' = 'not_applicable', 'the swept clean deletion hands out its receipt without any owner involvement');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1013), pg_temp.w08_cap(13))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'residue after the Auth delete reads blocked with no receipt');
insert into w08_results values ('sweep_idle', public.sweep_account_deletion_operations(50));
select pg_temp.w08_assert((select (data->>'certified')::int = 0 and (data->>'residue')::int = 1 from w08_results where name='sweep_idle'), 'a certified deletion is never swept twice; residue is re-checked every sweep');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(12), pg_temp.w08_id(1012), (select (data->>'leaseToken')::uuid from w08_results where name='death'))->>'outcome' = 'stale_lease', 'the dead worker''s lease cannot certify after the sweep');
-- a worker holding a valid lease is refused by the same database gate
insert into w08_results values ('orphan_claim', public.claim_account_deletion_work(pg_temp.w08_id(13), pg_temp.w08_id(1013)));
select pg_temp.w08_assert((select data->>'outcome' = 'claimed' from w08_results where name='orphan_claim'), 'the residue phase stays re-acquirable');
select pg_temp.w08_assert(public.certify_account_deletion_completion(pg_temp.w08_id(13), pg_temp.w08_id(1013), (select (data->>'leaseToken')::uuid from w08_results where name='orphan_claim'))
  = '{"outcome":"residue","namespaces":[{"table":"account_deletion_feedback","rows":1}]}'::jsonb, 'certification with a valid lease is refused while owner rows remain');
select pg_temp.w08_assert(public.fail_account_deletion_operation(pg_temp.w08_id(13), pg_temp.w08_id(1013), (select (data->>'leaseToken')::uuid from w08_results where name='orphan_claim'), 'completion_unverified')->>'outcome' = 'released', 'a refused certification keeps the lease for the caller''s verdict');
reset role;
select pg_temp.w08_assert((select completed_at is null and phase = 'auth_delete_intent' and lease_token is null and last_error_code = 'completion_unverified'
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1013)), 'residue never yields a receipt');
select pg_temp.w08_assert((select phase = 'completed' and completed_at > auth_deleted_at and lease_token is null and attempts = 2 and last_error_code is null
  from api_private.account_deletion_operations where id = pg_temp.w08_id(1012)), 'the swept receipt follows the Auth delete under the sweep''s own lease');
-- an orphaned phase whose identity is recreated under the same uuid: the
-- status agrees with the claim RPC (blocked), the sweep does not touch it
insert into auth.users (id, email, raw_app_meta_data) values (pg_temp.w08_id(13), 'w08-test-13@example.test', '{"provider":"google"}');
update api_private.account_deletion_operations set last_error_code = null where id = pg_temp.w08_id(1013);
set local role service_role;
select pg_temp.w08_assert(public.claim_account_deletion_work(pg_temp.w08_id(13), pg_temp.w08_id(1013))->>'outcome' = 'blocked', 'a recreated identity cannot re-acquire the orphaned phase');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1013), pg_temp.w08_cap(13))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'status is honest for a recreated identity: blocked, exactly as the claim RPC answers');
insert into w08_results values ('sweep_recreated', public.sweep_account_deletion_operations(50));
select pg_temp.w08_assert((select (data->>'scanned')::int = 0 and data->'operations' = '[]'::jsonb from w08_results where name='sweep_recreated'), 'the sweep never touches a phase whose identity exists');
reset role;
delete from auth.users where id = pg_temp.w08_id(13);
set local role service_role;
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1013), pg_temp.w08_cap(13))->>'state' = 'in_progress', 'once the identity is gone again the phase is recoverable');
reset role;
alter table public.account_deletion_feedback disable trigger all;
delete from public.account_deletion_feedback where user_id = pg_temp.w08_id(13);
alter table public.account_deletion_feedback enable trigger all;
set local role service_role;
insert into w08_results values ('sweep_repaired', public.sweep_account_deletion_operations(50));
select pg_temp.w08_assert((select (data->>'certified')::int = 1 and (data->>'residue')::int = 0 from w08_results where name='sweep_repaired'), 'once the residue is gone the sweep certifies the phase');
select pg_temp.w08_assert(public.read_account_deletion_status(pg_temp.w08_id(1013), pg_temp.w08_cap(13))->>'state' = 'completed', 'the repaired deletion hands out its receipt');
select pg_temp.w08_assert((select (data->>'certified')::int = 0 and (data->>'scanned')::int = 0 from (select public.sweep_account_deletion_operations(50) as data) s), 'nothing is left to sweep');
reset role;
select pg_temp.w08_assert(not exists ((table public.free_rating_ledger except table w08_ledger_before)
  union all (table w08_ledger_before except table public.free_rating_ledger)), 'the service sweep does not alter the free-rating ledger');

select 'W08 SQL assertions passed: ' || count(*) from w08_assertions;
rollback;

-- Genuine concurrent service transactions, independently of the Edge transport
-- model. Reuse the matrix's dblink extension when present; also run standalone.
create schema w08_probe;
create extension if not exists dblink with schema w08_probe;
set search_path = pg_catalog, w08_probe, w07_probe;

create function w08_probe.await_lock(p_application text)
returns void language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then return; end if;
    if clock_timestamp() > deadline then raise exception 'W08 concurrency: expected database lock was not observed'; end if;
    perform pg_sleep(0.01);
  end loop;
end $$;
create function w08_probe.collect(p_connection text)
returns jsonb language plpgsql set search_path = pg_catalog, w08_probe, w07_probe as $$
declare result jsonb;
begin
  select value into result from dblink_get_result(p_connection) as r(value jsonb);
  perform 1 from dblink_get_result(p_connection) as r(value jsonb);
  return result;
end $$;

insert into auth.users (id, email, raw_app_meta_data)
  select ('08080000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
    'w08-race-' || n || '@example.test', '{"provider":"apple"}'::jsonb from generate_series(81,84) n;
insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
  select ('08080000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
    ('08080000-0000-4000-8000-' || lpad((n + 2000)::text, 12, '0'))::uuid,
    clock_timestamp() - interval '10 seconds', clock_timestamp() + interval '1 minute' from generate_series(81,84) n;
set role service_role;
select public.store_account_apple_credential('08080000-0000-4000-8000-000000000082', 'v1.abcdefghijklmnop.initialRaceToken');
select public.store_account_apple_credential('08080000-0000-4000-8000-000000000083', 'v1.abcdefghijklmnop.initialRaceToken');
reset role;

do $$
<<deletion_races>>
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  c text;
  n integer;
  owner_id uuid;
  challenge_id uuid;
  challenge_hash bytea;
  confirm_query text;
  store_query text;
  first_result jsonb;
  second_result jsonb;
  original_lease jsonb;
  scenario_count integer := 0;
begin
  foreach c in array array['w08_first','w08_second'] loop
    perform dblink_connect(c, connection || ' application_name=' || c);
    perform dblink_exec(c, 'set statement_timeout = ''5s''');
  end loop;
  for n in 81..83 loop
    owner_id := ('08080000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
    challenge_id := ('08080000-0000-4000-8000-' || lpad((n + 2000)::text, 12, '0'))::uuid;
    challenge_hash := sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/' || owner_id::text || '/' || challenge_id::text, 'UTF8'));
    confirm_query := format('select public.confirm_account_deletion_operation(%L::uuid,%L::bytea)', owner_id, challenge_hash);
    store_query := format('select public.store_account_apple_credential(%L::uuid,%L::text)', owner_id, 'v1.abcdefghijklmnop.newerRaceToken');
    perform dblink_exec('w08_first', 'begin; set local role service_role');
    select value into first_result from dblink('w08_first', case when n = 82 then store_query else confirm_query end) as r(value jsonb);
    perform dblink_exec('w08_second', 'begin; set local role service_role');
    perform dblink_send_query('w08_second', case when n = 83 then store_query else confirm_query end);
    perform w08_probe.await_lock('w08_second');
    perform dblink_exec('w08_first', 'commit');
    second_result := w08_probe.collect('w08_second');
    perform dblink_exec('w08_second', 'commit');
    if n = 81 then
      if first_result->>'outcome' <> 'claimed' or second_result->>'outcome' <> 'busy'
        or first_result->>'operationId' <> second_result->>'operationId'
        or (select count(*) from api_private.account_deletion_operations o where o.owner_id = deletion_races.owner_id) <> 1 then
        raise exception 'W08 concurrency: duplicate confirmation must have one operation and one lease';
      end if;
      original_lease := first_result;
    elsif n = 82 then
      if first_result->>'outcome' <> 'stored' or second_result->>'outcome' <> 'claimed'
        or second_result->>'appleRefreshTokenEncrypted' <> 'v1.abcdefghijklmnop.newerRaceToken' then
        raise exception 'W08 concurrency: confirmation must capture the newest committed credential';
      end if;
    else
      if first_result->>'outcome' <> 'claimed' or second_result->>'outcome' <> 'confirmation_in_progress'
        or (select apple_refresh_token_encrypted from public.account_external_credentials where user_id = owner_id)
          <> 'v1.abcdefghijklmnop.initialRaceToken' then
        raise exception 'W08 concurrency: confirmed cleanup must fence replacement credentials';
      end if;
    end if;
    scenario_count := scenario_count + 1;
  end loop;

  owner_id := '08080000-0000-4000-8000-000000000084';
  perform dblink_exec('w08_first', 'begin');
  perform dblink_exec('w08_first', format('delete from auth.users where id = %L::uuid', owner_id));
  perform dblink_exec('w08_second', 'begin; set local role service_role');
  perform dblink_send_query('w08_second', format('select public.store_account_apple_credential(%L::uuid,%L::text)', owner_id, 'v1.abcdefghijklmnop.afterDeleteRaceToken'));
  perform w08_probe.await_lock('w08_second');
  perform dblink_exec('w08_first', 'commit');
  second_result := w08_probe.collect('w08_second');
  perform dblink_exec('w08_second', 'commit');
  if second_result->>'outcome' <> 'user_missing'
    or exists (select 1 from public.account_external_credentials where user_id = owner_id) then
    raise exception 'W08 concurrency: credential storage must serialize with Auth deletion and never resurrect a row';
  end if;
  scenario_count := scenario_count + 1;

  owner_id := '08080000-0000-4000-8000-000000000081';
  perform dblink_exec('w08_first', format('update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval ''1 second'' where id = %L::uuid', original_lease->>'operationId'));
  perform dblink_exec('w08_first', 'begin; set local role service_role');
  select value into first_result from dblink('w08_first', format('select public.claim_account_deletion_work(%L::uuid,%L::uuid)', owner_id, original_lease->>'operationId')) as r(value jsonb);
  perform dblink_exec('w08_second', 'begin; set local role service_role');
  perform dblink_send_query('w08_second', format('select public.checkpoint_account_deletion_operation(%L::uuid,%L::uuid,%L::uuid,''lease_check'')', owner_id, original_lease->>'operationId', original_lease->>'leaseToken'));
  perform w08_probe.await_lock('w08_second');
  perform dblink_exec('w08_first', 'commit');
  second_result := w08_probe.collect('w08_second');
  perform dblink_exec('w08_second', 'commit');
  if first_result->>'outcome' <> 'claimed' or second_result->>'outcome' <> 'stale_lease'
    or first_result->>'leaseToken' = original_lease->>'leaseToken' then
    raise exception 'W08 concurrency: lease takeover must fence every stale worker checkpoint';
  end if;
  scenario_count := scenario_count + 1;
  if scenario_count <> 5 then raise exception 'W08 concurrency: expected five scenarios, got %', scenario_count; end if;
  raise notice 'W08 concurrent deletion scenarios passed: %', scenario_count;
  foreach c in array array['w08_first','w08_second'] loop perform dblink_disconnect(c); end loop;
end $$;
reset search_path;
\echo W08 ACCOUNT DELETION MATRIX: ALL CASES PASSED
