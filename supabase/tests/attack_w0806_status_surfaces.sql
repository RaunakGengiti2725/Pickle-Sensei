-- W08-06 adversary (candidate 004c69f3): the new SQL surfaces of the post-Auth
-- status settlement — public.claim_account_deletion_status_work,
-- public.read_account_deletion_owner_residue and
-- api_private.account_deletion_owner_namespaces — at their authorization,
-- binding, replay and clock boundaries. Allowed AND denied paths.
--
--   docker exec -i <container> psql -U postgres -v ON_ERROR_STOP=1 -f supabase/tests/attack_w0806_status_surfaces.sql
--
-- Runs inside one transaction that is rolled back; assertions raise on failure
-- (psql exits 3 under ON_ERROR_STOP).
\set ON_ERROR_STOP on
\set QUIET on

begin;

create temporary table atk_assertions (name text primary key);
create temporary table atk_results (name text primary key, data jsonb not null);
grant select, insert, update on atk_results to service_role;

create function pg_temp.atk_id(p_number integer) returns uuid
language sql immutable as $$
  select ('0806a000-0000-4000-8000-' || lpad(p_number::text, 12, '0'))::uuid
$$;
create function pg_temp.atk_challenge(p_owner integer, p_challenge integer) returns bytea
language sql immutable as $$
  select sha256(convert_to('pickle-sensei/account-deletion/challenge/v1/' || pg_temp.atk_id(p_owner)::text
    || '/' || pg_temp.atk_id(p_challenge)::text, 'UTF8'))
$$;
create function pg_temp.atk_cap(p_number integer) returns bytea
language sql immutable as $$ select sha256(convert_to('attack-capability-hash-' || p_number, 'UTF8')) $$;
create function pg_temp.atk_assert(p_condition boolean, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_condition is distinct from true then raise exception 'W08-06 ATTACK failure: %', p_name; end if;
  insert into pg_temp.atk_assertions values (p_name);
end;
$$;
create function pg_temp.atk_throws(p_sql text, p_state text, p_name text) returns void
language plpgsql security invoker set search_path = '' as $$
declare v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    perform pg_temp.atk_assert(v_state = p_state, p_name || ' (got ' || v_state || ')');
    return;
  end;
  raise exception 'W08-06 ATTACK expected denial: %', p_name;
end;
$$;
grant execute on function pg_temp.atk_id(integer), pg_temp.atk_challenge(integer, integer),
  pg_temp.atk_cap(integer), pg_temp.atk_assert(boolean, text), pg_temp.atk_throws(text, text, text)
  to anon, authenticated, service_role;

-- Owners 1 and 2 are Google sign-ins with data in several namespaces.
insert into auth.users (id, email, raw_app_meta_data)
  select pg_temp.atk_id(n), 'w0806-attack-' || n || '@example.test', '{"provider":"google"}'::jsonb
  from generate_series(1, 2) n;
insert into auth.identities (provider, provider_id, user_id)
  select 'google', 'w0806-attack-identity-' || n, pg_temp.atk_id(n) from generate_series(1, 2) n;
insert into auth.sessions (id, user_id) values (pg_temp.atk_id(9001), pg_temp.atk_id(1));
insert into public.profiles (id, provider, email, display_name)
  select pg_temp.atk_id(n), 'google', 'w0806-attack-' || n || '@example.test', 'ATK' || n
  from generate_series(1, 2) n on conflict (id) do nothing;
insert into public.sessions (id, user_id, kind, started_at)
  select pg_temp.atk_id(7000 + n), pg_temp.atk_id(n), 'practice', now() from generate_series(1, 2) n;
insert into public.user_saved_drills (user_id, slug)
  select pg_temp.atk_id(n), 'dink-ladder' from generate_series(1, 2) n;
insert into public.free_rating_ledger (identity_hash, scored_count)
  values (public.free_rating_identity_hash('google', 'w0806-attack-identity-1'), 2)
  on conflict (identity_hash) do update set scored_count = 2;
create temporary table atk_ledger as select * from public.free_rating_ledger order by identity_hash;

-- ─── S1: authorization matrix for the new surfaces (denied paths) ─────────────
set session authorization authenticated;
set local request.jwt.claim.sub = '0806a000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';
select pg_temp.atk_throws('select public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1))', '42501',
  'S1 the owner cannot claim status work with their own capability hash');
select pg_temp.atk_throws('select public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1001), gen_random_uuid())', '42501',
  'S1 the owner cannot count their own residue');
select pg_temp.atk_throws('select * from api_private.account_deletion_owner_namespaces()', '42501',
  'S1 the owner cannot enumerate the owner-namespace catalog');
select pg_temp.atk_throws('select public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), gen_random_uuid(), ''completion_unverified'')', '42501',
  'S1 the owner cannot record a completion verdict');
reset session authorization;
set local role anon;
select pg_temp.atk_throws('select public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1))', '42501',
  'S1 anon cannot claim status work');
select pg_temp.atk_throws('select public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1001), gen_random_uuid())', '42501',
  'S1 anon cannot count residue');
select pg_temp.atk_throws('select * from api_private.account_deletion_owner_namespaces()', '42501',
  'S1 anon cannot enumerate the owner-namespace catalog');
reset role;
set local role service_role;
select pg_temp.atk_throws('select * from api_private.account_deletion_owner_namespaces()', '42501',
  'S1 service cannot call the private catalog helper directly');
select pg_temp.atk_throws('select api_private.lock_account_deletion_certification(pg_temp.atk_id(1), pg_temp.atk_id(1001), gen_random_uuid())', '42501',
  'S1 service cannot call the private certification lock directly');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1))->>'outcome' = 'invalid',
  'S1 service claim of an unknown operation invents nothing');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(null, pg_temp.atk_cap(1))->>'outcome' = 'invalid',
  'S1 null operation id is invalid');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1001), null)->>'outcome' = 'invalid',
  'S1 null capability hash is invalid');
