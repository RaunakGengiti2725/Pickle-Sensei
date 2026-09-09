-- ADV (adversarial, integration head 2994371e): account deletion must remove
-- exactly one owner's rows, never a neighbour's, and no combination of RPC
-- calls or direct DML may turn an unknown/partial cleanup into a completed
-- deletion receipt. Runs standalone against a database that has every
-- migration applied (same shape as run_rls_tests.sh); everything rolls back.
\set ON_ERROR_STOP on
\set QUIET on

begin;

create temporary table adv_assertions (name text primary key);
create temporary table adv_results (name text primary key, data jsonb not null);
grant select, insert, update on adv_results to service_role;

create function pg_temp.adv_id(p_number integer) returns uuid
language sql immutable as $$
  select ('0adb0000-0000-4000-8000-' || lpad(p_number::text, 12, '0'))::uuid
$$;
create function pg_temp.adv_challenge(p_owner integer, p_challenge integer) returns bytea
language sql immutable as $$
  select sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/' || pg_temp.adv_id(p_owner)::text
    || '/' || pg_temp.adv_id(p_challenge)::text, 'UTF8'))
$$;
create function pg_temp.adv_cap(p_number integer) returns bytea
language sql immutable as $$ select sha256(convert_to('adv-capability-hash-' || p_number, 'UTF8')) $$;
create function pg_temp.adv_assert(p_condition boolean, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_condition is distinct from true then raise exception 'ADV failure: %', p_name; end if;
  insert into pg_temp.adv_assertions values (p_name);
end;
$$;
create function pg_temp.adv_throws(p_sql text, p_state text, p_name text) returns void
language plpgsql security invoker set search_path = '' as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform pg_temp.adv_assert(v_state = p_state, p_name || ' (got ' || v_state || ')');
    return;
  end;
  raise exception 'ADV expected denial: %', p_name;
end;
$$;
-- Every (table, column) that references auth.users or public.profiles, plus
-- the owner-keyed tables that deliberately carry no FK. One row per owner so
-- the isolation check is exhaustive rather than a hand-picked list.
create function pg_temp.adv_owner_rows(p_owner uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_row record; v_count bigint; v_result jsonb := '{}'::jsonb;
begin
  for v_row in
    select distinct n.nspname as schema_name, c.relname as table_name, a.attname as column_name
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any (k.conkey)
    where k.contype = 'f'
      and k.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
      and n.nspname in ('public', 'api_private', 'auth')
    union
    select 'public', 'offline_allocation_ledger', 'user_id'
    union
    select 'public', 'offline_allocation_identity_links', 'user_id'
    union
    select 'api_private', 'account_deletion_operations', 'owner_id'
    order by 1, 2, 3
  loop
    execute format('select count(*) from %I.%I where %I = $1', v_row.schema_name, v_row.table_name, v_row.column_name)
      into v_count using p_owner;
    v_result := v_result || jsonb_build_object(v_row.schema_name || '.' || v_row.table_name || '.' || v_row.column_name, v_count);
  end loop;
  return v_result;
end;
$$;
grant execute on function pg_temp.adv_id(integer), pg_temp.adv_challenge(integer, integer), pg_temp.adv_cap(integer),
  pg_temp.adv_assert(boolean, text), pg_temp.adv_throws(text, text, text), pg_temp.adv_owner_rows(uuid)
  to anon, authenticated, service_role;

-- Owner 21 (Apple, credential, will be deleted), owner 22 (Apple, credential,
-- neighbour with its own pending request), owner 23 (Google, no credential).
insert into auth.users (id, email, raw_app_meta_data)
  select pg_temp.adv_id(n), 'adv-owner-' || n || '@example.test',
    jsonb_build_object('provider', case when n = 23 then 'google' else 'apple' end)
  from generate_series(21, 23) n;
insert into auth.identities (provider, provider_id, user_id)
  select case when n = 23 then 'google' else 'apple' end, 'adv-identity-' || n, pg_temp.adv_id(n)
  from generate_series(21, 23) n;
insert into auth.sessions (id, user_id) select pg_temp.adv_id(9000 + n), pg_temp.adv_id(n) from generate_series(21, 23) n;
insert into public.shots (
  id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
) select pg_temp.adv_id(8000 + n * 10 + s), pg_temp.adv_id(n), 'drive', now(), 0, 1000, 5, 1, 'scored',
  'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1' from generate_series(21, 23) n, generate_series(1, 2) s;
insert into public.account_deletion_feedback (user_id, reason, provider)
  select pg_temp.adv_id(n), 'not_using', 'apple' from generate_series(21, 22) n;

set local role service_role;
select pg_temp.adv_assert(public.store_account_apple_credential(pg_temp.adv_id(21), 'v1.abcdefghijklmnop.ownerTwentyOneToken')->>'outcome' = 'stored', 'owner 21 credential stored');
select pg_temp.adv_assert(public.store_account_apple_credential(pg_temp.adv_id(22), 'v1.abcdefghijklmnop.ownerTwentyTwoToken')->>'outcome' = 'stored', 'owner 22 credential stored');
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_id(1021), pg_temp.adv_challenge(21, 2021), pg_temp.adv_cap(21))->>'outcome' = 'requested', 'owner 21 requested');
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(22), pg_temp.adv_id(1022), pg_temp.adv_challenge(22, 2022), pg_temp.adv_cap(22))->>'outcome' = 'requested', 'owner 22 requested');
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(23), pg_temp.adv_id(1023), pg_temp.adv_challenge(23, 2023), pg_temp.adv_cap(23))->>'outcome' = 'requested', 'owner 23 requested');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where owner_id in (pg_temp.adv_id(21), pg_temp.adv_id(22), pg_temp.adv_id(23));

