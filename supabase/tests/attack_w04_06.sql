-- ============================================================================
-- W04-06 ADVERSARY — single-connection SQL attacks on
-- 20260910140000_offline_grants_unattested_installations (candidate fbc1cc99).
--
-- Runs against a database with supabase/tests/shim_auth.sql and every
-- migration applied (./supabase/functions/api/__wf__/xc_pg_up.sh or the
-- run_rls_tests.sh harness):
--
--   docker exec -i pickle-xc-pg psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/attack_w04_06.sql
--
-- Every section is one transaction that is ROLLED BACK, so the script is
-- re-runnable on a shared disposable database. Each assertion states the
-- behaviour the candidate claims; a raised exception is a confirmed break.
-- The multi-connection races live in
-- supabase/functions/api/__wf__/attack_w04_06_live.test.ts.
--
--   ATK-S1  unauthorised roles / session boundaries for the new RPC surface:
--           JWT sub with ANOTHER user's session (interleaved account switch),
--           an expired session, a banned user, a missing API gate header,
--           anon, service_role, and the client's direct table paths
--           (INSERT grants, UPDATE/DELETE devices — no self-un-revoke)
--   ATK-S2  input boundaries: installation key at 128 / 129 chars, leading
--           '-', trailing newline, case, empty, NULL; requested tickets -1,
--           3, NULL, int max; nothing is persisted by a refusal
--   ATK-S3  time boundaries on the Pro branch: entitlement expiring in 1s,
--           exactly now, 'infinity', far future; revoked_at in the future
--           and at -infinity
--   ATK-S4  corrupt / partial persisted state and truthfulness: an owner-side
--           attestation flip is recorded per grant (old rows immutable), the
--           column check refuses '', 'Attested'; device deletion cascades the
--           grants but reclaims nothing and the same installation key
--           recovers its tickets
--   ATK-S5  free-rating conservation across two installations, a revoked
--           holder (no reclaim), a live online reservation (offline gets only
--           what is left) and a grant replay (no new allocation)
--   ATK-S6  duplicate identities: the same installation key under two owners
--           is two devices; a revocation on one owner never leaks to the
--           other; RLS hides the other owner's device; a grant naming the
--           other owner's device is refused for every role
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

-- ----------------------------------------------------------------------------
-- ATK-S1  unauthorised roles / session boundaries
-- ----------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000a060001', 'atk0601-alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000a060002', 'atk0601-bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'atk0601-alice', '00000000-0000-4000-8000-00000a060001', '{"sub":"atk0601-alice"}'),
  ('apple',  'atk0601-bob',   '00000000-0000-4000-8000-00000a060002', '{"sub":"atk0601-bob"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000a060101', '00000000-0000-4000-8000-00000a060001'),
  ('00000000-0000-4000-8000-00000a060102', '00000000-0000-4000-8000-00000a060001'),
  ('00000000-0000-4000-8000-00000a060201', '00000000-0000-4000-8000-00000a060002');
-- Alice's second session is already expired; Bob is not banned (yet).
update auth.sessions set not_after = now() - interval '1 minute'
where id = '00000000-0000-4000-8000-00000a060102';

create temporary table s1_state (key text primary key, id uuid);
grant select, insert on s1_state to authenticated;

do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;

-- Precondition: Alice registers as the shipping app does and holds a grant.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060001';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060101"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('alice-phone', 'production', false);
  select * into g from public.issue_offline_grant('alice-phone', 2);
  if r.result <> 'accepted' or g.result <> 'accepted' or g.attestation_state <> 'unattested' then
    raise exception 'ATK-S1 precondition: Alice registers and is issued (got %, %, %)', r.result, g.result, g.attestation_state;
  end if;
  insert into s1_state values ('alice-device', r.device_id), ('alice-grant', g.grant_id);
end $$;

-- S1a  JWT sub = Alice, session = BOB's live session (account switch mid-flight).
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060201"}';
do $$
declare g record; ok boolean := false;
begin
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then
    raise exception 'ATK-S1a BROKE: another user''s session id authorised issue_offline_grant (got %)', g.result;
  end if;
end $$;

-- S1b  Alice's own, but EXPIRED, session.
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060102"}';
do $$
declare g record; ok boolean := false;
begin
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then
    raise exception 'ATK-S1b BROKE: an expired session authorised issue_offline_grant (got %)', g.result;
  end if;
end $$;

