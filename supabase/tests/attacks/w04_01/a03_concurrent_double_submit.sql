-- A03 — concurrency / double submit across real sessions (dblink).
--
-- Three races, each with a first session holding its transaction open at
-- the decision point while a second session fires the competing call:
--   R1 two consume_offline_ticket() calls for the same ticket with two shots;
--   R2 issue_offline_grant() on device A vs issue_offline_grant() on device B
--      of the same free account (2 + 2 requested, 2 available);
--   R3 issue_offline_grant() vs reserve_analysis_permit() (online) with one
--      rating left.
-- Expected: the second call BLOCKS on access_lock_key(uid) instead of reading
-- a stale count, and once the first commits it sees the outcome — one
-- consumed row for one shot, total tickets + permits ≤ 2, never a raw
-- unique_violation. Fixtures here are committed (other sessions must see
-- them); the runner builds a throwaway database per run.
\set ON_ERROR_STOP on
\set QUIET on
create extension if not exists dblink;

begin;
\ir _prelude.sql
select pg_temp.atk_user(3, 'google', 'google-sub-a03');
select pg_temp.atk_user(4, 'google', 'google-sub-a03b');
commit;

-- Remote-session preamble: the same API-request + live-session shape as the
-- edge function, executed inside an open transaction on connection p_conn.
create function pg_temp.a03_open(p_conn text, p_n integer) returns void
language plpgsql as $$
begin
  perform dblink_connect(p_conn, 'dbname=' || current_database() || ' user=' || current_user);
  perform dblink_exec(p_conn, 'begin');
  perform * from dblink(p_conn, format(
    $q$select set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true),
              set_config('request.jwt.claim.sub', %L, true),
              set_config('request.jwt.claims', %L, true)$q$,
    pg_temp.atk_uid(p_n)::text, jsonb_build_object('session_id', pg_temp.atk_sid(p_n))::text)) as t(a text, b text, c text);
  perform dblink_exec(p_conn, 'set local role authenticated');
end $$;

create function pg_temp.a03_call(p_conn text, p_sql text) returns text
language plpgsql as $$
declare r text;
begin
  select t.r into r from dblink(p_conn, p_sql) as t(r text);
  return r;
end $$;

-- Fire p_sql asynchronously on p_conn, assert it is still blocked after
-- p_wait seconds, then return true if it was blocked.
create function pg_temp.a03_fire_and_check_blocked(p_conn text, p_sql text, p_wait double precision) returns boolean
language plpgsql as $$
begin
  if dblink_send_query(p_conn, p_sql) <> 1 then
    raise exception 'A03: dblink_send_query failed: %', dblink_error_message(p_conn);
  end if;
  perform pg_sleep(p_wait);
  return dblink_is_busy(p_conn) = 1;
end $$;

create function pg_temp.a03_result(p_conn text) returns text
language plpgsql as $$
declare r text;
begin
  select t.r into r from dblink_get_result(p_conn) as t(r text);
  -- drain the trailing empty result set dblink returns after an async query
  perform * from dblink_get_result(p_conn) as t(r text);
  return r;
end $$;

create function pg_temp.a03_close(p_conn text, p_end text) returns void
language plpgsql as $$
begin
  perform dblink_exec(p_conn, p_end);
  perform dblink_disconnect(p_conn);
end $$;

-- ---------------------------------------------------------------------------
-- R1: two consumes of one ticket with two different shots
-- ---------------------------------------------------------------------------
create temp table a03 (k text primary key, v uuid);
do $$
declare g record;
begin
  perform pg_temp.a03_open('a', 3);
  perform pg_temp.a03_call('a', $q$select result from public.register_offline_device('a03-key', 'production', true)$q$);
  select * into g from dblink('a', $q$select result, ticket_ids from public.issue_offline_grant('a03-key', 2)$q$) as t(result text, ticket_ids uuid[]);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A03 precondition: two tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  insert into a03 values ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
  perform pg_temp.a03_close('a', 'commit');
