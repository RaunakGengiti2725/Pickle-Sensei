-- ============================================================================
-- W04-01 ADVERSARIAL ATTACK SUITE against candidate 77b5814e
-- (20260908120000_offline_device_grants.sql).
--
-- Run with supabase/tests/attacks/run_w04_01_attack.sh (fresh shim + every
-- migration, then this file WITHOUT ON_ERROR_STOP so every attack reports).
-- Each attack asserts the behaviour the work package promises; an assertion
-- failure prints "ATTACK Axx: BREAK — <message>", a surviving candidate prints
-- "ATTACK Axx: HELD". The runner exits non-zero when any attack reports BREAK.
--
-- Attack categories exercised:
--   A01 double submit / concurrency      concurrent first registration
--   A02 interleaved account switch       two accounts alternate on one key
--   A03 boundary values                  key length, ticket counts, clocks,
--                                        NaN / Infinity / out-of-range payloads
--   A04 corrupt / partial persisted state forged allocation, cascade-deleted
--                                        settlement, vouch residue
--   A05 replay & duplicate identities    replayed settlement with a different
--                                        payload, two heirs of one identity pair
--   A06 unauthorised roles               service_role, cross-user, forged vouch
--   A07 free-rating conservation         online/offline interleavings
--   A08 crash between steps              settlement fails after the consumed
--                                        event was written
--   A09 process death / retry storm      re-issue idempotency, grant growth
--   A10 late-link race                   identity linked while allocating
--   A11 released hold vs late link       late-linked identity and a returned
--                                        ticket
--   A12 heir race consume vs release     two sessions, one ticket
-- ============================================================================

\set ON_ERROR_STOP off
\set QUIET on

create schema atk;
create extension if not exists dblink with schema atk;

-- Run one statement as the current role: 'allowed <n>' or '<SQLSTATE>:<hint>'.
create function atk.try(p_sql text) returns text
language plpgsql as $$
declare n integer; v_state text; v_hint text;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'allowed ' || n;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end $$;

-- Act as an account through the API (transaction-local).
create function atk.act(p_uid uuid, p_session uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.headers',
    jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('session_id', p_session)::text, true);
  execute 'set local role authenticated';
end $$;

create function atk.owner() returns void
language plpgsql as $$
begin
  execute 'reset role';
end $$;

-- A committed account with one sign-in identity and one live session.
create function atk.mk_user(p_uid uuid, p_email text, p_provider text, p_sub text, p_session uuid) returns void
language plpgsql as $$
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (p_uid, p_email, jsonb_build_object('full_name', p_email), jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_sub, p_uid, jsonb_build_object('sub', p_sub));
  insert into auth.sessions (id, user_id) values (p_session, p_uid);
end $$;

-- The settlement payload (apply_synced_shot shape), scored.
create function atk.shot(p_id uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-08T10:00:00Z', 'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.4, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;

-- "begin; act as this account through the API" for a dblink connection.
create function atk.as_client(p_uid uuid, p_session uuid) returns text
language sql as $$
  select format(
    'begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
    || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
    jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text,
    p_uid::text, jsonb_build_object('session_id', p_session)::text)
$$;

create function atk.conninfo() returns text
language sql as $$
  select format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1),
    current_setting('port'), current_database())
$$;

create function atk.await_lock(p_application text) returns void
language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then
      return;
    end if;
    if clock_timestamp() > deadline then
      raise exception 'the second connection never blocked';
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

-- Collect an async dblink result: 'ok:<text>' or 'error:<SQLSTATE-free message>'.
create function atk.collect(p_connection text) returns text
language plpgsql as $$
declare v text; e text;
begin
  select value into v from atk.dblink_get_result(p_connection, false) as t(value text);
  e := atk.dblink_error_message(p_connection);
  perform 1 from atk.dblink_get_result(p_connection, false) as t(value text);
  if e is not null and e <> 'OK' then
    return 'error:' || e;
  end if;
  return 'ok:' || coalesce(v, '');
end $$;

-- Per-identity conservation audit (the invariant the package promises).
create function atk.audit() returns text
language plpgsql as $$
declare bad record;
begin
  for bad in
    select h.hash,
           coalesce((select scored_count from public.free_rating_ledger l where l.identity_hash = h.hash), 0) as scored,
           (select count(*) from public.offline_allocation_ledger a
             where a.event = 'allocated' and h.hash = any(a.identity_hashes)
               and not exists (select 1 from public.offline_allocation_ledger c
                               where c.ticket_id = a.ticket_id and c.event = 'consumed')) as outstanding
    from (select distinct unnest(identity_hashes) as hash from public.offline_allocation_ledger) h
  loop
    if bad.scored + bad.outstanding > 2 then
      return format('identity %s: scored %s + outstanding %s > 2', left(bad.hash, 8), bad.scored, bad.outstanding);
    end if;
  end loop;
  return 'ok';
end $$;

grant usage on schema atk to authenticated, anon, service_role;
grant execute on all functions in schema atk to authenticated, anon, service_role;

-- ───────────────────────────── A01: double submit ─────────────────────────────
-- Two in-flight first registrations of the same (account, installation key):
-- the mobile client retries a timed-out registration while the first request
-- is still executing. Contract: register_offline_device() is idempotent and
-- returns accepted | offline.invalid_input | offline.device_environment_mismatch.
select atk.mk_user('0000a7a7-0000-4000-8000-000000000001', 'a01@example.test', 'apple', 'apple-a01', '0000a7a7-0000-4000-8000-000000000101');
do $$
declare first text; second text; first_id uuid; second_id uuid;
begin
  perform atk.dblink_connect('a01_first', atk.conninfo() || ' application_name=a01_first');
  perform atk.dblink_connect('a01_second', atk.conninfo() || ' application_name=a01_second');
  perform atk.dblink_exec('a01_first', 'set statement_timeout = ''5s''');
  perform atk.dblink_exec('a01_second', 'set statement_timeout = ''5s''');
  perform atk.dblink_exec('a01_first', atk.as_client('0000a7a7-0000-4000-8000-000000000001', '0000a7a7-0000-4000-8000-000000000101'));
  perform atk.dblink_exec('a01_second', atk.as_client('0000a7a7-0000-4000-8000-000000000001', '0000a7a7-0000-4000-8000-000000000101'));
  perform atk.dblink_send_query('a01_first',
    'select result || '':'' || coalesce(device_id::text, '''') from public.register_offline_device(''a01-key'', ''production'', true)');
  first := atk.collect('a01_first');
  perform atk.dblink_send_query('a01_second',
    'select result || '':'' || coalesce(device_id::text, '''') from public.register_offline_device(''a01-key'', ''production'', true)');
  perform atk.await_lock('a01_second');
  perform atk.dblink_exec('a01_first', 'commit');
  second := atk.collect('a01_second');
  perform atk.dblink_exec('a01_second', case when second like 'error:%' then 'rollback' else 'commit' end);
  perform atk.dblink_disconnect('a01_first');
  perform atk.dblink_disconnect('a01_second');
  if first not like 'ok:accepted:%' then
    raise exception 'first registration must be accepted (got %)', first;
  end if;
  if second not like 'ok:accepted:%' then
    raise exception 'a concurrent duplicate registration must be idempotent (accepted), got %', second;
  end if;
  first_id := split_part(first, ':', 3)::uuid;
  second_id := split_part(second, ':', 3)::uuid;
  if first_id <> second_id then
    raise exception 'both registrations must name the same device (% vs %)', first_id, second_id;
  end if;