-- S1c  a session id that is not a uuid, and no session claim at all.
set local request.jwt.claims = '{"session_id":"not-a-uuid"}';
do $$
declare g record; ok boolean := false;
begin
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then
    raise exception 'ATK-S1c BROKE: a malformed session id authorised issue_offline_grant (got %)', g.result;
  end if;
end $$;
set local request.jwt.claims = '{}';
do $$
declare g record; ok boolean := false;
begin
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then
    raise exception 'ATK-S1c BROKE: a missing session claim authorised issue_offline_grant (got %)', g.result;
  end if;
end $$;

-- S1d  live session but the API gate header is absent (a direct PostgREST caller).
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060101"}';
do $$
declare g record; ok boolean := false;
begin
  perform set_config('request.headers', '{}', true);
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then
    raise exception 'ATK-S1d BROKE: issue_offline_grant without the API gate header (got %)', g.result;
  end if;
end $$;
reset role;
do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;
set local role authenticated;

-- S1e  the client's direct table paths: no INSERT on grants, no UPDATE/DELETE
--      on devices (a revoked owner cannot un-revoke or delete-and-recreate).
do $$
declare ok boolean; d uuid := (select id from s1_state where key = 'alice-device');
begin
  ok := false;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, attestation_state)
    values ((select auth.uid()), d, 'identity_lifetime_free', 50, now() + interval '1 day', 'unattested');
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1e BROKE: authenticated INSERTed an offline grant directly'; end if;

  ok := false;
  begin
    update public.offline_devices set revoked_at = null where id = d;
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1e BROKE: authenticated UPDATEd offline_devices.revoked_at'; end if;

  ok := false;
  begin
    update public.offline_devices set attestation_state = 'attested', attested_at = now() where id = d;
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1e BROKE: authenticated promoted its own device to attested'; end if;

  ok := false;
  begin
    delete from public.offline_devices where id = d;
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1e BROKE: authenticated DELETEd its own device row'; end if;

  ok := false;
  begin
    update public.offline_grants set attestation_state = 'attested' where id = (select id from s1_state where key = 'alice-grant');
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1e BROKE: authenticated UPDATEd offline_grants.attestation_state'; end if;
end $$;
reset role;

-- S1f  anon and service_role hold no EXECUTE on the recreated RPC (the DROP +
--      CREATE must not have re-granted PUBLIC), even with the gate header set.
set local role anon;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060001';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060101"}';
do $$
declare g record; ok boolean := false;
begin
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1f BROKE: anon executed issue_offline_grant (got %)', g.result; end if;
end $$;
reset role;
set local role service_role;
do $$
declare g record; ok boolean := false;
begin
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1f BROKE: service_role executed issue_offline_grant (got %)', g.result; end if;
  ok := false;
  begin
    select * into g from public.register_offline_device('alice-phone', 'production', true);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1f BROKE: service_role executed register_offline_device (got %)', g.result; end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- S1g  a banned owner with a live session is refused.
update auth.users set banned_until = now() + interval '1 day'
where id = '00000000-0000-4000-8000-00000a060001';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060001';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060101"}';
do $$
declare g record; ok boolean := false;
begin
  begin
    select * into g from public.issue_offline_grant('alice-phone', 2);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S1g BROKE: a banned user was issued a grant (got %)', g.result; end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- Every refusal above persisted nothing: exactly the precondition grant exists.
do $$
declare n int;
begin
  select count(*) into n from public.offline_grants where user_id = '00000000-0000-4000-8000-00000a060001';
  if n <> 1 then raise exception 'ATK-S1 BROKE: a refused path persisted a grant (% rows)', n; end if;
  select count(*) into n from public.offline_grants g
  where g.attestation_state <> (select d.attestation_state from public.offline_devices d where d.id = g.device_id);
  if n <> 0 then raise exception 'ATK-S1 BROKE: % grant(s) disagree with their device''s attestation state', n; end if;
end $$;
\echo ATK-S1 HOLDS: session/role boundaries of issue_offline_grant() and the client table paths
rollback;

-- ----------------------------------------------------------------------------
-- ATK-S2  input boundaries
-- ----------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000a060003', 'atk0602-cara@example.com', '{"full_name":"Cara"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'atk0602-cara', '00000000-0000-4000-8000-00000a060003', '{"sub":"atk0602-cara"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000a060301', '00000000-0000-4000-8000-00000a060003');
do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060003';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060301"}';
do $$
declare
  r record; g record;
  k128 text := 'k' || repeat('x', 127);
  k129 text := 'k' || repeat('x', 128);
  bad text;
  grants_before int; ledger_before int;