end $$;
-- two scored, permit-free shots written by the owner (the only path that
-- yields a consumable shot today); committed so the racing sessions see them
do $$
declare st text;
begin
  st := pg_temp.atk_direct_shot('00000000-0000-4000-8000-0000000a0301', pg_temp.atk_uid(3));
  if st is not null then raise exception 'A03 precondition: shot 1 (%)', st; end if;
  st := pg_temp.atk_direct_shot('00000000-0000-4000-8000-0000000a0302', pg_temp.atk_uid(3));
  if st is not null then raise exception 'A03 precondition: shot 2 (%)', st; end if;
end $$;
do $$
declare t1 uuid := (select v from a03 where k = 't1'); r1 text; r2 text; blocked boolean; k integer;
begin
  perform pg_temp.a03_open('a', 3);
  perform pg_temp.a03_open('b', 3);
  r1 := pg_temp.a03_call('a', format($q$select public.consume_offline_ticket(%L, %L)$q$, t1, '00000000-0000-4000-8000-0000000a0301'));
  if r1 <> 'accepted' then raise exception 'A03 R1 precondition: first consume (got %)', r1; end if;
  blocked := pg_temp.a03_fire_and_check_blocked('b', format($q$select public.consume_offline_ticket(%L, %L)$q$, t1, '00000000-0000-4000-8000-0000000a0302'), 0.7);
  if not blocked then
    r2 := pg_temp.a03_result('b');
    raise exception 'A03 BREAK (R1): second consume did not wait for the first (returned % while the first was uncommitted)', r2;
  end if;
  perform pg_temp.a03_close('a', 'commit');
  r2 := pg_temp.a03_result('b');
  perform pg_temp.a03_close('b', 'commit');
  if r2 <> 'offline.ticket_consumed' then
    raise exception 'A03 BREAK (R1): concurrent consume of a consumed ticket returned % (expected offline.ticket_consumed)', r2;
  end if;
  select count(*) into k from public.offline_allocation_ledger where ticket_id = t1 and event = 'consumed';
  if k <> 1 then raise exception 'A03 BREAK (R1): % consumed rows for one ticket', k; end if;
  select count(*) into k from public.offline_allocation_ledger where shot_id = '00000000-0000-4000-8000-0000000a0302';
  if k <> 0 then raise exception 'A03 BREAK (R1): the losing shot was recorded'; end if;
end $$;

-- R1b: release racing consume on the second ticket — one terminal event wins
do $$
declare t2 uuid := (select v from a03 where k = 't2'); r1 text; r2 text; blocked boolean; ev text;
begin
  perform pg_temp.a03_open('a', 3);
  perform pg_temp.a03_open('b', 3);
  r1 := pg_temp.a03_call('a', format($q$select public.release_offline_ticket(%L, 'unused_ticket_returned')$q$, t2));
  if r1 <> 'accepted' then raise exception 'A03 R1b precondition: release (got %)', r1; end if;
  blocked := pg_temp.a03_fire_and_check_blocked('b', format($q$select public.consume_offline_ticket(%L, %L)$q$, t2, '00000000-0000-4000-8000-0000000a0302'), 0.7);
  if not blocked then
    r2 := pg_temp.a03_result('b');
    raise exception 'A03 BREAK (R1b): consume did not wait for the in-flight release (returned %)', r2;
  end if;
  perform pg_temp.a03_close('a', 'commit');
  r2 := pg_temp.a03_result('b');
  perform pg_temp.a03_close('b', 'commit');
  if r2 <> 'offline.ticket_released' then
    raise exception 'A03 BREAK (R1b): consume after a racing release returned %', r2;
  end if;
  select string_agg(event, ',' order by event) into ev from public.offline_allocation_ledger where ticket_id = t2;
  if ev <> 'allocated,released' then raise exception 'A03 BREAK (R1b): ledger for the raced ticket is %', ev; end if;
end $$;

