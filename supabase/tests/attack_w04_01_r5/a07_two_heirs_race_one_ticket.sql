-- A07 — duplicate identities × concurrency: one ticket, two living heirs.
-- Account A signs in with Google (X), takes two tickets on installation K,
-- then links Apple (Y) — the candidate's late-link trigger attaches both
-- tickets to Y. A deletes the account. Two accounts are re-created: B with X
-- and C with Y. Both own T1/T2 by the candidate's ownership arms, both
-- recover them on K, and both hold a permit-less scored shot. Then B and C
-- consume T1 AT THE SAME TIME from two connections.
-- The RPC serialises on access_lock_key(uid) — a per-ACCOUNT key — so two
-- heirs never wait for each other; only the (ticket_id, event) unique index
-- stands between them. Expected by the RPC contract: exactly one 'accepted',
-- the other 'offline.ticket_consumed', one consumed row, and both heirs
-- afterwards hold exactly the one remaining ticket. A raised error (unique
-- violation) instead of the terminal code is a contract break.
\set ON_ERROR_STOP on
\set QUIET on

create schema if not exists a07_probe;
create extension if not exists dblink with schema a07_probe;

create or replace function a07_probe.await_lock(p_application text)
returns void language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then
      return;
    end if;
    if clock_timestamp() > deadline then
      raise exception 'A07: the second heir never blocked — both consumptions committed independently?';
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

do $$
<<heirs>>
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  header text := jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text;
  a uuid := '00000000-0000-4000-8000-00000000a701';
  b uuid := '00000000-0000-4000-8000-00000000a702';
  c uuid := '00000000-0000-4000-8000-00000000a703';
  sa uuid := '00000000-0000-4000-8000-0000000a0701';
  sb uuid := '00000000-0000-4000-8000-0000000a0702';
  sc uuid := '00000000-0000-4000-8000-0000000a0703';
  shot_b uuid := '00000000-0000-4000-8000-00000000a7b1';
  shot_c uuid := '00000000-0000-4000-8000-00000000a7c1';
  t1 uuid; t2 uuid;
  tickets uuid[];
  out_b text; out_c text; v text;
  n_consumed int; hold_b int; hold_c int;
  as_client text;
  conn text;
