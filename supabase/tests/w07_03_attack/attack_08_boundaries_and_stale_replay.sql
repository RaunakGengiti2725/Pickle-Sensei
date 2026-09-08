-- W07-03 attack A8 — boundary values + replay / clock games against the new
-- queue and barrier:
--   1. 17 distinct subjects (cap is 16) must be rejected with 22023 AND leave
--      no transfer/side/audit rows behind;
--   2. a TRANSFER whose parties are all anonymous (both arrays empty after
--      normalisation) must not create a 0-subject transfer;
--   3. a source verdict with a FAR-FUTURE expiresAt (year 9999) parks the
--      transfer as held (never fabricates loss); with a far-past expiresAt
--      (year 1970, premium=true) the source counts as inactive (release);
--   4. STALE REPLAY: after the transfer is confirmed and the destination
--      applied, an OLDER destination ticket (lower verification_order) that
--      says premium=false must not demote the destination nor rewrite the
--      applied side; an older SOURCE ticket saying premium=true must not
--      re-grant the source nor reopen/flip the confirmed transfer;
--   5. re-enqueue of the confirmed event with a different payload -> 22023,
--      with the same payload -> idempotent (still confirmed, no new sides).
-- Runs as the table owner so the private queue rows can be inspected; the
-- RPCs carry no role checks beyond EXECUTE grants (pinned by attack_07).
-- A raise below is a confirmed break.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data)
select format('00000000-0000-4000-8000-00000000a8%s', lpad(i::text, 2, '0'))::uuid,
       format('w07a8-%s@example.test', i), '{"provider":"google"}'
from generate_series(1, 20) i;

