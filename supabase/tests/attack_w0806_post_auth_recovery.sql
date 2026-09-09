-- W08-06 adversarial matrix (attack branch only; not wired into run_rls_tests.sh).
-- Run: psql "$XC_PG_URL" -v ON_ERROR_STOP=1 -f supabase/tests/attack_w0806_post_auth_recovery.sql
-- Every probe records pass/fail into atk_checks; the file exits non-zero at
-- the end when any probe failed so that one run reports every observation.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on

begin;

create temporary table atk_checks (seq serial primary key, name text not null, passed boolean not null, observed text);
-- sequences are non-transactional: they survive the savepoint rollbacks below
create temporary sequence atk_pass_seq;
create temporary sequence atk_fail_seq;
grant usage, select, update on sequence atk_pass_seq, atk_fail_seq to service_role, anon, authenticated;
create temporary table atk_results (name text primary key, data jsonb not null);
grant select, insert, update on atk_results to service_role;
grant select, insert, update on atk_checks to service_role, anon, authenticated;
grant usage, select on sequence atk_checks_seq_seq to service_role, anon, authenticated;

create function pg_temp.atk_id(p_number integer) returns uuid
language sql immutable as $$
  select ('0806a77a-0000-4000-8000-' || lpad(p_number::text, 12, '0'))::uuid
$$;
create function pg_temp.atk_challenge(p_owner integer, p_challenge integer) returns bytea
language sql immutable as $$
  select sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/' || pg_temp.atk_id(p_owner)::text
    || '/' || pg_temp.atk_id(p_challenge)::text, 'UTF8'))
$$;
create function pg_temp.atk_cap(p_number integer) returns bytea
language sql immutable as $$ select sha256(convert_to('attack-capability-hash-' || p_number, 'UTF8')) $$;
create function pg_temp.atk_check(p_condition boolean, p_name text, p_observed text default null) returns text
language plpgsql security definer set search_path = '' as $$
begin
  insert into pg_temp.atk_checks (name, passed, observed) values (p_name, p_condition is true, p_observed);
  perform nextval(case when p_condition is true then 'pg_temp.atk_pass_seq' else 'pg_temp.atk_fail_seq' end);
  return format('%s %s%s', case when p_condition is true then 'ok  ' else 'FAIL' end, p_name,
    case when p_observed is null then '' else ' — observed: ' || p_observed end);
end;
$$;
create function pg_temp.atk_throws(p_sql text, p_state text, p_name text) returns text
language plpgsql security invoker set search_path = '' as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    return pg_temp.atk_check(v_state = p_state, p_name, 'sqlstate ' || v_state);
  end;
  return pg_temp.atk_check(false, p_name, 'no error raised');
end;
$$;
grant execute on function pg_temp.atk_id(integer), pg_temp.atk_challenge(integer, integer),
  pg_temp.atk_cap(integer), pg_temp.atk_check(boolean, text, text), pg_temp.atk_throws(text, text, text)
  to anon, authenticated, service_role;

-- Owners 1..4 are Google identities with one live session each and one scored shot.
insert into auth.users (id, email, raw_app_meta_data)
  select pg_temp.atk_id(n), 'atk-w0806-' || n || '@example.test', '{"provider":"google"}'::jsonb
  from generate_series(1, 4) n;
insert into auth.identities (provider, provider_id, user_id)
  select 'google', 'atk-w0806-identity-' || n, pg_temp.atk_id(n) from generate_series(1, 4) n;
insert into auth.sessions (id, user_id) select pg_temp.atk_id(9000 + n), pg_temp.atk_id(n) from generate_series(1, 4) n;
insert into public.profiles (id, provider, email, display_name)
  select pg_temp.atk_id(n), 'google', 'atk-w0806-' || n || '@example.test', 'ATK' || n from generate_series(1, 4) n
  on conflict (id) do nothing;
create temporary table atk_ledger_before as table public.free_rating_ledger;

