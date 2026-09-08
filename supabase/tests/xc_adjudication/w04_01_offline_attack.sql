-- W04-01 adversarial matrix — offline device registry / grants / allocation
-- ledger (20260908120000_offline_device_grants.sql). Runs against the shim +
-- every migration (same harness as run_rls_tests.sh / xc_pg_up.sh).
--
-- Every block asserts the behaviour the work package REQUIRES (conservation,
-- original-owner recovery, API-only writes, append-only ledger, bounded
-- leases). A block that raises records BROKEN; a block whose expectations hold
-- records HELD. The file exits non-zero when any block is BROKEN, so on the
-- candidate a confirmed break is a failing run and a fix flips it green.
--
--   docker exec <c> psql -U postgres -v ON_ERROR_STOP=1 \
--     -f /tests/xc_adjudication/w04_01_offline_attack.sql
--
-- Each attack is self-contained: it builds its own users/devices/tickets and
-- ends by raising ATTACK_OK, so its writes roll back and no attack depends on
-- another.
\set ON_ERROR_STOP on
begin;

create temporary table x_results (
  n serial primary key, attack text not null, verdict text not null, detail text not null
);
create temporary table x_sessions (user_id uuid primary key, session_id uuid not null);
grant select on x_sessions to authenticated;

create function pg_temp.x_record(p_attack text, p_verdict text, p_detail text) returns void
language sql as $$
  insert into x_results (attack, verdict, detail) values (p_attack, p_verdict, p_detail);
$$;

create function pg_temp.x_ok(p_detail text) returns void
language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'ATTACK_OK:' || p_detail;
end;
$$;

-- Owner-role fixture: a user with one sign-in identity and one live session.
create function pg_temp.x_user(p_n integer, p_provider text, p_sub text) returns uuid
language plpgsql as $$
declare
  v_uid uuid := format('a0000000-0000-4000-8000-%s', lpad(to_hex(p_n), 12, '0'))::uuid;
  v_sid uuid := format('b0000000-0000-4000-8000-%s', lpad(to_hex(p_n), 12, '0'))::uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (v_uid, format('x%s@example.com', p_n), '{"full_name":"X"}', jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_sub, v_uid, jsonb_build_object('sub', p_sub));
  insert into auth.sessions (id, user_id) values (v_sid, v_uid);
  insert into x_sessions (user_id, session_id) values (v_uid, v_sid);
  return v_uid;
end;
$$;