do $$
declare
  u uuid[] := (select array_agg(format('00000000-0000-4000-8000-00000000a8%s', lpad(i::text, 2, '0'))::uuid order by i) from generate_series(1, 20) i);
  payload jsonb;
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  src_ticket_old uuid;
  dst_ticket_old uuid;
  r jsonb;
  outcome text;
  broken text[] := '{}';
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  far_future jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_lifetime',
    'expiresAt', '9999-12-31T23:59:59Z',
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  far_past jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', '1970-01-01T00:00:00Z',
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  side_before record;
begin
  -- 1. seventeen subjects
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a8-seventeen', 'type', 'TRANSFER',
    'transferred_from', to_jsonb(u[1:9]), 'transferred_to', to_jsonb(u[10:17])));
  begin
    lease := (public.claim_billing_webhook_delivery('w07a8-seventeen', payload)->>'lease_token')::uuid;
    outcome := 'claim ACCEPTED';
  exception when others then
    outcome := 'claim ' || sqlstate;
    lease := gen_random_uuid();
  end;
  begin
    perform public.enqueue_billing_transfer('w07a8-seventeen', payload, lease);
    outcome := outcome || ', enqueue ACCEPTED';
  exception when others then
    outcome := outcome || ', enqueue ' || sqlstate;
  end;
  if outcome not in ('claim 22023, enqueue 22023', 'claim 22023, enqueue 55000', 'claim ACCEPTED, enqueue 22023') then
    broken := array_append(broken, format('17 subjects => %s', outcome));
  end if;
  if exists (select 1 from api_private.billing_transfers where event_id = 'w07a8-seventeen')
     or exists (select 1 from api_private.billing_transfer_audit where event_id = 'w07a8-seventeen') then
    broken := array_append(broken, '17 subjects left durable rows behind');
  end if;
  raise notice 'W07-A8 case 1 (17 subjects) => %', outcome;

  -- 2. anonymous-only parties
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a8-anon', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array('$RCAnonymousID:aaa'),
    'transferred_to', jsonb_build_array('$RCAnonymousID:bbb')));
  lease := (public.claim_billing_webhook_delivery('w07a8-anon', payload)->>'lease_token')::uuid;
  begin
    r := public.enqueue_billing_transfer('w07a8-anon', payload, lease);
    outcome := r::text;
  exception when others then
    outcome := sqlstate;
  end;
  if exists (select 1 from api_private.billing_transfers where event_id = 'w07a8-anon') then
    broken := array_append(broken, format('anonymous-only transfer created a queue row (%s)', outcome));
  end if;
  raise notice 'W07-A8 case 2 (anonymous only) => %', outcome;

  -- 3. far-future / far-past source clocks
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a8-future', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(u[18]::text), 'transferred_to', jsonb_build_array(u[19]::text)));
  -- older, never-persisted tickets for both parties (a slow isolate from an
  -- earlier sync that only answers after everything below has settled)
  issued := public.begin_billing_verification(array[u[18]]);
  src_ticket_old := (issued->0->>'ticket_id')::uuid;
  issued := public.begin_billing_verification(array[u[19]]);
  dst_ticket_old := (issued->0->>'ticket_id')::uuid;
  lease := (public.claim_billing_webhook_delivery('w07a8-future', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[u[18], u[19]], 'w07a8-future', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = u[18]::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = u[19]::text;
  perform public.persist_billing_verdict(u[18], src_ticket, far_future);
  r := public.persist_billing_verdict(u[19], dst_ticket, active);
  raise notice 'W07-A8 case 3a (far-future source) => %', r;
  if not (r->>'withheld')::boolean or r->'transfer'->>'state' <> 'held' then
    broken := array_append(broken, format('far-future source did not hold the transfer (%s)', r));
  end if;
  -- the source later syncs with a far-past expiry: inactive -> release
  issued := public.begin_billing_verification(array[u[18]]);
  r := public.persist_billing_verdict(u[18], (issued->0->>'ticket_id')::uuid, far_past);
  raise notice 'W07-A8 case 3b (far-past source) => %', r;
  if (r->'billing'->>'premium')::boolean
     or (select state from api_private.billing_transfers where event_id = 'w07a8-future') <> 'confirmed'
     or not exists (select 1 from public.billing_entitlements where user_id = u[19] and premium) then
    broken := array_append(broken, format('far-past source did not release the destination (%s, state %s)', r,
      (select state from api_private.billing_transfers where event_id = 'w07a8-future')));
  end if;

  -- 4. stale replay against the confirmed transfer with the OLDER tickets.
  select * into side_before from api_private.billing_transfer_sides s
    join api_private.billing_transfers t on t.id = s.transfer_id
    where t.event_id = 'w07a8-future' and s.user_id = u[19];
  begin
    r := public.persist_billing_verdict(u[19], dst_ticket_old, inactive);
    outcome := r::text;
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  raise notice 'W07-A8 case 4a (stale destination ticket) => %', outcome;
  if not exists (select 1 from public.billing_entitlements where user_id = u[19] and premium) then
    broken := array_append(broken, format('stale destination ticket demoted the destination (%s)', outcome));
  end if;
  if (select (s.verification_order, s.applied_at, s.verdict) from api_private.billing_transfer_sides s
        join api_private.billing_transfers t on t.id = s.transfer_id
        where t.event_id = 'w07a8-future' and s.user_id = u[19])
     is distinct from (side_before.verification_order, side_before.applied_at, side_before.verdict) then
    broken := array_append(broken, 'stale destination ticket rewrote the applied side');
  end if;
  begin
    r := public.persist_billing_verdict(u[18], src_ticket_old, active);
    outcome := r::text;
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  raise notice 'W07-A8 case 4b (stale source ticket) => %', outcome;
  if exists (select 1 from public.billing_entitlements where user_id = u[18] and premium and (expires_at is null or expires_at > now()))
     or (select state from api_private.billing_transfers where event_id = 'w07a8-future') <> 'confirmed'
     or (select verdict from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id
         where t.event_id = 'w07a8-future' and s.user_id = u[18]) is distinct from far_past then
    broken := array_append(broken, format('stale source ticket re-granted the source, reopened the transfer or rewrote the source side (%s)', outcome));
  end if;

  -- 5. re-enqueue of the confirmed event under the still-live lease
  begin
    perform public.enqueue_billing_transfer('w07a8-future', payload || '{"extra":1}', lease);
    outcome := 'ACCEPTED';
  exception when others then
    outcome := sqlstate;
  end;
  if outcome <> '22023' then
    broken := array_append(broken, format('conflicting re-enqueue of a confirmed transfer => %s', outcome));
  end if;
  r := public.enqueue_billing_transfer('w07a8-future', payload, lease);
  if r->>'state' <> 'confirmed'
     or (select count(*) from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id where t.event_id = 'w07a8-future') <> 2 then
    broken := array_append(broken, format('idempotent re-enqueue changed the confirmed transfer (%s)', r));
  end if;
  raise notice 'W07-A8 case 5 (re-enqueue) => %', r;

  if cardinality(broken) > 0 then
    raise exception 'W07-A8: %', array_to_string(broken, ' | ');
  end if;
end $$;
rollback;