end $$;
\if :ERROR
\echo 'ATTACK A01 (double submit: concurrent first registration): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A01 (double submit: concurrent first registration): HELD'
\endif

-- ─────────────────── A02: interleaved account switch on one key ───────────────
begin;
do $$
declare x uuid := '0000a7a7-0000-4000-8000-000000000002'; y uuid := '0000a7a7-0000-4000-8000-000000000003';
        sx uuid := '0000a7a7-0000-4000-8000-000000000102'; sy uuid := '0000a7a7-0000-4000-8000-000000000103';
        x2 uuid := '0000a7a7-0000-4000-8000-000000000004'; sx2 uuid := '0000a7a7-0000-4000-8000-000000000104';
        tx uuid[]; ty uuid[]; again uuid[]; r text; g record; n int;
begin
  perform atk.mk_user(x, 'a02-x@example.test', 'google', 'google-a02-x', sx);
  perform atk.mk_user(y, 'a02-y@example.test', 'apple', 'apple-a02-y', sy);

  perform atk.act(x, sx);
  perform public.register_offline_device('shared-a02', 'production', true);
  select ticket_ids into tx from public.issue_offline_grant('shared-a02', 2);
  perform atk.owner();
  if coalesce(array_length(tx, 1), 0) <> 2 then raise exception 'X gets 2 tickets (got %)', tx; end if;

  perform atk.act(y, sy);
  perform public.register_offline_device('shared-a02', 'production', true);
  select ticket_ids into ty from public.issue_offline_grant('shared-a02', 2);
  if coalesce(array_length(ty, 1), 0) <> 2 then raise exception 'Y gets its own 2 tickets (got %)', ty; end if;
  if tx && ty then raise exception 'Y must never be handed X''s tickets'; end if;
  -- Y on X's ticket: nothing.
  r := public.consume_offline_ticket(tx[1], atk.shot('0000a7a7-0000-4000-8000-00000000a201'));
  if r <> 'offline.ticket_not_found' then raise exception 'Y consuming X''s ticket (got %)', r; end if;
  r := public.release_offline_ticket(tx[1], 'unused_ticket_returned');
  if r <> 'offline.ticket_not_found' then raise exception 'Y releasing X''s ticket (got %)', r; end if;
  if public.offline_hold_count() <> 2 then raise exception 'Y holds exactly its own 2 (got %)', public.offline_hold_count(); end if;
  perform atk.owner();

  -- X back on the device: its own tickets, unchanged.
  perform atk.act(x, sx);
  select ticket_ids into again from public.issue_offline_grant('shared-a02', 2);
  if again <> tx then raise exception 'X re-issue must return exactly its tickets (% vs %)', again, tx; end if;
  r := public.consume_offline_ticket(tx[1], atk.shot('0000a7a7-0000-4000-8000-00000000a202'));
  if r <> 'accepted' then raise exception 'X settles its own ticket (got %)', r; end if;
  if public.offline_hold_count() <> 1 then raise exception 'X now holds 1 (got %)', public.offline_hold_count(); end if;
  perform atk.owner();

  perform atk.act(y, sy);
  if public.offline_hold_count() <> 2 then raise exception 'Y unaffected by X''s settlement (got %)', public.offline_hold_count(); end if;
  select ticket_ids into again from public.issue_offline_grant('shared-a02', 2);
  if again <> ty then raise exception 'Y re-issue must return exactly its tickets'; end if;
  perform atk.owner();

  -- X deletes the account and signs in again with the same Google identity
  -- on the same installation: exactly the unconsumed ticket comes back.
  delete from auth.users where id = x;
  perform atk.mk_user(x2, 'a02-x2@example.test', 'google', 'google-a02-x', sx2);
  perform atk.act(x2, sx2);
  perform public.register_offline_device('shared-a02', 'production', true);
  select ticket_ids into again from public.issue_offline_grant('shared-a02', 2);
  if again <> array[tx[2]] then raise exception 'the re-created X recovers only its outstanding ticket (got %)', again; end if;
  if public.offline_hold_count() <> 1 then raise exception 'the re-created X holds 1 (got %)', public.offline_hold_count(); end if;
  perform atk.owner();

  perform atk.act(y, sy);
  if public.offline_hold_count() <> 2 then raise exception 'Y still unaffected (got %)', public.offline_hold_count(); end if;
  perform atk.owner();
  if atk.audit() <> 'ok' then raise exception '%', atk.audit(); end if;
end $$;
\if :ERROR
\echo 'ATTACK A02 (interleaved account switch on one installation): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A02 (interleaved account switch on one installation): HELD'
\endif
rollback;

-- ───────────────────────────── A03: boundary values ───────────────────────────
begin;
do $$
declare u uuid := '0000a7a7-0000-4000-8000-000000000005'; su uuid := '0000a7a7-0000-4000-8000-000000000105';
        p uuid := '0000a7a7-0000-4000-8000-000000000006'; sp uuid := '0000a7a7-0000-4000-8000-000000000106';
        r record; t text; tix uuid[]; k128 text := repeat('k', 128); k129 text := repeat('k', 129);
        payload jsonb; bad text; shot_id uuid; n int;
