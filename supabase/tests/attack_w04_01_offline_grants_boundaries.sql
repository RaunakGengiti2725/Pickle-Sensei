-- ============================================================================
-- W04-01 ADVERSARIAL BOUNDARY MATRIX (attack branch, not a candidate deliverable)
--
-- Attacks the candidate migration 20260908120000_offline_device_grants.sql at
-- its failure boundaries from psql, with hosted-like privileges: the file runs
-- as the table owner and switches to `authenticated` / `anon` / `service_role`
-- exactly the way supabase/tests/security_regression.sql does. Every attack is
-- one `do` block; a failed expectation or an unexpected error is RECORDED (not
-- raised) so that ONE run reports EVERY boundary, and the final block raises
-- with the full list of failures — psql exits 3 when any attack broke the
-- candidate, 0 when none did.
--
-- Run (disposable PostgreSQL only — never production):
--   psql "$XC_PG_URL" -v ON_ERROR_STOP=1 -f supabase/tests/attack_w04_01_offline_grants_boundaries.sql
-- after shim_auth.sql + every migration in order (see run_rls_tests.sh).
--
-- Attacks:
--   X1  unauthorised roles: anon, service_role, a user token without a live
--       session, another user's session id, a missing API header; direct
--       table writes; cross-user consume/release; RLS reads
--   X2  boundary values: installation key length/charset, attestation
--       environment, requested ticket counts (-1, 3, 2^31-1, null), malformed
--       shot payloads (wrong JSON type, bad uuid, NaN / out-of-range score,
--       int overflow, out-of-bounds captured_at, over-long text, bad enum) —
--       every failure must leave the ticket outstanding with NO shot row
--   X3  Pro lease clock boundaries: null / 1h / 7d+1s / far-future / lapsed
--       entitlement expiry; lapsed entitlement falls back to the free budget
--   X4  corrupt / partial persisted state: device row wiped with tickets
--       outstanding (never auto-reclaimed, recoverable on re-registration),
--       grant row wiped (the ledger stays the truth), support release through
--       the table, owner-side ledger writes that break the state machine
--   X5  replay / duplicate outcomes: abstention never charges, a rating the
--       server already holds (own online, other user's) never charges, the
--       same (ticket, shot) replays, different-shot / different-ticket replays
--   X6  interleaved account switch on ONE installation key: a stranger who
--       registers the same key gets only their own budget and cannot see,
--       consume or release the first account's tickets; a signed-out session
--       is refused
--   X7  stale online permit vs offline allocation: a 25h-old reserved permit
--       is a reservation to neither path; its late sync is refused beside the
--       ticket it would have overspent
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create temporary table atk_results (seq serial, name text, ok boolean, detail text);
grant select, insert on atk_results to authenticated, anon, service_role;
grant usage, select on sequence atk_results_seq_seq to authenticated, anon, service_role;

create function pg_temp.chk(p_name text, p_ok boolean, p_detail text) returns void
language sql as $$
  insert into atk_results (name, ok, detail) values (p_name, p_ok, p_detail)
$$;
grant execute on function pg_temp.chk(text, boolean, text) to authenticated, anon, service_role;

-- Switch the transaction to one client role with hosted-like request context.
create function pg_temp.as_client(p_role text, p_uid uuid, p_session uuid, p_api_key boolean) returns void
language plpgsql as $$
begin
  perform set_config('request.headers',
    case when p_api_key
      then jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text
      else '{}' end, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims',
    case when p_session is null then '' else jsonb_build_object('session_id', p_session)::text end, true);
  perform set_config('role', p_role, true);
end;
$$;
create function pg_temp.as_user(p_uid uuid, p_session uuid) returns void
language sql as $$ select pg_temp.as_client('authenticated', p_uid, p_session, true) $$;
create function pg_temp.as_owner() returns void
language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;
grant execute on function pg_temp.as_owner() to authenticated, anon, service_role;

create function pg_temp.shot(p_id uuid, p_kind text, p_over jsonb) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'sessionId', null, 'resultKind', p_kind,
    'shotType', 'dink', 'cameraView', 'side',
    'capturedAt', '2026-09-01T10:00:00Z',
    'startMs', 0, 'contactMs', 100, 'endMs', 200,
    'overallScore', case when p_kind = 'scored' then 7 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')) || p_over
$$;
grant execute on function pg_temp.shot(uuid, text, jsonb) to authenticated;

-- Ledger events of one ticket, in order.
create function pg_temp.events(p_ticket uuid) returns text
language sql security definer as $$
  select coalesce(string_agg(event, ',' order by created_at, id), '')
  from public.offline_allocation_ledger where ticket_id = p_ticket
$$;
grant execute on function pg_temp.events(uuid) to authenticated;
create function pg_temp.shots_for(p_ticket uuid, p_shot uuid) returns text
language sql security definer as $$
  select (select count(*) from public.shots where offline_ticket_id = p_ticket)::text || '/' ||
         (select count(*) from public.shots where id = p_shot)::text || '/' ||
         (select count(*) from public.shot_phases where shot_id = p_shot)::text
$$;
grant execute on function pg_temp.shots_for(uuid, uuid) to authenticated;
-- Outstanding tickets owned by the CURRENT user through the RPC's own reader.
create function pg_temp.hold() returns integer
language sql as $$ select public.offline_hold_count() $$;
grant execute on function pg_temp.hold() to authenticated;

-- ── fixtures ──────────────────────────────────────────────────────────────
-- Xa: free user, one attested installation, two tickets.
-- Xb: unrelated free user (stranger).
-- Xc: Pro user (entitlement rewritten per case by the owner).
-- Xd: free user, one scored online rating already synced.
insert into auth.users (id, email, raw_app_meta_data) values
  ('0000000a-a704-4000-8000-0000000000a1', 'xa@example.com', '{"provider":"google"}'),
  ('0000000a-a704-4000-8000-0000000000b1', 'xb@example.com', '{"provider":"apple"}'),
  ('0000000a-a704-4000-8000-0000000000c1', 'xc@example.com', '{"provider":"google"}'),
  ('0000000a-a704-4000-8000-0000000000d1', 'xd@example.com', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'w04-atk-xa', '0000000a-a704-4000-8000-0000000000a1', '{"sub":"w04-atk-xa"}'),
  ('apple',  'w04-atk-xb', '0000000a-a704-4000-8000-0000000000b1', '{"sub":"w04-atk-xb"}'),
  ('google', 'w04-atk-xc', '0000000a-a704-4000-8000-0000000000c1', '{"sub":"w04-atk-xc"}'),
  ('apple',  'w04-atk-xd', '0000000a-a704-4000-8000-0000000000d1', '{"sub":"w04-atk-xd"}');
insert into auth.sessions (id, user_id) values
  ('0000000a-a704-4000-8000-00000000a1a1', '0000000a-a704-4000-8000-0000000000a1'),
  ('0000000a-a704-4000-8000-00000000b1b1', '0000000a-a704-4000-8000-0000000000b1'),
  ('0000000a-a704-4000-8000-00000000c1c1', '0000000a-a704-4000-8000-0000000000c1'),
  ('0000000a-a704-4000-8000-00000000d1d1', '0000000a-a704-4000-8000-0000000000d1');

create temporary table atk_state (key text primary key, id uuid);
grant select, insert, update on atk_state to authenticated;

do $$
declare g record; t uuid[];
begin
  perform pg_temp.as_user('0000000a-a704-4000-8000-0000000000a1', '0000000a-a704-4000-8000-00000000a1a1');
  perform public.register_offline_device('xa-key', 'production', true);
  select * into g from public.issue_offline_grant('xa-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'FIXTURE: Xa allocation failed (%)', g.result;
  end if;
  t := g.ticket_ids;
  insert into atk_state values ('xa_t1', t[1]), ('xa_t2', t[2]);
  perform pg_temp.as_owner();
end $$;

-- ── X1: unauthorised roles and direct table access ────────────────────────
do $$
declare v text; c int; r record;
  t1 uuid := (select id from atk_state where key = 'xa_t1');
  xa uuid := '0000000a-a704-4000-8000-0000000000a1';
  xb uuid := '0000000a-a704-4000-8000-0000000000b1';
begin
  -- anon: every RPC refused, nothing readable
  perform pg_temp.as_client('anon', null, null, true);
  begin
    perform public.register_offline_device('anon-key', 'production', true);
    perform pg_temp.chk('X1a anon register', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1a anon register', true, sqlstate); end;
  begin
    perform public.issue_offline_grant('xa-key', 2);
    perform pg_temp.chk('X1b anon issue', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1b anon issue', true, sqlstate); end;
  begin
    perform public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{}'));
    perform pg_temp.chk('X1c anon consume', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1c anon consume', true, sqlstate); end;
  begin
    perform public.release_offline_ticket(t1, 'unused_ticket_returned');
    perform pg_temp.chk('X1d anon release', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1d anon release', true, sqlstate); end;
  begin
    select count(*) into c from public.offline_allocation_ledger;
    perform pg_temp.chk('X1e anon ledger read', false, c || ' rows readable');
  exception when insufficient_privilege then perform pg_temp.chk('X1e anon ledger read', true, sqlstate); end;
  perform pg_temp.as_owner();

  -- service_role: the RPCs are client-only; the server never settles for a device
  perform pg_temp.as_client('service_role', null, null, true);
  begin
    perform public.issue_offline_grant('xa-key', 2);
    perform pg_temp.chk('X1f service issue', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1f service issue', true, sqlstate); end;
  begin
    perform public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{}'));
    perform pg_temp.chk('X1g service consume', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1g service consume', true, sqlstate); end;
  perform pg_temp.as_owner();

  -- a user token without a live session (session id missing / revoked / another user's)
  perform pg_temp.as_user(xa, null);
  begin
    perform public.issue_offline_grant('xa-key', 2);
    perform pg_temp.chk('X1h no session claim', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1h no session claim', true, sqlstate); end;
  perform pg_temp.as_owner();
  perform pg_temp.as_user(xa, '0000000a-a704-4000-8000-00000000b1b1');
  begin
    perform public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{}'));
    perform pg_temp.chk('X1i other user session id', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1i other user session id', true, sqlstate); end;
  perform pg_temp.as_owner();
  perform pg_temp.as_user(xa, '0000000a-a704-4000-8000-00000000dead');
  begin
    perform public.release_offline_ticket(t1, 'unused_ticket_returned');
    perform pg_temp.chk('X1j unknown session id', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1j unknown session id', true, sqlstate); end;
  perform pg_temp.as_owner();
  -- a valid session but no API header (direct PostgREST call around the edge fn)
  perform pg_temp.as_client('authenticated', xa, '0000000a-a704-4000-8000-00000000a1a1', false);
  begin
    perform public.issue_offline_grant('xa-key', 2);
    perform pg_temp.chk('X1k no api header', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1k no api header', true, sqlstate); end;
  begin
    select count(*) into c from public.offline_allocation_ledger;
    perform pg_temp.chk('X1l no api header ledger read', c = 0, c || ' rows');
  exception when insufficient_privilege then perform pg_temp.chk('X1l no api header ledger read', true, sqlstate); end;
  perform pg_temp.as_owner();

  -- direct table writes by the owner account itself
  perform pg_temp.as_user(xa, '0000000a-a704-4000-8000-00000000a1a1');
  begin
    insert into public.offline_devices (user_id, installation_key_id, attestation_environment, attestation_state, attested_at)
    values (xa, 'forged-key', 'production', 'attested', now());
    perform pg_temp.chk('X1m direct device insert', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1m direct device insert', true, sqlstate); end;
  begin
    update public.offline_devices set attestation_state = 'attested', attested_at = now() where user_id = xa;
    get diagnostics c = row_count;
    perform pg_temp.chk('X1n direct device update', c = 0, c || ' rows');
  exception when insufficient_privilege then perform pg_temp.chk('X1n direct device update', true, sqlstate); end;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at)
    select xa, d.id, 'verified_store', 99, now(), now() + interval '7 days' from public.offline_devices d where d.user_id = xa;
    perform pg_temp.chk('X1o direct grant insert', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1o direct grant insert', true, sqlstate); end;
  begin
    update public.offline_grants set expires_at = now() + interval '365 days' where user_id = xa;
    get diagnostics c = row_count;
    perform pg_temp.chk('X1p direct grant extension', c = 0, c || ' rows');
  exception when insufficient_privilege then perform pg_temp.chk('X1p direct grant extension', true, sqlstate); end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id)
    select xa, device_id, grant_id, generation, gen_random_uuid(), 'allocated', identity_hashes, installation_key_id
    from public.offline_allocation_ledger where user_id = xa limit 1;
    perform pg_temp.chk('X1q direct ledger allocation', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1q direct ledger allocation', true, sqlstate); end;
  begin
    delete from public.offline_allocation_ledger where user_id = xa;
    get diagnostics c = row_count;
    perform pg_temp.chk('X1r direct ledger delete', c = 0, c || ' rows');
  exception when insufficient_privilege or check_violation then perform pg_temp.chk('X1r direct ledger delete', true, sqlstate); end;
  begin
    insert into public.offline_allocation_identity_links (ticket_id, identity_hash, user_id)
    values (t1, public.free_rating_identity_hash('apple', 'w04-atk-xb'), xa);
    perform pg_temp.chk('X1s direct identity link', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X1s direct identity link', true, sqlstate); end;
  perform pg_temp.as_owner();

  -- the stranger: cannot see, consume or release Xa's ticket (no existence leak)
  perform pg_temp.as_user(xb, '0000000a-a704-4000-8000-00000000b1b1');
  select count(*) into c from public.offline_allocation_ledger;
  perform pg_temp.chk('X1t stranger ledger read', c = 0, c || ' rows visible');
  select count(*) into c from public.offline_devices;
  perform pg_temp.chk('X1u stranger device read', c = 0, c || ' rows visible');
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{}'));
  perform pg_temp.chk('X1v stranger consume', v = 'offline.ticket_not_found', v);
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  perform pg_temp.chk('X1w stranger release', v = 'offline.ticket_not_found', v);
  perform pg_temp.as_owner();
  perform pg_temp.chk('X1x ticket untouched', pg_temp.events(t1) = 'allocated', pg_temp.events(t1));
exception when others then
  perform pg_temp.as_owner();
  perform pg_temp.chk('X1 UNEXPECTED', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ── X2: boundary values ───────────────────────────────────────────────────
do $$
declare r record; v text; s uuid; c int;
  t1 uuid := (select id from atk_state where key = 'xa_t1');
  xa uuid := '0000000a-a704-4000-8000-0000000000a1';
  k128 text := repeat('k', 128);
  k129 text := repeat('k', 129);
begin
  perform pg_temp.as_user(xa, '0000000a-a704-4000-8000-00000000a1a1');

  -- registration input
  select * into r from public.register_offline_device('', 'production', true);
  perform pg_temp.chk('X2a empty key', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device(k129, 'production', true);
  perform pg_temp.chk('X2b 129-char key', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device(k128, 'production', true);
  perform pg_temp.chk('X2c 128-char key accepted', r.result = 'accepted', r.result);
  select * into r from public.register_offline_device('-leading-dash', 'production', true);
  perform pg_temp.chk('X2d leading dash', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device('ключ', 'production', true);
  perform pg_temp.chk('X2e non-ascii key', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device('a b', 'production', true);
  perform pg_temp.chk('X2f space in key', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device(null, 'production', true);
  perform pg_temp.chk('X2g null key', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device('env-key', 'staging', true);
  perform pg_temp.chk('X2h env staging', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device('env-key', 'Production', true);
  perform pg_temp.chk('X2i env case', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device('env-key', 'production', null);
  perform pg_temp.chk('X2j attested null', r.result = 'offline.invalid_input', r.result);
  select * into r from public.register_offline_device('xa-key', 'development', true);
  perform pg_temp.chk('X2k env switch refused', r.result = 'offline.device_environment_mismatch', r.result);
  -- an unattested key never gets tickets, and re-registering it unattested keeps it so
  select * into r from public.register_offline_device('xa-unattested', 'production', false);
  perform pg_temp.chk('X2l unattested registers', r.result = 'accepted' and r.attestation_state = 'unattested', r.result || '/' || r.attestation_state);
  select * into r from public.issue_offline_grant('xa-unattested', 2);
  perform pg_temp.chk('X2m unattested no grant', r.result = 'offline.device_not_attested', r.result);
  select * into r from public.issue_offline_grant('never-registered', 2);
  perform pg_temp.chk('X2n unregistered key', r.result = 'offline.device_not_registered', r.result);

  -- requested ticket counts
  select * into r from public.issue_offline_grant('xa-key', -1);
  perform pg_temp.chk('X2o count -1', r.result = 'offline.invalid_input', r.result);
  select * into r from public.issue_offline_grant('xa-key', 3);
  perform pg_temp.chk('X2p count 3', r.result = 'offline.invalid_input', r.result);
  select * into r from public.issue_offline_grant('xa-key', 2147483647);
  perform pg_temp.chk('X2q count int max', r.result = 'offline.invalid_input', r.result);
  select * into r from public.issue_offline_grant('xa-key', null);
  perform pg_temp.chk('X2r count null', r.result = 'offline.invalid_input', r.result);
  select * into r from public.issue_offline_grant('xa-key', 0);
  perform pg_temp.chk('X2s count 0 re-issues outstanding', r.result = 'accepted' and array_length(r.ticket_ids, 1) = 2, r.result);
  select * into r from public.issue_offline_grant('xa-key', 1);
  perform pg_temp.chk('X2t count 1 with 2 outstanding', r.result = 'accepted' and array_length(r.ticket_ids, 1) = 2, r.result || ' ' || coalesce(array_length(r.ticket_ids, 1), 0));
  select count(*) into c from public.offline_allocation_ledger where user_id = xa and event = 'allocated';
  perform pg_temp.chk('X2u still exactly 2 allocations', c = 2, c::text);

  -- malformed settlement payloads: each is refused AND leaves ticket t1 outstanding, no shot, no phase
  s := gen_random_uuid();
  v := public.consume_offline_ticket(t1, 'null'::jsonb);
  perform pg_temp.chk('X2v shot json null', v = 'offline.invalid_input', v);
  v := public.consume_offline_ticket(t1, '[]'::jsonb);
  perform pg_temp.chk('X2w shot json array', v = 'offline.invalid_input', v);
  v := public.consume_offline_ticket(t1, '"scored"'::jsonb);
  perform pg_temp.chk('X2x shot json string', v = 'offline.invalid_input', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(s, 'scored', '{"id":"not-a-uuid"}'));
  perform pg_temp.chk('X2y bad shot id', v = 'offline.invalid_input', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(s, 'scored', '{"id":null}'));
  perform pg_temp.chk('X2z missing shot id', v = 'offline.invalid_input', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(s, 'scored', '{"sessionId":"nope"}'));
  perform pg_temp.chk('X2A bad session id', v = 'offline.invalid_input', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(s, 'scored', jsonb_build_object('sessionId', gen_random_uuid())));
  perform pg_temp.chk('X2B unknown session', v = 'shot.session_not_found', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"overallScore":"NaN"}'));
  perform pg_temp.chk('X2C NaN score', v like 'shot.write_failed:%' and v not like '%NaN%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"overallScore":"Infinity"}'));
  perform pg_temp.chk('X2D Infinity score', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"overallScore":10.01}'));
  perform pg_temp.chk('X2E score > 10 (beyond numeric(4,2) rounding)', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"overallScore":-0.01}'));
  perform pg_temp.chk('X2F score < 0 (beyond numeric(4,2) rounding)', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"overallScore":null}'));
  perform pg_temp.chk('X2G scored without score', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"confidence":1.5}'));
  perform pg_temp.chk('X2H confidence > 1', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"startMs":2147483648}'));
  perform pg_temp.chk('X2I int overflow', v like 'shot.write_failed:%' and v not like '%2147483648%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"capturedAt":"1999-12-31T23:59:59Z"}'));
  perform pg_temp.chk('X2J captured_at past bound', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"capturedAt":"2100-01-01T00:00:00Z"}'));
  perform pg_temp.chk('X2K captured_at future bound', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"capturedAt":"garbage"}'));
  perform pg_temp.chk('X2L captured_at garbage', v like 'shot.write_failed:%' and v not like '%garbage%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', jsonb_build_object('shotType', repeat('x', 65))));
  perform pg_temp.chk('X2M over-long shot type', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"cameraView":"front"}'));
  perform pg_temp.chk('X2N bad camera view', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"phases":[{"key":"p","startMs":"x"}]}'));
  perform pg_temp.chk('X2O malformed phase', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"checkpoints":[{"key":"c","score":"x"}]}'));
  perform pg_temp.chk('X2P malformed checkpoint', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(t1, pg_temp.shot(gen_random_uuid(), 'scored', '{"versionVector":null}'));
  perform pg_temp.chk('X2Q missing version vector', v like 'shot.write_failed:%', v);
  v := public.consume_offline_ticket(gen_random_uuid(), pg_temp.shot(s, 'scored', '{}'));
  perform pg_temp.chk('X2R unknown ticket', v = 'offline.ticket_not_found', v);
  v := public.consume_offline_ticket(null, pg_temp.shot(s, 'scored', '{}'));
  perform pg_temp.chk('X2S null ticket', v = 'offline.invalid_input', v);
  perform pg_temp.chk('X2T after every malformed payload: ticket outstanding, no shot',
    pg_temp.events(t1) = 'allocated' and pg_temp.shots_for(t1, s) = '0/0/0' and pg_temp.hold() = 2
    and (select count(*) from public.shots where user_id = xa) = 0,
    pg_temp.events(t1) || ' ' || pg_temp.shots_for(t1, s) || ' hold=' || pg_temp.hold()
    || ' shots=' || (select count(*) from public.shots where user_id = xa));

  -- release reasons
  v := public.release_offline_ticket(t1, 'support_review');
  perform pg_temp.chk('X2U client support_review', v = 'offline.invalid_input', v);
  v := public.release_offline_ticket(t1, '');
  perform pg_temp.chk('X2V empty reason', v = 'offline.invalid_input', v);
  v := public.release_offline_ticket(t1, null);
  perform pg_temp.chk('X2W null reason', v = 'offline.invalid_input', v);
  v := public.release_offline_ticket(null, 'unused_ticket_returned');
  perform pg_temp.chk('X2X null ticket release', v = 'offline.invalid_input', v);
  perform pg_temp.chk('X2Y ticket still outstanding', pg_temp.events(t1) = 'allocated', pg_temp.events(t1));

  -- the clean retry after all of the above settles exactly once, with details
  v := public.consume_offline_ticket(t1, pg_temp.shot(s, 'scored',
    '{"phases":[{"key":"backswing","startMs":0,"representativeMs":10,"endMs":20,"confidence":0.8}]}'));
  perform pg_temp.chk('X2Z clean retry accepted', v = 'accepted' and pg_temp.shots_for(t1, s) = '1/1/1' and pg_temp.events(t1) = 'allocated,consumed',
    v || ' ' || pg_temp.shots_for(t1, s) || ' ' || pg_temp.events(t1));
  perform pg_temp.as_owner();
exception when others then
  perform pg_temp.as_owner();
  perform pg_temp.chk('X2 UNEXPECTED', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ── X3: Pro lease clock boundaries ────────────────────────────────────────
do $$
declare g record; v text;
  xc uuid := '0000000a-a704-4000-8000-0000000000c1';
  sc uuid := '0000000a-a704-4000-8000-00000000c1c1';
begin
  perform pg_temp.as_user(xc, sc);
  perform public.register_offline_device('xc-key', 'production', true);
  perform pg_temp.as_owner();

  -- lifetime entitlement: exactly 7 days, no entitlement expiry recorded
  insert into public.billing_entitlements (user_id, premium, expires_at) values (xc, true, null);
  perform pg_temp.as_user(xc, sc);
  select * into g from public.issue_offline_grant('xc-key', 2);
  perform pg_temp.chk('X3a lifetime pro: 7d lease, no tickets',
    g.result = 'accepted' and g.entitlement_source = 'verified_store'
    and g.expires_at = g.issued_at + interval '7 days' and g.entitlement_expires_at is null
    and coalesce(array_length(g.ticket_ids, 1), 0) = 0,
    format('%s %s %s %s', g.result, g.entitlement_source, g.expires_at - g.issued_at, g.entitlement_expires_at));
  perform pg_temp.as_owner();

  -- entitlement ending in one hour: the lease ends there too
  update public.billing_entitlements set expires_at = now() + interval '1 hour', verified_at = now() where user_id = xc;
  perform pg_temp.as_user(xc, sc);
  select * into g from public.issue_offline_grant('xc-key', 2);
  perform pg_temp.chk('X3b 1h entitlement: 1h lease',
    g.result = 'accepted' and g.entitlement_source = 'verified_store'
    and g.expires_at = (select expires_at from public.billing_entitlements where user_id = xc)
    and g.entitlement_expires_at = g.expires_at,
    format('%s %s %s', g.result, g.expires_at - g.issued_at, g.entitlement_expires_at));
  perform pg_temp.as_owner();

  -- entitlement ending 7 days + 1 second out: the lease is capped at 7 days, expiry still recorded
  update public.billing_entitlements set expires_at = now() + interval '7 days 1 second', verified_at = now() where user_id = xc;
  perform pg_temp.as_user(xc, sc);
  select * into g from public.issue_offline_grant('xc-key', 2);
  perform pg_temp.chk('X3c 7d+1s entitlement: 7d lease',
    g.result = 'accepted' and g.expires_at = g.issued_at + interval '7 days'
    and g.entitlement_expires_at = (select expires_at from public.billing_entitlements where user_id = xc),
    format('%s %s %s', g.result, g.expires_at - g.issued_at, g.entitlement_expires_at));
  perform pg_temp.as_owner();

  -- far-future entitlement clock: still 7 days
  update public.billing_entitlements set expires_at = '9999-12-31T00:00:00Z', verified_at = now() where user_id = xc;
  perform pg_temp.as_user(xc, sc);
  select * into g from public.issue_offline_grant('xc-key', 2);
  perform pg_temp.chk('X3d far-future entitlement: 7d lease',
    g.result = 'accepted' and g.expires_at = g.issued_at + interval '7 days',
    format('%s %s', g.result, g.expires_at - g.issued_at));
  perform pg_temp.as_owner();

  -- entitlement that lapsed one second ago: no Pro lease; the free budget decides
  update public.billing_entitlements set expires_at = now() - interval '1 second', verified_at = now() where user_id = xc;
  perform pg_temp.as_user(xc, sc);
  select * into g from public.issue_offline_grant('xc-key', 2);
  perform pg_temp.chk('X3e lapsed entitlement: free path',
    g.result = 'accepted' and g.entitlement_source = 'identity_lifetime_free'
    and array_length(g.ticket_ids, 1) = 2 and g.entitlement_expires_at is null
    and g.expires_at = g.issued_at + interval '7 days',
    format('%s %s %s', g.result, g.entitlement_source, coalesce(array_length(g.ticket_ids, 1), 0)));
  perform pg_temp.as_owner();

  -- premium=false with a future expiry is not Pro either
  update public.billing_entitlements set premium = false, expires_at = now() + interval '30 days', verified_at = now() where user_id = xc;
  perform pg_temp.as_user(xc, sc);
  select * into g from public.issue_offline_grant('xc-key', 2);
  perform pg_temp.chk('X3f premium=false future expiry: free path re-issues the same tickets',
    g.result = 'accepted' and g.entitlement_source = 'identity_lifetime_free' and array_length(g.ticket_ids, 1) = 2,
    format('%s %s', g.result, g.entitlement_source));
  perform pg_temp.as_owner();

  -- Pro again with tickets outstanding: lease, and the free tickets are still settle-able
  update public.billing_entitlements set premium = true, expires_at = null, verified_at = now() where user_id = xc;
  perform pg_temp.as_user(xc, sc);
  select * into g from public.issue_offline_grant('xc-key', 2);
  perform pg_temp.chk('X3g pro with outstanding free tickets: lease, no tickets',
    g.result = 'accepted' and g.entitlement_source = 'verified_store' and coalesce(array_length(g.ticket_ids, 1), 0) = 0,
    format('%s %s', g.result, g.entitlement_source));
  perform pg_temp.as_owner();

  -- Lease ledger sanity: every Pro lease within 7 days and within its recorded entitlement
  perform pg_temp.chk('X3h every lease bounded',
    not exists (select 1 from public.offline_grants where user_id = xc
      and (expires_at > issued_at + interval '7 days'
        or (entitlement_expires_at is not null and expires_at > entitlement_expires_at))),
    (select string_agg(format('%s:%s/%s', entitlement_source, expires_at - issued_at, entitlement_expires_at), '; ' order by generation)
     from public.offline_grants where user_id = xc));
exception when others then
  perform pg_temp.as_owner();
  perform pg_temp.chk('X3 UNEXPECTED', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ── X4: corrupt / partial persisted state ─────────────────────────────────
do $$
declare g record; v text; p record; c int; s uuid := gen_random_uuid();
  t2 uuid := (select id from atk_state where key = 'xa_t2');
  xa uuid := '0000000a-a704-4000-8000-0000000000a1';
  sa uuid := '0000000a-a704-4000-8000-00000000a1a1';
  tk uuid;
begin
  -- the device row and its grants vanish (support wipe / cascade) while t2 is outstanding
  perform pg_temp.as_owner();
  delete from public.offline_devices where user_id = xa and installation_key_id = 'xa-key';
  perform pg_temp.as_user(xa, sa);
  perform pg_temp.chk('X4a hold survives device wipe', pg_temp.hold() = 1, 'hold=' || pg_temp.hold());
  select * into p from public.reserve_analysis_permit('xa-after-wipe');
  perform pg_temp.chk('X4b no online rating while the wiped device still holds the last unit',
    p.result = 'access.paywall_required', p.result);
  select * into g from public.issue_offline_grant('xa-key', 2);
  perform pg_temp.chk('X4c wiped device must re-register', g.result = 'offline.device_not_registered', g.result);
  perform public.register_offline_device('xa-key', 'production', true);
  select * into g from public.issue_offline_grant('xa-key', 2);
  perform pg_temp.chk('X4d re-registration recovers exactly the outstanding ticket',
    g.result = 'accepted' and g.ticket_ids = array[t2], format('%s %s', g.result, g.ticket_ids));
  perform pg_temp.as_owner();

  -- the grant row vanishes: the ledger is still the truth for settlement
  delete from public.offline_grants where user_id = xa;
  perform pg_temp.as_user(xa, sa);
  v := public.consume_offline_ticket(t2, pg_temp.shot(s, 'scored', '{}'));
  perform pg_temp.chk('X4e consume with grant row gone', v = 'accepted' and pg_temp.events(t2) = 'allocated,consumed', v || ' ' || pg_temp.events(t2));
  perform pg_temp.chk('X4f budget fully spent: scored 2, hold 0', pg_temp.hold() = 0 and public.lifetime_scored_count() = 2,
    format('hold=%s scored=%s', pg_temp.hold(), public.lifetime_scored_count()));
  select * into p from public.reserve_analysis_permit('xa-third');
  perform pg_temp.chk('X4g no third rating online', p.result = 'access.paywall_required', p.result);
  select * into g from public.issue_offline_grant('xa-key', 2);
  perform pg_temp.chk('X4h no third rating offline', g.result = 'access.paywall_required', g.result);
  perform pg_temp.as_owner();

  -- owner-side ledger writes that would break the state machine
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
    select user_id, device_id, grant_id, generation, ticket_id, 'released', 'support_review', identity_hashes, installation_key_id
    from public.offline_allocation_ledger where ticket_id = t2 and event = 'allocated';
    perform pg_temp.chk('X4i owner release after consume', false, 'accepted: ' || pg_temp.events(t2));
  exception when check_violation then perform pg_temp.chk('X4i owner release after consume', true, sqlstate); end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes, installation_key_id)
    select user_id, device_id, grant_id, generation, gen_random_uuid(), 'consumed', s, identity_hashes, installation_key_id
    from public.offline_allocation_ledger where ticket_id = t2 and event = 'allocated';
    perform pg_temp.chk('X4j owner consumed without allocation', false, 'accepted');
  exception when check_violation then perform pg_temp.chk('X4j owner consumed without allocation', true, sqlstate); end;
  begin
    update public.offline_allocation_ledger set event = 'released', reason = 'support_review', shot_id = null where ticket_id = t2 and event = 'consumed';
    perform pg_temp.chk('X4k owner rewrite of a terminal row', false, 'accepted');
  exception when check_violation then perform pg_temp.chk('X4k owner rewrite of a terminal row', true, sqlstate); end;
  begin
    delete from public.offline_allocation_ledger where ticket_id = t2;
    perform pg_temp.chk('X4l owner delete of ledger rows', false, 'accepted');
  exception when check_violation then perform pg_temp.chk('X4l owner delete of ledger rows', true, sqlstate); end;
  -- an allocation whose installation key is not the device's
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id)
    select xa, d.id, gen_random_uuid(), 1, gen_random_uuid(), 'allocated', '{}', 'some-other-key'
    from public.offline_devices d where d.user_id = xa and d.installation_key_id = 'xa-key';
    perform pg_temp.chk('X4m allocation naming another installation', false, 'accepted');
  exception when check_violation or foreign_key_violation then perform pg_temp.chk('X4m allocation naming another installation', true, sqlstate); end;

  -- support release through the table of a stranger-free fresh ticket: the client then sees ticket_released
  perform pg_temp.as_user('0000000a-a704-4000-8000-0000000000d1', '0000000a-a704-4000-8000-00000000d1d1');
  perform public.register_offline_device('xd-key', 'production', true);
  select * into g from public.issue_offline_grant('xd-key', 1);
  tk := g.ticket_ids[1];
  perform pg_temp.as_owner();
  insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
  select user_id, device_id, grant_id, generation, ticket_id, 'released', 'support_review', identity_hashes, installation_key_id
  from public.offline_allocation_ledger where ticket_id = tk and event = 'allocated';
  perform pg_temp.as_user('0000000a-a704-4000-8000-0000000000d1', '0000000a-a704-4000-8000-00000000d1d1');
  v := public.consume_offline_ticket(tk, pg_temp.shot(gen_random_uuid(), 'scored', '{}'));
  perform pg_temp.chk('X4n consume after support release', v = 'offline.ticket_released' and pg_temp.events(tk) = 'allocated,released', v || ' ' || pg_temp.events(tk));
  v := public.release_offline_ticket(tk, 'unused_ticket_returned');
  perform pg_temp.chk('X4o client release replays accepted, no second row', v = 'accepted' and pg_temp.events(tk) = 'allocated,released', v || ' ' || pg_temp.events(tk));
  perform pg_temp.chk('X4p released ticket still counts', pg_temp.hold() = 1, 'hold=' || pg_temp.hold());
  perform pg_temp.as_owner();
exception when others then
  perform pg_temp.as_owner();
  perform pg_temp.chk('X4 UNEXPECTED', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ── X5: replay / duplicate outcomes ───────────────────────────────────────
do $$
declare g record; p record; v text; c int;
  xd uuid := '0000000a-a704-4000-8000-0000000000d1';
  sd uuid := '0000000a-a704-4000-8000-00000000d1d1';
  xb uuid := '0000000a-a704-4000-8000-0000000000b1';
  sb uuid := '0000000a-a704-4000-8000-00000000b1b1';
  tk uuid; online_shot uuid := gen_random_uuid(); stranger_shot uuid := gen_random_uuid();
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid();
begin
  -- Xd: one released ticket (X4), one unit left. Take it as a ticket.
  perform pg_temp.as_user(xd, sd);
  select * into g from public.issue_offline_grant('xd-key', 2);
  perform pg_temp.chk('X5a one ticket left beside the released one',
    g.result = 'accepted' and array_length(g.ticket_ids, 1) = 1, format('%s %s', g.result, coalesce(array_length(g.ticket_ids, 1), 0)));
  tk := g.ticket_ids[1];

  -- abstentions never charge
  v := public.consume_offline_ticket(tk, pg_temp.shot(s1, 'low_confidence', '{}'));
  perform pg_temp.chk('X5b low_confidence not charged', v = 'offline.shot_not_chargeable' and pg_temp.events(tk) = 'allocated', v);
  v := public.consume_offline_ticket(tk, pg_temp.shot(s1, 'partial', '{}'));
  perform pg_temp.chk('X5c partial not charged', v = 'offline.shot_not_chargeable' and pg_temp.events(tk) = 'allocated', v);
  v := public.consume_offline_ticket(tk, pg_temp.shot(s1, 'scored', '{"resultKind":"Scored"}'));
  perform pg_temp.chk('X5d resultKind case not charged', v = 'offline.shot_not_chargeable' and pg_temp.events(tk) = 'allocated', v);
  perform pg_temp.chk('X5e abstentions wrote nothing', pg_temp.shots_for(tk, s1) = '0/0/0', pg_temp.shots_for(tk, s1));

  -- a rating the server already holds online (budget is spent: released + ticket = 2, so no permit)
  select * into p from public.reserve_analysis_permit('xd-online');
  perform pg_temp.chk('X5f no online reservation beside released + outstanding', p.result = 'access.paywall_required', p.result);
  perform pg_temp.as_owner();
  -- a stranger's shot with a known id (Xb's own online rating)
  perform pg_temp.as_user(xb, sb);
  select * into p from public.reserve_analysis_permit('xb-online');
  v := public.apply_synced_shot(pg_temp.shot(stranger_shot, 'scored', jsonb_build_object('analysisPermitId', p.permit_id)));
  perform pg_temp.chk('X5g stranger syncs a rating', v = 'accepted', v);
  perform pg_temp.as_owner();
  perform pg_temp.as_user(xd, sd);
  v := public.consume_offline_ticket(tk, pg_temp.shot(stranger_shot, 'scored', '{}'));
  perform pg_temp.chk('X5h stranger shot id never settles a ticket', v = 'shot.id_conflict' and pg_temp.events(tk) = 'allocated', v);
  perform pg_temp.chk('X5i stranger shot untouched', (select count(*) from public.shots where id = stranger_shot) = 0, 'visible to xd');

  -- settle, then replay every way
  v := public.consume_offline_ticket(tk, pg_temp.shot(s1, 'scored', '{}'));
  perform pg_temp.chk('X5j settle', v = 'accepted', v);
  v := public.consume_offline_ticket(tk, pg_temp.shot(s1, 'scored', '{}'));
  perform pg_temp.chk('X5k same (ticket, shot) replays accepted', v = 'accepted', v);
  v := public.consume_offline_ticket(tk, pg_temp.shot(s1, 'scored', '{"overallScore":9.9}'));
  perform pg_temp.chk('X5l replay with changed score accepted without rewrite',
    v = 'accepted' and (select overall_score from public.shots where id = s1) = 7, v);
  v := public.consume_offline_ticket(tk, pg_temp.shot(s2, 'scored', '{}'));
  perform pg_temp.chk('X5m same ticket, new shot', v = 'offline.ticket_consumed' and pg_temp.shots_for(tk, s2) = '1/0/0', v);
  v := public.release_offline_ticket(tk, 'unused_ticket_returned');
  perform pg_temp.chk('X5n release after consume', v = 'offline.ticket_consumed' and pg_temp.events(tk) = 'allocated,consumed', v);
  perform pg_temp.chk('X5o exactly one scored row for xd, hold 1 (the released ticket)', public.lifetime_scored_count() = 1 and pg_temp.hold() = 1,
    format('scored=%s hold=%s', public.lifetime_scored_count(), pg_temp.hold()));
  select * into g from public.issue_offline_grant('xd-key', 2);
  perform pg_temp.chk('X5p nothing left: released(1) + consumed(1) = 2', g.result = 'access.paywall_required', g.result);
  perform pg_temp.as_owner();
exception when others then
  perform pg_temp.as_owner();
  perform pg_temp.chk('X5 UNEXPECTED', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ── X6: interleaved account switch on one installation ────────────────────
do $$
declare g record; v text; c int;
  xb uuid := '0000000a-a704-4000-8000-0000000000b1';
  sb uuid := '0000000a-a704-4000-8000-00000000b1b1';
  xa_t uuid := (select id from atk_state where key = 'xa_t2');
  bt uuid[];
begin
  -- Xb (1 online rating so far) signs in on Xa's installation
  perform pg_temp.as_user(xb, sb);
  select * into g from public.register_offline_device('xa-key', 'production', true);
  perform pg_temp.chk('X6a stranger registers the same installation key', g.result = 'accepted', g.result);
  select * into g from public.issue_offline_grant('xa-key', 2);
  perform pg_temp.chk('X6b stranger gets ONLY their own remaining unit, none of Xa''s tickets',
    g.result = 'accepted' and array_length(g.ticket_ids, 1) = 1 and not (xa_t = any(g.ticket_ids)),
    format('%s %s', g.result, g.ticket_ids));
  bt := g.ticket_ids;
  select count(*) into c from public.offline_allocation_ledger where installation_key_id = 'xa-key';
  perform pg_temp.chk('X6c stranger sees only their own ledger rows on the shared key', c = 1, c::text);
  v := public.consume_offline_ticket(xa_t, pg_temp.shot(gen_random_uuid(), 'scored', '{}'));
  perform pg_temp.chk('X6d stranger cannot settle Xa''s ticket', v = 'offline.ticket_not_found', v);
  v := public.release_offline_ticket(xa_t, 'unused_ticket_returned');
  perform pg_temp.chk('X6e stranger cannot return Xa''s ticket', v = 'offline.ticket_not_found', v);
  perform pg_temp.as_owner();

  -- Xb signs out (session revoked): nothing works on the old session
  delete from auth.sessions where id = sb;
  perform pg_temp.as_user(xb, sb);
  begin
    perform public.consume_offline_ticket(bt[1], pg_temp.shot(gen_random_uuid(), 'scored', '{}'));
    perform pg_temp.chk('X6f signed-out consume', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X6f signed-out consume', true, sqlstate); end;
  begin
    perform public.release_offline_ticket(bt[1], 'unused_ticket_returned');
    perform pg_temp.chk('X6g signed-out release', false, 'accepted');
  exception when insufficient_privilege then perform pg_temp.chk('X6g signed-out release', true, sqlstate); end;
  perform pg_temp.as_owner();
  -- the hold is NOT reclaimed by the sign-out
  insert into auth.sessions (id, user_id) values ('0000000a-a704-4000-8000-00000000b1b2', xb);
  perform pg_temp.as_user(xb, '0000000a-a704-4000-8000-00000000b1b2');
  perform pg_temp.chk('X6h hold survives sign-out', pg_temp.hold() = 1, 'hold=' || pg_temp.hold());
  select * into g from public.issue_offline_grant('xa-key', 2);
  perform pg_temp.chk('X6i new session re-issues the same ticket', g.result = 'accepted' and g.ticket_ids = bt, format('%s %s', g.result, g.ticket_ids));
  perform pg_temp.as_owner();
exception when others then
  perform pg_temp.as_owner();
  perform pg_temp.chk('X6 UNEXPECTED', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ── X7: stale online permit vs offline allocation ─────────────────────────
do $$
declare g record; p record; v text; stale uuid; s uuid := gen_random_uuid();
  xb uuid := '0000000a-a704-4000-8000-0000000000b1';
  sb uuid := '0000000a-a704-4000-8000-00000000b1b2';
begin
  -- Xb: 1 scored online + 1 ticket outstanding = spent. Give Xb a stale permit
  -- that predates the ticket (owner ages it) and try to sync a rating on it.
  perform pg_temp.as_owner();
  insert into public.analysis_permits (user_id, idempotency_key, status, created_at, updated_at)
  values (xb, 'xb-stale', 'reserved', now() - interval '25 hours', now() - interval '25 hours')
  returning id into stale;
  perform pg_temp.as_user(xb, sb);
  perform pg_temp.chk('X7a stale permit is no reservation', public.online_reservation_count() = 0, public.online_reservation_count()::text);
  v := public.apply_synced_shot(pg_temp.shot(s, 'scored', jsonb_build_object('analysisPermitId', stale)));
  perform pg_temp.chk('X7b late sync on the stale permit refused beside the ticket',
    v <> 'accepted' and (select count(*) from public.shots where id = s) = 0, v);
  select * into p from public.reserve_analysis_permit('xb-fresh');
  perform pg_temp.chk('X7c no fresh permit either', p.result = 'access.paywall_required', p.result);
  perform pg_temp.chk('X7d conservation: scored + hold = 2', public.lifetime_scored_count() + pg_temp.hold() = 2,
    format('scored=%s hold=%s', public.lifetime_scored_count(), pg_temp.hold()));
  perform pg_temp.as_owner();
exception when others then
  perform pg_temp.as_owner();
  perform pg_temp.chk('X7 UNEXPECTED', false, sqlstate || ' ' || sqlerrm);
end $$;

-- ── report ────────────────────────────────────────────────────────────────
reset role;
\set QUIET off
select format('%s %s — %s', case when ok then 'ok  ' else 'FAIL' end, name, coalesce(detail, '')) as result
from atk_results order by seq;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed, count(*) as executed
from atk_results;
do $$
declare failed text;
begin
  select string_agg(name || ' (' || coalesce(detail, '') || ')', E'\n  ' order by seq)
  into failed from atk_results where not ok;
  if failed is not null then
    raise exception E'W04-01 attack matrix: candidate broke at:\n  %', failed;
  end if;
end $$;

rollback;