begin
  -- The maximum-length key registers and is issued (an unattested installation).
  select * into r from public.register_offline_device(k128, 'production', false);
  if r.result <> 'accepted' then raise exception 'ATK-S2 BROKE: a 128-char key is refused (%)', r.result; end if;
  select * into g from public.issue_offline_grant(k128, 2);
  if g.result <> 'accepted' or g.attestation_state <> 'unattested' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'ATK-S2 BROKE: a 128-char unattested key is not issued (%, %)', g.result, g.attestation_state;
  end if;
  select count(*) into grants_before from public.offline_grants where user_id = (select auth.uid());
  select count(*) into ledger_before from public.offline_allocation_ledger where user_id = (select auth.uid());

  -- Every malformed key is refused as invalid input, never registered/issued.
  foreach bad in array array[k129, '-leading-dash', '.dot', ':colon', 'has space', 'tab' || chr(9),
                            'nl' || chr(10), 'key' || chr(10), 'key' || chr(13), 'unicode-é', 'k/slash', ''] loop
    select * into r from public.register_offline_device(bad, 'production', false);
    if r.result <> 'offline.invalid_input' then
      raise exception 'ATK-S2 BROKE: register accepted key % (%)', quote_literal(bad), r.result;
    end if;
    select * into g from public.issue_offline_grant(bad, 2);
    if g.result <> 'offline.invalid_input' then
      raise exception 'ATK-S2 BROKE: issue accepted key % (%)', quote_literal(bad), g.result;
    end if;
  end loop;
  select * into g from public.issue_offline_grant(null, 2);
  if g.result <> 'offline.invalid_input' then raise exception 'ATK-S2 BROKE: NULL key (%)', g.result; end if;

  -- Case is significant: the registered key is not matched case-insensitively.
  select * into g from public.issue_offline_grant(upper(k128), 2);
  if g.result <> 'offline.device_not_registered' then
    raise exception 'ATK-S2 BROKE: upper-cased key resolved to the registered device (%)', g.result;
  end if;

  -- Requested-ticket boundaries.
  select * into g from public.issue_offline_grant(k128, -1);
  if g.result <> 'offline.invalid_input' then raise exception 'ATK-S2 BROKE: requested -1 (%)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, 3);
  if g.result <> 'offline.invalid_input' then raise exception 'ATK-S2 BROKE: requested 3 (%)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, 2147483647);
  if g.result <> 'offline.invalid_input' then raise exception 'ATK-S2 BROKE: requested int max (%)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, -2147483648);
  if g.result <> 'offline.invalid_input' then raise exception 'ATK-S2 BROKE: requested int min (%)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, null);
  if g.result <> 'offline.invalid_input' then raise exception 'ATK-S2 BROKE: requested NULL (%)', g.result; end if;

  -- Refusals persist nothing.
  if (select count(*) from public.offline_grants where user_id = (select auth.uid())) <> grants_before
     or (select count(*) from public.offline_allocation_ledger where user_id = (select auth.uid())) <> ledger_before
     or (select count(*) from public.offline_devices where user_id = (select auth.uid())) <> 1 then
    raise exception 'ATK-S2 BROKE: a refused input persisted a grant, ledger row or device';
  end if;

  -- requested 0 with tickets already outstanding re-issues them (a refresh);
  -- requested 0 on a fresh installation with capacity is invalid input.
  select * into g from public.issue_offline_grant(k128, 0);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 or g.generation <> 2 then
    raise exception 'ATK-S2 BROKE: requested 0 with two outstanding tickets (%, %, %)', g.result, g.ticket_ids, g.generation;
  end if;
  select * into r from public.register_offline_device('cara-second', 'production', false);
  select * into g from public.issue_offline_grant('cara-second', 0);
  if g.result <> 'access.paywall_required' then
    raise exception 'ATK-S2: requested 0 on a second installation while the first holds both tickets (%)', g.result;
  end if;
end $$;
reset role;
\echo ATK-S2 HOLDS: installation key / requested ticket boundaries persist nothing when refused
rollback;