begin
  perform atk.mk_user(u, 'a03@example.test', 'apple', 'apple-a03', su);
  perform atk.mk_user(p, 'a03-pro@example.test', 'google', 'google-a03', sp);
  insert into public.billing_entitlements (user_id, premium, expires_at) values (p, true, 'infinity');

  perform atk.act(u, su);
  select * into r from public.register_offline_device(k128, 'production', true);
  if r.result <> 'accepted' then raise exception 'a 128-char key is the documented maximum (got %)', r.result; end if;
  select * into r from public.register_offline_device(k129, 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'a 129-char key must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('.dot', 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'a key starting with punctuation must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('', 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'an empty key must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('a', 'production', true);
  if r.result <> 'accepted' then raise exception 'a 1-char key registers (got %)', r.result; end if;
  select * into r from public.register_offline_device('a03-key', 'production', true);

  select * into r from public.issue_offline_grant('a03-key', 3);
  if r.result <> 'offline.invalid_input' then raise exception '3 tickets must be refused (got %)', r.result; end if;
  select * into r from public.issue_offline_grant('a03-key', -1);
  if r.result <> 'offline.invalid_input' then raise exception '-1 tickets must be refused (got %)', r.result; end if;
  select * into r from public.issue_offline_grant('a03-key', null);
  if r.result <> 'offline.invalid_input' then raise exception 'null tickets must be refused (got %)', r.result; end if;
  select * into r from public.issue_offline_grant('a03-key', 0);
  if r.result <> 'offline.invalid_input' then raise exception '0 tickets with capacity is not a grant (got %)', r.result; end if;
  if (select count(*) from public.offline_grants) <> 0 or (select count(*) from public.offline_allocation_ledger) <> 0 then
    raise exception 'refused requests must persist nothing';
  end if;
  select * into r from public.issue_offline_grant('a03-key', 1);
  if r.result <> 'accepted' or array_length(r.ticket_ids, 1) <> 1 then raise exception 'one ticket (got %)', r; end if;
  tix := r.ticket_ids;
  if r.expires_at - r.issued_at <> interval '7 days' then raise exception 'free lease is exactly 7 days'; end if;

  -- Payload boundaries: every refusal leaves the ticket outstanding and writes
  -- nothing. NaN / Infinity / negative scores, out-of-range clocks, overflow.
  foreach bad in array array[
    '{"overallScore":"NaN"}', '{"overallScore":"Infinity"}', '{"overallScore":"-Infinity"}',
    '{"overallScore":-0.01}', '{"overallScore":10.01}', '{"overallScore":"1e400"}',
    '{"overallScore":null}', '{"capturedAt":"0001-01-01T00:00:00Z"}', '{"capturedAt":"infinity"}',
    '{"capturedAt":"9999-12-31T23:59:59Z"}', '{"capturedAt":null}', '{"startMs":"NaN"}',
    '{"endMs":2147483648}', '{"shotType":null}', '{"cameraView":"top"}', '{"resultKind":"low_confidence"}',
    '{"resultKind":"partial"}', '{"resultKind":"bogus"}',
    '{"confidence":"NaN"}', '{"confidence":1.5}', '{"id":"not-a-uuid"}', '{"sessionId":"nope"}',
    '{"versionVector":null}', '{"versionVector":"x"}'
  ] loop
    shot_id := gen_random_uuid();
    payload := atk.shot(shot_id) || bad::jsonb;
    t := public.consume_offline_ticket(tix[1], payload);
    if t = 'accepted' then
      -- Some of these may be legitimately storable; the ticket must then be
      -- consumed exactly once and never again for another payload.
      if not exists (select 1 from public.shots s where s.id = shot_id and s.result_kind = 'scored') then
        raise exception 'accepted % but no scored shot', bad;
      end if;
      raise exception 'boundary payload % was ACCEPTED as a rating (score %, captured %)', bad,
        (select overall_score from public.shots where id = shot_id), (select captured_at from public.shots where id = shot_id);
    end if;
    if exists (select 1 from public.shots s where s.id = shot_id)
       or exists (select 1 from public.offline_allocation_ledger c where c.event = 'consumed') then
      raise exception 'refused payload % left a row behind (verdict %)', bad, t;
    end if;
    if coalesce(current_setting('pickle.offline_ticket_id', true), '') <> '' then
      raise exception 'refused payload % left the settlement vouch set (%)', bad, current_setting('pickle.offline_ticket_id', true);
    end if;
  end loop;
  if public.offline_hold_count() <> 1 then raise exception 'the ticket is still outstanding after every refusal'; end if;
  t := public.consume_offline_ticket(tix[1], atk.shot('0000a7a7-0000-4000-8000-00000000a301'));
  if t <> 'accepted' then raise exception 'a well-formed settlement still works after the refusals (got %)', t; end if;
  perform atk.owner();

  -- Pro clocks: infinity, one second ahead, exactly 7 days, far past.
  perform atk.act(p, sp);
  perform public.register_offline_device('a03-pro', 'production', true);
  select * into r from public.issue_offline_grant('a03-pro', 2);
  if r.result <> 'accepted' or r.entitlement_source <> 'verified_store' or r.expires_at - r.issued_at <> interval '7 days'
     or r.entitlement_expires_at <> 'infinity' or r.ticket_ids <> '{}'::uuid[] then
    raise exception 'infinite entitlement leases exactly 7 days with no tickets (got %)', r;
  end if;
  perform atk.owner();
  update public.billing_entitlements set expires_at = now() + interval '1 second' where user_id = p;
  perform atk.act(p, sp);
  select * into r from public.issue_offline_grant('a03-pro', 2);
  if r.result <> 'accepted' or r.entitlement_source <> 'verified_store' or r.expires_at <> now() + interval '1 second' then
    raise exception 'a lease ends at the entitlement expiry when that is sooner (got %)', r;
  end if;
  perform atk.owner();
  update public.billing_entitlements set expires_at = now() + interval '7 days' where user_id = p;
  perform atk.act(p, sp);
  select * into r from public.issue_offline_grant('a03-pro', 2);
  if r.result <> 'accepted' or r.expires_at <> now() + interval '7 days' or r.expires_at > r.entitlement_expires_at then
    raise exception 'an entitlement exactly 7 days out leases exactly 7 days (got %)', r;
  end if;
  perform atk.owner();
  update public.billing_entitlements set expires_at = '-infinity' where user_id = p;
  perform atk.act(p, sp);
  select * into r from public.issue_offline_grant('a03-pro', 2);
  if r.result <> 'accepted' or r.entitlement_source <> 'identity_lifetime_free' or array_length(r.ticket_ids, 1) <> 2
     or r.entitlement_expires_at is not null then
    raise exception 'a -infinity entitlement is a free identity (got %)', r;
  end if;
  perform atk.owner();
  update public.billing_entitlements set expires_at = now() where user_id = p;
  perform atk.act(p, sp);
  select * into r from public.issue_offline_grant('a03-pro', 2);
  if r.result <> 'accepted' or r.entitlement_source <> 'identity_lifetime_free' then
    raise exception 'an entitlement expiring exactly now is not effective (got %)', r;
  end if;
  perform atk.owner();
  if exists (select 1 from public.offline_grants g where g.expires_at > g.issued_at + interval '7 days'
             or (g.entitlement_expires_at is not null and g.expires_at > g.entitlement_expires_at)) then
    raise exception 'a lease exceeded its bound';
  end if;
  if atk.audit() <> 'ok' then raise exception '%', atk.audit(); end if;
end $$;
\if :ERROR
\echo 'ATTACK A03 (boundary values: keys, counts, clocks, NaN/Infinity payloads): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A03 (boundary values: keys, counts, clocks, NaN/Infinity payloads): HELD'
\endif
rollback;

-- ───────────────────── A04: corrupt / partial persisted state ─────────────────
begin;
do $$
declare u uuid := '0000a7a7-0000-4000-8000-000000000007'; su uuid := '0000a7a7-0000-4000-8000-000000000107';
        v uuid := '0000a7a7-0000-4000-8000-000000000008'; sv uuid := '0000a7a7-0000-4000-8000-000000000108';
        u2 uuid := '0000a7a7-0000-4000-8000-000000000009'; su2 uuid := '0000a7a7-0000-4000-8000-000000000109';
        tix uuid[]; dev_u uuid; dev_v uuid; grant_u uuid; r text; forged uuid := gen_random_uuid();
        shot_id uuid := '0000a7a7-0000-4000-8000-00000000a401';
begin
  perform atk.mk_user(u, 'a04-u@example.test', 'apple', 'apple-a04-u', su);
  perform atk.mk_user(v, 'a04-v@example.test', 'google', 'google-a04-v', sv);
  perform atk.act(u, su);
  select device_id into dev_u from public.register_offline_device('a04-u', 'production', true);
  select grant_id, ticket_ids into grant_u, tix from public.issue_offline_grant('a04-u', 2);
  perform atk.owner();
  perform atk.act(v, sv);
  select device_id into dev_v from public.register_offline_device('a04-v', 'production', true);
  perform atk.owner();

  -- (a) A support/owner write forging an allocation that names ANOTHER
  -- account's device (with an explicit installation key) must be refused as
  -- an allocation that names a device the owner does not hold — the same
  -- rule guard_offline_grant() enforces for grants.
  r := atk.try(format($q$insert into public.offline_allocation_ledger
    (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id)
    values (%L, %L, %L, 1, %L, 'allocated', '{}', 'a04-v')$q$, u, dev_v, grant_u, forged));
  if r <> '23514:' then
    raise exception 'an allocation naming another account''s device was written (got %)', r;
  end if;
  perform atk.owner();

  -- (b) Settlement whose shot was cascade-deleted with the account: the heir
  -- replaying the same (ticket, shot) must not be told "accepted" for a
  -- rating that no longer exists — or if it is, no second settlement of that
  -- ticket may ever land.
  perform atk.act(u, su);
  r := public.consume_offline_ticket(tix[1], atk.shot(shot_id));
  if r <> 'accepted' then raise exception 'precondition: settle (got %)', r; end if;
  perform atk.owner();
  delete from auth.users where id = u;
  if exists (select 1 from public.shots where id = shot_id) then raise exception 'precondition: shot cascades'; end if;
  perform atk.mk_user(u2, 'a04-u2@example.test', 'apple', 'apple-a04-u', su2);
  perform atk.act(u2, su2);
  r := public.consume_offline_ticket(tix[1], atk.shot(shot_id));
  if r not in ('accepted', 'offline.ticket_consumed') then raise exception 'replay after deletion (got %)', r; end if;
  r := public.consume_offline_ticket(tix[1], atk.shot('0000a7a7-0000-4000-8000-00000000a402'));
  if r <> 'offline.ticket_consumed' then raise exception 'a consumed ticket never settles again (got %)', r; end if;
  -- The freed shot id can not be reused to settle the other ticket either.
  r := public.consume_offline_ticket(tix[2], atk.shot(shot_id));
  if r <> 'offline.shot_not_chargeable' then raise exception 'a shot id already named by a settlement is not chargeable again (got %)', r; end if;
  if public.offline_hold_count() <> 1 then raise exception 'heir holds exactly the unconsumed ticket (got %)', public.offline_hold_count(); end if;
  perform atk.owner();

  -- (c) Vouch residue: after a successful settlement the transaction-local
  -- vouch must be empty so nothing later in the same transaction can ride it.
  perform atk.act(u2, su2);
  r := public.consume_offline_ticket(tix[2], atk.shot('0000a7a7-0000-4000-8000-00000000a403'));
  if r <> 'accepted' then raise exception 'settle second (got %)', r; end if;
  if coalesce(current_setting('pickle.offline_ticket_id', true), '') <> '' then
    raise exception 'the settlement vouch survived the RPC: %', current_setting('pickle.offline_ticket_id', true);
  end if;
  perform atk.owner();
  if atk.audit() <> 'ok' then raise exception '%', atk.audit(); end if;
end $$;
\if :ERROR
\echo 'ATTACK A04 (corrupt/partial state: forged allocation, cascade-deleted settlement, vouch residue): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A04 (corrupt/partial state: forged allocation, cascade-deleted settlement, vouch residue): HELD'
\endif
rollback;

-- ───────────────────── A05: replay & duplicate identities ─────────────────────
begin;
do $$
declare a uuid := '0000a7a7-0000-4000-8000-00000000000a'; sa uuid := '0000a7a7-0000-4000-8000-00000000010a';
        b uuid := '0000a7a7-0000-4000-8000-00000000000b'; sb uuid := '0000a7a7-0000-4000-8000-00000000010b';
        c uuid := '0000a7a7-0000-4000-8000-00000000000c'; sc uuid := '0000a7a7-0000-4000-8000-00000000010c';
        tix uuid[]; got uuid[]; r text; shot1 uuid := '0000a7a7-0000-4000-8000-00000000a501';
begin
  -- One account, two sign-in identities.
  perform atk.mk_user(a, 'a05-a@example.test', 'google', 'google-a05', sa);
  insert into auth.identities (provider, provider_id, user_id, identity_data) values ('apple', 'apple-a05', a, '{"sub":"apple-a05"}');
  perform atk.act(a, sa);
  perform public.register_offline_device('a05-key', 'production', true);
  select ticket_ids into tix from public.issue_offline_grant('a05-key', 2);
  -- (a) Replay with a DIFFERENT payload for the same (ticket, shot id): the
  -- stored rating must not change and nothing new is written.
  r := public.consume_offline_ticket(tix[1], atk.shot(shot1));
  if r <> 'accepted' then raise exception 'settle (got %)', r; end if;
  r := public.consume_offline_ticket(tix[1], atk.shot(shot1) || '{"overallScore": 9.9, "shotType": "dink"}'::jsonb);
  if r <> 'accepted' then raise exception 'replay is idempotent (got %)', r; end if;
  if (select overall_score from public.shots where id = shot1) <> 7.4 or (select shot_type from public.shots where id = shot1) <> 'drive' then
    raise exception 'a replay rewrote the stored rating';
  end if;
  if (select count(*) from public.shots) <> 1 or (select count(*) from public.offline_allocation_ledger where event = 'consumed') <> 1 then
    raise exception 'a replay wrote a second row';
  end if;
  perform atk.owner();

  -- (b) The account is deleted; each identity signs in again as its own
  -- account. Both heirs are handed the outstanding ticket; whichever settles
  -- it first wins, the other stops being handed it, and neither identity
  -- ever exceeds scored + outstanding = 2.
  delete from auth.users where id = a;
  perform atk.mk_user(b, 'a05-b@example.test', 'google', 'google-a05', sb);
  perform atk.mk_user(c, 'a05-c@example.test', 'apple', 'apple-a05', sc);
  perform atk.act(b, sb);
  perform public.register_offline_device('a05-key', 'production', true);
  select ticket_ids into got from public.issue_offline_grant('a05-key', 2);
  if got <> array[tix[2]] then raise exception 'heir B recovers the outstanding ticket only (got %)', got; end if;
  if public.offline_hold_count() <> 1 then raise exception 'B holds 1'; end if;
  perform atk.owner();
  perform atk.act(c, sc);
  perform public.register_offline_device('a05-key', 'production', true);
  select ticket_ids into got from public.issue_offline_grant('a05-key', 2);
  if got <> array[tix[2]] then raise exception 'heir C recovers the same ticket (got %)', got; end if;
  r := public.consume_offline_ticket(tix[2], atk.shot('0000a7a7-0000-4000-8000-00000000a502'));
  if r <> 'accepted' then raise exception 'C settles (got %)', r; end if;
  perform atk.owner();
  perform atk.act(b, sb);
  r := public.consume_offline_ticket(tix[2], atk.shot('0000a7a7-0000-4000-8000-00000000a503'));
  if r <> 'offline.ticket_consumed' then raise exception 'B sees the terminal verdict (got %)', r; end if;
  select ticket_ids, result into got, r from public.issue_offline_grant('a05-key', 2);
  if r = 'accepted' and tix[2] = any(got) then raise exception 'a consumed ticket was re-issued to B'; end if;
  perform atk.owner();
  if atk.audit() <> 'ok' then raise exception '%', atk.audit(); end if;
end $$;
\if :ERROR
\echo 'ATTACK A05 (replay with a different payload; two heirs of one identity pair): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A05 (replay with a different payload; two heirs of one identity pair): HELD'
\endif
rollback;

-- ─────────────── A06: unauthorised roles — allowed AND denied paths ───────────
begin;
do $$
declare u uuid := '0000a7a7-0000-4000-8000-00000000000d'; su uuid := '0000a7a7-0000-4000-8000-00000000010d';
        w uuid := '0000a7a7-0000-4000-8000-00000000000e'; sw uuid := '0000a7a7-0000-4000-8000-00000000010e';
        tix uuid[]; r text; t text; forged_shot uuid := '0000a7a7-0000-4000-8000-00000000a601';
begin
  perform atk.mk_user(u, 'a06-u@example.test', 'apple', 'apple-a06-u', su);
  perform atk.mk_user(w, 'a06-w@example.test', 'google', 'google-a06-w', sw);
  perform atk.act(u, su);
  perform public.register_offline_device('a06-u', 'production', true);
  select ticket_ids into tix from public.issue_offline_grant('a06-u', 2);
  -- Allowed: the owner reads its own rows through the API.
  if (select count(*) from public.offline_devices) <> 1 or (select count(*) from public.offline_grants) <> 1
     or (select count(*) from public.offline_allocation_ledger) <> 2 then
    raise exception 'the owner must read exactly its own rows';
  end if;
  perform atk.owner();

  -- service_role: no table, no RPC (allowed nothing).
  execute 'set local role service_role';
  foreach t in array array['offline_devices', 'offline_grants', 'offline_allocation_ledger', 'offline_allocation_identity_links'] loop
    r := atk.try(format('select 1 from public.%I limit 1', t));
    if r <> '42501:' then raise exception 'service_role read public.% (got %)', t, r; end if;
  end loop;
  r := atk.try(format('select public.consume_offline_ticket(%L, atk.shot(%L))', tix[1], forged_shot));
  if r <> '42501:' then raise exception 'service_role consume (got %)', r; end if;
  r := atk.try(format('select public.release_offline_ticket(%L, ''unused_ticket_returned'')', tix[1]));
  if r <> '42501:' then raise exception 'service_role release (got %)', r; end if;
  r := atk.try('select public.issue_offline_grant(''a06-u'', 1)');
  if r <> '42501:' then raise exception 'service_role issue (got %)', r; end if;
  r := atk.try('select public.offline_hold_count()');
  if r <> '42501:' then raise exception 'service_role hold count (got %)', r; end if;
  perform atk.owner();

  -- Another authenticated user with the API proof: reads nothing of U's,
  -- owns none of U's tickets, and cannot forge the settlement vouch to write
  -- a scored shot around the ticket (no consumed event → refused, no row).
  perform atk.act(w, sw);
  if exists (select 1 from public.offline_devices) or exists (select 1 from public.offline_grants)
     or exists (select 1 from public.offline_allocation_ledger) then
    raise exception 'another user must read none of U''s offline rows';
  end if;
  if public.offline_hold_count() <> 0 then raise exception 'another user holds nothing of U''s'; end if;
  perform set_config('pickle.offline_ticket_id', tix[1]::text, true);
  r := atk.try(format($q$insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version
    ) values (%L, %L, 'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')$q$, forged_shot, w));
  if r not like 'PKP03:%' and r not like '42501:%' then raise exception 'a forged offline vouch wrote a scored shot (got %)', r; end if;
  -- Even the ticket's real owner cannot ride a hand-set vouch without the RPC.
  perform set_config('pickle.offline_ticket_id', '', true);
  perform atk.owner();
  perform atk.act(u, su);
  perform set_config('pickle.offline_ticket_id', tix[1]::text, true);
  r := atk.try(format($q$insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version
    ) values (%L, %L, 'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')$q$, forged_shot, u));
  if r not like 'PKP03:%' and r not like '42501:%' then raise exception 'the owner rode a hand-set vouch (got %)', r; end if;
  perform set_config('pickle.offline_ticket_id', '', true);
  if exists (select 1 from public.shots where id = forged_shot) then raise exception 'a forged shot row exists'; end if;
  if public.offline_hold_count() <> 2 then raise exception 'both tickets still outstanding'; end if;
  perform atk.owner();
