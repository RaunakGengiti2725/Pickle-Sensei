-- ATTACK 02 — concurrency / reentrancy around the NEW released/partial
-- outcome (20260908100000_permit_partial_terminal_outcome).
--
-- Two real sessions (dblink) on ONE reserved permit of the same user:
--   C1  scored sync holds the advisory lock uncommitted; a partial sync on the
--       same permit waits, then must be refused — one shot, permit
--       finalized/scored, count 1.
--   C2  the mirror: partial first, scored waits → refused, count 0, permit
--       released/partial. A partial must never open a door for a rating.
--   C3  double submit of the identical partial (same shot id) → both
--       accepted, exactly one row.
--   C4  interleaved client release: a client session UPDATEs the permit to
--       released/partial (row lock held, uncommitted) while the RPC tries to
--       spend it for a scored shot → the RPC must see the committed partial
--       and refuse; no shot, count 0.
--   C5  the mirror: RPC consumes the permit first (uncommitted); the client
--       release waits and must be refused with 23514 once the RPC commits.
--   C6  crash between steps: a sync that fails AFTER the advisory lock (the
--       partial carries a score → 23514 inside the write block) must leave
--       the permit reserved for a clean retry and the lock released so a
--       second session proceeds.
begin;
\ir _helpers.sql

create schema a02_probe;
-- The candidate matrix (W07/W08) may already have installed dblink into its
-- own probe schema when it runs first in the same database; own it here either way.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'dblink') then
    alter extension dblink set schema a02_probe;
  else
    create extension dblink with schema a02_probe;
  end if;
end $$;

create function a02_probe.await_lock(p_application text)
returns void language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity
               where application_name = p_application and wait_event_type = 'Lock') then
      return;
    end if;
    if clock_timestamp() > deadline then
      raise exception 'ATTACK 02: the second connection never blocked on the expected lock';
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

create function a02_probe.collect(p_connection text) returns text
language plpgsql set search_path = '' as $$
declare r text; e text;
begin
  select value into r from a02_probe.dblink_get_result(p_connection, false) as result(value text);
  e := a02_probe.dblink_error_message(p_connection);
  perform 1 from a02_probe.dblink_get_result(p_connection, false) as result(value text);
  if e <> 'OK' then
    return 'ERROR:' || e;
  end if;
  return coalesce(r, 'NULL');
end $$;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a201', 'a02-conc@example.test', '{"full_name":"Conc"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'google-sub-a02', '00000000-0000-4000-8000-00000000a201',
   '{"sub":"google-sub-a02","email":"a02-conc@example.test"}');
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a211', '00000000-0000-4000-8000-00000000a201', 'a02-c1'),
  ('00000000-0000-4000-8000-00000000a212', '00000000-0000-4000-8000-00000000a201', 'a02-c2'),
  ('00000000-0000-4000-8000-00000000a213', '00000000-0000-4000-8000-00000000a201', 'a02-c3'),
  ('00000000-0000-4000-8000-00000000a214', '00000000-0000-4000-8000-00000000a201', 'a02-c4'),
  ('00000000-0000-4000-8000-00000000a215', '00000000-0000-4000-8000-00000000a201', 'a02-c5'),
  ('00000000-0000-4000-8000-00000000a216', '00000000-0000-4000-8000-00000000a201', 'a02-c6');

-- The seed must be visible to the other sessions.
commit;
begin;
select set_config('request.headers', pg_temp.api_headers(), true);

do $$
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1),
    current_setting('port'), current_database());
  u text := '00000000-0000-4000-8000-00000000a201';
  c text;
  r1 text; r2 text;
  n_shots integer;
  as_user text := format('set request.headers = %L; set role authenticated; set request.jwt.claim.sub = %L;',
    pg_temp.api_headers(), u);