-- ----------------------------------------------------------------------------
-- ATK-S3  time boundaries (Pro entitlement expiry, revoked_at extremes)
-- ----------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000a060004', 'atk0603-pat@example.com', '{"full_name":"Pat"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'atk0603-pat', '00000000-0000-4000-8000-00000a060004', '{"sub":"atk0603-pat"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000a060401', '00000000-0000-4000-8000-00000a060004');
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values ('00000000-0000-4000-8000-00000a060004', true, 'pickle_sensei_pro_monthly', now() + interval '1 second');
create temporary table s3_state (key text primary key, id uuid);
grant select, insert on s3_state to authenticated;
do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060004';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060401"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('pat-phone', 'production', false);
  insert into s3_state values ('pat-device', r.device_id);
  -- S3a  entitlement expiring one second from now: a one-second lease,
  --      strictly after issuance, ending exactly at the verified expiry.
  select * into g from public.issue_offline_grant('pat-phone', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'verified_store'
     or g.expires_at <> now() + interval '1 second' or g.entitlement_expires_at <> g.expires_at
     or g.expires_at <= g.issued_at or coalesce(array_length(g.ticket_ids, 1), 0) <> 0
     or g.attestation_state <> 'unattested' then
    raise exception 'ATK-S3a BROKE: 1-second entitlement (%, %, %, %, %)', g.result, g.entitlement_source, g.expires_at - g.issued_at, g.ticket_ids, g.attestation_state;
  end if;
end $$;
reset role;

-- S3b  entitlement expiring exactly at this transaction's now(): not effective,
--      so the identity falls back to the free allowance (the same predicate
--      access_state() applies) — never a zero-length Pro lease.
update public.billing_entitlements set expires_at = now() where user_id = '00000000-0000-4000-8000-00000a060004';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060004';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060401"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('pat-phone', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free'
     or array_length(g.ticket_ids, 1) <> 2 or g.entitlement_expires_at is not null
     or g.expires_at <> g.issued_at + interval '7 days' then
    raise exception 'ATK-S3b BROKE: an entitlement expiring at now() (%, %, %, %)', g.result, g.entitlement_source, g.ticket_ids, g.entitlement_expires_at;
  end if;
end $$;
reset role;

-- S3c  'infinity' and a far-future expiry: the lease is capped at 7 days and
--      records the expiry verbatim (the Edge claim builder refuses a
--      non-ISO instant, see attack_w04_06_routes.test.ts).
update public.billing_entitlements set expires_at = 'infinity' where user_id = '00000000-0000-4000-8000-00000a060004';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060004';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060401"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('pat-phone', 0);
  if g.result <> 'accepted' or g.entitlement_source <> 'verified_store'
     or g.expires_at <> g.issued_at + interval '7 days' or g.entitlement_expires_at <> 'infinity'::timestamptz
     or to_jsonb(g.entitlement_expires_at) <> to_jsonb('infinity'::text) then
    raise exception 'ATK-S3c BROKE: infinity entitlement (%, %, %, %)', g.result, g.entitlement_source, g.expires_at - g.issued_at, g.entitlement_expires_at;
  end if;
end $$;
reset role;
update public.billing_entitlements set expires_at = '2999-01-01T00:00:00Z' where user_id = '00000000-0000-4000-8000-00000a060004';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060004';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060401"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('pat-phone', 0);
  if g.result <> 'accepted' or g.expires_at <> g.issued_at + interval '7 days'
     or g.entitlement_expires_at <> '2999-01-01T00:00:00Z'::timestamptz then
    raise exception 'ATK-S3c BROKE: far-future entitlement (%, %, %)', g.result, g.expires_at - g.issued_at, g.entitlement_expires_at;
  end if;
end $$;
reset role;

-- S3d  revoked_at extremes: a future or -infinity marker still refuses (the
--      marker is a flag, not a schedule), and the table agrees.
update public.offline_devices set revoked_at = now() + interval '1 year'
where id = (select id from s3_state where key = 'pat-device');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060004';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060401"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('pat-phone', 0);
  if g.result <> 'offline.device_revoked' or g.grant_id is not null then
    raise exception 'ATK-S3d BROKE: a future revoked_at was not refused (%)', g.result;
  end if;
end $$;
reset role;
update public.offline_devices set revoked_at = '-infinity'
where id = (select id from s3_state where key = 'pat-device');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060004';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060401"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('pat-phone', 0);
  if g.result <> 'offline.device_revoked' then
    raise exception 'ATK-S3d BROKE: a -infinity revoked_at was not refused (%)', g.result;
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
do $$
declare ok boolean := false;
begin
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, entitlement_expires_at)
    values ('00000000-0000-4000-8000-00000a060004', (select id from s3_state where key = 'pat-device'),
            'verified_store', 99, now() + interval '1 day', '2999-01-01T00:00:00Z');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'ATK-S3d BROKE: the table accepted a grant for a device with revoked_at = -infinity'; end if;