-- Drive owner N to the post-Auth phase exactly as the shipping worker does:
-- request → (3 s age) → confirm → apple → revenuecat → external_complete →
-- intent → Auth delete (the trigger records the absence, retains the lease).
create function pg_temp.atk_drive_post_auth(p_owner integer, p_operation integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare v_claim jsonb; v_lease uuid;
begin
  set local role service_role;
  perform public.begin_account_deletion_operation(pg_temp.atk_id(p_owner), pg_temp.atk_id(p_operation),
    pg_temp.atk_challenge(p_owner, p_operation + 1000), pg_temp.atk_cap(p_operation));
  reset role;
  update api_private.account_deletion_operations
    set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
      status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
    where id = pg_temp.atk_id(p_operation);
  set local role service_role;
  v_claim := public.confirm_account_deletion_operation(pg_temp.atk_id(p_owner),
    pg_temp.atk_challenge(p_owner, p_operation + 1000), pg_temp.atk_id(p_operation));
  if v_claim->>'outcome' <> 'claimed' then raise exception 'drive: confirm answered %', v_claim; end if;
  v_lease := (v_claim->>'leaseToken')::uuid;
  perform public.checkpoint_account_deletion_operation(pg_temp.atk_id(p_owner), pg_temp.atk_id(p_operation), v_lease, 'apple', 'not_applicable');
  perform public.checkpoint_account_deletion_operation(pg_temp.atk_id(p_owner), pg_temp.atk_id(p_operation), v_lease, 'revenuecat');
  perform public.checkpoint_account_deletion_operation(pg_temp.atk_id(p_owner), pg_temp.atk_id(p_operation), v_lease, 'external_complete');
  perform public.set_account_deletion_auth_intent(pg_temp.atk_id(p_owner), pg_temp.atk_id(p_operation), v_lease);
  reset role;
  delete from auth.users where id = pg_temp.atk_id(p_owner);
  return v_lease;
end;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S1 — process death after the Auth delete, then the shipping app's
-- only re-entry point (POST /v1/me/delete-confirm) is gated on a LIVE session.
-- ───────────────────────────────────────────────────────────────────────────
insert into atk_results values ('s1_lease', to_jsonb(pg_temp.atk_drive_post_auth(1, 101)));
select pg_temp.atk_check((select auth_deleted_at is not null and completed_at is null and phase = 'auth_delete_intent'
  and lease_token = (select (data#>>'{}')::uuid from atk_results where name = 's1_lease')
  from api_private.account_deletion_operations where id = pg_temp.atk_id(101)),
  'S1 precondition: Auth gone, lease retained, no receipt');

-- the worker dies here: nothing releases the lease; it expires 120 s later
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second'
  where id = pg_temp.atk_id(101);

-- the deleting user's own JWT no longer satisfies the confirm route's live-session recheck
savepoint s1_session;
do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub', pg_temp.atk_id(1)::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.atk_id(1), 'session_id', pg_temp.atk_id(9001))::text, true);
end $$;
select pg_temp.atk_check(public.is_api_session_active() is not true,
  'S1 the deleted owner''s session is dead: is_api_session_active() is false after the Auth delete',
  coalesce(public.is_api_session_active()::text, 'null'));
rollback to s1_session;

-- the database WOULD hand the phase back to the shipping confirm path ...
savepoint s1_db_path;
set local role service_role;
insert into atk_results values ('s1_reconfirm', public.confirm_account_deletion_operation(pg_temp.atk_id(1),
  pg_temp.atk_challenge(1, 1101), pg_temp.atk_id(101)));
select pg_temp.atk_check((select data->>'outcome' = 'claimed' and (data->>'authDeleted')::boolean from atk_results where name = 's1_reconfirm'),
  'S1 database: confirm_account_deletion_operation re-acquires the expired post-Auth lease (authDeleted=true)',
  (select data->>'outcome' from atk_results where name = 's1_reconfirm'));
rollback to s1_db_path;
-- ... but the Edge confirm route refuses before reaching it (verifyLiveSession → false → 401 session_invalid;
-- proven in supabase/functions/api/__wf__/attack_w0806_post_auth_reachability.test.ts). Meanwhile /delete-status
-- keeps promising progress although no worker exists and none can be started by the app:
set local role service_role;
select pg_temp.atk_check(public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))->>'state' = 'in_progress',
  'S1 observed: an orphaned expired post-Auth lease reads in_progress to the client',
  public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))::text);
reset role;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S2 — corrupt/partial state: the identity is recreated under the same
-- uuid while the post-Auth phase is orphaned. Acquisition refuses (blocked),
-- certification refuses (stale_lease) — but what does the client read?
-- ───────────────────────────────────────────────────────────────────────────
savepoint s2;
insert into auth.users (id, email, raw_app_meta_data) values (pg_temp.atk_id(1), 'atk-w0806-1b@example.test', '{"provider":"google"}');
set local role service_role;
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))->>'outcome' = 'blocked',
  'S2 a recreated identity cannot re-acquire the post-Auth phase');
