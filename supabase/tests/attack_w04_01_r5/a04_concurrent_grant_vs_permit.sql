-- A04 — concurrency / interleaving: an offline refresh and an online
-- reservation for the same identity race on two connections. Both must
-- serialise on access_lock_key(uid); the loser must see the winner's hold /
-- reservation. Three interleavings, each with the second statement blocked on
-- the lock while the first transaction is still open:
--   (1) issue 2 tickets ‖ reserve → reservation paywalled
--   (2) reserve ‖ issue 2 tickets → exactly one ticket
--   (3) two issue calls from two devices of the same account → 2 tickets total
--       (the blocked device sees the sibling's hold: no ticket, paywall)
-- Concurrency needs committed rows, so the setup and the two actors run on
-- dblink connections (postgres over the unix socket, then the API header and
-- the client role are set per connection exactly as the edge function does).
-- Expected: outstanding tickets + syncable permits ≤ 2 after every race.
\set ON_ERROR_STOP on
\set QUIET on

create schema if not exists a04_probe;
create extension if not exists dblink with schema a04_probe;
-- The candidate's W07 matrix may already hold dblink in its own schema; the
-- actors below resolve it through search_path either way.

create or replace function a04_probe.await_lock(p_application text)
returns void language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then
      return;
    end if;
    if clock_timestamp() > deadline then
      raise exception 'A04: the second connection never blocked on the per-identity lock (no serialisation)';
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a401', 'a04-race-1@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a402', 'a04-race-2@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a403', 'a04-race-3@example.test', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'google-sub-a04-1', '00000000-0000-4000-8000-00000000a401', '{"sub":"google-sub-a04-1"}'),
  ('google', 'google-sub-a04-2', '00000000-0000-4000-8000-00000000a402', '{"sub":"google-sub-a04-2"}'),
  ('google', 'google-sub-a04-3', '00000000-0000-4000-8000-00000000a403', '{"sub":"google-sub-a04-3"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-0000000a0401', '00000000-0000-4000-8000-00000000a401'),
  ('00000000-0000-4000-8000-0000000a0402', '00000000-0000-4000-8000-00000000a402'),
  ('00000000-0000-4000-8000-0000000a0403', '00000000-0000-4000-8000-00000000a403');

do $$
<<race>>
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  header text := jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text;
  c text;
  u uuid;
  s uuid;
  first_out text;
  second_out text;
  n_tickets int;
  n_permits int;
  hold_count int;
  as_client text;
begin
  execute format('set local search_path = public, %s',
    (select extnamespace::regnamespace from pg_extension where extname = 'dblink'));
  foreach c in array array['a04_first','a04_second'] loop
    perform dblink_connect(c, connection || ' application_name=' || c);
    perform dblink_exec(c, 'set statement_timeout = ''5s''');
  end loop;

  -- ── (1) refresh first, reservation blocked behind it ──
  u := '00000000-0000-4000-8000-00000000a401'; s := '00000000-0000-4000-8000-0000000a0401';
  as_client := format('begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
    || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
    header, u::text, jsonb_build_object('session_id', s)::text);
  perform dblink_exec('a04_first', as_client);
  perform 1 from dblink('a04_first', 'select public.register_offline_device(''a04-key-1'', ''production'', true)') as t(value text);
  select value into first_out from dblink('a04_first',
    'select result || '':'' || coalesce(array_length(ticket_ids, 1), 0) from public.issue_offline_grant(''a04-key-1'', 2)') as t(value text);
  perform dblink_exec('a04_second', as_client);
  perform dblink_send_query('a04_second', 'select result from public.reserve_analysis_permit(''a04-race-1'')');
  perform a04_probe.await_lock('a04_second');
  perform dblink_exec('a04_first', 'commit');
  select value into second_out from dblink_get_result('a04_second') as t(value text);
  perform 1 from dblink_get_result('a04_second', false) as t(value text);
  perform dblink_exec('a04_second', 'commit');
  select count(*) into n_tickets from public.offline_allocation_ledger where user_id = u and event = 'allocated';
  select count(*) into n_permits from public.analysis_permits p where p.user_id = u and public.permit_backs_sync(p.status, p.outcome);
  raise notice 'A04(1) grant=% then reserve=% → tickets=% permits=%', first_out, second_out, n_tickets, n_permits;
  if first_out <> 'accepted:2' or second_out <> 'access.paywall_required' or n_tickets + n_permits > 2 then
    raise exception 'A04 BREAK (1): grant % / blocked reserve % left % tickets + % permits for a 2-rating identity', first_out, second_out, n_tickets, n_permits;
  end if;

  -- ── (2) reservation first, refresh blocked behind it ──
  u := '00000000-0000-4000-8000-00000000a402'; s := '00000000-0000-4000-8000-0000000a0402';
  as_client := format('begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
    || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
    header, u::text, jsonb_build_object('session_id', s)::text);
  perform dblink_exec('a04_second', as_client);
  perform 1 from dblink('a04_second', 'select public.register_offline_device(''a04-key-2'', ''production'', true)') as t(value text);
  perform dblink_exec('a04_second', 'commit');
  perform dblink_exec('a04_first', as_client);
  select value into first_out from dblink('a04_first', 'select result from public.reserve_analysis_permit(''a04-race-2'')') as t(value text);
  perform dblink_exec('a04_second', as_client);
  perform dblink_send_query('a04_second',
    'select result || '':'' || coalesce(array_length(ticket_ids, 1), 0) from public.issue_offline_grant(''a04-key-2'', 2)');
  perform a04_probe.await_lock('a04_second');
  perform dblink_exec('a04_first', 'commit');
  select value into second_out from dblink_get_result('a04_second') as t(value text);
  perform 1 from dblink_get_result('a04_second', false) as t(value text);
  perform dblink_exec('a04_second', 'commit');
  select count(*) into n_tickets from public.offline_allocation_ledger where user_id = u and event = 'allocated';
  select count(*) into n_permits from public.analysis_permits p where p.user_id = u and public.permit_backs_sync(p.status, p.outcome);
  raise notice 'A04(2) reserve=% then grant=% → tickets=% permits=%', first_out, second_out, n_tickets, n_permits;
  if first_out <> 'accepted' or second_out <> 'accepted:1' or n_tickets + n_permits > 2 then
    raise exception 'A04 BREAK (2): reserve % / blocked grant % left % tickets + % permits for a 2-rating identity', first_out, second_out, n_tickets, n_permits;
  end if;

  -- ── (3) two devices of one account refresh at once ──
  u := '00000000-0000-4000-8000-00000000a403'; s := '00000000-0000-4000-8000-0000000a0403';
  as_client := format('begin; select set_config(''request.headers'', %L, true); set local role authenticated; '
    || 'set local request.jwt.claim.sub = %L; set local request.jwt.claims = %L;',
    header, u::text, jsonb_build_object('session_id', s)::text);
  perform dblink_exec('a04_first', as_client);
  perform 1 from dblink('a04_first', 'select public.register_offline_device(''a04-key-3a'', ''production'', true)') as t(value text);
  perform 1 from dblink('a04_first', 'select public.register_offline_device(''a04-key-3b'', ''production'', true)') as t(value text);
  perform dblink_exec('a04_first', 'commit');
  perform dblink_exec('a04_first', as_client);
  select value into first_out from dblink('a04_first',
    'select result || '':'' || coalesce(array_length(ticket_ids, 1), 0) from public.issue_offline_grant(''a04-key-3a'', 2)') as t(value text);
  perform dblink_exec('a04_second', as_client);
  perform dblink_send_query('a04_second',
    'select result || '':'' || coalesce(array_length(ticket_ids, 1), 0) from public.issue_offline_grant(''a04-key-3b'', 2)');
  perform a04_probe.await_lock('a04_second');
  perform dblink_exec('a04_first', 'commit');
  select value into second_out from dblink_get_result('a04_second') as t(value text);
  perform 1 from dblink_get_result('a04_second', false) as t(value text);
  perform dblink_exec('a04_second', 'commit');
  select count(*) into n_tickets from public.offline_allocation_ledger where user_id = u and event = 'allocated';
  select count(*) into hold_count from api_private.offline_owned_allocations(u) o(ticket_id)
    where not exists (select 1 from public.offline_allocation_ledger c where c.ticket_id = o.ticket_id and c.event = 'consumed');
  raise notice 'A04(3) device A=% device B=% → tickets=% hold=%', first_out, second_out, n_tickets, hold_count;
  if first_out <> 'accepted:2' or second_out not in ('accepted:0', 'access.paywall_required:0')
     or n_tickets <> 2 or hold_count <> 2 then
    raise exception 'A04 BREAK (3): two devices refreshing at once got % / % → % tickets, hold %', first_out, second_out, n_tickets, hold_count;
  end if;

  foreach c in array array['a04_first','a04_second'] loop
    perform dblink_disconnect(c);
  end loop;
end $$;
\echo A04 PASSED