end $$;
\echo ATK-S3 HOLDS: entitlement-expiry and revoked_at extremes
rollback;

-- ----------------------------------------------------------------------------
-- ATK-S4  corrupt / partial persisted state and per-grant truthfulness
-- ----------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000a060005', 'atk0604-dee@example.com', '{"full_name":"Dee"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'atk0604-dee', '00000000-0000-4000-8000-00000a060005', '{"sub":"atk0604-dee"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000a060501', '00000000-0000-4000-8000-00000a060005');
create temporary table s4_state (key text primary key, id uuid);
grant select, insert on s4_state to authenticated;
do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060005';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060501"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('dee-phone', 'production', false);
  select * into g from public.issue_offline_grant('dee-phone', 2);
  if g.result <> 'accepted' or g.attestation_state <> 'unattested' then
    raise exception 'ATK-S4 precondition (%, %)', g.result, g.attestation_state;
  end if;
  insert into s4_state values ('device', r.device_id), ('g1', g.grant_id), ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- S4a  the owner/support path (or a later App Attest wiring) flips the device
--      to attested: the NEXT grant records attested, the earlier one stays
--      unattested and cannot be rewritten by anyone.
update public.offline_devices set attestation_state = 'attested', attested_at = now()
where id = (select id from s4_state where key = 'device');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060005';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060501"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('dee-phone', 2);
  if g.result <> 'accepted' or g.attestation_state <> 'attested' or g.generation <> 2
     or g.ticket_ids <> array[(select id from s4_state where key = 't1'), (select id from s4_state where key = 't2')] then
    raise exception 'ATK-S4a BROKE: after an attested flip the next grant (%, %, %, %)', g.result, g.attestation_state, g.generation, g.ticket_ids;
  end if;
  insert into s4_state values ('g2', g.grant_id);
  if (select attestation_state from public.offline_grants where id = (select id from s4_state where key = 'g1')) <> 'unattested' then
    raise exception 'ATK-S4a BROKE: the earlier grant''s recorded state changed';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
-- Flip back (support downgrade): the next grant records unattested again; the
-- two earlier rows keep their own history; the owner role cannot rewrite either.
update public.offline_devices set attestation_state = 'unattested', attested_at = null
where id = (select id from s4_state where key = 'device');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060005';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060501"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('dee-phone', 2);
  if g.result <> 'accepted' or g.attestation_state <> 'unattested' or g.generation <> 3 then
    raise exception 'ATK-S4a BROKE: after a downgrade the next grant (%, %, %)', g.result, g.attestation_state, g.generation;
  end if;
  if (select array_agg(attestation_state order by generation) from public.offline_grants
      where device_id = (select id from s4_state where key = 'device')) <> array['unattested', 'attested', 'unattested'] then
    raise exception 'ATK-S4a BROKE: per-grant history is not preserved';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
do $$
declare ok boolean; bad text;
begin
  ok := false;
  begin
    update public.offline_grants set attestation_state = 'unattested' where id = (select id from s4_state where key = 'g2');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'ATK-S4a BROKE: the owner role rewrote a grant''s attestation state'; end if;
  -- S4b  the column refuses every value that is not exactly one of the two states.
  foreach bad in array array['', 'Attested', 'ATTESTED', 'unattested ', 'verified', 'pending', 'none'] loop
    ok := false;
    begin
      insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, attestation_state)
      values ('00000000-0000-4000-8000-00000a060005', (select id from s4_state where key = 'device'),
              'identity_lifetime_free', 90, now() + interval '1 day', bad);
    exception when check_violation then ok := true;
    end;
    if not ok then raise exception 'ATK-S4b BROKE: the table accepted attestation_state %', quote_literal(bad); end if;
  end loop;
  -- A grant for a device row that does not exist at all (partial state).
  ok := false;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at)
    values ('00000000-0000-4000-8000-00000a060005', gen_random_uuid(), 'identity_lifetime_free', 91, now() + interval '1 day');
  exception when check_violation or foreign_key_violation then ok := true;
  end;
  if not ok then raise exception 'ATK-S4b BROKE: a grant for a non-existent device was accepted'; end if;
end $$;