select pg_temp.atk_assert(public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1001), gen_random_uuid())->>'outcome' = 'stale_lease',
  'S1 residue read without a lease reveals nothing');
select pg_temp.atk_assert(public.read_account_deletion_owner_residue(null, null, null)->>'outcome' = 'stale_lease',
  'S1 residue read with null binding reveals nothing');
reset role;

-- ─── Build a genuine post-Auth row for owner 1 through the shipped RPCs ───────
set local role service_role;
select pg_temp.atk_assert(public.begin_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), pg_temp.atk_challenge(1, 2001), pg_temp.atk_cap(1))->>'outcome' = 'requested', 'setup: requested');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where id = pg_temp.atk_id(1001);
set local role service_role;
insert into atk_results values ('lease', public.confirm_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_challenge(1, 2001), pg_temp.atk_id(1001)));
select pg_temp.atk_assert((select data->>'outcome' = 'claimed' and data->>'appleAction' = 'not_applicable' from atk_results where name = 'lease'), 'setup: confirmed and leased');
select pg_temp.atk_assert(public.checkpoint_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease'), 'apple', 'not_applicable')->>'outcome' = 'checkpointed', 'setup: apple');
select pg_temp.atk_assert(public.checkpoint_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease'), 'revenuecat')->>'outcome' = 'checkpointed', 'setup: revenuecat');
select pg_temp.atk_assert(public.checkpoint_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease'), 'external_complete')->>'outcome' = 'checkpointed', 'setup: external complete');
select pg_temp.atk_assert(public.set_account_deletion_auth_intent(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease'))->>'outcome' = 'intent_recorded', 'setup: intent');
-- S2a: before the Auth delete, the status capability must not move the work
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1))->>'outcome' = 'blocked',
  'S2 pre-Auth work is never moved by the status capability');
reset role;
select pg_temp.atk_assert((select auth_deleted_at is null and lease_token is not null and completed_at is null
  from api_private.account_deletion_operations where id = pg_temp.atk_id(1001)), 'S2 pre-Auth claim left the row untouched');
-- the worker's deleteUser lands; its response is lost; the worker dies with its lease
delete from auth.users where id = pg_temp.atk_id(1);
select pg_temp.atk_assert((select auth_deleted_at is not null and completed_at is null and lease_token is not null
  and last_error_code is null and phase = 'auth_delete_intent'
  from api_private.account_deletion_operations where id = pg_temp.atk_id(1001)), 'setup: Auth gone, lease retained, no receipt');
select pg_temp.atk_assert(not exists (select 1 from public.profiles where id = pg_temp.atk_id(1)), 'setup: the cascade ran');

-- ─── S2: capability binding and live-lease protection ─────────────────────────
set local role service_role;
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(2))->>'outcome' = 'invalid',
  'S2 the wrong capability hash learns nothing about the operation');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1002), pg_temp.atk_cap(1))->>'outcome' = 'invalid',
  'S2 the right capability hash on another operation id learns nothing');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1))->>'outcome' = 'busy',
  'S2 a live (dead-worker) lease is never stolen by the status capability');
select pg_temp.atk_assert(public.read_account_deletion_status(pg_temp.atk_id(1001), pg_temp.atk_cap(1))->>'state' = 'in_progress',
  'S2 status stays honest while the lease is live');