-- Owner/service write of a durably delivered offline result (scored, no
-- online permit) — the shape consume_offline_ticket() is specified to bind.
create function pg_temp.x_shot(p_uid uuid, p_shot uuid) returns void
language plpgsql as $$
begin
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
  ) values (p_shot, p_uid, 'drive', now(), 0, 1000, 7, 1, 'scored', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1');
end;
$$;

-- Become the API-authenticated caller (role, JWT sub, live session claim, API
-- header) — exactly what the Edge Function's per-request connection carries.
create function pg_temp.x_as(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.headers',
    jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('session_id', (select session_id from x_sessions where user_id = p_uid))::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create function pg_temp.x_owner() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
end;
$$;

create function pg_temp.x_events(p_uid uuid) returns text
language sql security definer as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
grant execute on function pg_temp.x_ok(text), pg_temp.x_as(uuid), pg_temp.x_owner(), pg_temp.x_events(uuid)
  to anon, authenticated, service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- A1  Original-installation recovery after account deletion + re-creation.
--     The contract (packages/shared-types offlineAuthorization.ts) promises
--     recovery by "original installation proof or explicit support review";
--     the product invariant is "preserve original-owner recovery". Device K
--     of identity I holds one ticket; the account is deleted; I signs in
--     again (new auth.users row, same provider subject) on the SAME
--     installation K and the offline result it produced is delivered. The
--     hold follows the identity (candidate T6) — so the ticket must be
--     consumable/re-issuable by the same installation, otherwise the identity
--     is charged twice for one rating (scored=1 AND held=1 → paywall).
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_b uuid; v_ticket uuid; g record; rec record; v_r text;
  v_shot uuid := 'c0000000-0000-4000-8000-000000000001';
begin
  begin
    v_a := pg_temp.x_user(1, 'google', 'google-sub-a1');
    perform pg_temp.x_as(v_a);
    select * into g from public.register_offline_device('a1-key', 'production', true);
    if g.result <> 'accepted' then raise exception 'A1 setup: register → %', g.result; end if;
    select * into g from public.issue_offline_grant('a1-key', 1);
    if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
      raise exception 'A1 setup: issue → %', g.result;
    end if;
    v_ticket := g.ticket_ids[1];
    perform pg_temp.x_owner();

    delete from auth.users where id = v_a;
    if pg_temp.x_events(v_a) <> 'allocated:1' then
      raise exception 'A1 setup: ledger must survive deletion (got %)', pg_temp.x_events(v_a);
    end if;

    -- Same Google account signs in again: a new auth.users row, same subject.
    v_b := pg_temp.x_user(2, 'google', 'google-sub-a1');
    -- The offline result the SAME installation produced is durably delivered.
    perform pg_temp.x_shot(v_b, v_shot);

    perform pg_temp.x_as(v_b);
    select * into g from public.register_offline_device('a1-key', 'production', true);
    if g.result <> 'accepted' then raise exception 'A1: re-register → %', g.result; end if;
    if public.offline_hold_count() <> 1 then
      raise exception 'A1: the identity''s hold must follow it (got %)', public.offline_hold_count();
    end if;

    -- Original-installation proof: the same key asks for its outstanding ticket back.
    select * into g from public.issue_offline_grant('a1-key', 1);
    if not (g.result = 'accepted' and g.ticket_ids = array[v_ticket]) then
      raise exception 'A1 BREAK: same installation + same identity cannot recover its outstanding ticket after account re-creation: issue_offline_grant → % tickets=% (expected accepted, re-issue of %)',
        g.result, g.ticket_ids, v_ticket;
    end if;
    v_r := public.consume_offline_ticket(v_ticket, v_shot);
    if v_r <> 'accepted' then
      raise exception 'A1 BREAK: consume by the original installation after re-creation → % (expected accepted)', v_r;
    end if;
    select * into rec from public.access_state();
    if rec.scored_count <> 1 or rec.reserved_count <> 0 then
      raise exception 'A1 BREAK: one delivered rating charged twice after re-creation (scored=% held=%)',
        rec.scored_count, rec.reserved_count;
    end if;
    perform pg_temp.x_ok('same installation recovers its ticket across account re-creation; one rating charged once');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A1 recreate-recover', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A1 recreate-recover', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- A1b The same scenario, observed from the identity's point of view: after
--     the result is delivered nothing — not the owner, not support via the
--     owner role — can bind the held ticket to the delivered shot, and the
--     identity's remaining budget is 0 with 1 rating actually delivered.
do $$
declare
  v_a uuid; v_b uuid; v_ticket uuid; g record; rec record; p record; v_r text;
  v_shot uuid := 'c0000000-0000-4000-8000-000000000002';
begin
  begin
    v_a := pg_temp.x_user(3, 'apple', 'apple-sub-a1b');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('a1b-key', 'production', true);
    select * into g from public.issue_offline_grant('a1b-key', 1);
    v_ticket := g.ticket_ids[1];
    perform pg_temp.x_owner();
    delete from auth.users where id = v_a;
    v_b := pg_temp.x_user(4, 'apple', 'apple-sub-a1b');
    perform pg_temp.x_shot(v_b, v_shot);

    -- Support (owner role) tries to reconcile the delivered rating with the
    -- held ticket: the ledger guard must accept a consume that closes the
    -- identity's own hold, or the double charge is permanent.
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
      select v_b, a.device_id, a.grant_id, a.generation, a.ticket_id, 'consumed', v_shot, a.identity_hashes
      from public.offline_allocation_ledger a where a.ticket_id = v_ticket and a.event = 'allocated';
      v_r := 'accepted';
    exception when others then
      v_r := sqlerrm;
    end;

    perform pg_temp.x_as(v_b);
    select * into rec from public.access_state();
    select * into p from public.reserve_analysis_permit('a1b-online-after-recreate');
    if v_r <> 'accepted' or rec.scored_count + rec.reserved_count <> 1 or p.result <> 'accepted' then
      raise exception 'A1b BREAK: identity delivered 1 rating but has scored=% held=% online→% ; support reconcile → %',
        rec.scored_count, rec.reserved_count, p.result, v_r;
    end if;
    perform pg_temp.x_ok('delivered rating reconciled with the identity''s hold; second free rating still available');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A1b recreate-double-charge', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A1b recreate-double-charge', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A2  Forged audit reason: a plain client asserts 'support_review' on its own
--     release. The contract reserves support review for explicit support
--     action; the client must only be able to say 'unused_ticket_returned'.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare v_a uuid; g record; v_r text; v_reason text;
begin
  begin
    v_a := pg_temp.x_user(5, 'google', 'google-sub-a2');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('a2-key', 'production', true);
    select * into g from public.issue_offline_grant('a2-key', 1);
    v_r := public.release_offline_ticket(g.ticket_ids[1], 'support_review');
    select reason into v_reason from public.offline_allocation_ledger
    where ticket_id = g.ticket_ids[1] and event = 'released';
    if v_r = 'accepted' or v_reason = 'support_review' then
      raise exception 'A2 BREAK: ordinary client self-asserted a support_review release (rpc → %, ledger reason → %)', v_r, v_reason;
    end if;
    perform pg_temp.x_ok('client cannot record support_review');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A2 forged-support-reason', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A2 forged-support-reason', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A3  Append-only "for every role": row triggers do not fire on TRUNCATE.
--     The billing tables (20260906233000, 20260907133000) revoke truncate from
--     service_role; the three new tables must too, or a service-role TRUNCATE
--     silently reclaims every outstanding allocation.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare v_a uuid; g record; v_left int; v_tables text := '';
begin
  begin
    v_a := pg_temp.x_user(6, 'google', 'google-sub-a3');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('a3-key', 'production', true);
    select * into g from public.issue_offline_grant('a3-key', 2);
    perform pg_temp.x_owner();
    perform set_config('role', 'service_role', true);
    begin
      truncate public.offline_allocation_ledger;
      v_tables := v_tables || 'offline_allocation_ledger ';
    exception when insufficient_privilege then null; end;
    begin
      truncate public.offline_grants;
      v_tables := v_tables || 'offline_grants ';
    exception when insufficient_privilege then null; end;
    begin
      truncate public.offline_devices cascade;
      v_tables := v_tables || 'offline_devices ';
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_owner();
    select count(*) into v_left from public.offline_allocation_ledger where user_id = v_a;
    if v_tables <> '' then
      raise exception 'A3 BREAK: service_role TRUNCATE succeeded on [%] — % of 2 allocations left', v_tables, v_left;
    end if;
    perform pg_temp.x_ok('truncate denied to service_role on all three tables');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A3 service-truncate', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A3 service-truncate', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A4  Replay / duplicate binding (network-failure analogues: the client
--     retries consume/release after a timeout, 429 or 5xx, sometimes with a
--     different body). One ticket ↔ one shot; nothing double-charges.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; rec record; t1 uuid; t2 uuid; v_r text;
  s1 uuid := 'c0000000-0000-4000-8000-000000000041';
  s2 uuid := 'c0000000-0000-4000-8000-000000000042';
begin
  begin
    v_a := pg_temp.x_user(7, 'google', 'google-sub-a4');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('a4-key', 'production', true);
    select * into g from public.issue_offline_grant('a4-key', 2);
    t1 := g.ticket_ids[1]; t2 := g.ticket_ids[2];
    perform pg_temp.x_owner();
    perform pg_temp.x_shot(v_a, s1);
    perform pg_temp.x_shot(v_a, s2);
    perform pg_temp.x_as(v_a);

    -- t1 ↔ s1, retried three times (timeout replay)
    if public.consume_offline_ticket(t1, s1) <> 'accepted' then raise exception 'A4: first consume'; end if;
    if public.consume_offline_ticket(t1, s1) <> 'accepted' then raise exception 'A4: replay must be accepted'; end if;
    if public.consume_offline_ticket(t1, s1) <> 'accepted' then raise exception 'A4: replay must be accepted (3)'; end if;
    -- same ticket, different shot (retry with a rebuilt body)
    v_r := public.consume_offline_ticket(t1, s2);
    if v_r <> 'offline.ticket_consumed' then raise exception 'A4: t1 with s2 → % (expected ticket_consumed)', v_r; end if;
    -- different ticket, same shot (two tickets try to pay for one rating)
    v_r := public.consume_offline_ticket(t2, s1);
    if v_r <> 'offline.shot_not_chargeable' then raise exception 'A4: t2 with s1 → % (expected shot_not_chargeable)', v_r; end if;
    -- release after consume, then release replay
    v_r := public.release_offline_ticket(t1, 'unused_ticket_returned');
    if v_r <> 'offline.ticket_consumed' then raise exception 'A4: release consumed → %', v_r; end if;
    if public.release_offline_ticket(t2, 'unused_ticket_returned') <> 'accepted' then raise exception 'A4: release t2'; end if;
    if public.release_offline_ticket(t2, 'unused_ticket_returned') <> 'accepted' then raise exception 'A4: release replay'; end if;
    v_r := public.consume_offline_ticket(t2, s2);
    if v_r <> 'offline.ticket_released' then raise exception 'A4: consume released → %', v_r; end if;
    select * into g from public.issue_offline_grant('a4-key', 2);
    if g.result <> 'access.paywall_required' then
      raise exception 'A4: released ticket must still count (issue → %)', g.result;
    end if;
    if pg_temp.x_events(v_a) <> 'allocated:2,consumed:1,released:1' then
      raise exception 'A4: ledger % ', pg_temp.x_events(v_a);
    end if;
    if (select count(*) from public.offline_allocation_ledger where shot_id is not null) <> 1 then
      raise exception 'A4: exactly one consumed row per shot';
    end if;
    perform pg_temp.x_ok('one ticket ↔ one shot; replays idempotent; released still counts');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A4 replay-matrix', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A4 replay-matrix', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A5  Unauthorised roles on every new RPC and table: anon, authenticated
--     without the API header, a forged header with someone else's session,
--     an expired session, a banned user, another user, the plain owner
--     without a session.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_b uuid; g record; t1 uuid; v_r text; v_n int; v_state text;
  s1 uuid := 'c0000000-0000-4000-8000-000000000051';
  procedure_failed text := '';
begin
  begin
    v_a := pg_temp.x_user(8, 'google', 'google-sub-a5a');
    v_b := pg_temp.x_user(9, 'apple', 'apple-sub-a5b');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('a5-key', 'production', true);
    select * into g from public.issue_offline_grant('a5-key', 1);
    t1 := g.ticket_ids[1];
    perform pg_temp.x_owner();
    perform pg_temp.x_shot(v_a, s1);

    -- anon: no EXECUTE at all
    perform set_config('role', 'anon', true);
    begin perform public.register_offline_device('z', 'production', true); procedure_failed := procedure_failed || 'anon-register ';
    exception when insufficient_privilege then null; end;
    begin perform public.issue_offline_grant('a5-key', 1); procedure_failed := procedure_failed || 'anon-issue ';
    exception when insufficient_privilege then null; end;
    begin perform public.consume_offline_ticket(t1, s1); procedure_failed := procedure_failed || 'anon-consume ';
    exception when insufficient_privilege then null; end;
    begin perform public.release_offline_ticket(t1, 'unused_ticket_returned'); procedure_failed := procedure_failed || 'anon-release ';
    exception when insufficient_privilege then null; end;
    begin perform public.offline_hold_count(); procedure_failed := procedure_failed || 'anon-hold ';
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_owner();

    -- authenticated owner, valid JWT, NO API header (a direct PostgREST call)
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('session_id', (select session_id from x_sessions where user_id = v_a))::text, true);
    perform set_config('role', 'authenticated', true);
    begin perform public.register_offline_device('a5-key', 'production', true); procedure_failed := procedure_failed || 'noapi-register ';
    exception when insufficient_privilege then null; end;
    begin perform public.issue_offline_grant('a5-key', 1); procedure_failed := procedure_failed || 'noapi-issue ';
    exception when insufficient_privilege then null; end;
    begin perform public.consume_offline_ticket(t1, s1); procedure_failed := procedure_failed || 'noapi-consume ';
    exception when insufficient_privilege then null; end;
    begin perform public.release_offline_ticket(t1, 'unused_ticket_returned'); procedure_failed := procedure_failed || 'noapi-release ';
    exception when insufficient_privilege then null; end;
    select count(*) into v_n from public.offline_allocation_ledger; if v_n <> 0 then procedure_failed := procedure_failed || 'noapi-ledger-read '; end if;
    select count(*) into v_n from public.offline_devices; if v_n <> 0 then procedure_failed := procedure_failed || 'noapi-device-read '; end if;
    select count(*) into v_n from public.offline_grants; if v_n <> 0 then procedure_failed := procedure_failed || 'noapi-grant-read '; end if;
    if public.offline_hold_count() <> 0 then procedure_failed := procedure_failed || 'noapi-hold '; end if;
    perform pg_temp.x_owner();

    -- forged: A's JWT with B's session id and the real API header
    perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('session_id', (select session_id from x_sessions where user_id = v_b))::text, true);
    perform set_config('role', 'authenticated', true);
    begin perform public.issue_offline_grant('a5-key', 1); procedure_failed := procedure_failed || 'forged-session-issue ';
    exception when insufficient_privilege then null; end;
    begin perform public.consume_offline_ticket(t1, s1); procedure_failed := procedure_failed || 'forged-session-consume ';
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_owner();

    -- wrong API key value
    perform set_config('request.headers', '{"x-pickle-api-key":"not-the-key"}', true);
    perform set_config('request.jwt.claim.sub', v_a::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('session_id', (select session_id from x_sessions where user_id = v_a))::text, true);
    perform set_config('role', 'authenticated', true);
    begin perform public.issue_offline_grant('a5-key', 1); procedure_failed := procedure_failed || 'badkey-issue ';
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_owner();

    -- expired session
    update auth.sessions set not_after = now() - interval '1 second' where user_id = v_a;
    perform pg_temp.x_as(v_a);
    begin perform public.consume_offline_ticket(t1, s1); procedure_failed := procedure_failed || 'expired-session-consume ';
    exception when insufficient_privilege then null; end;
    begin perform public.release_offline_ticket(t1, 'unused_ticket_returned'); procedure_failed := procedure_failed || 'expired-session-release ';
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_owner();
    update auth.sessions set not_after = null where user_id = v_a;

    -- banned user
    update auth.users set banned_until = now() + interval '1 day' where id = v_a;
    perform pg_temp.x_as(v_a);
    begin perform public.issue_offline_grant('a5-key', 1); procedure_failed := procedure_failed || 'banned-issue ';
    exception when insufficient_privilege then null; end;
    perform pg_temp.x_owner();
    update auth.users set banned_until = null where id = v_a;

    -- another fully authorised user, B, aims at A's ticket / shot / rows
    perform pg_temp.x_as(v_b);
    if public.consume_offline_ticket(t1, s1) <> 'offline.ticket_not_found' then procedure_failed := procedure_failed || 'other-consume '; end if;
    if public.release_offline_ticket(t1, 'unused_ticket_returned') <> 'offline.ticket_not_found' then procedure_failed := procedure_failed || 'other-release '; end if;
    select result into v_r from public.issue_offline_grant('a5-key', 1);
    if v_r <> 'offline.device_not_registered' then procedure_failed := procedure_failed || 'other-issue-on-A-key '; end if;
    select count(*) into v_n from public.offline_allocation_ledger; if v_n <> 0 then procedure_failed := procedure_failed || 'other-ledger-read '; end if;
    select count(*) into v_n from public.offline_devices; if v_n <> 0 then procedure_failed := procedure_failed || 'other-device-read '; end if;
    select count(*) into v_n from public.offline_grants; if v_n <> 0 then procedure_failed := procedure_failed || 'other-grant-read '; end if;
    if public.offline_hold_count() <> 0 then procedure_failed := procedure_failed || 'other-hold '; end if;
    perform pg_temp.x_owner();

    -- A's ledger is untouched by all of the above
    if pg_temp.x_events(v_a) <> 'allocated:1' then procedure_failed := procedure_failed || 'ledger-mutated '; end if;
    if procedure_failed <> '' then
      raise exception 'A5 BREAK: unauthorised paths succeeded: %', procedure_failed;
    end if;
    perform pg_temp.x_ok('anon / no-API / forged session / bad key / expired / banned / other user all denied');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A5 unauthorised-roles', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A5 unauthorised-roles', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A6  Boundary values: key length/charset, environment, ticket counts,