create temporary table adv_neighbour_before as
  select pg_temp.adv_owner_rows(pg_temp.adv_id(22)) as rows_22, pg_temp.adv_owner_rows(pg_temp.adv_id(23)) as rows_23;
select pg_temp.adv_assert((select (rows_22->>'public.shots.user_id')::int = 2 and (rows_22->>'public.profiles.id')::int = 1
  and (rows_22->>'public.account_external_credentials.user_id')::int = 1
  and (rows_22->>'api_private.account_deletion_operations.owner_id')::int = 1 from adv_neighbour_before),
  'neighbour snapshot sees the seeded rows (the isolation check is not vacuous)');

-- ATTACK 1: unknown state must never be written as a completed receipt, even
-- by the table owner with direct DML (the Edge only ever goes through RPCs,
-- but a migration or operator with the same privileges must hit the same wall).
select pg_temp.adv_throws(format('update api_private.account_deletion_operations set phase = ''completed'', completed_at = clock_timestamp() where id = %L', pg_temp.adv_id(1021)),
  '23514', 'a requested operation cannot be stamped completed by DML');
select pg_temp.adv_throws(format('update api_private.account_deletion_operations set apple_outcome = ''deleted'', apple_completed_at = clock_timestamp() where id = %L', pg_temp.adv_id(1021)),
  '23514', 'a non-allowlisted Apple outcome is refused at the table');
select pg_temp.adv_throws(format('update api_private.account_deletion_operations set apple_completed_at = clock_timestamp() where id = %L', pg_temp.adv_id(1021)),
  '23514', 'an Apple completion timestamp without an outcome is refused at the table');
select pg_temp.adv_throws(format('update api_private.account_deletion_operations set last_error_code = ''apple invalid_grant user@example.test'' where id = %L', pg_temp.adv_id(1021)),
  '23514', 'free-text provider errors cannot be persisted on the operation');