select pg_temp.atk_check(public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(101),
  (select (data#>>'{}')::uuid from atk_results where name = 's1_lease'))->>'outcome' = 'stale_lease',
  'S2 a recreated identity cannot be certified deleted');
select pg_temp.atk_check(public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))->>'state' = 'blocked',
  'S2 /delete-status is honest for a recreated identity (blocked, since nothing can ever certify it)',
  public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))::text);
reset role;
rollback to s2;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S3 — boundary: the attempt budget at exactly 8 and 7, the status
-- window at exactly its edge, and the lease clamp to status_expires_at.
-- ───────────────────────────────────────────────────────────────────────────
savepoint s3;
update api_private.account_deletion_operations set attempts = 8 where id = pg_temp.atk_id(101);
set local role service_role;
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))->>'outcome' = 'blocked',
  'S3 attempts=8 with an expired post-Auth lease: acquisition refused');
select pg_temp.atk_check(public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))->>'state' = 'blocked',
  'S3 attempts=8 with an expired post-Auth lease: status reads blocked',
  public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))::text);
reset role;
update api_private.account_deletion_operations set attempts = 7 where id = pg_temp.atk_id(101);
set local role service_role;
insert into atk_results values ('s3_last', public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101)));
select pg_temp.atk_check((select data->>'outcome' = 'claimed' from atk_results where name = 's3_last'),
  'S3 attempts=7: the last budgeted post-Auth acquisition is issued');
reset role;
select pg_temp.atk_check((select attempts = 8 from api_private.account_deletion_operations where id = pg_temp.atk_id(101)),
  'S3 the last acquisition spends the eighth attempt (constraint 0..8 holds)');
set local role service_role;
select pg_temp.atk_check(public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(101),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's3_last'), 'completion_unverified')->>'outcome' = 'released',
  'S3 the eighth sweep records its residue verdict');
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))->>'outcome' = 'blocked',
  'S3 no ninth acquisition');
select pg_temp.atk_check(public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb,
  'S3 exhausted budget with a verdict reads blocked, no receipt');
reset role;
rollback to s3;

savepoint s3b;
-- the 24 h status window: shift the row so status_expires_at is 1 s in the past
update api_private.account_deletion_operations
  set created_at = created_at - interval '24 hours', challenge_expires_at = challenge_expires_at - interval '24 hours',
    status_expires_at = status_expires_at - interval '24 hours', retain_until = retain_until - interval '24 hours',
    lease_expires_at = null, lease_token = null
  where id = pg_temp.atk_id(101);
set local role service_role;
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))->>'outcome' = 'blocked',
  'S3 status window elapsed: no post-Auth acquisition');
select pg_temp.atk_check(public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101)) is null,
  'S3 status window elapsed: the capability no longer reads anything');
select pg_temp.atk_check(public.read_account_deletion_receipt(pg_temp.atk_id(1), pg_temp.atk_id(101))->>'state' = 'blocked',
  'S3 status window elapsed: the owner receipt read says blocked, not completed',
  public.read_account_deletion_receipt(pg_temp.atk_id(1), pg_temp.atk_id(101))::text);
reset role;
rollback to s3b;

savepoint s3c;
-- the lease clamp: 30 s of status window left → lease_expires_at = status_expires_at, never beyond it
update api_private.account_deletion_operations
  set created_at = created_at - interval '23 hours 59 minutes 30 seconds',
    challenge_expires_at = challenge_expires_at - interval '23 hours 59 minutes 30 seconds',
    status_expires_at = status_expires_at - interval '23 hours 59 minutes 30 seconds',
    retain_until = retain_until - interval '23 hours 59 minutes 30 seconds'
  where id = pg_temp.atk_id(101);
set local role service_role;
insert into atk_results values ('s3_clamp', public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101)));
select pg_temp.atk_check((select data->>'outcome' = 'claimed' from atk_results where name = 's3_clamp'),
  'S3 a post-Auth acquisition inside the last 30 s of the window is still issued');
reset role;
select pg_temp.atk_check((select lease_expires_at = status_expires_at from api_private.account_deletion_operations where id = pg_temp.atk_id(101)),
  'S3 the post-Auth lease is clamped to status_expires_at');