-- ---------------------------------------------------------------------------
-- R2: two devices of one account race for the two free tickets
-- ---------------------------------------------------------------------------
do $$
declare g record; r text; blocked boolean; total integer;
begin
  perform pg_temp.a03_open('a', 4);
  perform pg_temp.a03_call('a', $q$select result from public.register_offline_device('a03b-key-1', 'production', true)$q$);
  perform pg_temp.a03_call('a', $q$select result from public.register_offline_device('a03b-key-2', 'production', true)$q$);
  perform pg_temp.a03_close('a', 'commit');

  perform pg_temp.a03_open('a', 4);
  perform pg_temp.a03_open('b', 4);
  select * into g from dblink('a', $q$select result, ticket_ids from public.issue_offline_grant('a03b-key-1', 2)$q$) as t(result text, ticket_ids uuid[]);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A03 R2 precondition: device 1 takes both (got %, %)', g.result, g.ticket_ids;
  end if;
  blocked := pg_temp.a03_fire_and_check_blocked('b', $q$select result || ':' || coalesce(array_length(ticket_ids, 1), 0) from public.issue_offline_grant('a03b-key-2', 2)$q$, 0.7);
  if not blocked then
    r := pg_temp.a03_result('b');
    raise exception 'A03 BREAK (R2): second device allocated against a stale count (returned % while device 1 was uncommitted)', r;
  end if;
  perform pg_temp.a03_close('a', 'commit');
  r := pg_temp.a03_result('b');
  perform pg_temp.a03_close('b', 'commit');
  if r <> 'access.paywall_required:0' then
    raise exception 'A03 BREAK (R2): second device got % after device 1 took both tickets', r;
  end if;
  select count(*) into total from public.offline_allocation_ledger where user_id = pg_temp.atk_uid(4) and event = 'allocated';
  if total <> 2 then raise exception 'A03 BREAK (R2): % tickets allocated to one free account', total; end if;
end $$;

-- ---------------------------------------------------------------------------
-- R3: offline allocation vs online reservation for the last rating
-- ---------------------------------------------------------------------------
select pg_temp.atk_user(5, 'apple', 'apple-sub-a03c');
do $$
declare g record; r text; blocked boolean; used integer;
begin
  perform pg_temp.a03_open('a', 5);
  perform pg_temp.a03_call('a', $q$select result from public.register_offline_device('a03c-key', 'production', true)$q$);
  r := pg_temp.a03_call('a', $q$select result from public.reserve_analysis_permit('a03c-first')$q$);
  if r <> 'accepted' then raise exception 'A03 R3 precondition: first online reservation (got %)', r; end if;
  perform pg_temp.a03_close('a', 'commit');

  perform pg_temp.a03_open('a', 5);
  perform pg_temp.a03_open('b', 5);
  select * into g from dblink('a', $q$select result, ticket_ids from public.issue_offline_grant('a03c-key', 2)$q$) as t(result text, ticket_ids uuid[]);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then
    raise exception 'A03 R3 precondition: one ticket beside one reservation (got %, %)', g.result, g.ticket_ids;
  end if;
  blocked := pg_temp.a03_fire_and_check_blocked('b', $q$select result from public.reserve_analysis_permit('a03c-second')$q$, 0.7);
  if not blocked then
    r := pg_temp.a03_result('b');
    raise exception 'A03 BREAK (R3): online reservation did not wait for the allocation (returned %)', r;
  end if;
  perform pg_temp.a03_close('a', 'commit');
  r := pg_temp.a03_result('b');
  perform pg_temp.a03_close('b', 'commit');
  if r <> 'access.paywall_required' then
    raise exception 'A03 BREAK (R3): online reservation granted beside 1 permit + 1 offline ticket (got %)', r;
  end if;
  used := pg_temp.atk_budget_used(pg_temp.atk_uid(5));
  if used <> 2 then raise exception 'A03 BREAK (R3): budget used % > 2', used; end if;
end $$;
\echo A03 PASS: concurrent double submits serialize on access_lock_key