-- ATTACK 2: the worker RPC surface with wrong or invented outcomes.
set local role service_role;
insert into adv_results values ('lease21', public.confirm_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_challenge(21, 2021), pg_temp.adv_id(1021)));
select pg_temp.adv_assert((select data->>'outcome' = 'claimed' and data->>'appleAction' = 'revoke' from adv_results where name = 'lease21'), 'owner 21 confirmed with a revoke lease');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple'', ''deleted'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'invented Apple outcome is refused by the RPC');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple'', ''not_applicable'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'a stored credential cannot be skipped as not_applicable');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple_unrevocable'', ''revoked'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'apple_unrevocable cannot claim a revocation');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple_unrevocable'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'apple_unrevocable without an outcome is refused');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''external_complete'', ''revoked'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'external_complete with a smuggled Apple outcome is refused');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''completed'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'there is no completed checkpoint a worker can write');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''auth_deleted'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'there is no auth_deleted checkpoint a worker can write');
-- The lease of owner 21 has no authority over owner 22 or 23, whatever it names.
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(22), pg_temp.adv_id(1022),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'lease21'), 'apple', 'revoked')->>'outcome' = 'stale_lease', 'owner 21 lease cannot checkpoint owner 22');
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(22), pg_temp.adv_id(1021),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'lease21'), 'apple', 'revoked')->>'outcome' = 'stale_lease', 'owner 21 operation cannot be checkpointed under owner 22');
select pg_temp.adv_assert(public.fail_account_deletion_operation(pg_temp.adv_id(22), pg_temp.adv_id(1022),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'lease21'), 'apple_cleanup_unavailable')->>'outcome' = 'stale_lease', 'owner 21 lease cannot fail owner 22');
reset role;
select pg_temp.adv_assert((select apple_outcome is null and apple_completed_at is null and attempts = 1
  from api_private.account_deletion_operations where id = pg_temp.adv_id(1021)), 'refused checkpoints leave owner 21 untouched');
select pg_temp.adv_assert((select phase = 'requested' and confirmed_at is null and attempts = 0 and lease_token is null
  from api_private.account_deletion_operations where id = pg_temp.adv_id(1022)), 'cross-owner attempts leave owner 22 untouched');
select pg_temp.adv_assert((select apple_refresh_token_encrypted = 'v1.abcdefghijklmnop.ownerTwentyOneToken' and apple_revoked_at is null
  from public.account_external_credentials where user_id = pg_temp.adv_id(21)), 'refused checkpoints do not touch the stored credential');

-- ATTACK 3: revocation failure path for a real credential — permanent Apple
-- refusal → apple_unrevocable. It must erase the ciphertext, pin the outcome
-- to manual_action_required, and survive a worker restart without reopening.
set local role service_role;
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_id(1021),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'lease21'), 'apple_unrevocable', 'manual_action_required')->>'outcome' = 'checkpointed', 'permanent Apple refusal is checkpointed as unrevocable');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple_unrevocable'', ''manual_action_required'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'apple_unrevocable is not repeatable once the ciphertext is gone');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple'', ''revoked'')',
  pg_temp.adv_id(21), pg_temp.adv_id(1021), (select data->>'leaseToken' from adv_results where name = 'lease21')), '22023', 'a later revoked claim cannot overwrite manual_action_required');
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_id(1021),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'lease21'), 'apple', 'manual_action_required')->>'outcome' = 'checkpointed', 'repeating the pinned outcome is idempotent');
reset role;
select pg_temp.adv_assert((select apple_refresh_token_encrypted is null and apple_token_captured_at is null and apple_revoked_at is null
  from public.account_external_credentials where user_id = pg_temp.adv_id(21)), 'unrevocable credential ciphertext is erased and never marked revoked');
select pg_temp.adv_assert((select apple_refresh_token_encrypted = 'v1.abcdefghijklmnop.ownerTwentyTwoToken'
  from public.account_external_credentials where user_id = pg_temp.adv_id(22)), 'neighbour credential is untouched by owner 21 unrevocable checkpoint');
