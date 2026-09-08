-- W07-03 attack A3 — corrupt/partial persisted state + process restart:
-- the source is recorded as RETAINING the entitlement (transfer `held`), then
-- the source deletes its account (auth.users row gone — the ordinary
-- "I moved to a new account, delete the old one" flow). RevenueCat redelivers
-- the TRANSFER (lease lapsed; simulated here through release + re-claim).
--
-- The candidate's own rule: the destination is released once every source is
-- "provider-confirmed inactive OR authoritatively absent from Auth". A source
-- side that already carries a verdict is never re-checked against Auth, so
-- the transfer must stay `held` forever, the destination never gains and the
-- webhook can never complete (55000 -> 503 on every redelivery).
--
-- Expected: an absent source releases the barrier (transfer confirmed,
-- destination applied, webhook completes). A raise below is a confirmed break.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a301', 'w07a3-src@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a302', 'w07a3-dst@example.test', '{"provider":"apple"}');

set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-00000000a301';
  dst uuid := '00000000-0000-4000-8000-00000000a302';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a3-transfer', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07a3-transfer', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07a3-transfer', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  perform public.persist_billing_verdict(src, src_ticket, active);
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if not (r->>'withheld')::boolean or r->'transfer'->>'state' <> 'held' then
    raise exception 'W07-A3 setup: transfer must be held (%)', r;
  end if;
  perform public.release_billing_webhook_delivery('w07a3-transfer', payload, lease);
end $$;
reset role;

-- The source deletes its account (GoTrue admin deleteUser -> auth.users row
-- gone; every FK cascades). The transfer side keeps its stale "active" verdict.
delete from auth.users where id = '00000000-0000-4000-8000-00000000a301';

set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-00000000a301';
  dst uuid := '00000000-0000-4000-8000-00000000a302';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a3-transfer', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid;
  issued jsonb;
  dst_ticket uuid;
  r jsonb;
  completed boolean := false;
begin
  -- Redelivery: the Edge claims again, begin issues user_missing for src and
  -- a fresh ticket for dst, dst is re-verified premium.
  lease := (public.claim_billing_webhook_delivery('w07a3-transfer', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07a3-transfer', payload, lease);
  raise notice 'W07-A3 redelivery begin => %', issued;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  raise notice 'W07-A3 redelivery persist(dst) => %', r;
  raise notice 'W07-A3 recovery(dst) => %', public.billing_transfer_recovery(dst);
  begin
    r := public.complete_billing_webhook('w07a3-transfer', payload, jsonb_build_object(dst::text, dst_ticket), lease);
    completed := true;
    raise notice 'W07-A3 complete => %', r;
  exception when object_not_in_prerequisite_state then
    raise notice 'W07-A3 complete_billing_webhook raised 55000: %', sqlerrm;
  end;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium) or not completed then
    raise exception 'W07-A3: source is authoritatively absent from Auth yet the transfer stays held — destination not premium (%), webhook completed (%)',
      exists (select 1 from public.billing_entitlements where user_id = dst and premium), completed;
  end if;
end $$;
rollback;
