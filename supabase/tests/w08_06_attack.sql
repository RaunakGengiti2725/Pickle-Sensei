-- W08-06 ADVERSARIAL SQL ATTACKS — candidate devin/pp/w08-06/impl-r4 @ 750da77d.
--
-- Run against a disposable database that has every migration applied
-- (supabase/functions/api/__wf__/xc_pg_up.sh), e.g.
--   docker exec pickle-xc-pg psql -U postgres -v ON_ERROR_STOP=1 -f /tests/w08_06_attack.sql
-- The whole file runs in one transaction and rolls back. An assertion that
-- raises is a confirmed break; a file that reaches ROLLBACK cleanly broke nothing.

\set ON_ERROR_STOP on
\set QUIET on

begin;

create temporary table w0806_results (name text primary key, data jsonb not null);
create temporary table w0806_breaks (seq serial primary key, name text not null);
create temporary table w0806_passed (seq serial primary key, name text not null);
grant select, insert, update on w0806_results, w0806_breaks, w0806_passed to service_role;

create function pg_temp.a_id(p_number integer) returns uuid
language sql immutable as $$
  select ('08060a00-0000-4000-8000-' || lpad(p_number::text, 12, '0'))::uuid
$$;
create function pg_temp.a_challenge(p_owner integer, p_challenge integer) returns bytea
language sql immutable as $$
  select sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/' || pg_temp.a_id(p_owner)::text
    || '/' || pg_temp.a_id(p_challenge)::text, 'UTF8'))