-- Worker dies here; the lease expires; a restarted worker resumes.
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.adv_id(1021);
set local role service_role;
insert into adv_results values ('resume21', public.claim_account_deletion_work(pg_temp.adv_id(21), pg_temp.adv_id(1021)));
select pg_temp.adv_assert((select data->>'outcome' = 'claimed' and (data->>'appleCompleted')::boolean and data->>'appleAction' = 'manual_action_required'
  and data->>'appleRefreshTokenEncrypted' is null and not (data->>'revenueCatCompleted')::boolean from adv_results where name = 'resume21'),
  'restart after unrevocable resumes with Apple done, no ciphertext, RevenueCat pending');
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_id(1021),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'lease21'), 'revenuecat')->>'outcome' = 'stale_lease', 'the dead worker lease is fenced after resume');
select pg_temp.adv_assert(public.read_account_deletion_status(pg_temp.adv_id(1021), pg_temp.adv_cap(21))->>'state' = 'in_progress', 'status stays in_progress until Auth is actually gone');
select public.checkpoint_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_id(1021), (select (data->>'leaseToken')::uuid from adv_results where name = 'resume21'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_id(1021), (select (data->>'leaseToken')::uuid from adv_results where name = 'resume21'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.adv_id(21), pg_temp.adv_id(1021), (select (data->>'leaseToken')::uuid from adv_results where name = 'resume21'));
select pg_temp.adv_assert(public.read_account_deletion_status(pg_temp.adv_id(1021), pg_temp.adv_cap(21))->>'state' = 'in_progress', 'intent alone is still in_progress, never completed');
select pg_temp.adv_assert(public.read_account_deletion_status(pg_temp.adv_id(1021), pg_temp.adv_cap(21))->'completionReceipt' = 'null'::jsonb, 'no completion receipt before Auth deletion');
reset role;

-- ATTACK 4: delete only owner 21. Every owner-keyed row of 22 and 23 must be
-- byte-for-byte the same count afterwards; every FK-bound row of 21 must be gone.
delete from auth.users where id = pg_temp.adv_id(21);
select pg_temp.adv_assert((select rows_22 = pg_temp.adv_owner_rows(pg_temp.adv_id(22)) from adv_neighbour_before), 'owner 22 row counts are unchanged across every owner-keyed table');
select pg_temp.adv_assert((select rows_23 = pg_temp.adv_owner_rows(pg_temp.adv_id(23)) from adv_neighbour_before), 'owner 23 row counts are unchanged across every owner-keyed table');
do $$
declare v_key text; v_count int; v_left text[] := '{}';
begin
  for v_key, v_count in select key, value::int from jsonb_each_text(pg_temp.adv_owner_rows(pg_temp.adv_id(21))) loop
    if v_count <> 0 and v_key <> 'api_private.account_deletion_operations.owner_id' then v_left := v_left || v_key; end if;
  end loop;
  perform pg_temp.adv_assert(cardinality(v_left) = 0, 'deleted owner leaves no owner-keyed rows outside the receipt: ' || coalesce(array_to_string(v_left, ','), ''));
end;
$$;
select pg_temp.adv_assert((select count(*) from api_private.account_deletion_operations where owner_id = pg_temp.adv_id(21)) = 1, 'exactly one durable receipt row survives for the deleted owner');
select pg_temp.adv_assert((select phase = 'completed' and completed_at = auth_deleted_at and apple_outcome = 'manual_action_required' and lease_token is null
  from api_private.account_deletion_operations where id = pg_temp.adv_id(1021)), 'receipt records manual_action_required, not a fabricated revocation');
select pg_temp.adv_assert(exists (select 1 from public.account_deletion_feedback where user_id is null and reason = 'not_using')
  and exists (select 1 from public.account_deletion_feedback where user_id = pg_temp.adv_id(22)), 'only the deleted owner survey is anonymised');
select pg_temp.adv_assert(exists (select 1 from auth.sessions where user_id = pg_temp.adv_id(22)) and exists (select 1 from auth.identities where user_id = pg_temp.adv_id(22)),
  'neighbour sessions and identities survive');

set local role service_role;
insert into adv_results values ('status21', public.read_account_deletion_status(pg_temp.adv_id(1021), pg_temp.adv_cap(21)));
select pg_temp.adv_assert((select data->>'state' = 'completed' and data->>'appleAuthorizationRevocation' = 'manual_action_required'
  and (data->'completionReceipt'->>'completedAt')::timestamptz is not null
  and (data - array['state', 'completionReceipt', 'appleAuthorizationRevocation']) = '{}'::jsonb
  from adv_results where name = 'status21'), 'completed status carries the receipt and the honest Apple outcome, nothing else');
select pg_temp.adv_assert(public.read_account_deletion_status(pg_temp.adv_id(1022), pg_temp.adv_cap(21)) is null
  and public.read_account_deletion_status(pg_temp.adv_id(1021), pg_temp.adv_cap(22)) is null, 'capabilities never cross owners');
select pg_temp.adv_assert(public.read_account_deletion_status(pg_temp.adv_id(1022), pg_temp.adv_cap(22))->>'state' = 'pending', 'neighbour status is still pending');
select pg_temp.adv_assert(public.read_account_deletion_receipt(pg_temp.adv_id(22), pg_temp.adv_id(1021)) is null, 'neighbour cannot read the deleted owner receipt');
select pg_temp.adv_assert(public.claim_account_deletion_work(pg_temp.adv_id(22), pg_temp.adv_id(1022))->>'outcome' = 'invalid', 'neighbour unconfirmed work is not claimable after the deletion next door');
select pg_temp.adv_assert(public.account_deletion_allows_apple_bootstrap(pg_temp.adv_id(22)), 'neighbour Apple bootstrap remains allowed');
select pg_temp.adv_assert(public.store_account_apple_credential(pg_temp.adv_id(22), 'v1.abcdefghijklmnop.ownerTwentyTwoReplacement')->>'outcome' = 'stored', 'neighbour can still rotate its credential');

-- ATTACK 5: repeated action after completion — every entry point answers with
-- the existing receipt or a refusal, never with a second deletion.
select pg_temp.adv_assert(public.claim_account_deletion_work(pg_temp.adv_id(21), pg_temp.adv_id(1021))->>'outcome' = 'completed', 'recovery claim reads completion');
select pg_temp.adv_assert(public.confirm_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_challenge(21, 2021), pg_temp.adv_id(1021))->>'outcome' in ('completed', 'invalid'),
  'a replayed confirm after completion never claims a new lease');
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(21), pg_temp.adv_id(1031), pg_temp.adv_challenge(21, 2031), pg_temp.adv_cap(31))->>'outcome' = 'user_missing',
  'a fresh request for a deleted owner does not invent a new operation');