reset role;
select pg_temp.atk_assert((select lease_token = (select (data->>'leaseToken')::uuid from atk_results where name = 'lease') and attempts = 1
  from api_private.account_deletion_operations where id = pg_temp.atk_id(1001)), 'S2 busy claims spend no attempt and keep the worker lease');
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.atk_id(1001);

-- ─── S3: the status claim, residue count and certification are lease-bound ───
set local role service_role;
insert into atk_results values ('claim', public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1)));
select pg_temp.atk_assert((select data->>'outcome' = 'claimed' and (data->>'authDeleted')::boolean and data->>'ownerId' = pg_temp.atk_id(1)::text
  and data->>'operationId' = pg_temp.atk_id(1001)::text and data->>'leaseToken' <> (select data->>'leaseToken' from atk_results where name = 'lease')
  from atk_results where name = 'claim'), 'S3 the expired dead-worker lease is taken over under the original ids with a new token');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1))->>'outcome' = 'busy',
  'S3 a second concurrent poll sees busy');
-- the dead worker's token is fenced everywhere
select pg_temp.atk_assert(public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease'))->>'outcome' = 'stale_lease',
  'S3 the fenced worker token cannot count residue');
select pg_temp.atk_assert(public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease'))->>'outcome' = 'stale_lease',
  'S3 the fenced worker token cannot certify');
select pg_temp.atk_assert(public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease'), 'completion_unverified')->>'outcome' = 'stale_lease',
  'S3 the fenced worker token cannot record a verdict');