$$;
create function pg_temp.a_cap(p_number integer) returns bytea
language sql immutable as $$ select sha256(convert_to('attack-capability-hash-' || p_number, 'UTF8')) $$;
-- a failed assertion is recorded (so every attack still runs) and reported at the end
create function pg_temp.a_assert(p_condition boolean, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_condition is distinct from true then
    raise warning 'W08-06 ATTACK BREAK: %', p_name;
    insert into pg_temp.w0806_breaks (name) values (p_name);
  else
    insert into pg_temp.w0806_passed (name) values (p_name);
  end if;
end;
$$;
grant execute on function pg_temp.a_id(integer), pg_temp.a_challenge(integer, integer),
  pg_temp.a_cap(integer), pg_temp.a_assert(boolean, text) to anon, authenticated, service_role;

-- owners 1..3 (Google, no Apple credential); every owner namespace holds a row that cascades
insert into auth.users (id, email, raw_app_meta_data)
  select pg_temp.a_id(n), 'w0806-attack-' || n || '@example.test', '{"provider":"google"}'::jsonb
  from generate_series(1, 3) n;
insert into auth.identities (provider, provider_id, user_id)
  select 'google', 'w0806-attack-identity-' || n, pg_temp.a_id(n) from generate_series(1, 3) n;
insert into public.user_saved_drills (user_id, slug) select pg_temp.a_id(n), 'dink-ladder' from generate_series(1, 3) n;

-- one operation per owner, driven by the service to the Auth-delete intent
create function pg_temp.a_request(p_owner integer, p_operation integer, p_challenge integer, p_cap integer)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_temp.a_assert(public.begin_account_deletion_operation(pg_temp.a_id(p_owner), pg_temp.a_id(p_operation),
    pg_temp.a_challenge(p_owner, p_challenge), pg_temp.a_cap(p_cap))->>'outcome' = 'requested', 'request ' || p_operation);
end;
$$;
create function pg_temp.a_confirm_to_intent(p_owner integer, p_operation integer, p_challenge integer)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_claim jsonb; v_lease uuid;
begin
  v_claim := public.confirm_account_deletion_operation(pg_temp.a_id(p_owner), pg_temp.a_challenge(p_owner, p_challenge), pg_temp.a_id(p_operation));
  perform pg_temp.a_assert(v_claim->>'outcome' = 'claimed' and v_claim->>'appleAction' = 'not_applicable', 'claim ' || p_operation);
  v_lease := (v_claim->>'leaseToken')::uuid;
  perform pg_temp.a_assert(public.checkpoint_account_deletion_operation(pg_temp.a_id(p_owner), pg_temp.a_id(p_operation), v_lease, 'apple', 'not_applicable')->>'outcome' = 'checkpointed', 'apple ' || p_operation);
  perform pg_temp.a_assert(public.checkpoint_account_deletion_operation(pg_temp.a_id(p_owner), pg_temp.a_id(p_operation), v_lease, 'revenuecat')->>'outcome' = 'checkpointed', 'revenuecat ' || p_operation);
  perform pg_temp.a_assert(public.checkpoint_account_deletion_operation(pg_temp.a_id(p_owner), pg_temp.a_id(p_operation), v_lease, 'external_complete')->>'outcome' = 'checkpointed', 'external ' || p_operation);
  perform pg_temp.a_assert(public.set_account_deletion_auth_intent(pg_temp.a_id(p_owner), pg_temp.a_id(p_operation), v_lease)->>'outcome' = 'intent_recorded', 'intent ' || p_operation);
  return v_lease;
end;
$$;
grant execute on function pg_temp.a_request(integer, integer, integer, integer),
  pg_temp.a_confirm_to_intent(integer, integer, integer) to service_role;

set local role service_role;
select pg_temp.a_request(1, 101, 201, 1);
select pg_temp.a_request(2, 102, 202, 2);
select pg_temp.a_request(3, 103, 203, 3);
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where id in (pg_temp.a_id(101), pg_temp.a_id(102), pg_temp.a_id(103));
set local role service_role;
insert into w0806_results values ('lease1', to_jsonb(pg_temp.a_confirm_to_intent(1, 101, 201)));
insert into w0806_results values ('lease2', to_jsonb(pg_temp.a_confirm_to_intent(2, 102, 202)));
insert into w0806_results values ('lease3', to_jsonb(pg_temp.a_confirm_to_intent(3, 103, 203)));
reset role;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S1 (boundary: lease age at the Auth delete). The worker is slow: its
-- 120 s lease runs out between recording the Auth-delete intent and the Auth
-- delete actually landing (Auth admin call retried through a 5xx). The trigger
-- sees an EXPIRED lease. Every owner namespace cascades — the deletion is
-- clean — so some shipping path must still be able to certify it.
-- ───────────────────────────────────────────────────────────────────────────
update api_private.account_deletion_operations
  set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.a_id(101);
delete from auth.users where id = pg_temp.a_id(1);
select pg_temp.a_assert(not exists (select 1 from public.user_saved_drills where user_id = pg_temp.a_id(1)), 'S1 owner rows cascaded');
select pg_temp.a_assert((select auth_deleted_at is not null and completed_at is null and phase = 'auth_delete_intent'
  from api_private.account_deletion_operations where id = pg_temp.a_id(101)), 'S1 trigger recorded Auth absence, no receipt');
set local role service_role;
insert into w0806_results values ('s1_certify', public.certify_account_deletion_completion(pg_temp.a_id(1), pg_temp.a_id(101),
  (select (data#>>'{}')::uuid from w0806_results where name = 'lease1')));
insert into w0806_results values ('s1_claim', public.claim_account_deletion_work(pg_temp.a_id(1), pg_temp.a_id(101)));
insert into w0806_results values ('s1_status', public.read_account_deletion_status(pg_temp.a_id(101), pg_temp.a_cap(1)));
select pg_temp.a_assert(
  (select data->>'state' from w0806_results where name = 's1_certify') = 'completed'
    or (select data->>'outcome' from w0806_results where name = 's1_claim') = 'claimed',
  format('S1 a clean deletion whose lease expired before the Auth delete landed can never be certified: certify=%s claim=%s status=%s',
    (select data from w0806_results where name = 's1_certify'),
    (select data from w0806_results where name = 's1_claim'),
    (select data from w0806_results where name = 's1_status')));
reset role;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S2 (cross-account isolation of the new surfaces). Owner 2's retained
-- lease and status capability must not read, certify or fail owner 3's work.
-- ───────────────────────────────────────────────────────────────────────────
delete from auth.users where id in (pg_temp.a_id(2), pg_temp.a_id(3));
set local role service_role;
select pg_temp.a_assert(public.read_account_deletion_status(pg_temp.a_id(103), pg_temp.a_cap(2)) is null, 'S2 capability 2 cannot read operation 3');
select pg_temp.a_assert(public.read_account_deletion_receipt(pg_temp.a_id(2), pg_temp.a_id(103)) is null, 'S2 owner 2 cannot read owner 3 receipt');
select pg_temp.a_assert(public.certify_account_deletion_completion(pg_temp.a_id(3), pg_temp.a_id(103),
  (select (data#>>'{}')::uuid from w0806_results where name = 'lease2'))->>'outcome' = 'stale_lease', 'S2 lease 2 cannot certify operation 3');
select pg_temp.a_assert(public.certify_account_deletion_completion(pg_temp.a_id(2), pg_temp.a_id(103),
  (select (data#>>'{}')::uuid from w0806_results where name = 'lease3'))->>'outcome' = 'stale_lease', 'S2 owner 2 cannot certify operation 3 with lease 3');
select pg_temp.a_assert(public.fail_account_deletion_operation(pg_temp.a_id(3), pg_temp.a_id(103),
  (select (data#>>'{}')::uuid from w0806_results where name = 'lease2'), 'completion_unverified')->>'outcome' = 'stale_lease', 'S2 lease 2 cannot record residue on operation 3');
reset role;
select pg_temp.a_assert((select completed_at is null and last_error_code is null and lease_token is not null
  from api_private.account_deletion_operations where id = pg_temp.a_id(103)), 'S2 operation 3 untouched by owner 2');
-- the genuine lease still certifies exactly once
set local role service_role;
select pg_temp.a_assert(public.certify_account_deletion_completion(pg_temp.a_id(3), pg_temp.a_id(103),
  (select (data#>>'{}')::uuid from w0806_results where name = 'lease3'))->>'state' = 'completed', 'S2 owner 3 certifies with its own lease');
select pg_temp.a_assert(public.certify_account_deletion_completion(pg_temp.a_id(3), pg_temp.a_id(103),
  (select (data#>>'{}')::uuid from w0806_results where name = 'lease3'))->>'outcome' = 'stale_lease', 'S2 spent lease cannot certify twice');
reset role;

-- ───────────────────────────────────────────────────────────────────────────
-- ATTACK S3 (status honesty while a live retained lease is held). Owner 2's
-- worker is mid-sweep: the Auth identity is gone and its lease is live and
-- unexpired. The status poller must not already call the operation `blocked`
-- (the app renders `blocked` as "the server declined to delete this account").
-- ───────────────────────────────────────────────────────────────────────────
select pg_temp.a_assert((select lease_token is not null and lease_expires_at > clock_timestamp() and auth_deleted_at is not null
  and completed_at is null from api_private.account_deletion_operations where id = pg_temp.a_id(102)), 'S3 precondition: live retained lease after Auth delete');
set local role service_role;
insert into w0806_results values ('s3_status', public.read_account_deletion_status(pg_temp.a_id(102), pg_temp.a_cap(2)));
select pg_temp.a_assert((select data->>'state' from w0806_results where name = 's3_status') = 'in_progress',
  format('S3 status during the live sweep reads %s instead of in_progress', (select data from w0806_results where name = 's3_status')));
reset role;

\set QUIET off
select count(*) as assertions_passed from w0806_passed;
select seq, name as confirmed_break from w0806_breaks order by seq;
do $$
declare v_count integer;
begin
  select count(*) into v_count from pg_temp.w0806_breaks;
  if v_count > 0 then raise exception 'W08-06 attack file: % confirmed break(s)', v_count; end if;
end;
$$;

rollback;