--     entitlement clocks (infinity, far-future, one second, past, exactly now).
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_p uuid; g record; bad text := ''; v_r text;
begin
  begin
    v_a := pg_temp.x_user(10, 'google', 'google-sub-a6');
    perform pg_temp.x_as(v_a);
    -- installation key
    select result into v_r from public.register_offline_device(repeat('k', 128), 'production', true);
    if v_r <> 'accepted' then bad := bad || 'key128 '; end if;
    select result into v_r from public.register_offline_device(repeat('k', 129), 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key129 '; end if;
    select result into v_r from public.register_offline_device('', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key-empty '; end if;
    select result into v_r from public.register_offline_device(null, 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key-null '; end if;
    select result into v_r from public.register_offline_device('-lead', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key-leading-dash '; end if;
    select result into v_r from public.register_offline_device('ké', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key-unicode '; end if;
    select result into v_r from public.register_offline_device('a b', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key-space '; end if;
    select result into v_r from public.register_offline_device(E'a\nb', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key-newline '; end if;
    select result into v_r from public.register_offline_device('a''; drop table x; --', 'production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'key-quote '; end if;
    -- environment / attestation
    select result into v_r from public.register_offline_device('a6-env', 'staging', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'env-staging '; end if;
    select result into v_r from public.register_offline_device('a6-env', 'Production', true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'env-case '; end if;
    select result into v_r from public.register_offline_device('a6-env', null, true);
    if v_r <> 'offline.invalid_input' then bad := bad || 'env-null '; end if;
    select result into v_r from public.register_offline_device('a6-env', 'production', null);
    if v_r <> 'offline.invalid_input' then bad := bad || 'attested-null '; end if;
    select result into v_r from public.register_offline_device('a6-env', 'development', true);
    if v_r <> 'accepted' then bad := bad || 'env-dev '; end if;
    select result into v_r from public.register_offline_device('a6-env', 'production', true);
    if v_r <> 'offline.device_environment_mismatch' then bad := bad || 'env-switch '; end if;
    -- unattested never allocates, attested later upgrades, never downgrades
    select result into v_r from public.register_offline_device('a6-key', 'production', false);
    select result into v_r from public.issue_offline_grant('a6-key', 2);
    if v_r <> 'offline.device_not_attested' then bad := bad || 'unattested-issue '; end if;
    select result into v_r from public.register_offline_device('a6-key', 'production', true);
    select attestation_state into v_r from public.register_offline_device('a6-key', 'production', false);
    if v_r <> 'attested' then bad := bad || 'downgrade '; end if;
    -- ticket counts
    select result into v_r from public.issue_offline_grant('a6-key', 3);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets3 '; end if;
    select result into v_r from public.issue_offline_grant('a6-key', -1);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets-1 '; end if;
    select result into v_r from public.issue_offline_grant('a6-key', null);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets-null '; end if;
    select result into v_r from public.issue_offline_grant('a6-key', 0);
    if v_r <> 'offline.invalid_input' then bad := bad || 'tickets0-none-outstanding:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('unknown-key', 1);
    if v_r <> 'offline.device_not_registered' then bad := bad || 'unknown-key '; end if;
    if public.consume_offline_ticket(null, gen_random_uuid()) <> 'offline.invalid_input' then bad := bad || 'consume-null-ticket '; end if;
    if public.consume_offline_ticket(gen_random_uuid(), null) <> 'offline.invalid_input' then bad := bad || 'consume-null-shot '; end if;
    if public.consume_offline_ticket(gen_random_uuid(), gen_random_uuid()) <> 'offline.ticket_not_found' then bad := bad || 'consume-unknown '; end if;
    if public.release_offline_ticket(gen_random_uuid(), 'anything') <> 'offline.invalid_input' then bad := bad || 'release-reason '; end if;
    if public.release_offline_ticket(gen_random_uuid(), null) <> 'offline.invalid_input' then bad := bad || 'release-null-reason '; end if;
    -- exactly 2 then nothing; the second device re-issues nothing new
    select * into g from public.issue_offline_grant('a6-key', 2);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 or g.generation <> 1
       or g.expires_at <> g.issued_at + interval '7 days' or g.entitlement_expires_at is not null then bad := bad || 'free-grant-shape '; end if;
    select * into g from public.issue_offline_grant('a6-key', 2);
    if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 or g.generation <> 2 then bad := bad || 'reissue-shape '; end if;
    select result into v_r from public.register_offline_device('a6-key2', 'production', true);
    select result into v_r from public.issue_offline_grant('a6-key2', 1);
    if v_r <> 'access.paywall_required' then bad := bad || 'second-device:' || v_r || ' '; end if;
    if pg_temp.x_events(v_a) <> 'allocated:2' then bad := bad || 'ledger:' || pg_temp.x_events(v_a) || ' '; end if;
    perform pg_temp.x_owner();

    -- Pro clocks
    v_p := pg_temp.x_user(11, 'apple', 'apple-sub-a6p');
    insert into public.billing_entitlements (user_id, premium, expires_at) values (v_p, true, 'infinity');
    perform pg_temp.x_as(v_p);
    perform public.register_offline_device('a6p-key', 'production', true);
    select * into g from public.issue_offline_grant('a6p-key', 2);
    if g.result <> 'accepted' or g.entitlement_source <> 'verified_store' or g.expires_at <> g.issued_at + interval '7 days'
       or g.ticket_ids <> '{}'::uuid[] then bad := bad || 'pro-infinity '; end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set expires_at = '9999-12-31' where user_id = v_p;
    perform pg_temp.x_as(v_p);
    select * into g from public.issue_offline_grant('a6p-key', 2);
    if g.result <> 'accepted' or g.expires_at <> g.issued_at + interval '7 days' then bad := bad || 'pro-far-future '; end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set expires_at = now() + interval '3 days' where user_id = v_p;
    perform pg_temp.x_as(v_p);
    select * into g from public.issue_offline_grant('a6p-key', 2);
    if g.result <> 'accepted' or g.expires_at <> g.entitlement_expires_at or g.expires_at > g.issued_at + interval '3 days' then bad := bad || 'pro-3d '; end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set expires_at = now() + interval '1 second' where user_id = v_p;
    perform pg_temp.x_as(v_p);
    select * into g from public.issue_offline_grant('a6p-key', 2);
    if g.result <> 'accepted' or g.expires_at <> g.entitlement_expires_at or g.expires_at <= g.issued_at then bad := bad || 'pro-1s '; end if;
    perform pg_temp.x_owner();
    -- exactly now(): not effective → free path (tickets, not a lease)
    update public.billing_entitlements set expires_at = now() where user_id = v_p;
    perform pg_temp.x_as(v_p);
    select * into g from public.issue_offline_grant('a6p-key', 2);
    if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' or array_length(g.ticket_ids, 1) <> 2 then bad := bad || 'pro-expires-now:' || g.result || '/' || g.entitlement_source || ' '; end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set expires_at = '-infinity' where user_id = v_p;
    perform pg_temp.x_as(v_p);
    select * into g from public.issue_offline_grant('a6p-key', 2);
    if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' then bad := bad || 'pro-neg-infinity '; end if;
    perform pg_temp.x_owner();
    update public.billing_entitlements set premium = false, expires_at = now() + interval '30 days' where user_id = v_p;
    perform pg_temp.x_as(v_p);
    select * into g from public.issue_offline_grant('a6p-key', 2);
    if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' then bad := bad || 'premium-false '; end if;
    perform pg_temp.x_owner();
    -- every lease ever written respects both bounds
    if exists (select 1 from public.offline_grants where user_id = v_p
               and (expires_at > issued_at + interval '7 days' or expires_at <= issued_at
                    or (entitlement_expires_at is not null and expires_at > entitlement_expires_at))) then
      bad := bad || 'lease-bounds ';
    end if;
    if bad <> '' then raise exception 'A6 BREAK: %', bad; end if;
    perform pg_temp.x_ok('key/env/count/clock boundaries all refused or bounded as specified');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A6 boundaries', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A6 boundaries', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A7  Interleaved account switch on ONE physical installation: A allocates 2
--     on key K, signs out, B signs in on the same phone and registers K.
--     B's budget is B's own; B cannot touch A's tickets; A gets them back.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_b uuid; ga record; gb record; g record; bad text := '';
  sb uuid := 'c0000000-0000-4000-8000-000000000071';
begin
  begin
    v_a := pg_temp.x_user(12, 'google', 'google-sub-a7a');
    v_b := pg_temp.x_user(13, 'apple', 'apple-sub-a7b');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('shared-K', 'production', true);
    select * into ga from public.issue_offline_grant('shared-K', 2);
    perform pg_temp.x_owner();
    perform pg_temp.x_as(v_b);
    select * into g from public.register_offline_device('shared-K', 'development', false);
    if g.result <> 'accepted' then bad := bad || 'B-register:' || g.result || ' '; end if;
    select * into g from public.issue_offline_grant('shared-K', 2);
    if g.result <> 'offline.device_not_attested' then bad := bad || 'B-unattested:' || g.result || ' '; end if;
    perform public.register_offline_device('shared-K', 'development', true);
    select * into gb from public.issue_offline_grant('shared-K', 2);
    if gb.result <> 'accepted' or array_length(gb.ticket_ids, 1) <> 2 or gb.generation <> 1 then bad := bad || 'B-issue '; end if;
    if gb.ticket_ids && ga.ticket_ids then bad := bad || 'ticket-overlap '; end if;
    if public.consume_offline_ticket(ga.ticket_ids[1], sb) <> 'offline.ticket_not_found' then bad := bad || 'B-consumes-A '; end if;
    if public.release_offline_ticket(ga.ticket_ids[1], 'unused_ticket_returned') <> 'offline.ticket_not_found' then bad := bad || 'B-releases-A '; end if;
    if public.offline_hold_count() <> 2 then bad := bad || 'B-hold:' || public.offline_hold_count() || ' '; end if;
    perform pg_temp.x_owner();
    perform pg_temp.x_shot(v_b, sb);
    perform pg_temp.x_as(v_a);
    select * into g from public.issue_offline_grant('shared-K', 2);
    if g.result <> 'accepted' or g.generation <> 2 or not (g.ticket_ids <@ ga.ticket_ids and ga.ticket_ids <@ g.ticket_ids) then
      bad := bad || 'A-reissue ';
    end if;
    if public.offline_hold_count() <> 2 then bad := bad || 'A-hold:' || public.offline_hold_count() || ' '; end if;
    if public.consume_offline_ticket(ga.ticket_ids[1], sb) <> 'offline.shot_not_chargeable' then bad := bad || 'A-consumes-B-shot '; end if;
    perform pg_temp.x_owner();
    if (select count(*) from public.offline_devices where installation_key_id = 'shared-K') <> 2 then bad := bad || 'device-rows '; end if;
    if bad <> '' then raise exception 'A7 BREAK: %', bad; end if;
    perform pg_temp.x_ok('two accounts on one installation are isolated; A recovers its tickets');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A7 account-switch', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A7 account-switch', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A8  Corrupt / partial persistence via the table itself (owner role = what a
--     buggy service write or a support script could do): the guards must
--     refuse every inconsistent row, and deleting parents must never reclaim.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; v_b uuid; g record; a record; bad text := ''; v_dev uuid; v_n int; v_r text;
  sa uuid := 'c0000000-0000-4000-8000-000000000081';
  sb uuid := 'c0000000-0000-4000-8000-000000000082';
begin
  begin
    v_a := pg_temp.x_user(14, 'google', 'google-sub-a8a');
    v_b := pg_temp.x_user(15, 'apple', 'apple-sub-a8b');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('a8-key', 'production', true);
    select * into g from public.issue_offline_grant('a8-key', 2);
    perform pg_temp.x_owner();
    perform pg_temp.x_shot(v_a, sa);
    perform pg_temp.x_shot(v_b, sb);
    select * into a from public.offline_allocation_ledger where ticket_id = g.ticket_ids[1] and event = 'allocated';
    v_dev := a.device_id;

    -- consumed with another owner's shot
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, a.ticket_id, 'consumed', sb, a.identity_hashes);
      bad := bad || 'consume-other-owner-shot ';
    exception when check_violation then null; end;
    -- consumed by a user that is not the allocation owner
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
      values (v_b, a.device_id, a.grant_id, a.generation, a.ticket_id, 'consumed', sb, a.identity_hashes);
      bad := bad || 'consume-as-other-user ';
    exception when check_violation then null; end;
    -- allocated row carrying a shot / release carrying no reason / unknown reason
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, gen_random_uuid(), 'allocated', sa, a.identity_hashes);
      bad := bad || 'allocated-with-shot ';
    exception when check_violation then null; end;
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, a.ticket_id, 'released', a.identity_hashes);
      bad := bad || 'released-no-reason ';
    exception when check_violation then null; end;
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, a.ticket_id, 'released', 'because', a.identity_hashes);
      bad := bad || 'released-unknown-reason ';
    exception when check_violation then null; end;
    -- terminal event for a ticket never allocated
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, gen_random_uuid(), 'released', 'unused_ticket_returned', a.identity_hashes);
      bad := bad || 'terminal-without-allocation ';
    exception when check_violation then null; end;
    -- unknown event
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, gen_random_uuid(), 'expired', a.identity_hashes);
      bad := bad || 'unknown-event ';
    exception when check_violation then null; end;
    -- two tickets, one shot (table layer, not the RPC)
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
    values (v_a, a.device_id, a.grant_id, a.generation, g.ticket_ids[1], 'consumed', sa, a.identity_hashes);
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, g.ticket_ids[2], 'consumed', sa, a.identity_hashes);
      bad := bad || 'two-tickets-one-shot ';
    exception when unique_violation then null; end;
    -- second terminal for the consumed ticket
    begin
      insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes)
      values (v_a, a.device_id, a.grant_id, a.generation, g.ticket_ids[1], 'released', 'unused_ticket_returned', a.identity_hashes);
      bad := bad || 'second-terminal ';
    exception when check_violation then null; end;
    -- owner update / delete of the ledger
    begin update public.offline_allocation_ledger set event = 'released', reason = 'unused_ticket_returned', shot_id = null where ticket_id = g.ticket_ids[1] and event = 'consumed'; bad := bad || 'owner-update ';
    exception when others then null; end;
    begin delete from public.offline_allocation_ledger where user_id = v_a; bad := bad || 'owner-delete ';
    exception when others then null; end;
    -- grants immutable, and a grant cannot be forged for an unattested / foreign device or a stale Pro entitlement
    begin update public.offline_grants set expires_at = expires_at + interval '1 year' where user_id = v_a; bad := bad || 'grant-update ';
    exception when check_violation then null; end;
    begin
      insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at)
      values (v_b, v_dev, 'identity_lifetime_free', 9, now(), now() + interval '1 day');
      bad := bad || 'grant-foreign-device ';
    exception when check_violation then null; end;
    begin
      insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
      values (v_a, v_dev, 'verified_store', 9, now(), now() + interval '1 day', now() + interval '1 day');
      bad := bad || 'pro-lease-without-entitlement ';
    exception when check_violation then null; end;
    begin
      insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at)
      values (v_a, v_dev, 'identity_lifetime_free', 9, now(), now() + interval '7 days 1 second');
      bad := bad || 'lease-over-7d ';
    exception when check_violation then null; end;
    begin
      insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at)
      values (v_a, v_dev, 'identity_lifetime_free', 9, now(), now());
      bad := bad || 'lease-zero-length ';
    exception when check_violation then null; end;

    -- parents vanish: device row deleted → grants cascade, ledger + hold stay
    delete from public.offline_devices where id = v_dev;
    select count(*) into v_n from public.offline_grants where device_id = v_dev;
    if v_n <> 0 then bad := bad || 'grants-not-cascaded '; end if;
    if pg_temp.x_events(v_a) <> 'allocated:2,consumed:1' then bad := bad || 'ledger-after-device-delete:' || pg_temp.x_events(v_a) || ' '; end if;
    perform pg_temp.x_as(v_a);
    if public.offline_hold_count() <> 1 then bad := bad || 'hold-after-device-delete:' || public.offline_hold_count() || ' '; end if;
    if public.release_offline_ticket(g.ticket_ids[2], 'unused_ticket_returned') <> 'accepted' then bad := bad || 'release-orphan '; end if;
    select result into v_r from public.register_offline_device('a8-key', 'production', true);
    if v_r <> 'accepted' then bad := bad || 'reregister-after-parent-loss:' || v_r || ' '; end if;
    select result into v_r from public.issue_offline_grant('a8-key', 2);
    if v_r <> 'access.paywall_required' then bad := bad || 'reissue-after-parent-loss:' || v_r || ' '; end if;
    perform pg_temp.x_owner();
    if bad <> '' then raise exception 'A8 BREAK: %', bad; end if;
    perform pg_temp.x_ok('every inconsistent row refused; parent loss reclaims nothing');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A8 corrupt-state', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A8 corrupt-state', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A9  Process death / restart on the device: a ticket issued 40 days ago on a
