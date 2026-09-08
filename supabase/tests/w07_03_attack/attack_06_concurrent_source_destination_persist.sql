-- W07-03 attack A6 — concurrency / reentrancy across connections (two Edge
-- isolates, or a webhook isolate racing the destination's sync):
--   (a) source verdict and webhook-bound destination verdict persisted from
--       two connections, each interleaving order (first holder commits while
--       the second is blocked on the transfer lock);
--   (b) HELD transfer: the source's later "lost it" sync verdict races the
--       destination's replayed webhook verdict;
--   (c) the same TRANSFER delivery issued twice under one lease from two
--       connections (double submit) must yield exactly one queued transfer.
-- Expected: no deadlock (statement_timeout 5s would surface one as an error),
-- no error, and the end state is exactly "source non-premium, destination
-- premium, transfer confirmed, one transfer row". A raise is a confirmed break.
\set ON_ERROR_STOP on
create schema w07a_probe;
create extension if not exists dblink with schema w07a_probe;

create function w07a_probe.await_lock(p_application text)
returns void language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then
      return;
    end if;
    if clock_timestamp() > deadline then
      raise exception 'W07-A6: the second connection never blocked on the expected lock';
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

insert into auth.users (id, email, raw_app_meta_data)
select format('00000000-0000-4000-8000-00000000a6%s', lpad(i::text, 2, '0'))::uuid,
       format('w07a6-%s@example.test', i), '{"provider":"google"}'
from generate_series(1, 8) i;

do $$
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  c text;
  src uuid;
  dst uuid;
  event_id text;
  payload jsonb;
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  first_user uuid;
  first_ticket uuid;
  first_verdict jsonb;
  second_user uuid;
  second_ticket uuid;
  second_verdict jsonb;
  r jsonb;
  err text;
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  source_first boolean;
  scenario integer := 0;
  transfer_count bigint;
begin
  foreach c in array array['w07a6_setup','w07a6_first','w07a6_second'] loop
    perform w07a_probe.dblink_connect(c, connection || ' application_name=' || c);
    perform w07a_probe.dblink_exec(c, 'set statement_timeout = ''5s''');
  end loop;
  perform w07a_probe.dblink_exec('w07a6_setup', 'set role service_role');

  -- (a) source / destination race, both orders.
  foreach source_first in array array[true, false] loop
    scenario := scenario + 1;
    src := format('00000000-0000-4000-8000-00000000a6%s', lpad((scenario * 2 - 1)::text, 2, '0'))::uuid;
    dst := format('00000000-0000-4000-8000-00000000a6%s', lpad((scenario * 2)::text, 2, '0'))::uuid;
    event_id := format('w07a6-race-%s', scenario);
    payload := jsonb_build_object('event', jsonb_build_object(
      'id', event_id, 'type', 'TRANSFER',
      'transferred_from', jsonb_build_array(src::text),
      'transferred_to', jsonb_build_array(dst::text)));
    select (value->>'lease_token')::uuid into lease from w07a_probe.dblink('w07a6_setup', format(
      'select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', event_id, payload)) as result(value jsonb);
    select value into issued from w07a_probe.dblink('w07a6_setup', format(
      'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)',
      array[src, dst]::text, event_id, payload, lease)) as result(value jsonb);
    select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
    select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
    if source_first then
      first_user := src; first_ticket := src_ticket; first_verdict := inactive;
      second_user := dst; second_ticket := dst_ticket; second_verdict := active;
    else
      first_user := dst; first_ticket := dst_ticket; first_verdict := active;
      second_user := src; second_ticket := src_ticket; second_verdict := inactive;
    end if;
    perform w07a_probe.dblink_exec('w07a6_first', 'begin; set local role service_role');
    select value into r from w07a_probe.dblink('w07a6_first', format(
      'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', first_user, first_ticket, first_verdict)) as result(value jsonb);
    perform w07a_probe.dblink_exec('w07a6_second', 'begin; set local role service_role');
    perform w07a_probe.dblink_send_query('w07a6_second', format(
      'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', second_user, second_ticket, second_verdict));
    perform w07a_probe.await_lock('w07a6_second');
    perform w07a_probe.dblink_exec('w07a6_first', 'commit');
    select value into r from w07a_probe.dblink_get_result('w07a6_second', false) as result(value jsonb);
    err := w07a_probe.dblink_error_message('w07a6_second');
    perform 1 from w07a_probe.dblink_get_result('w07a6_second', false) as result(value jsonb);
    perform w07a_probe.dblink_exec('w07a6_second', 'commit');
    raise notice 'W07-A6 (a) source_first=% second result=% error=%', source_first, r, err;
    if err <> 'OK' then
      raise exception 'W07-A6a: concurrent persistence failed (source_first %): %', source_first, err;
    end if;
    if exists (select 1 from public.billing_entitlements where user_id = src and premium)
       or not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
       or (select state from api_private.billing_transfers where billing_transfers.event_id = payload->'event'->>'id') <> 'confirmed' then
      raise exception 'W07-A6a: end state inconsistent (source_first %): src premium %, dst premium %, state %',
        source_first,
        exists (select 1 from public.billing_entitlements where user_id = src and premium),
        exists (select 1 from public.billing_entitlements where user_id = dst and premium),
        (select state from api_private.billing_transfers where billing_transfers.event_id = payload->'event'->>'id');
    end if;
    -- The webhook completes after both verdicts landed.
    select value into r from w07a_probe.dblink('w07a6_setup', format(
      'select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb,%L::uuid)',
      event_id, payload, jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease)) as result(value jsonb);
    if not (r->>'verified')::boolean then
      raise exception 'W07-A6a: webhook did not complete after the race (%)', r;
    end if;
  end loop;

  -- (b) held transfer: source sync "lost" races the destination replay.
  scenario := scenario + 1;
  src := format('00000000-0000-4000-8000-00000000a6%s', lpad((scenario * 2 - 1)::text, 2, '0'))::uuid;
  dst := format('00000000-0000-4000-8000-00000000a6%s', lpad((scenario * 2)::text, 2, '0'))::uuid;
  event_id := format('w07a6-held-%s', scenario);
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', event_id, 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  select (value->>'lease_token')::uuid into lease from w07a_probe.dblink('w07a6_setup', format(
    'select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', event_id, payload)) as result(value jsonb);
  select value into issued from w07a_probe.dblink('w07a6_setup', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)',
    array[src, dst]::text, event_id, payload, lease)) as result(value jsonb);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  perform 1 from w07a_probe.dblink('w07a6_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', src, src_ticket, active)) as result(value jsonb);
  perform 1 from w07a_probe.dblink('w07a6_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', dst, dst_ticket, active)) as result(value jsonb);
  if (select state from api_private.billing_transfers where billing_transfers.event_id = payload->'event'->>'id') <> 'held' then
    raise exception 'W07-A6b setup: transfer must be held';
  end if;
  select value into issued from w07a_probe.dblink('w07a6_setup', format(
    'select public.begin_billing_verification(%L::uuid[])', array[src]::text)) as result(value jsonb);
  perform w07a_probe.dblink_exec('w07a6_first', 'begin; set local role service_role');
  perform 1 from w07a_probe.dblink('w07a6_first', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', src, (issued->0->>'ticket_id')::uuid, inactive)) as result(value jsonb);
  perform w07a_probe.dblink_exec('w07a6_second', 'begin; set local role service_role');
  perform w07a_probe.dblink_send_query('w07a6_second', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', dst, dst_ticket, active));
  perform w07a_probe.await_lock('w07a6_second');
  perform w07a_probe.dblink_exec('w07a6_first', 'commit');
  select value into r from w07a_probe.dblink_get_result('w07a6_second', false) as result(value jsonb);
  err := w07a_probe.dblink_error_message('w07a6_second');
  perform 1 from w07a_probe.dblink_get_result('w07a6_second', false) as result(value jsonb);
  perform w07a_probe.dblink_exec('w07a6_second', 'commit');
  raise notice 'W07-A6 (b) destination replay after the source lost => % error=%', r, err;
  if err <> 'OK' or exists (select 1 from public.billing_entitlements where user_id = src and premium)
     or not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or (select state from api_private.billing_transfers where billing_transfers.event_id = payload->'event'->>'id') <> 'confirmed' then
    raise exception 'W07-A6b: held-release race left an inconsistent state (%, %)', r, err;
  end if;

  -- (c) double submit of the same delivery under one lease.
  scenario := scenario + 1;
  src := format('00000000-0000-4000-8000-00000000a6%s', lpad((scenario * 2 - 1)::text, 2, '0'))::uuid;
  dst := format('00000000-0000-4000-8000-00000000a6%s', lpad((scenario * 2)::text, 2, '0'))::uuid;
  event_id := format('w07a6-double-%s', scenario);
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', event_id, 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  select (value->>'lease_token')::uuid into lease from w07a_probe.dblink('w07a6_setup', format(
    'select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', event_id, payload)) as result(value jsonb);
  perform w07a_probe.dblink_exec('w07a6_first', 'begin; set local role service_role');
  perform 1 from w07a_probe.dblink('w07a6_first', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)',
    array[src, dst]::text, event_id, payload, lease)) as result(value jsonb);
  perform w07a_probe.dblink_exec('w07a6_second', 'begin; set local role service_role');
  perform w07a_probe.dblink_send_query('w07a6_second', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)',
    array[src, dst]::text, event_id, payload, lease));
  perform w07a_probe.await_lock('w07a6_second');
  perform w07a_probe.dblink_exec('w07a6_first', 'commit');
  select value into r from w07a_probe.dblink_get_result('w07a6_second', false) as result(value jsonb);
  err := w07a_probe.dblink_error_message('w07a6_second');
  perform 1 from w07a_probe.dblink_get_result('w07a6_second', false) as result(value jsonb);
  perform w07a_probe.dblink_exec('w07a6_second', 'commit');
  select count(*) into transfer_count from api_private.billing_transfers where billing_transfers.event_id = payload->'event'->>'id';
  raise notice 'W07-A6 (c) double submit second result=% error=% transfers=%', r, err, transfer_count;
  if err <> 'OK' or transfer_count <> 1
     or (select count(*) from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id
         where t.event_id = payload->'event'->>'id') <> 2 then
    raise exception 'W07-A6c: double submit produced % transfer rows (%)', transfer_count, err;
  end if;

  foreach c in array array['w07a6_setup','w07a6_first','w07a6_second'] loop
    perform w07a_probe.dblink_disconnect(c);
  end loop;
end $$;
drop schema w07a_probe cascade;