rollback to s3c;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S4 — replay / exactly-once: certify, then replay every verb.
-- ───────────────────────────────────────────────────────────────────────────
savepoint s4;
set local role service_role;
insert into atk_results values ('s4_claim', public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101)));
insert into atk_results values ('s4_certified', public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(101),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's4_claim')));
select pg_temp.atk_check((select data->>'state' = 'completed' and data->'completionReceipt'->>'completedAt' is not null from atk_results where name = 's4_certified'),
  'S4 a clean sweep under a re-acquired lease certifies');
select pg_temp.atk_check(public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(101),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's4_claim'))->>'outcome' = 'stale_lease',
  'S4 replaying certify with the spent lease is refused');
select pg_temp.atk_check(public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(101),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's4_claim'), 'completion_unverified')->>'outcome' = 'stale_lease',
  'S4 a late residue verdict cannot un-certify a receipt');
select pg_temp.atk_check(public.set_account_deletion_auth_intent(pg_temp.atk_id(1), pg_temp.atk_id(101),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's4_claim'))->>'outcome' = 'stale_lease',
  'S4 a late intent write cannot touch a certified row');
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))->>'outcome' = 'completed',
  'S4 a later worker reads the receipt instead of a lease');
reset role;
select pg_temp.atk_check((select o.completed_at = (r.data->'completionReceipt'->>'completedAt')::timestamptz and o.lease_token is null
  and o.attempts = 2 and o.last_error_code is null
  from api_private.account_deletion_operations o, atk_results r where o.id = pg_temp.atk_id(101) and r.name = 's4_certified'),
  'S4 the receipt does not move under replay');
select pg_temp.atk_check(not exists ((table public.free_rating_ledger except table atk_ledger_before)
  union all (table atk_ledger_before except table public.free_rating_ledger)),
  'S4 free-rating identity ledger unchanged through post-Auth recovery + certification');
rollback to s4;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S5 — cross-owner / cross-operation binding on the post-Auth surfaces.
-- ───────────────────────────────────────────────────────────────────────────
savepoint s5;
insert into atk_results values ('s5_lease', to_jsonb(pg_temp.atk_drive_post_auth(2, 102)));
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second'
  where id in (pg_temp.atk_id(101), pg_temp.atk_id(102));
set local role service_role;
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(2), pg_temp.atk_id(101))->>'outcome' = 'invalid',
  'S5 owner 2 cannot claim owner 1''s post-Auth phase');
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(102))->>'outcome' = 'invalid',
  'S5 owner 1''s binding cannot claim owner 2''s operation');
insert into atk_results values ('s5_claim1', public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101)));
select pg_temp.atk_check(public.certify_account_deletion_completion(pg_temp.atk_id(2), pg_temp.atk_id(102),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's5_claim1'))->>'outcome' = 'stale_lease',
  'S5 owner 1''s fresh lease certifies nothing for owner 2');
select pg_temp.atk_check(public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(102),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's5_claim1'))->>'outcome' = 'stale_lease',
  'S5 owner 1''s lease cannot certify another operation');
select pg_temp.atk_check(public.certify_account_deletion_completion(pg_temp.atk_id(2), pg_temp.atk_id(101),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's5_claim1'))->>'outcome' = 'stale_lease',
  'S5 the lease with a swapped owner certifies nothing');
select pg_temp.atk_check(public.fail_account_deletion_operation(pg_temp.atk_id(2), pg_temp.atk_id(102),
  (select (data->>'leaseToken')::uuid from atk_results where name = 's5_claim1'), 'completion_unverified')->>'outcome' = 'stale_lease',
  'S5 owner 1''s lease records no verdict on owner 2');
reset role;
select pg_temp.atk_check((select count(*) = 0 from api_private.account_deletion_operations where completed_at is not null
  and id in (pg_temp.atk_id(101), pg_temp.atk_id(102))), 'S5 no receipt was minted by any cross probe');