--     grant long expired, then the phone comes back. The allocation is still
--     the identity's (never reclaimed), the delivered result binds to it, and
--     the online path never hands out a third rating in between.
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare
  v_a uuid; g record; p record; rec record; bad text := ''; v_r text;
  s1 uuid := 'c0000000-0000-4000-8000-000000000091';
  s2 uuid := 'c0000000-0000-4000-8000-000000000092';
begin
  begin
    v_a := pg_temp.x_user(17, 'google', 'google-sub-a9b');
    perform pg_temp.x_as(v_a);
    perform public.register_offline_device('a9-key', 'production', true);
    select * into g from public.issue_offline_grant('a9-key', 1);
    -- meanwhile the user goes online on another phone: exactly one more rating, no third
    select * into p from public.reserve_analysis_permit('a9-online-1');
    if p.result <> 'accepted' then bad := bad || 'online-1:' || p.result || ' '; end if;
    select * into p from public.reserve_analysis_permit('a9-online-2');
    if p.result <> 'access.paywall_required' then bad := bad || 'online-2:' || p.result || ' '; end if;
    perform pg_temp.x_owner();
    -- the online shot lands with its permit
    insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind, analysis_permit_id,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    select s2, v_a, 'drive', now(), 0, 1000, 7, 1, 'scored', id, 'v1','v1','v1','v1','v1','v1','v1','v1' from public.analysis_permits where user_id = v_a;
    update public.analysis_permits set status = 'finalized', outcome = 'scored' where user_id = v_a;
    -- the grant's 7-day window has passed from the device's perspective (nothing server-side reclaims); the offline result is delivered
    perform pg_temp.x_shot(v_a, s1);
    perform pg_temp.x_as(v_a);
    -- an online-permit-backed shot can never be charged to a ticket
    v_r := public.consume_offline_ticket(g.ticket_ids[1], s2);
    if v_r <> 'offline.shot_not_chargeable' then bad := bad || 'permit-backed-shot:' || v_r || ' '; end if;
    v_r := public.consume_offline_ticket(g.ticket_ids[1], s1);
    if v_r <> 'accepted' then bad := bad || 'consume-after-restart:' || v_r || ' '; end if;
    select * into rec from public.access_state();
    if rec.scored_count <> 2 or rec.reserved_count <> 0 then bad := bad || format('final scored=%s reserved=%s ', rec.scored_count, rec.reserved_count); end if;
    select * into p from public.reserve_analysis_permit('a9-online-3');
    if p.result <> 'access.paywall_required' then bad := bad || 'online-3:' || p.result || ' '; end if;
    select result into v_r from public.issue_offline_grant('a9-key', 1);
    if v_r <> 'access.paywall_required' then bad := bad || 'offline-3:' || v_r || ' '; end if;
    perform pg_temp.x_owner();
    if bad <> '' then raise exception 'A9 BREAK: %', bad; end if;
    perform pg_temp.x_ok('offline hold + one online rating = exactly 2; delivered offline result binds after restart');
  exception when others then
    if sqlerrm like 'ATTACK_OK:%' then perform pg_temp.x_record('A9 restart-conservation', 'HELD', substr(sqlerrm, 11));
    else perform pg_temp.x_record('A9 restart-conservation', 'BROKEN', sqlerrm); end if;
  end;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- Verdict
-- ───────────────────────────────────────────────────────────────────────────
select attack, verdict, detail from x_results order by n;
select count(*) filter (where verdict = 'HELD') as held,
       count(*) filter (where verdict = 'BROKEN') as broken,
       count(*) as executed
from x_results;
do $$
declare v_broken int; v_total int;
begin
  select count(*) filter (where verdict = 'BROKEN'), count(*) into v_broken, v_total from x_results;
  if v_total < 10 then
    raise exception 'W04-01 attack matrix: only % attacks executed', v_total;
  end if;
  if v_broken > 0 then
    raise exception 'W04-01 attack matrix: % of % attacks BROKE the candidate', v_broken, v_total;
  end if;
end $$;
rollback;
