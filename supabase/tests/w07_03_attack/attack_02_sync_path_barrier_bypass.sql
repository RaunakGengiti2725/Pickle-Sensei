-- W07-03 attack A2 — interleaved account switch: the destination's own
-- `POST /v1/billing/sync` (begin_billing_verification(array[dst]) with no
-- event, then persist_billing_verdict) lands while the transfer is unsettled.
--
-- Scenario 1: T1 pending, source not yet verified.
-- Scenario 2: T1 HELD — the provider confirmed the source STILL holds the
--             entitlement; the same purchase would now be premium on both
--             accounts if the destination is granted.
--
-- Expected (AC2 "destination not premium before confirmation"; objective
-- "destination gains only after provider confirmation" of the source losing):
-- the sync verdict is recorded on the queue but the grant waits for the
-- barrier. A raise below is a confirmed break (or a documented design gap).
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a201', 'w07a2-src@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a202', 'w07a2-dst@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000a203', 'w07a2-src-held@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a204', 'w07a2-dst-held@example.test', '{"provider":"apple"}');

set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-00000000a201';
  dst uuid := '00000000-0000-4000-8000-00000000a202';
  src_h uuid := '00000000-0000-4000-8000-00000000a203';
  dst_h uuid := '00000000-0000-4000-8000-00000000a204';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a2-transfer-1', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  payload_h jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a2-transfer-held', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src_h::text),
    'transferred_to', jsonb_build_array(dst_h::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  sync_ticket uuid;
  r jsonb;
  broken text[] := '{}';
begin
  -- Scenario 1: pending transfer, destination syncs from its device.
  lease := (public.claim_billing_webhook_delivery('w07a2-transfer-1', payload)->>'lease_token')::uuid;
  perform public.begin_billing_verification(array[src, dst], 'w07a2-transfer-1', payload, lease);
  issued := public.begin_billing_verification(array[dst]);
  sync_ticket := (issued->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst, sync_ticket, active);
  raise notice 'W07-A2 scenario 1 sync persist => %', r;
  raise notice 'W07-A2 scenario 1 recovery(dst) => %', public.billing_transfer_recovery(dst);
  if exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    broken := array_append(broken, 'W07-A2a: pending transfer — destination premium via sync before the source was confirmed');
  end if;

  -- Scenario 2: held transfer (provider says the source STILL holds it).
  lease := (public.claim_billing_webhook_delivery('w07a2-transfer-held', payload_h)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src_h, dst_h], 'w07a2-transfer-held', payload_h, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src_h::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst_h::text;
  perform public.persist_billing_verdict(src_h, src_ticket, active);
  r := public.persist_billing_verdict(dst_h, dst_ticket, active);
  if not (r->>'withheld')::boolean or r->'transfer'->>'state' <> 'held' then
    raise exception 'W07-A2 setup: the webhook-bound destination verdict must be withheld on a held transfer (%)', r;
  end if;
  issued := public.begin_billing_verification(array[dst_h]);
  sync_ticket := (issued->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst_h, sync_ticket, active);
  raise notice 'W07-A2 scenario 2 sync persist => %', r;
  raise notice 'W07-A2 scenario 2 recovery(dst_h) => %', public.billing_transfer_recovery(dst_h);
  if exists (select 1 from public.billing_entitlements where user_id = dst_h and premium)
     and exists (select 1 from public.billing_entitlements where user_id = src_h and premium) then
    broken := array_append(broken, 'W07-A2b: HELD transfer — source retains premium AND destination gained premium via sync (one purchase, two premium accounts)');
  end if;
  if cardinality(broken) > 0 then
    raise exception '%', array_to_string(broken, ' | ');
  end if;
end $$;
rollback;