rollback to s5;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S6 — unauthorized roles on every post-Auth surface (allowed + denied).
-- ───────────────────────────────────────────────────────────────────────────
savepoint s6;
set local role anon;
select pg_temp.atk_throws('select public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))', '42501', 'S6 anon cannot claim post-Auth work');
select pg_temp.atk_throws('select public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(101), gen_random_uuid())', '42501', 'S6 anon cannot certify');
select pg_temp.atk_throws('select public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(101), gen_random_uuid(), ''completion_unverified'')', '42501', 'S6 anon cannot record a verdict');
select pg_temp.atk_throws('select public.read_account_deletion_receipt(pg_temp.atk_id(1), pg_temp.atk_id(101))', '42501', 'S6 anon cannot read receipts');
select pg_temp.atk_throws('select public.read_account_deletion_status(pg_temp.atk_id(101), pg_temp.atk_cap(101))', '42501', 'S6 anon cannot read status');
reset role;
set session authorization authenticated;
set local request.jwt.claim.role = 'service_role';
select pg_temp.atk_throws('select public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))', '42501', 'S6 forged service claim cannot claim post-Auth work');
select pg_temp.atk_throws('select public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(101), gen_random_uuid())', '42501', 'S6 forged service claim cannot certify');
select pg_temp.atk_throws('select public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(101), gen_random_uuid(), ''completion_unverified'')', '42501', 'S6 forged service claim cannot record a verdict');
select pg_temp.atk_throws('select public.set_account_deletion_auth_intent(pg_temp.atk_id(1), pg_temp.atk_id(101), gen_random_uuid())', '42501', 'S6 forged service claim cannot write intent');
select pg_temp.atk_throws('select api_private.acquire_account_deletion_lease(pg_temp.atk_id(1), pg_temp.atk_id(101))', '42501', 'S6 user cannot call the private acquire helper');
select pg_temp.atk_throws('select * from api_private.account_deletion_operations', '42501', 'S6 user cannot read the operations table');
select pg_temp.atk_throws('set local role service_role', '42501', 'S6 user cannot escalate');
reset session authorization;
set local role service_role;
select pg_temp.atk_throws('select api_private.acquire_account_deletion_lease(pg_temp.atk_id(1), pg_temp.atk_id(101))', '42501', 'S6 service cannot call the private acquire helper directly');
select pg_temp.atk_throws('select api_private.lock_account_deletion_lease(pg_temp.atk_id(1), pg_temp.atk_id(101), gen_random_uuid())', '42501', 'S6 service cannot call the private lease lock');
select pg_temp.atk_throws('select api_private.lock_account_deletion_certification(pg_temp.atk_id(1), pg_temp.atk_id(101), gen_random_uuid())', '42501', 'S6 service cannot call the private certification lock');
select pg_temp.atk_throws('select api_private.account_deletion_view(o) from api_private.account_deletion_operations o', '42501', 'S6 service cannot read rows / call the view helper');
select pg_temp.atk_throws('update api_private.account_deletion_operations set auth_deleted_at = null', '42501', 'S6 service cannot erase the Auth-absence mark by DML');
select pg_temp.atk_throws('update api_private.account_deletion_operations set attempts = 0', '42501', 'S6 service cannot refill the attempt budget by DML');
select pg_temp.atk_throws('update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() + interval ''1 hour''', '42501', 'S6 service cannot extend a lease by DML');
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(1), pg_temp.atk_id(101))->>'outcome' in ('claimed', 'busy'),
  'S6 allowed path: the service role may claim post-Auth work');