-- S4c  device deletion: the grants cascade, the ledger holds stay (allocation
--      is never reclaimed), the same installation key re-registers as a NEW
--      device and recovers exactly its two outstanding tickets.
do $$
declare held_before int;
begin
  select count(*) into held_before from public.offline_allocation_ledger
  where user_id = '00000000-0000-4000-8000-00000a060005' and event = 'allocated';
  if held_before <> 2 then raise exception 'ATK-S4c precondition: two allocations (got %)', held_before; end if;
  delete from public.offline_devices where id = (select id from s4_state where key = 'device');
  if (select count(*) from public.offline_grants where user_id = '00000000-0000-4000-8000-00000a060005') <> 0 then
    raise exception 'ATK-S4c: grants did not cascade with the device';
  end if;
  if (select count(*) from public.offline_allocation_ledger
      where user_id = '00000000-0000-4000-8000-00000a060005' and event = 'allocated') <> 2 then
    raise exception 'ATK-S4c BROKE: deleting the device reclaimed (deleted) ledger allocations';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060005';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060501"}';
do $$
declare r record; g record; p record;
begin
  if public.offline_hold_count() <> 2 then
    raise exception 'ATK-S4c BROKE: the hold count dropped to % after device deletion', public.offline_hold_count();
  end if;
  select * into p from public.reserve_analysis_permit('atk0604-online');
  if p.result <> 'access.paywall_required' then
    raise exception 'ATK-S4c BROKE: a deleted holder freed a third rating online (%)', p.result;
  end if;
  select * into g from public.issue_offline_grant('dee-phone', 2);
  if g.result <> 'offline.device_not_registered' then
    raise exception 'ATK-S4c BROKE: a deleted installation was issued (%)', g.result;
  end if;
  select * into r from public.register_offline_device('dee-phone', 'production', false);
  if r.result <> 'accepted' or r.device_id = (select id from s4_state where key = 'device') then
    raise exception 'ATK-S4c: re-registration after deletion (%, same id: %)', r.result,
      r.device_id = (select id from s4_state where key = 'device');
  end if;
  select * into g from public.issue_offline_grant('dee-phone', 2);
  if g.result <> 'accepted' or g.generation <> 1 or g.attestation_state <> 'unattested'
     or g.ticket_ids <> array[(select id from s4_state where key = 't1'), (select id from s4_state where key = 't2')] then
    raise exception 'ATK-S4c BROKE: recovery after deletion (%, %, %, %)', g.result, g.generation, g.attestation_state, g.ticket_ids;
  end if;
  if public.offline_hold_count() <> 2 then
    raise exception 'ATK-S4c BROKE: recovery allocated new tickets (hold count %)', public.offline_hold_count();
  end if;
end $$;
reset role;
\echo ATK-S4 HOLDS: per-grant attestation history, column check, deletion reclaims nothing
rollback;