-- the live status lease is bound to owner AND operation
select pg_temp.atk_assert(public.read_account_deletion_owner_residue(pg_temp.atk_id(2), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'))->>'outcome' = 'stale_lease',
  'S3 the live lease cannot count another owner');
select pg_temp.atk_assert(public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'))->>'outcome' = 'stale_lease',
  'S3 the live lease cannot count under another operation id');
select pg_temp.atk_assert(public.certify_account_deletion_completion(pg_temp.atk_id(2), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'))->>'outcome' = 'stale_lease',
  'S3 the live lease cannot certify another owner');
select pg_temp.atk_assert(public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'), 'apple_cleanup_unavailable')->>'outcome' = 'stale_lease',
  'S3 a pre-Auth verdict cannot be recorded on the post-Auth lease');
select pg_temp.atk_assert(public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'), 'checkpoint_unavailable')->>'outcome' = 'stale_lease',
  'S3 a checkpoint verdict cannot be recorded on the post-Auth lease');
reset role;
select pg_temp.atk_assert((select count(*) from public.sessions where user_id = pg_temp.atk_id(2)) = 1
  and (select count(*) from public.user_saved_drills where user_id = pg_temp.atk_id(2)) = 1
  and exists (select 1 from public.profiles where id = pg_temp.atk_id(2)), 'S3 owner 2 is untouched by every cross-owner attempt');
select pg_temp.atk_assert((select completed_at is null and last_error_code is null from api_private.account_deletion_operations where id = pg_temp.atk_id(1001)),
  'S3 no cross-binding attempt moved the row');

-- ─── S4: the count is complete and honest; certification is exactly once ─────
set local role service_role;
insert into atk_results values ('residue', public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim')));
reset role;
select pg_temp.atk_assert((select data->>'outcome' = 'counted' from atk_results where name = 'residue'), 'S4 the live lease counts');
select pg_temp.atk_assert((select coalesce(sum((ns->>'rows')::int), -1) = 0 from atk_results, jsonb_array_elements(data->'namespaces') ns where name = 'residue'), 'S4 the cascade left nothing');
select pg_temp.atk_assert((select jsonb_array_length(data->'namespaces') from atk_results where name = 'residue')
  = (select count(*) from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
      where con.contype = 'f' and array_length(con.conkey, 1) = 1
        and con.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
        and n.nspname in ('public', 'api_private') and c.relkind in ('r', 'p')),
  'S4 every single-column owner FK in public/api_private is a counted namespace');
select pg_temp.atk_assert((select bool_and(ns ? 'schema' and ns ? 'table' and ns ? 'column' and (ns->>'rows')::int = 0)
  from atk_results, jsonb_array_elements(data->'namespaces') ns where name = 'residue'), 'S4 every namespace is named and zero');
select pg_temp.atk_assert((select not (data::text ilike '%example.test%') from atk_results where name = 'residue'), 'S4 the count exposes no row content');
-- residue in a table the Edge does not read is still residue for the database
select pg_temp.atk_throws('insert into public.account_deletion_requests (user_id) values (pg_temp.atk_id(1))', '23503',
  'S4 an FK-guarded write for a gone owner is refused even by the table owner');
set local role service_role;
select pg_temp.atk_assert((select sum((ns->>'rows')::int) = 0 from jsonb_array_elements(public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'))->'namespaces') ns),
  'S4 an FK-guarded write for a gone owner cannot create residue (FK refused the row or it does not exist)');
reset role;
select pg_temp.atk_assert(not exists (select 1 from public.account_deletion_requests where user_id = pg_temp.atk_id(1)), 'S4 the FK refused the orphan');
set local role service_role;
insert into atk_results values ('certified', public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim')));
select pg_temp.atk_assert((select data->>'state' = 'completed' and data->'completionReceipt'->>'completedAt' is not null
  and data->>'appleAuthorizationRevocation' = 'not_applicable' from atk_results where name = 'certified'), 'S4 a clean sweep certifies');
-- replay: the same lease, the same certification, a later verdict
select pg_temp.atk_assert(public.certify_account_deletion_completion(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'))->>'outcome' = 'stale_lease',
  'S4 replaying the certification is refused');
select pg_temp.atk_assert(public.read_account_deletion_owner_residue(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'))->>'outcome' = 'stale_lease',
  'S4 the consumed lease cannot count again');
select pg_temp.atk_assert(public.fail_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1001), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim'), 'completion_unverified')->>'outcome' = 'stale_lease',
  'S4 a late completion_unverified cannot dirty the receipt');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1001), pg_temp.atk_cap(1))->>'outcome' = 'completed',
  'S4 a later poll learns completed without a new lease');
select pg_temp.atk_assert(public.read_account_deletion_status(pg_temp.atk_id(1001), pg_temp.atk_cap(1)) = (select data from atk_results where name = 'certified'),
  'S4 the status read equals the certification receipt');
reset role;
select pg_temp.atk_assert((select completed_at is not null and last_error_code is null and lease_token is null and phase = 'completed'
  from api_private.account_deletion_operations where id = pg_temp.atk_id(1001)), 'S4 the durable row is completed exactly once');
select pg_temp.atk_assert((select data->'completionReceipt'->>'completedAt' from atk_results where name = 'certified')
  = (select to_jsonb(completed_at) #>> '{}' from api_private.account_deletion_operations where id = pg_temp.atk_id(1001)),
  'S4 the receipt is the durable timestamp');
select pg_temp.atk_assert((select count(*) from public.free_rating_ledger) = (select count(*) from atk_ledger)
  and not exists (select l.identity_hash, l.scored_count from public.free_rating_ledger l
    except select a.identity_hash, a.scored_count from atk_ledger a), 'S4 the free-rating ledger survives the settlement unchanged');

-- ─── S5: recreated identity and clock boundaries on owner 2 ──────────────────
set local role service_role;
select pg_temp.atk_assert(public.begin_account_deletion_operation(pg_temp.atk_id(2), pg_temp.atk_id(1002), pg_temp.atk_challenge(2, 2002), pg_temp.atk_cap(2))->>'outcome' = 'requested', 'setup 2: requested');
reset role;
update api_private.account_deletion_operations
  set created_at = created_at - interval '10 seconds', challenge_expires_at = challenge_expires_at - interval '10 seconds',
    status_expires_at = status_expires_at - interval '10 seconds', retain_until = retain_until - interval '10 seconds'
  where id = pg_temp.atk_id(1002);
set local role service_role;
insert into atk_results values ('lease2', public.confirm_account_deletion_operation(pg_temp.atk_id(2), pg_temp.atk_challenge(2, 2002), pg_temp.atk_id(1002)));
select pg_temp.atk_assert((select data->>'outcome' = 'claimed' from atk_results where name = 'lease2'), 'setup 2: leased');
select public.checkpoint_account_deletion_operation(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease2'), 'apple', 'not_applicable');
select public.checkpoint_account_deletion_operation(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease2'), 'revenuecat');
select public.checkpoint_account_deletion_operation(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease2'), 'external_complete');
select public.set_account_deletion_auth_intent(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'lease2'));
reset role;
delete from auth.users where id = pg_temp.atk_id(2);
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.atk_id(1002);
set local role service_role;
insert into atk_results values ('claim2', public.claim_account_deletion_status_work(pg_temp.atk_id(1002), pg_temp.atk_cap(2)));
select pg_temp.atk_assert((select data->>'outcome' = 'claimed' from atk_results where name = 'claim2'), 'S5 the status capability claims the dead-worker phase');
reset role;
-- the same uuid comes back while the status poll holds its lease
insert into auth.users (id, email, raw_app_meta_data) values (pg_temp.atk_id(2), 'w0806-attack-2b@example.test', '{"provider":"google"}');
set local role service_role;
select pg_temp.atk_assert(public.read_account_deletion_owner_residue(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim2'))->>'outcome' = 'stale_lease',
  'S5 a recreated identity is never counted as the deleted owner');
select pg_temp.atk_assert(public.certify_account_deletion_completion(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim2'))->>'outcome' = 'stale_lease',
  'S5 a recreated identity is never certified deleted');
select pg_temp.atk_assert(public.read_account_deletion_status(pg_temp.atk_id(1002), pg_temp.atk_cap(2))->>'state' = 'blocked',
  'S5 the status view is honest about the recreated identity even while the lease is live');
-- while the identity exists nothing about the operation moves — not even the
-- poll's own verdict; the lease simply times out (fail closed)
select pg_temp.atk_assert(public.fail_account_deletion_operation(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim2'), 'completion_unverified')->>'outcome' = 'stale_lease',
  'S5 a recreated identity freezes the operation: the verdict is refused too');
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1002), pg_temp.atk_cap(2))->>'outcome' = 'blocked',
  'S5 the recreated identity blocks every later claim');
reset role;
select pg_temp.atk_assert((select completed_at is null and last_error_code is null and lease_token is not null
  from api_private.account_deletion_operations where id = pg_temp.atk_id(1002)), 'S5 the row stays uncertified without a receipt');
-- the recreated identity disappears again and the frozen lease times out: the
-- phase is recoverable exactly once more
delete from auth.users where id = pg_temp.atk_id(2);
update api_private.account_deletion_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = pg_temp.atk_id(1002);
-- clock: the 24 h status window closed
update api_private.account_deletion_operations
  set created_at = created_at - interval '25 hours', challenge_expires_at = challenge_expires_at - interval '25 hours',
    status_expires_at = status_expires_at - interval '25 hours', retain_until = retain_until - interval '25 hours',
    lease_expires_at = lease_expires_at - interval '25 hours'
  where id = pg_temp.atk_id(1002);
set local role service_role;
select pg_temp.atk_assert(public.claim_account_deletion_status_work(pg_temp.atk_id(1002), pg_temp.atk_cap(2))->>'outcome' = 'invalid',
  'S5 an expired status window cannot be claimed');
select pg_temp.atk_assert(public.read_account_deletion_status(pg_temp.atk_id(1002), pg_temp.atk_cap(2)) is null,
  'S5 an expired status window reads nothing');
reset role;
-- clock rollback: the window is open again; the ordinary settlement runs once
update api_private.account_deletion_operations
  set created_at = created_at + interval '25 hours', challenge_expires_at = challenge_expires_at + interval '25 hours',
    status_expires_at = status_expires_at + interval '25 hours', retain_until = retain_until + interval '25 hours',
    lease_expires_at = lease_expires_at + interval '25 hours'
  where id = pg_temp.atk_id(1002);
set local role service_role;
insert into atk_results values ('claim3', public.claim_account_deletion_status_work(pg_temp.atk_id(1002), pg_temp.atk_cap(2)));
select pg_temp.atk_assert((select data->>'outcome' = 'claimed' from atk_results where name = 'claim3'), 'S5 the reopened window claims again');
select pg_temp.atk_assert((select sum((ns->>'rows')::int) = 0 from jsonb_array_elements(public.read_account_deletion_owner_residue(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim3'))->'namespaces') ns),
  'S5 the recreated-then-removed identity left nothing behind');
select pg_temp.atk_assert(public.certify_account_deletion_completion(pg_temp.atk_id(2), pg_temp.atk_id(1002), (select (data->>'leaseToken')::uuid from atk_results where name = 'claim3'))->>'state' = 'completed',
  'S5 the clean phase certifies once the identity is gone for good');
reset role;

-- ─── S6: attempts budget boundary on the status capability ───────────────────
-- (documents the boundary the Deno attack A2 reproduces on the Edge route)
set local role service_role;
select pg_temp.atk_assert(public.begin_account_deletion_operation(pg_temp.atk_id(1), pg_temp.atk_id(1003), pg_temp.atk_challenge(1, 2003), pg_temp.atk_cap(3))->>'outcome' = 'user_missing',
  'S6 a deleted owner cannot request a new operation');
reset role;

select pg_temp.atk_assert((select count(*) from atk_assertions) >= 60, 'at least sixty attack assertions executed');
select count(*) as attack_assertions from atk_assertions \gset
\echo W08-06 ATTACK SQL: :attack_assertions assertions passed
rollback;