end $$;
\if :ERROR
\echo 'ATTACK A06 (unauthorised roles: service_role, cross-user, forged settlement vouch): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A06 (unauthorised roles: service_role, cross-user, forged settlement vouch): HELD'
\endif
rollback;

-- ───────────────── A07: free-rating conservation, interleavings ───────────────
begin;
do $$
declare u uuid := '0000a7a7-0000-4000-8000-00000000000f'; su uuid := '0000a7a7-0000-4000-8000-00000000010f';
        v uuid := '0000a7a7-0000-4000-8000-000000000010'; sv uuid := '0000a7a7-0000-4000-8000-000000000110';
        p record; g record; r text; tix uuid[];
begin
  -- (a) online reserve → allocate (1 ticket) → settle ticket → direct INSERT
  -- under the live permit → the permit's own late sync must be the refused
  -- third unit.
  perform atk.mk_user(u, 'a07-u@example.test', 'apple', 'apple-a07-u', su);
  perform atk.act(u, su);
  perform public.register_offline_device('a07-u', 'production', true);
  select * into p from public.reserve_analysis_permit('a07-k1');
  if p.result <> 'accepted' then raise exception 'reserve (got %)', p.result; end if;
  select * into g from public.issue_offline_grant('a07-u', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then raise exception 'one ticket beside a live permit (got %)', g; end if;
  tix := g.ticket_ids;
  r := public.consume_offline_ticket(tix[1], atk.shot('0000a7a7-0000-4000-8000-00000000a701'));
  if r <> 'accepted' then raise exception 'settle (got %)', r; end if;
  r := atk.try(format($q$insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version
    ) values ('0000a7a7-0000-4000-8000-00000000a702', %L, 'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')$q$, u));
  if r <> 'allowed 1' then raise exception 'second rating under the live permit (got %)', r; end if;
  r := public.apply_synced_shot(atk.shot('0000a7a7-0000-4000-8000-00000000a703') || jsonb_build_object('analysisPermitId', p.permit_id));
  if r <> 'access.paywall_required' then raise exception 'the permit''s late sync must be the refused third unit (got %)', r; end if;
  select * into g from public.issue_offline_grant('a07-u', 2);
  if g.result <> 'access.paywall_required' then raise exception 'no more tickets at 2 (got %)', g.result; end if;
  if public.lifetime_scored_count() <> 2 then raise exception 'exactly 2 scored'; end if;
  perform atk.owner();

  -- (b) swept permit + ticket: permit sync first, then settlement, then no
  -- online reservation and no further ticket.
  perform atk.mk_user(v, 'a07-v@example.test', 'google', 'google-a07-v', sv);
  perform atk.act(v, sv);
  perform public.register_offline_device('a07-v', 'production', true);
  select * into p from public.reserve_analysis_permit('a07-k2');
  perform atk.owner();
  update public.analysis_permits set status = 'released', outcome = 'expired' where id = p.permit_id;
  perform atk.act(v, sv);
  select * into g from public.issue_offline_grant('a07-v', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then raise exception 'a swept-but-syncable permit is a reservation (got %)', g; end if;
  r := public.apply_synced_shot(atk.shot('0000a7a7-0000-4000-8000-00000000a704') || jsonb_build_object('analysisPermitId', p.permit_id));
  if r <> 'accepted' then raise exception 'swept permit late sync (got %)', r; end if;
  r := public.consume_offline_ticket(g.ticket_ids[1], atk.shot('0000a7a7-0000-4000-8000-00000000a705'));
  if r <> 'accepted' then raise exception 'settle after sync (got %)', r; end if;
  select * into p from public.reserve_analysis_permit('a07-k3');
  if p.result <> 'access.paywall_required' then raise exception 'third online unit (got %)', p.result; end if;
  select * into g from public.issue_offline_grant('a07-v', 1);
  if g.result <> 'access.paywall_required' then raise exception 'third offline unit (got %)', g.result; end if;
  if public.lifetime_scored_count() <> 2 then raise exception 'exactly 2 scored (v)'; end if;
  perform atk.owner();
  if atk.audit() <> 'ok' then raise exception '%', atk.audit(); end if;
end $$;
\if :ERROR
\echo 'ATTACK A07 (free-rating conservation: online/offline interleavings): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A07 (free-rating conservation: online/offline interleavings): HELD'
\endif
rollback;

-- ───────────────────────── A08: crash between steps ───────────────────────────
begin;
do $$
declare u uuid := '0000a7a7-0000-4000-8000-000000000011'; su uuid := '0000a7a7-0000-4000-8000-000000000111';
        tix uuid[]; r text; v_shot uuid := '0000a7a7-0000-4000-8000-00000000a801';
begin
  perform atk.mk_user(u, 'a08@example.test', 'apple', 'apple-a08', su);
  perform atk.act(u, su);
  perform public.register_offline_device('a08', 'production', true);
  select ticket_ids into tix from public.issue_offline_grant('a08', 2);
  -- The consumed event and the shot are written, then the details fail.
  r := public.consume_offline_ticket(tix[1], atk.shot(v_shot)
    || '{"phases":[{"key":"backswing","startMs":0,"representativeMs":100,"endMs":200,"confidence":0.9}],"checkpoints":[{"key":"contact","score":"abc"}]}'::jsonb);
  if r not like 'shot.write_failed:%' then raise exception 'a failing detail write must fail the settlement (got %)', r; end if;
  if exists (select 1 from public.shots s where s.id = v_shot) or exists (select 1 from public.shot_phases ph where ph.shot_id = v_shot)
     or exists (select 1 from public.offline_allocation_ledger where event = 'consumed') then
    raise exception 'a failed settlement left partial rows';
  end if;
  if coalesce(current_setting('pickle.offline_ticket_id', true), '') <> '' then raise exception 'vouch residue after failure'; end if;
  if public.offline_hold_count() <> 2 then raise exception 'the ticket stays outstanding'; end if;
  -- phases as an object instead of an array.
  r := public.consume_offline_ticket(tix[1], atk.shot(v_shot) || '{"phases":{}}'::jsonb);
  if r not like 'shot.write_failed:%' then raise exception 'malformed phases (got %)', r; end if;
  if exists (select 1 from public.shots s where s.id = v_shot) then raise exception 'partial shot after malformed phases'; end if;
  -- Then the same ticket settles cleanly with the same shot id.
  r := public.consume_offline_ticket(tix[1], atk.shot(v_shot));
  if r <> 'accepted' then raise exception 'recovery settlement (got %)', r; end if;
  if public.offline_hold_count() <> 1 or public.lifetime_scored_count() <> 1 then raise exception 'exactly one consumed'; end if;
  perform atk.owner();
end $$;
\if :ERROR
\echo 'ATTACK A08 (crash between steps: detail write fails after the consumed event): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A08 (crash between steps: detail write fails after the consumed event): HELD'
\endif
rollback;

-- ──────────────────── A09: process death / restart, retry storm ───────────────
begin;
do $$
declare u uuid := '0000a7a7-0000-4000-8000-000000000012'; su uuid := '0000a7a7-0000-4000-8000-000000000112';
        first uuid[]; again uuid[]; i int; gens int[];
begin
  perform atk.mk_user(u, 'a09@example.test', 'google', 'google-a09', su);
  perform atk.act(u, su);
  perform public.register_offline_device('a09', 'production', true);
  select ticket_ids into first from public.issue_offline_grant('a09', 2);
  for i in 1..20 loop
    perform public.register_offline_device('a09', 'production', true);
    select ticket_ids into again from public.issue_offline_grant('a09', 2);
    if again <> first then raise exception 'restart % handed a different ticket set (% vs %)', i, again, first; end if;
  end loop;
  if public.offline_hold_count() <> 2 then raise exception 'still 2 holds'; end if;
  if (select count(*) from public.offline_allocation_ledger) <> 2 then raise exception 'no new allocations'; end if;
  select array_agg(generation order by generation) into gens from public.offline_grants;
  if gens[1] <> 1 or gens[array_length(gens, 1)] <> 21 or array_length(gens, 1) <> 21 then
    raise exception 'generations must be 1..21 contiguous (got %)', gens;
  end if;
  perform atk.owner();
end $$;
\if :ERROR
\echo 'ATTACK A09 (process death / retry storm: re-issue idempotency): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A09 (process death / retry storm: re-issue idempotency): HELD'
\endif
rollback;

-- ─────────── A10: identity linked WHILE the allocation is in flight ───────────
-- Sequential order (link before, or link after allocation) puts the hold on
-- the late-linked identity (hash on the allocation, or a link row). The race
-- — allocation reads the identities, the link commits, the allocation
-- commits — must not lose the hold for that identity.
select atk.mk_user('0000a7a7-0000-4000-8000-000000000013', 'a10@example.test', 'google', 'google-a10', '0000a7a7-0000-4000-8000-000000000113');
select atk.mk_user('0000a7a7-0000-4000-8000-00000000001b', 'a10-control@example.test', 'google', 'google-a10-control', '0000a7a7-0000-4000-8000-00000000011b');
do $$
declare a uuid := '0000a7a7-0000-4000-8000-000000000013'; sa uuid := '0000a7a7-0000-4000-8000-000000000113';
        h uuid := '0000a7a7-0000-4000-8000-000000000014'; sh uuid := '0000a7a7-0000-4000-8000-000000000114';
        ctl uuid := '0000a7a7-0000-4000-8000-00000000001b'; sctl uuid := '0000a7a7-0000-4000-8000-00000000011b';
        ctl_h uuid := '0000a7a7-0000-4000-8000-00000000001c'; sctl_h uuid := '0000a7a7-0000-4000-8000-00000000011c';
        r text; tix uuid[]; holds int;
begin
  -- Control: the same steps in sequence (allocation committed, THEN the
  -- Apple identity linked) put the hold on the late-linked identity.
  perform atk.dblink_connect('a10_ctl', atk.conninfo() || ' application_name=a10_ctl');
  perform atk.dblink_exec('a10_ctl', atk.as_client(ctl, sctl));
  perform 1 from atk.dblink('a10_ctl', 'select public.register_offline_device(''a10-ctl'', ''production'', true)') as t(v text);
  perform 1 from atk.dblink('a10_ctl', 'select ticket_ids::text from public.issue_offline_grant(''a10-ctl'', 2)') as t(v text);
  perform atk.dblink_exec('a10_ctl', 'commit');
  perform atk.dblink_disconnect('a10_ctl');
  insert into auth.identities (provider, provider_id, user_id, identity_data) values ('apple', 'apple-a10-control', ctl, '{"sub":"apple-a10-control"}');
  delete from auth.users where id = ctl;
  perform atk.mk_user(ctl_h, 'a10-control-heir@example.test', 'apple', 'apple-a10-control', sctl_h);
  perform atk.act(ctl_h, sctl_h);
  holds := public.offline_hold_count();
  perform atk.owner();
  if holds <> 2 then raise exception 'control: a sequentially late-linked identity carries the holds (got %)', holds; end if;

  perform atk.dblink_connect('a10_alloc', atk.conninfo() || ' application_name=a10_alloc');
  perform atk.dblink_exec('a10_alloc', 'set statement_timeout = ''5s''');
  perform atk.dblink_exec('a10_alloc', atk.as_client(a, sa));
  perform 1 from atk.dblink('a10_alloc', 'select public.register_offline_device(''a10-key'', ''production'', true)') as t(v text);
  perform atk.dblink_exec('a10_alloc', 'commit');
  perform atk.dblink_exec('a10_alloc', atk.as_client(a, sa));
  -- Allocation in flight (identities read, not yet committed).
  select v into r from atk.dblink('a10_alloc', 'select ticket_ids::text from public.issue_offline_grant(''a10-key'', 2)') as t(v text);
  tix := r::uuid[];
  -- Apple identity linked and committed meanwhile (autocommit on this session).
  insert into auth.identities (provider, provider_id, user_id, identity_data) values ('apple', 'apple-a10', a, '{"sub":"apple-a10"}');
  perform atk.dblink_exec('a10_alloc', 'commit');
  perform atk.dblink_disconnect('a10_alloc');
  if coalesce(array_length(tix, 1), 0) <> 2 then raise exception 'precondition: two tickets (got %)', tix; end if;

  -- Account deleted; the Apple identity signs in again as its own account.
  delete from auth.users where id = a;
  perform atk.mk_user(h, 'a10-heir@example.test', 'apple', 'apple-a10', sh);
  perform atk.act(h, sh);
  holds := public.offline_hold_count();
  perform atk.owner();
  if holds <> 2 then
    raise exception 'the identity linked during allocation lost the hold: heir holds % (expected 2)', holds;
  end if;
end $$;
\if :ERROR
\echo 'ATTACK A10 (late-link race: identity linked while the allocation is in flight): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A10 (late-link race: identity linked while the allocation is in flight): HELD'
\endif

-- ────────────── A11: a RETURNED ticket vs a late-linked identity ──────────────
-- offline_hold_count(): "a released ticket still counts — returning a ticket
-- is not a re-credit". The hold must count the same for every identity of the
-- account that returned it, including one linked after the allocation.
begin;
do $$
declare a uuid := '0000a7a7-0000-4000-8000-000000000015'; sa uuid := '0000a7a7-0000-4000-8000-000000000115';
        g uuid := '0000a7a7-0000-4000-8000-000000000016'; sg uuid := '0000a7a7-0000-4000-8000-000000000116';
        p uuid := '0000a7a7-0000-4000-8000-000000000017'; sp uuid := '0000a7a7-0000-4000-8000-000000000117';
        tix uuid[]; r text; holds_g int; holds_p int; got record;
begin
  perform atk.mk_user(a, 'a11@example.test', 'google', 'google-a11', sa);
  perform atk.act(a, sa);
  perform public.register_offline_device('a11-key', 'production', true);
  select ticket_ids into tix from public.issue_offline_grant('a11-key', 2);
  r := public.release_offline_ticket(tix[1], 'unused_ticket_returned');
  if r <> 'accepted' then raise exception 'release (got %)', r; end if;
  if public.offline_hold_count() <> 2 then raise exception 'precondition: the returned ticket still counts (got %)', public.offline_hold_count(); end if;
  perform atk.owner();
  -- Apple identity linked after the return.
  insert into auth.identities (provider, provider_id, user_id, identity_data) values ('apple', 'apple-a11', a, '{"sub":"apple-a11"}');
  perform atk.act(a, sa);
  if public.offline_hold_count() <> 2 then raise exception 'the account still holds 2 after linking (got %)', public.offline_hold_count(); end if;
  perform atk.owner();

  delete from auth.users where id = a;
  perform atk.mk_user(g, 'a11-g@example.test', 'google', 'google-a11', sg);
  perform atk.mk_user(p, 'a11-p@example.test', 'apple', 'apple-a11', sp);
  perform atk.act(g, sg);
  holds_g := public.offline_hold_count();
  perform atk.owner();
  perform atk.act(p, sp);
  holds_p := public.offline_hold_count();
  perform public.register_offline_device('a11-key', 'production', true);
  select * into got from public.issue_offline_grant('a11-key', 2);
  perform atk.owner();
  if holds_g <> 2 then raise exception 'the original identity carries both holds (got %)', holds_g; end if;
  if holds_p <> holds_g then
    raise exception 'the late-linked identity carries % hold(s) while the original carries % — the returned ticket became a re-credit for the late-linked identity (its heir was handed % new ticket(s), verdict %)',
      holds_p, holds_g, coalesce(array_length(array_remove(got.ticket_ids, tix[2]), 1), 0), got.result;
  end if;
end $$;
\if :ERROR
\echo 'ATTACK A11 (returned ticket vs late-linked identity): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A11 (returned ticket vs late-linked identity): HELD'
\endif
rollback;

-- ─────────────── A12: two heirs race consume vs release on one ticket ─────────
select atk.mk_user('0000a7a7-0000-4000-8000-000000000018', 'a12@example.test', 'google', 'google-a12', '0000a7a7-0000-4000-8000-000000000118');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-a12', '0000a7a7-0000-4000-8000-000000000018', '{"sub":"apple-a12"}');
-- The account allocates two tickets (committed), then is deleted; each of its
-- identities signs in again as its own account (committed so both sessions
-- below can see them).
do $$
declare a uuid := '0000a7a7-0000-4000-8000-000000000018'; sa uuid := '0000a7a7-0000-4000-8000-000000000118';
begin
  perform atk.dblink_connect('a12_setup', atk.conninfo());
  perform atk.dblink_exec('a12_setup', atk.as_client(a, sa));
  perform 1 from atk.dblink('a12_setup', 'select public.register_offline_device(''a12-key'', ''production'', true)') as t(v text);
  perform 1 from atk.dblink('a12_setup', 'select ticket_ids::text from public.issue_offline_grant(''a12-key'', 2)') as t(v text);
  perform atk.dblink_exec('a12_setup', 'commit');
  perform atk.dblink_disconnect('a12_setup');
end $$;
delete from auth.users where id = '0000a7a7-0000-4000-8000-000000000018';
select atk.mk_user('0000a7a7-0000-4000-8000-000000000019', 'a12-b@example.test', 'google', 'google-a12', '0000a7a7-0000-4000-8000-000000000119');
select atk.mk_user('0000a7a7-0000-4000-8000-00000000001a', 'a12-c@example.test', 'apple', 'apple-a12', '0000a7a7-0000-4000-8000-00000000011a');
do $$
declare b uuid := '0000a7a7-0000-4000-8000-000000000019'; sb uuid := '0000a7a7-0000-4000-8000-000000000119';
        c uuid := '0000a7a7-0000-4000-8000-00000000001a'; sc uuid := '0000a7a7-0000-4000-8000-00000000011a';
        tix uuid[]; out_b text; out_c text; n_consumed int; n_released int;
begin
  select array_agg(ticket_id order by id) into tix from public.offline_allocation_ledger
  where installation_key_id = 'a12-key' and event = 'allocated';
  if coalesce(array_length(tix, 1), 0) <> 2 then raise exception 'precondition: two tickets (got %)', tix; end if;
  perform atk.dblink_connect('a12_b', atk.conninfo() || ' application_name=a12_b');
  perform atk.dblink_connect('a12_c', atk.conninfo() || ' application_name=a12_c');
  perform atk.dblink_exec('a12_b', 'set statement_timeout = ''5s''');
  perform atk.dblink_exec('a12_c', 'set statement_timeout = ''5s''');
  perform atk.dblink_exec('a12_b', atk.as_client(b, sb));
  perform atk.dblink_exec('a12_c', atk.as_client(c, sc));
  perform atk.dblink_send_query('a12_b', format('select public.consume_offline_ticket(%L, atk.shot(%L))', tix[1], '0000a7a7-0000-4000-8000-00000000ac01'));
  out_b := atk.collect('a12_b');
  perform atk.dblink_send_query('a12_c', format('select public.release_offline_ticket(%L, ''unused_ticket_returned'')', tix[1]));
  perform atk.await_lock('a12_c');
  perform atk.dblink_exec('a12_b', 'commit');
  out_c := atk.collect('a12_c');
  perform atk.dblink_exec('a12_c', case when out_c like 'error:%' then 'rollback' else 'commit' end);
  perform atk.dblink_disconnect('a12_b');
  perform atk.dblink_disconnect('a12_c');
  if out_b <> 'ok:accepted' then raise exception 'B''s settlement (got %)', out_b; end if;
  if out_c <> 'ok:offline.ticket_consumed' then raise exception 'C''s release must read the terminal verdict, not an error (got %)', out_c; end if;
  select count(*) filter (where event = 'consumed'), count(*) filter (where event = 'released')
    into n_consumed, n_released from public.offline_allocation_ledger where ticket_id = tix[1];
  if n_consumed <> 1 or n_released <> 0 then raise exception 'ledger: consumed % released % for one ticket', n_consumed, n_released; end if;
  if atk.audit() <> 'ok' then raise exception '%', atk.audit(); end if;
end $$;
\if :ERROR
\echo 'ATTACK A12 (heir race: consume vs release on one ticket): BREAK —' :LAST_ERROR_MESSAGE
\else
\echo 'ATTACK A12 (heir race: consume vs release on one ticket): HELD'
\endif

\echo 'W04-01 ATTACK SUITE: DONE'
