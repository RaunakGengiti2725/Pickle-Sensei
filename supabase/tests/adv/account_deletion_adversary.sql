-- INT-deletion-managed-media adversary (attacked HEAD 30a40650).
-- Runs after supabase/tests/shim_auth.sql and every migration in
-- supabase/migrations (fresh history). Read-only against production code:
-- only the service RPC surface is exercised, as the Edge worker would.
--
--   docker exec pickle-adv psql -U postgres -d <db> -v ON_ERROR_STOP=1 \
--     -f /tests/adv/account_deletion_adversary.sql
--
-- ADV-S01 Apple invalid_grant path end to end: a credential Apple refuses is
--         dropped through the 'apple_unrevocable' checkpoint, the operation
--         still reaches a sealed receipt, and the receipt carries
--         manual_action_required (never 'revoked').
-- ADV-S02 Restart mid-deletion after the Apple step: a stale lease cannot
--         re-apply or contradict the Apple outcome; the resumed lease sees the
--         checkpoint and no credential ciphertext.
-- ADV-S03 Out-of-band Auth deletion (support tooling) before intent: the
--         operation becomes 'blocked' with auth_absent_without_ready_intent;
--         no receipt, no completion, and the worker cannot claim it again.
-- ADV-S04 Unknown state is never a receipt: the owner receipt of a superseded
--         request and of an unconfirmed request never reports 'completed'.
\set ON_ERROR_STOP on
\set QUIET on

begin;

create temporary table adv_assertions (name text primary key);
create temporary table adv_results (name text primary key, data jsonb not null);
grant select, insert, update on adv_results to service_role;

create function pg_temp.adv_id(p_number integer) returns uuid
language sql immutable as $$
  select ('0a0a0000-0000-4000-8000-' || lpad(p_number::text, 12, '0'))::uuid
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
    perform pg_temp.adv_assert(v_state = p_state, p_name);
    return;
  end;
  raise exception 'ADV expected denial: %', p_name;
end;
$$;
grant execute on function pg_temp.adv_id(integer), pg_temp.adv_challenge(integer, integer),
  pg_temp.adv_cap(integer), pg_temp.adv_assert(boolean, text), pg_temp.adv_throws(text, text, text)
  to anon, authenticated, service_role;

-- Owners: 1 = Apple user whose token Apple refuses; 2 = Apple user deleted out of band; 3 = Google user.
insert into auth.users (id, email, raw_app_meta_data)
  select pg_temp.adv_id(n), 'adv-test-' || n || '@example.test',
    jsonb_build_object('provider', case when n in (1, 2) then 'apple' else 'google' end)
  from generate_series(1, 3) n;
insert into auth.identities (provider, provider_id, user_id)
  select case when n in (1, 2) then 'apple' else 'google' end,
    'adv-test-identity-' || n, pg_temp.adv_id(n) from generate_series(1, 3) n;

-- ---------------------------------------------------------------------------
-- ADV-S01 / ADV-S02: Apple refuses the stored refresh token (invalid_grant).
-- ---------------------------------------------------------------------------
set local role service_role;
select pg_temp.adv_assert(public.store_account_apple_credential(pg_temp.adv_id(1), 'v1.abcdefghijklmnop.refusedByAppleCiphertext')->>'outcome' = 'stored', 'S01 credential stored before deletion');
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_id(1001), pg_temp.adv_challenge(1,2001), pg_temp.adv_cap(1))->>'outcome' = 'requested', 'S01 request admitted');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where id = pg_temp.adv_id(1001);
set local role service_role;
insert into adv_results values ('s01_claim', public.confirm_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_challenge(1,2001), pg_temp.adv_id(1001)));
select pg_temp.adv_assert((select data->>'outcome' = 'claimed' and data->>'appleAction' = 'revoke'
  and data->>'appleRefreshTokenEncrypted' = 'v1.abcdefghijklmnop.refusedByAppleCiphertext' from adv_results where name = 's01_claim'),
  'S01 first lease carries the ciphertext to revoke');

-- The worker may NOT downgrade a present credential through the ordinary Apple checkpoint...
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L,%L,%L,''apple'',''manual_action_required'')',
  pg_temp.adv_id(1), pg_temp.adv_id(1001), (select data->>'leaseToken' from adv_results where name='s01_claim')), '22023',
  'S01 ordinary apple checkpoint refuses manual fallback while ciphertext exists');
-- ...and may not claim 'revoked' through the unrevocable branch.
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L,%L,%L,''apple_unrevocable'',''revoked'')',
  pg_temp.adv_id(1), pg_temp.adv_id(1001), (select data->>'leaseToken' from adv_results where name='s01_claim')), '22023',
  'S01 apple_unrevocable refuses a revoked outcome');
-- The Apple invalid_grant path: drop the unrevocable credential.
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_id(1001),
  (select (data->>'leaseToken')::uuid from adv_results where name='s01_claim'), 'apple_unrevocable', 'manual_action_required')->>'outcome' = 'checkpointed',
  'S01 apple_unrevocable checkpoint accepted for a refused credential');