-- ----------------------------------------------------------------------------
-- ATK-S5  free-rating conservation (two installations, revoked holder, live
--         online reservation, replay)
-- ----------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000a060006', 'atk0605-eve@example.com', '{"full_name":"Eve"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000a060007', 'atk0605-fay@example.com', '{"full_name":"Fay"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple',  'atk0605-eve', '00000000-0000-4000-8000-00000a060006', '{"sub":"atk0605-eve"}'),
  ('google', 'atk0605-fay', '00000000-0000-4000-8000-00000a060007', '{"sub":"atk0605-fay"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000a060601', '00000000-0000-4000-8000-00000a060006'),
  ('00000000-0000-4000-8000-00000a060701', '00000000-0000-4000-8000-00000a060007');
create temporary table s5_state (key text primary key, id uuid);
grant select, insert on s5_state to authenticated;
do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;

-- S5a  Eve: installation A takes both tickets; installation B gets none;
--      a replay on A re-issues the same two; a replay on B still none.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060006';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060601"}';
do $$
declare r record; ga record; gb record; ga2 record;
begin
  select * into r from public.register_offline_device('eve-a', 'production', false);
  insert into s5_state values ('eve-a', r.device_id);
  select * into r from public.register_offline_device('eve-b', 'production', false);
  insert into s5_state values ('eve-b', r.device_id);
  select * into ga from public.issue_offline_grant('eve-a', 2);
  select * into gb from public.issue_offline_grant('eve-b', 2);
  if ga.result <> 'accepted' or array_length(ga.ticket_ids, 1) <> 2 or gb.result <> 'access.paywall_required' or gb.grant_id is not null then
    raise exception 'ATK-S5a BROKE: two installations (%, %, %, %)', ga.result, ga.ticket_ids, gb.result, gb.grant_id;
  end if;
  select * into gb from public.issue_offline_grant('eve-b', 1);
  if gb.result <> 'access.paywall_required' then
    raise exception 'ATK-S5a BROKE: asking for one ticket on B while A holds two (%)', gb.result;
  end if;
  select * into ga2 from public.issue_offline_grant('eve-a', 2);
  if ga2.result <> 'accepted' or ga2.ticket_ids <> ga.ticket_ids or ga2.generation <> 2 then
    raise exception 'ATK-S5a BROKE: replay on A (%, %, %)', ga2.result, ga2.ticket_ids, ga2.generation;
  end if;
  if public.offline_hold_count() <> 2 or (select count(distinct ticket_id) from public.offline_allocation_ledger where user_id = (select auth.uid())) <> 2 then
    raise exception 'ATK-S5a BROKE: more than two tickets exist for the identity';
  end if;
  insert into s5_state values ('eve-t1', ga.ticket_ids[1]), ('eve-t2', ga.ticket_ids[2]);
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- S5b  revoking the holder reclaims nothing: B still gets none, online still
--      paywalled, the two tickets stay outstanding.
update public.offline_devices set revoked_at = now() where id = (select id from s5_state where key = 'eve-a');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060006';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060601"}';
do $$
declare gb record; ga record; p record; s record;
begin
  select * into ga from public.issue_offline_grant('eve-a', 2);
  if ga.result <> 'offline.device_revoked' then raise exception 'ATK-S5b: revoked A (%)', ga.result; end if;
  select * into gb from public.issue_offline_grant('eve-b', 2);
  if gb.result <> 'access.paywall_required' then
    raise exception 'ATK-S5b BROKE: revoking the holder handed its tickets to B (%)', gb.result;
  end if;
  select * into p from public.reserve_analysis_permit('atk0605-eve-online');
  if p.result <> 'access.paywall_required' then
    raise exception 'ATK-S5b BROKE: revoking the holder freed a rating online (%)', p.result;
  end if;
  select * into s from public.access_state();
  if s.reserved_count <> 2 then raise exception 'ATK-S5b BROKE: access_state reserved_count % (want 2)', s.reserved_count; end if;
  if public.offline_hold_count() <> 2 then raise exception 'ATK-S5b BROKE: hold count %', public.offline_hold_count(); end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- S5c  Fay: a live ONLINE reservation leaves exactly one ticket for offline;
--      a replay while the permit is live allocates nothing more; after the
--      permit is released the second ticket becomes available.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060007';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060701"}';
do $$
declare r record; p record; g record; g2 record; g3 record;
begin
  select * into r from public.register_offline_device('fay-phone', 'production', false);
  select * into p from public.reserve_analysis_permit('atk0605-fay-online');
  if p.result <> 'accepted' then raise exception 'ATK-S5c precondition: online reservation (%)', p.result; end if;
  select * into g from public.issue_offline_grant('fay-phone', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then
    raise exception 'ATK-S5c BROKE: offline allocation ignored the live online reservation (%, %)', g.result, g.ticket_ids;
  end if;
  select * into g2 from public.issue_offline_grant('fay-phone', 2);
  if g2.result <> 'accepted' or g2.ticket_ids <> g.ticket_ids or g2.generation <> 2 then
    raise exception 'ATK-S5c BROKE: replay allocated beyond the allowance (%, %, %)', g2.result, g2.ticket_ids, g2.generation;
  end if;
  if public.offline_hold_count() + public.online_reservation_count() + public.lifetime_scored_count() <> 2 then
    raise exception 'ATK-S5c BROKE: holds % + online % + scored % <> 2',
      public.offline_hold_count(), public.online_reservation_count(), public.lifetime_scored_count();
  end if;
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = p.permit_id;
  select * into g3 from public.issue_offline_grant('fay-phone', 2);
  if g3.result <> 'accepted' or array_length(g3.ticket_ids, 1) <> 2 or g3.ticket_ids[1] <> g.ticket_ids[1] then
    raise exception 'ATK-S5c BROKE: after the online release the second ticket (%, %)', g3.result, g3.ticket_ids;
  end if;
  if public.offline_hold_count() <> 2 then raise exception 'ATK-S5c BROKE: hold count %', public.offline_hold_count(); end if;
end $$;
reset role;
\echo ATK-S5 HOLDS: conservation across installations, revocation, a live online reservation and replays
rollback;

-- ----------------------------------------------------------------------------
-- ATK-S6  duplicate identities: one installation key under two owners
-- ----------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000a060008', 'atk0606-gus@example.com', '{"full_name":"Gus"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000a060009', 'atk0606-hal@example.com', '{"full_name":"Hal"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'atk0606-gus', '00000000-0000-4000-8000-00000a060008', '{"sub":"atk0606-gus"}'),
  ('apple',  'atk0606-hal', '00000000-0000-4000-8000-00000a060009', '{"sub":"atk0606-hal"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000a060801', '00000000-0000-4000-8000-00000a060008'),
  ('00000000-0000-4000-8000-00000a060901', '00000000-0000-4000-8000-00000a060009');
create temporary table s6_state (key text primary key, id uuid);
grant select, insert on s6_state to authenticated;
do $$ begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060008';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060801"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('shared-key', 'production', false);
  select * into g from public.issue_offline_grant('shared-key', 2);
  if r.result <> 'accepted' or g.result <> 'accepted' then raise exception 'ATK-S6 precondition Gus (%, %)', r.result, g.result; end if;
  insert into s6_state values ('gus-device', r.device_id), ('gus-grant', g.grant_id);
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060009';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060901"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('shared-key', 'production', true);
  select * into g from public.issue_offline_grant('shared-key', 2);
  if r.result <> 'accepted' or r.device_id = (select id from s6_state where key = 'gus-device')
     or g.result <> 'accepted' or g.attestation_state <> 'attested' then
    raise exception 'ATK-S6 precondition Hal (%, %, %)', r.result, g.result, g.attestation_state;
  end if;
  insert into s6_state values ('hal-device', r.device_id), ('hal-grant', g.grant_id);
  -- Hal sees only his own device and grant rows.
  if (select count(*) from public.offline_devices) <> 1 or (select count(*) from public.offline_grants) <> 1 then
    raise exception 'ATK-S6 BROKE: RLS exposes another owner''s device/grant rows';
  end if;
  if (select count(*) from public.offline_devices where id = (select id from s6_state where key = 'gus-device')) <> 0 then
    raise exception 'ATK-S6 BROKE: Hal reads Gus''s device row by id';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- Revoking HAL's installation never touches GUS's device with the same key.
update public.offline_devices set revoked_at = now() where id = (select id from s6_state where key = 'hal-device');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060008';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060801"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('shared-key', 2);
  if g.result <> 'accepted' or g.attestation_state <> 'unattested' or g.generation <> 2 then
    raise exception 'ATK-S6 BROKE: revoking another owner''s same-key installation affected Gus (%, %)', g.result, g.attestation_state;
  end if;
  if (select device_id from public.offline_grants where id = g.grant_id) <> (select id from s6_state where key = 'gus-device') then
    raise exception 'ATK-S6 BROKE: Gus''s grant is bound to a device that is not his';
  end if;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000a060009';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000a060901"}';
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('shared-key', 2);
  if g.result <> 'offline.device_revoked' then
    raise exception 'ATK-S6 BROKE: Hal''s revoked same-key installation was issued (%)', g.result;
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
-- The table refuses a grant that names Gus as owner but Hal's device (or the
-- reverse), whichever role writes it; the surviving rows all agree with their
-- device.
do $$
declare ok boolean;
begin
  ok := false;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, attestation_state)
    values ('00000000-0000-4000-8000-00000a060008', (select id from s6_state where key = 'hal-device'),
            'identity_lifetime_free', 70, now() + interval '1 day', 'attested');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'ATK-S6 BROKE: a grant naming another owner''s device was accepted'; end if;
  ok := false;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at)
    values ('00000000-0000-4000-8000-00000a060009', (select id from s6_state where key = 'gus-device'),
            'identity_lifetime_free', 71, now() + interval '1 day');
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'ATK-S6 BROKE: a grant naming another owner''s device (stamped state) was accepted'; end if;
  if exists (
    select 1 from public.offline_grants g join public.offline_devices d on d.id = g.device_id
    where g.user_id <> d.user_id or g.attestation_state <> d.attestation_state
  ) then
    raise exception 'ATK-S6 BROKE: a grant disagrees with its device (owner or state)';
  end if;
end $$;
set local role service_role;
do $$
declare ok boolean := false;
begin
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, expires_at, attestation_state)
    values ('00000000-0000-4000-8000-00000a060008', (select id from s6_state where key = 'gus-device'),
            'identity_lifetime_free', 72, now() + interval '1 day', 'attested');
  exception when check_violation or insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'ATK-S6 BROKE: service_role wrote a grant claiming attested for an unattested device'; end if;
end $$;
reset role;
\echo ATK-S6 HOLDS: same installation key under two owners stays two isolated devices
rollback;

\echo W04-06 ATTACK MATRIX (SQL): ALL CASES HOLD