begin
  execute format('set local search_path = public, %s',
    (select extnamespace::regnamespace from pg_extension where extname = 'dblink'));
  foreach conn in array array['a07_b', 'a07_c'] loop
    perform dblink_connect(conn, connection || ' application_name=' || conn);
    perform dblink_exec(conn, 'set statement_timeout = ''5s''');
  end loop;

  -- ── A: Google sign-in, two tickets on K, then links Apple ──
  perform dblink_exec('a07_b', format(
    'insert into auth.users (id, email, raw_app_meta_data) values (%L, ''a07-a@example.test'', ''{"provider":"google"}'');'
    || 'insert into auth.identities (provider, provider_id, user_id, identity_data) values (''google'', ''google-sub-a07'', %L, ''{"sub":"google-sub-a07"}'');'
    || 'insert into auth.sessions (id, user_id) values (%L, %L);', a, a, sa, a));
  as_client := format('begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
    || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
    header, a::text, jsonb_build_object('session_id', sa)::text);
  perform dblink_exec('a07_b', as_client);
  perform 1 from dblink('a07_b', 'select public.register_offline_device(''a07-K'', ''production'', true)') as t(value text);
  select value::uuid[] into tickets from dblink('a07_b',
    'select ticket_ids::text from public.issue_offline_grant(''a07-K'', 2) where result = ''accepted''') as t(value text);
  perform dblink_exec('a07_b', 'commit');
  if coalesce(array_length(tickets, 1), 0) <> 2 then
    raise exception 'A07 precondition: A must hold two tickets (got %)', tickets;
  end if;
  t1 := tickets[1]; t2 := tickets[2];
  perform dblink_exec('a07_b', format(
    'insert into auth.identities (provider, provider_id, user_id, identity_data) values (''apple'', ''apple-sub-a07'', %L, ''{"sub":"apple-sub-a07"}'')', a));
  if (select count(*) from public.offline_allocation_identity_links where ticket_id in (t1, t2)) <> 2 then
    raise exception 'A07 precondition: the late link must attach both tickets to Apple (got %)',
      (select count(*) from public.offline_allocation_identity_links where ticket_id in (t1, t2));
  end if;

  -- ── A deletes; B (Google) and C (Apple) are created ──
  perform dblink_exec('a07_b', format('delete from auth.users where id = %L', a));
  perform dblink_exec('a07_b', format(
    'insert into auth.users (id, email, raw_app_meta_data) values (%L, ''a07-b@example.test'', ''{"provider":"google"}''), (%L, ''a07-c@example.test'', ''{"provider":"apple"}'');'
    || 'insert into auth.identities (provider, provider_id, user_id, identity_data) values (''google'', ''google-sub-a07'', %L, ''{"sub":"google-sub-a07"}''), (''apple'', ''apple-sub-a07'', %L, ''{"sub":"apple-sub-a07"}'');'
    || 'insert into auth.sessions (id, user_id) values (%L, %L), (%L, %L);',
    b, c, b, c, sb, b, sc, c));
  -- the delivered offline results, written by the owner role (the reconcile
  -- route's settlement write) — no online permit, one per heir
  perform dblink_exec('a07_b', format(
    'insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind, '
    || 'app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version) values '
    || '(%L, %L, ''drive'', now(), 0, 1000, 7, 1, ''scored'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1''),'
    || '(%L, %L, ''drive'', now(), 0, 1000, 7, 1, ''scored'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1'', ''v1'')',
    shot_b, b, shot_c, c));

  -- both heirs recover the same two tickets on K
  foreach conn in array array['a07_b', 'a07_c'] loop
    as_client := format('begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
      || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
      header, case conn when 'a07_b' then b else c end::text,
      jsonb_build_object('session_id', case conn when 'a07_b' then sb else sc end)::text);
    perform dblink_exec(conn, as_client);
    perform 1 from dblink(conn, 'select public.register_offline_device(''a07-K'', ''production'', true)') as t(value text);
    select value into v from dblink(conn,
      'select result || '':'' || coalesce(array_length(ticket_ids, 1), 0) || '':'' || (ticket_ids @> ' || quote_literal(array[t1, t2]::text) || '::uuid[])::text from public.issue_offline_grant(''a07-K'', 2)') as t(value text);
    perform dblink_exec(conn, 'commit');
    if v <> 'accepted:2:true' then
      raise exception 'A07 precondition: heir % must recover exactly the two inherited tickets (got %)', conn, v;
    end if;
  end loop;

  -- ── the race on T1 ──
  as_client := format('begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
    || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
    header, b::text, jsonb_build_object('session_id', sb)::text);
  perform dblink_exec('a07_b', as_client);
  select value into out_b from dblink('a07_b', format('select public.consume_offline_ticket(%L, %L)', t1, shot_b)) as t(value text);
  as_client := format('begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
    || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
    header, c::text, jsonb_build_object('session_id', sc)::text);
  perform dblink_exec('a07_c', as_client);
  perform dblink_send_query('a07_c', format('select public.consume_offline_ticket(%L, %L)', t1, shot_c));
  perform a07_probe.await_lock('a07_c');
  perform dblink_exec('a07_b', 'commit');
  begin
    select value into out_c from dblink_get_result('a07_c') as t(value text);
    perform 1 from dblink_get_result('a07_c', false) as t(value text);
    perform dblink_exec('a07_c', 'commit');
  exception when others then
    out_c := 'ERROR ' || sqlstate || ': ' || split_part(sqlerrm, E'\n', 1);
    begin
      perform 1 from dblink_get_result('a07_c', false) as t(value text);
    exception when others then null;
    end;
    perform dblink_exec('a07_c', 'rollback');
  end;

  select count(*) into n_consumed from public.offline_allocation_ledger where ticket_id = t1 and event = 'consumed';
  select count(*) into hold_b from api_private.offline_owned_allocations(b) o(ticket_id)
    where not exists (select 1 from public.offline_allocation_ledger x where x.ticket_id = o.ticket_id and x.event = 'consumed');
  select count(*) into hold_c from api_private.offline_owned_allocations(c) o(ticket_id)
    where not exists (select 1 from public.offline_allocation_ledger x where x.ticket_id = o.ticket_id and x.event = 'consumed');
  -- the loser's sequential retry after the race
  perform dblink_exec('a07_c', as_client);
  select value into v from dblink('a07_c', format('select public.consume_offline_ticket(%L, %L)', t1, shot_c)) as t(value text);
  perform dblink_exec('a07_c', 'commit');
  perform dblink_disconnect('a07_b');
  perform dblink_disconnect('a07_c');
  raise notice 'A07 B=% C=% retry=% → consumed rows for T1=% hold_b=% hold_c=%', out_b, out_c, v, n_consumed, hold_b, hold_c;

  if n_consumed <> 1 or hold_b <> 1 or hold_c <> 1 then
    raise exception 'A07 BREAK: conservation — % consumed rows for one ticket, holds b=% c=%', n_consumed, hold_b, hold_c;
  end if;
  if v <> 'offline.ticket_consumed' then
    raise exception 'A07 BREAK: after the race the loser must read the terminal state (got %)', v;
  end if;
  if out_b <> 'accepted' or out_c <> 'offline.ticket_consumed' then
    raise exception 'A07 BREAK: two heirs racing one ticket must end accepted / offline.ticket_consumed, never a raised error (got B=% C=%)', out_b, out_c;
  end if;
end heirs $$;
\echo A07 PASSED