reset role;
select pg_temp.adv_assert((select apple_refresh_token_encrypted is null and apple_token_captured_at is null and apple_revoked_at is null
  from public.account_external_credentials where user_id = pg_temp.adv_id(1)), 'S01 refused credential is dropped, never marked revoked');
select pg_temp.adv_assert((select apple_outcome = 'manual_action_required' and apple_completed_at is not null and revenuecat_completed_at is null
  from api_private.account_deletion_operations where id = pg_temp.adv_id(1001)), 'S01 Apple outcome checkpointed as manual_action_required');

-- ADV-S02: process death right after the Apple checkpoint; the lease expires.
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second'
  where id = pg_temp.adv_id(1001);
set local role service_role;
-- The dead worker's lease cannot re-apply or contradict the Apple step.
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_id(1001),
  (select (data->>'leaseToken')::uuid from adv_results where name='s01_claim'), 'apple_unrevocable', 'manual_action_required')->>'outcome' = 'stale_lease',
  'S02 expired lease cannot re-run apple_unrevocable');
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_id(1001),
  (select (data->>'leaseToken')::uuid from adv_results where name='s01_claim'), 'revenuecat')->>'outcome' = 'stale_lease',
  'S02 expired lease cannot advance to RevenueCat');
insert into adv_results values ('s02_resume', public.claim_account_deletion_work(pg_temp.adv_id(1), pg_temp.adv_id(1001)));
select pg_temp.adv_assert((select data->>'outcome' = 'claimed' and (data->>'appleCompleted')::boolean
  and data->>'appleAction' = 'manual_action_required' and data->'appleRefreshTokenEncrypted' = 'null'::jsonb
  and (data->>'revenueCatCompleted')::boolean = false from adv_results where name = 's02_resume'),
  'S02 resumed lease sees the Apple checkpoint and no ciphertext');
-- Re-running the unrevocable branch under the CURRENT lease after completion must be refused, not silently re-applied.
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L,%L,%L,''apple_unrevocable'',''manual_action_required'')',
  pg_temp.adv_id(1), pg_temp.adv_id(1001), (select data->>'leaseToken' from adv_results where name='s02_resume')), '22023',
  'S02 apple_unrevocable cannot be applied twice');
-- The idempotent 'apple' checkpoint with the recorded outcome is a no-op replay, and 'revoked' is refused.
select pg_temp.adv_assert(public.checkpoint_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_id(1001),
  (select (data->>'leaseToken')::uuid from adv_results where name='s02_resume'), 'apple', 'manual_action_required')->>'outcome' = 'checkpointed',
  'S02 recorded Apple outcome replays idempotently');
select pg_temp.adv_throws(format('select public.checkpoint_account_deletion_operation(%L,%L,%L,''apple'',''revoked'')',
  pg_temp.adv_id(1), pg_temp.adv_id(1001), (select data->>'leaseToken' from adv_results where name='s02_resume')), '22023',
  'S02 recorded manual outcome cannot be upgraded to revoked');
select public.checkpoint_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_id(1001), (select (data->>'leaseToken')::uuid from adv_results where name='s02_resume'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.adv_id(1), pg_temp.adv_id(1001), (select (data->>'leaseToken')::uuid from adv_results where name='s02_resume'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.adv_id(1), pg_temp.adv_id(1001), (select (data->>'leaseToken')::uuid from adv_results where name='s02_resume'));
select pg_temp.adv_assert(public.read_account_deletion_receipt(pg_temp.adv_id(1), pg_temp.adv_id(1001))->>'state' = 'in_progress',
  'S02 intent alone is not a completed receipt');
reset role;
delete from auth.users where id = pg_temp.adv_id(1);
set local role service_role;
insert into adv_results values ('s01_receipt', public.read_account_deletion_receipt(pg_temp.adv_id(1), pg_temp.adv_id(1001)));
select pg_temp.adv_assert((select data->>'state' = 'completed' and data->>'appleAuthorizationRevocation' = 'manual_action_required'
  and (data->'completionReceipt'->>'completedAt')::timestamptz <= clock_timestamp()
  and (data - array['state','completionReceipt','appleAuthorizationRevocation']) = '{}'::jsonb
  from adv_results where name = 's01_receipt'), 'S01 sealed receipt reports manual_action_required, never revoked');
select pg_temp.adv_assert(public.read_account_deletion_status(pg_temp.adv_id(1001), pg_temp.adv_cap(1))->>'appleAuthorizationRevocation' = 'manual_action_required',
  'S01 status capability reports the same Apple outcome');
reset role;
select pg_temp.adv_assert(not exists (select 1 from public.account_external_credentials where user_id = pg_temp.adv_id(1)),
  'S01 no credential row survives the cascade');

-- ---------------------------------------------------------------------------
-- ADV-S03: Auth user removed out of band after external cleanup, before intent.
-- ---------------------------------------------------------------------------
set local role service_role;
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(2), pg_temp.adv_id(1002), pg_temp.adv_challenge(2,2002), pg_temp.adv_cap(2))->>'outcome' = 'requested', 'S03 request admitted');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where id = pg_temp.adv_id(1002);
set local role service_role;
insert into adv_results values ('s03_claim', public.confirm_account_deletion_operation(pg_temp.adv_id(2), pg_temp.adv_challenge(2,2002), pg_temp.adv_id(1002)));
select pg_temp.adv_assert((select data->>'outcome' = 'claimed' and data->>'appleAction' = 'manual_action_required' from adv_results where name = 's03_claim'),
  'S03 Apple account without a stored credential takes the manual path');