select pg_temp.adv_assert(public.set_account_deletion_auth_intent(pg_temp.adv_id(21), pg_temp.adv_id(1021),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'resume21'))->>'outcome' = 'stale_lease', 'the completing lease is released and fenced');
reset role;
select pg_temp.adv_assert((select count(*) from api_private.account_deletion_operations where owner_id = pg_temp.adv_id(21)) = 1, 'replays add no operation rows');

-- ATTACK 6: Google owner without any credential — apple_unrevocable has
-- nothing to erase and must be refused rather than recorded as manual work.
set local role service_role;
insert into adv_results values ('lease23', public.confirm_account_deletion_operation(pg_temp.adv_id(23), pg_temp.adv_challenge(23, 2023), pg_temp.adv_id(1023)));
select pg_temp.adv_assert((select data->>'outcome' = 'claimed' and data->>'appleAction' = 'not_applicable' from adv_results where name = 'lease23'), 'Google owner lease has no Apple action');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple_unrevocable'', ''manual_action_required'')',
  pg_temp.adv_id(23), pg_temp.adv_id(1023), (select data->>'leaseToken' from adv_results where name = 'lease23')), '22023', 'unrevocable checkpoint without a credential is refused');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple'', ''revoked'')',
  pg_temp.adv_id(23), pg_temp.adv_id(1023), (select data->>'leaseToken' from adv_results where name = 'lease23')), '22023', 'a Google owner cannot be reported as Apple-revoked');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L, %L, %L, ''apple'', ''manual_action_required'')',
  pg_temp.adv_id(23), pg_temp.adv_id(1023), (select data->>'leaseToken' from adv_results where name = 'lease23')), '22023', 'a Google owner cannot be reported as needing manual Apple action');
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(23), pg_temp.adv_id(1023),
  (select (data->>'leaseToken')::uuid from adv_results where name = 'lease23'), 'apple', 'not_applicable')->>'outcome' = 'checkpointed', 'Google owner Apple step is not_applicable');
reset role;
select pg_temp.adv_assert(not exists (select 1 from public.account_external_credentials where user_id = pg_temp.adv_id(23)), 'no credential row is invented for a Google owner by the Apple checkpoint');

select 'ADV SQL assertions passed: ' || count(*) from adv_assertions;
rollback;