reset role;
rollback to s6;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S7 — "lost Auth-delete response" variant: the worker records
-- auth_delete_unavailable against the retained lease, releases it, and the
-- shipping app has no live session to re-enter. Status must not claim progress
-- and must not claim completion.
-- ───────────────────────────────────────────────────────────────────────────
savepoint s7;
insert into atk_results values ('s7_lease', to_jsonb(pg_temp.atk_drive_post_auth(3, 103)));
set local role service_role;
select pg_temp.atk_check(public.fail_account_deletion_operation(pg_temp.atk_id(3), pg_temp.atk_id(103),
  (select (data#>>'{}')::uuid from atk_results where name = 's7_lease'), 'auth_delete_unavailable')->>'outcome' = 'released',
  'S7 the lost Auth-delete verdict is recorded against the retained lease');
select pg_temp.atk_check(public.read_account_deletion_status(pg_temp.atk_id(103), pg_temp.atk_cap(103))
  = '{"state":"blocked","completionReceipt":null,"appleAuthorizationRevocation":null}'::jsonb,
  'S7 after the verdict the client reads blocked, no receipt');
select pg_temp.atk_check(public.certify_account_deletion_completion(pg_temp.atk_id(3), pg_temp.atk_id(103),
  (select (data#>>'{}')::uuid from atk_results where name = 's7_lease'))->>'outcome' = 'stale_lease',
  'S7 the released lease certifies nothing');
select pg_temp.atk_check(public.claim_account_deletion_work(pg_temp.atk_id(3), pg_temp.atk_id(103))->>'outcome' = 'claimed',
  'S7 the phase is re-acquirable by a service worker (the database side of recovery exists)');
reset role;
rollback to s7;

-- ─── report ─────────────────────────────────────────────────────────────────
select format('W08-06 ATTACK SQL: %s passed, %s failed',
  (select case when is_called then last_value else 0 end from atk_pass_seq),
  (select case when is_called then last_value else 0 end from atk_fail_seq));
select (case when is_called then last_value else 0 end)::text as atk_failed from atk_fail_seq \gset
rollback;
-- carry the tally past the rollback so S8 still runs and the exit code reflects every section
select set_config('atk.failed', :'atk_failed', false) as atk_carry \gset

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S8 — genuine concurrency: two service workers race to re-acquire the
-- same expired post-Auth lease; exactly one may be claimed. Then two workers
-- race to certify with the one live lease; exactly one receipt.
-- Runs on committed state (dblink sessions) and cleans up after itself.
-- ───────────────────────────────────────────────────────────────────────────
drop schema if exists atk_probe cascade;
create schema atk_probe;
create extension if not exists dblink with schema atk_probe;
set search_path = pg_catalog, atk_probe;
create function atk_probe.await_lock(p_application text)
returns void language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then return; end if;
    if clock_timestamp() > deadline then raise exception 'W08-06 ATTACK S8: expected database lock was not observed'; end if;
    perform pg_sleep(0.01);
  end loop;
end $$;
create function atk_probe.collect(p_connection text)
returns jsonb language plpgsql set search_path = pg_catalog, atk_probe as $$
declare result jsonb;
begin
  select value into result from dblink_get_result(p_connection) as r(value jsonb);
  perform 1 from dblink_get_result(p_connection) as r(value jsonb);
  return result;
end $$;

-- committed setup (each statement autocommits so no advisory lock is held
-- by this session while the dblink workers race)
delete from api_private.account_deletion_operations where id = '0806a77a-0000-4000-8000-000000000191';
delete from auth.users where id = '0806a77a-0000-4000-8000-000000000091';
insert into auth.users (id, email, raw_app_meta_data) values ('0806a77a-0000-4000-8000-000000000091', 'atk-race@example.test', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id) values ('google', 'atk-race-identity', '0806a77a-0000-4000-8000-000000000091');
set role service_role;
select public.begin_account_deletion_operation('0806a77a-0000-4000-8000-000000000091', '0806a77a-0000-4000-8000-000000000191',
  sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/0806a77a-0000-4000-8000-000000000091/0806a77a-0000-4000-8000-000000001191', 'UTF8')),
  sha256(convert_to('attack-race-cap', 'UTF8')))->>'outcome' as race_setup_begin;
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where id = '0806a77a-0000-4000-8000-000000000191';
create temporary table atk_race_lease as
  select null::uuid as lease where false;
grant select, insert on atk_race_lease to service_role;
set role service_role;
insert into atk_race_lease select (public.confirm_account_deletion_operation('0806a77a-0000-4000-8000-000000000091',
  sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/0806a77a-0000-4000-8000-000000000091/0806a77a-0000-4000-8000-000000001191', 'UTF8')),
  '0806a77a-0000-4000-8000-000000000191')->>'leaseToken')::uuid;
select public.checkpoint_account_deletion_operation('0806a77a-0000-4000-8000-000000000091', '0806a77a-0000-4000-8000-000000000191', (select lease from atk_race_lease), 'apple', 'not_applicable')->>'outcome' as race_setup_apple;
select public.checkpoint_account_deletion_operation('0806a77a-0000-4000-8000-000000000091', '0806a77a-0000-4000-8000-000000000191', (select lease from atk_race_lease), 'revenuecat')->>'outcome' as race_setup_revenuecat;
select public.checkpoint_account_deletion_operation('0806a77a-0000-4000-8000-000000000091', '0806a77a-0000-4000-8000-000000000191', (select lease from atk_race_lease), 'external_complete')->>'outcome' as race_setup_external;
select public.set_account_deletion_auth_intent('0806a77a-0000-4000-8000-000000000091', '0806a77a-0000-4000-8000-000000000191', (select lease from atk_race_lease))->>'outcome' as race_setup_intent;
reset role;
delete from auth.users where id = '0806a77a-0000-4000-8000-000000000091';
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = '0806a77a-0000-4000-8000-000000000191';

do $$
<<race>>
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  c text;
  owner_id uuid := '0806a77a-0000-4000-8000-000000000091';
  operation_id uuid := '0806a77a-0000-4000-8000-000000000191';
  first_result jsonb; second_result jsonb; lease uuid; receipts integer;
begin
  if not exists (select 1 from api_private.account_deletion_operations where id = operation_id and auth_deleted_at is not null
    and phase = 'auth_delete_intent' and completed_at is null and lease_expires_at <= clock_timestamp()) then
    raise exception 'W08-06 ATTACK S8: race setup did not reach the expired post-Auth phase';
  end if;
  foreach c in array array['atk_first','atk_second'] loop
    perform dblink_connect(c, connection || ' application_name=' || c);
    perform dblink_exec(c, 'set statement_timeout = ''5s''');
  end loop;
  -- race 1: two re-acquisitions of the expired post-Auth lease
  perform dblink_exec('atk_first', 'begin; set local role service_role');
  select value into first_result from dblink('atk_first', format('select public.claim_account_deletion_work(%L::uuid,%L::uuid)', owner_id, operation_id)) as r(value jsonb);
  perform dblink_exec('atk_second', 'begin; set local role service_role');
  perform dblink_send_query('atk_second', format('select public.claim_account_deletion_work(%L::uuid,%L::uuid)', owner_id, operation_id));
  perform atk_probe.await_lock('atk_second');
  perform dblink_exec('atk_first', 'commit');
  second_result := atk_probe.collect('atk_second');
  perform dblink_exec('atk_second', 'commit');
  if first_result->>'outcome' <> 'claimed' or (first_result->>'authDeleted')::boolean is not true
    or second_result->>'outcome' <> 'busy' or second_result->>'operationId' <> operation_id::text then
    raise exception 'W08-06 ATTACK S8: post-Auth re-acquisition race must yield exactly one lease, got % / %', first_result, second_result;
  end if;
  if (select attempts from api_private.account_deletion_operations where id = operation_id) <> 2 then
    raise exception 'W08-06 ATTACK S8: the losing worker must not spend an attempt';
  end if;
  lease := (first_result->>'leaseToken')::uuid;
  -- race 2: two certifications with the same live lease
  perform dblink_exec('atk_first', 'begin; set local role service_role');
  select value into first_result from dblink('atk_first', format('select public.certify_account_deletion_completion(%L::uuid,%L::uuid,%L::uuid)', owner_id, operation_id, lease)) as r(value jsonb);
  perform dblink_exec('atk_second', 'begin; set local role service_role');
  perform dblink_send_query('atk_second', format('select public.certify_account_deletion_completion(%L::uuid,%L::uuid,%L::uuid)', owner_id, operation_id, lease));
  perform atk_probe.await_lock('atk_second');
  perform dblink_exec('atk_first', 'commit');
  second_result := atk_probe.collect('atk_second');
  perform dblink_exec('atk_second', 'commit');
  if first_result->>'state' <> 'completed' or second_result->>'outcome' <> 'stale_lease' then
    raise exception 'W08-06 ATTACK S8: concurrent certification must mint exactly one receipt, got % / %', first_result, second_result;
  end if;
  select count(*) into receipts from api_private.account_deletion_operations where id = operation_id and completed_at is not null and lease_token is null;
  if receipts <> 1 then raise exception 'W08-06 ATTACK S8: receipt row state wrong'; end if;
  raise notice 'W08-06 ATTACK S8: concurrent post-Auth re-acquisition and certification races passed';
  foreach c in array array['atk_first','atk_second'] loop perform dblink_disconnect(c); end loop;
  delete from api_private.account_deletion_operations where id = operation_id;
end $$;
reset search_path;
drop schema atk_probe cascade;
\echo W08-06 ATTACK SQL: S8 concurrency passed
do $$
begin
  if current_setting('atk.failed')::bigint > 0 then
    raise exception 'W08-06 ATTACK SQL: % probe(s) failed (see FAIL lines above)', current_setting('atk.failed');
  end if;
end $$;
\echo W08-06 ATTACK SQL: ALL PROBES PASSED