select public.checkpoint_account_deletion_operation(pg_temp.adv_id(2), pg_temp.adv_id(1002), (select (data->>'leaseToken')::uuid from adv_results where name='s03_claim'), 'apple', 'manual_action_required');
select public.checkpoint_account_deletion_operation(pg_temp.adv_id(2), pg_temp.adv_id(1002), (select (data->>'leaseToken')::uuid from adv_results where name='s03_claim'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.adv_id(2), pg_temp.adv_id(1002), (select (data->>'leaseToken')::uuid from adv_results where name='s03_claim'), 'external_complete');
reset role;
-- Support tooling deletes the Auth user directly: no intent was ever recorded.
delete from auth.users where id = pg_temp.adv_id(2);
select pg_temp.adv_assert((select phase = 'external_complete' and completed_at is null and auth_deleted_at is not null
  and last_error_code = 'auth_absent_without_ready_intent' and lease_token is null
  from api_private.account_deletion_operations where id = pg_temp.adv_id(1002)), 'S03 out-of-band Auth deletion is recorded, never sealed');
set local role service_role;
select pg_temp.adv_assert(public.read_account_deletion_receipt(pg_temp.adv_id(2), pg_temp.adv_id(1002)) =
  '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'S03 receipt reports blocked with no completion');
select pg_temp.adv_assert(public.read_account_deletion_status(pg_temp.adv_id(1002), pg_temp.adv_cap(2))->>'state' = 'blocked', 'S03 status capability reports blocked');
select pg_temp.adv_assert(public.claim_account_deletion_work(pg_temp.adv_id(2), pg_temp.adv_id(1002))->>'outcome' = 'blocked', 'S03 worker cannot claim the blocked operation');
select pg_temp.adv_assert(public.set_account_deletion_auth_intent(pg_temp.adv_id(2), pg_temp.adv_id(1002), (select (data->>'leaseToken')::uuid from adv_results where name='s03_claim'))->>'outcome' = 'stale_lease',
  'S03 late intent from the old lease is refused');
select pg_temp.adv_assert(public.confirm_account_deletion_operation(pg_temp.adv_id(2), pg_temp.adv_challenge(2,2002), pg_temp.adv_id(1002))->>'outcome' = 'blocked',
  'S03 re-confirmation cannot mint completion');
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(2), pg_temp.adv_id(1902), pg_temp.adv_challenge(2,2902), pg_temp.adv_cap(902))->>'outcome' = 'user_missing',
  'S03 new request after out-of-band deletion is refused');

-- ---------------------------------------------------------------------------
-- ADV-S04: superseded / unconfirmed operations never read as completed.
-- ---------------------------------------------------------------------------
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(3), pg_temp.adv_id(1003), pg_temp.adv_challenge(3,2003), pg_temp.adv_cap(3))->>'outcome' = 'requested', 'S04 first request admitted');
select pg_temp.adv_assert(public.begin_account_deletion_operation(pg_temp.adv_id(3), pg_temp.adv_id(1004), pg_temp.adv_challenge(3,2004), pg_temp.adv_cap(4))->>'outcome' = 'requested', 'S04 second request admitted');
select pg_temp.adv_assert(public.read_account_deletion_receipt(pg_temp.adv_id(3), pg_temp.adv_id(1003)) =
  '{"state":"superseded","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'S04 superseded receipt has no completion');
select pg_temp.adv_assert(public.read_account_deletion_receipt(pg_temp.adv_id(3), pg_temp.adv_id(1004)) =
  '{"state":"pending","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb, 'S04 pending receipt has no completion');
select pg_temp.adv_assert(public.claim_account_deletion_work(pg_temp.adv_id(3), pg_temp.adv_id(1003))->>'outcome' = 'invalid', 'S04 superseded operation cannot be claimed');
select pg_temp.adv_assert(public.read_account_deletion_receipt(pg_temp.adv_id(1), pg_temp.adv_id(1004)) is null, 'S04 another owner reads no receipt for this operation');
reset role;
-- Out-of-band Auth deletion of an owner whose operation was never confirmed.
delete from auth.users where id = pg_temp.adv_id(3);
select pg_temp.adv_assert((select completed_at is null and phase = 'requested' and auth_deleted_at is not null
  and last_error_code = 'auth_absent_without_ready_intent' from api_private.account_deletion_operations where id = pg_temp.adv_id(1004)),
  'S04 unconfirmed request never completes on Auth absence');
set local role service_role;
select pg_temp.adv_assert(public.read_account_deletion_receipt(pg_temp.adv_id(3), pg_temp.adv_id(1004))->>'state' = 'blocked', 'S04 unconfirmed request with absent Auth reads blocked');
reset role;

select 'ADV SQL assertions passed: ' || count(*) from adv_assertions;
rollback;