begin
  foreach c in array array['a02_first', 'a02_second'] loop
    perform a02_probe.dblink_connect(c, connection || ' application_name=' || c);
    perform a02_probe.dblink_exec(c, 'set statement_timeout = ''5s''');
    perform a02_probe.dblink_exec(c, as_user);
  end loop;

  -- C1: scored (held) vs partial (waiting) on permit a211.
  perform a02_probe.dblink_exec('a02_first', 'begin');
  select value into r1 from a02_probe.dblink('a02_first', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a221', '00000000-0000-4000-8000-00000000a211', 'scored')))
    as result(value text);
  perform pg_temp.check_eq(r1, 'accepted', 'C1: first scored sync accepted (uncommitted)');
  perform a02_probe.dblink_exec('a02_second', 'begin');
  perform a02_probe.dblink_send_query('a02_second', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a222', '00000000-0000-4000-8000-00000000a211', 'partial')));
  perform a02_probe.await_lock('a02_second');
  perform a02_probe.dblink_exec('a02_first', 'commit');
  r2 := a02_probe.collect('a02_second');
  perform a02_probe.dblink_exec('a02_second', 'commit');
  perform pg_temp.check_eq(r2, 'access.permit_not_reserved', 'C1: the waiting partial must be refused once the scored sync commits');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a211'), 'finalized/scored', 'C1: permit finalized/scored');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a222'), 'MISSING', 'C1: the partial shot never persisted');
  select count(*) into n_shots from public.shots where user_id = u::uuid;
  perform pg_temp.check_eq(n_shots::text, '1', 'C1: exactly one shot');

  -- C2: partial (held) vs scored (waiting) on permit a212.
  perform a02_probe.dblink_exec('a02_first', 'begin');
  select value into r1 from a02_probe.dblink('a02_first', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a223', '00000000-0000-4000-8000-00000000a212', 'partial')))
    as result(value text);
  perform pg_temp.check_eq(r1, 'accepted', 'C2: partial sync accepted (uncommitted)');
  perform a02_probe.dblink_exec('a02_second', 'begin');
  perform a02_probe.dblink_send_query('a02_second', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a224', '00000000-0000-4000-8000-00000000a212', 'scored')));
  perform a02_probe.await_lock('a02_second');
  perform a02_probe.dblink_exec('a02_first', 'commit');
  r2 := a02_probe.collect('a02_second');
  perform a02_probe.dblink_exec('a02_second', 'commit');
  perform pg_temp.check_eq(r2, 'access.permit_not_reserved', 'C2: a scored sync waiting behind a partial on the same permit is refused');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a212'), 'released/partial', 'C2: permit released/partial');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a224'), 'MISSING', 'C2: the scored shot never persisted');
  select value into r1 from a02_probe.dblink('a02_first', 'select public.lifetime_scored_count()::text') as result(value text);
  perform pg_temp.check_eq(r1, '1', 'C2: lifetime count still 1 (C1 only)');

  -- C3: identical partial double submit on permit a213.
  perform a02_probe.dblink_exec('a02_first', 'begin');
  select value into r1 from a02_probe.dblink('a02_first', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a225', '00000000-0000-4000-8000-00000000a213', 'partial')))
    as result(value text);
  perform a02_probe.dblink_exec('a02_second', 'begin');
  perform a02_probe.dblink_send_query('a02_second', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a225', '00000000-0000-4000-8000-00000000a213', 'partial')));
  perform a02_probe.await_lock('a02_second');
  perform a02_probe.dblink_exec('a02_first', 'commit');
  r2 := a02_probe.collect('a02_second');
  perform a02_probe.dblink_exec('a02_second', 'commit');
  perform pg_temp.check_eq(r1 || '/' || r2, 'accepted/accepted', 'C3: both copies of the same partial are accepted');
  select count(*) into n_shots from public.shots where id = '00000000-0000-4000-8000-00000000a225';
  perform pg_temp.check_eq(n_shots::text, '1', 'C3: one row for the double-submitted partial');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a213'), 'released/partial', 'C3: permit released/partial');

  -- C4: client releases as partial (held) while the RPC spends it for a rating.
  perform a02_probe.dblink_exec('a02_first', 'begin');
  select value into r1 from a02_probe.dblink('a02_first',
    $q$with u as (update public.analysis_permits set status = 'released', outcome = 'partial'
       where id = '00000000-0000-4000-8000-00000000a214' returning 1)
       select pg_catalog.format('allowed %s', count(*)) from u$q$)
    as result(value text);
  perform pg_temp.check_eq(r1, 'allowed 1', 'C4: client release to partial holds the row lock (uncommitted)');
  perform a02_probe.dblink_exec('a02_second', 'begin');
  perform a02_probe.dblink_send_query('a02_second', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a226', '00000000-0000-4000-8000-00000000a214', 'scored')));
  perform a02_probe.await_lock('a02_second');
  perform a02_probe.dblink_exec('a02_first', 'commit');
  r2 := a02_probe.collect('a02_second');
  perform a02_probe.dblink_exec('a02_second', 'commit');
  perform pg_temp.check_eq(r2, 'access.permit_not_reserved', 'C4: the RPC must see the committed partial and refuse the rating');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a214'), 'released/partial', 'C4: permit released/partial');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a226'), 'MISSING', 'C4: no scored shot');

  -- C5: RPC consumes (held); the client release waits and must be refused.
  perform a02_probe.dblink_exec('a02_first', 'begin');
  select value into r1 from a02_probe.dblink('a02_first', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a227', '00000000-0000-4000-8000-00000000a215', 'scored')))
    as result(value text);
  perform pg_temp.check_eq(r1, 'accepted', 'C5: scored sync accepted (uncommitted)');
  perform a02_probe.dblink_exec('a02_second', 'begin');
  perform a02_probe.dblink_send_query('a02_second',
    $q$update public.analysis_permits set status = 'released', outcome = 'partial'
       where id = '00000000-0000-4000-8000-00000000a215'$q$);
  perform a02_probe.await_lock('a02_second');
  perform a02_probe.dblink_exec('a02_first', 'commit');
  r2 := a02_probe.collect('a02_second');
  perform a02_probe.dblink_exec('a02_second', 'rollback');
  perform pg_temp.check(r2 like 'ERROR:%' and r2 like '%illegal permit transition finalized/scored -> released/partial%',
    'C5: the waiting client release is refused with the lifecycle error (got ' || r2 || ')');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a215'), 'finalized/scored', 'C5: permit stays finalized/scored');
  select value into r1 from a02_probe.dblink('a02_first', 'select public.lifetime_scored_count()::text') as result(value text);
  perform pg_temp.check_eq(r1, '2', 'C5: lifetime count is 2 (C1 + C5)');

  -- C6: a partial carrying a score fails inside the write block after the
  -- advisory lock; the permit stays reserved, the lock is released, and a
  -- second session can settle it cleanly.
  perform a02_probe.dblink_exec('a02_first', 'begin');
  select value into r1 from a02_probe.dblink('a02_first', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a228', '00000000-0000-4000-8000-00000000a216', 'partial')
      || jsonb_build_object('overallScore', 5.5)))
    as result(value text);
  perform pg_temp.check(r1 like 'shot.write_failed:%', 'C6: a scored partial is refused by the table (got ' || r1 || ')');
  perform a02_probe.dblink_exec('a02_first', 'commit');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a216'), 'reserved/NULL', 'C6: permit stays reserved after the failed write');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a228'), 'MISSING', 'C6: nothing persisted');
  select value into r2 from a02_probe.dblink('a02_second', format(
    'select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a228', '00000000-0000-4000-8000-00000000a216', 'partial')))
    as result(value text);
  perform pg_temp.check_eq(r2, 'accepted', 'C6: the clean retry from another session settles the permit');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a216'), 'released/partial', 'C6: permit released/partial');
  select value into r1 from a02_probe.dblink('a02_first', 'select public.lifetime_scored_count()::text') as result(value text);
  perform pg_temp.check_eq(r1, '2', 'C6: partials never moved the count');

  foreach c in array array['a02_first', 'a02_second'] loop
    perform a02_probe.dblink_disconnect(c);
  end loop;
end $$;

select format('ATTACK 02 partial concurrency: %s assertions passed', pg_temp.assertions());
rollback;

-- The seed was committed so the dblink sessions could see it; remove it (the
-- account cascade is the product's own deletion path).
delete from auth.users where id = '00000000-0000-4000-8000-00000000a201';
drop extension if exists dblink;
drop schema if exists a02_probe cascade;
