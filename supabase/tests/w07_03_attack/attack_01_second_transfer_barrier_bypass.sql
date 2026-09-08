-- W07-03 attack A1 — replay / duplicate identity across two queued transfers.
--
-- Hypothesis: the destination barrier is keyed on the ticket's OWN event id.
-- A destination that sits in an older unsettled transfer (T1, source never
-- confirmed) receives a verdict bound to a SECOND transfer event (T2). The
-- persist loop treats that verdict as "direct" for T1 and applies it, so the
-- destination becomes premium although neither source has been confirmed.
--
-- Expected (W07-03 objective / AC2): the destination is NOT premium before a
-- source confirmation; the RPC answer is coherent (withheld => premium=false).
-- A raise below is a confirmed break.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a101', 'w07a1-src1@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a102', 'w07a1-src2@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a103', 'w07a1-dst@example.test', '{"provider":"apple"}');

set local role service_role;
do $$
declare
  src1 uuid := '00000000-0000-4000-8000-00000000a101';
  src2 uuid := '00000000-0000-4000-8000-00000000a102';
  dst uuid := '00000000-0000-4000-8000-00000000a103';
  payload1 jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a1-transfer-1', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src1::text),
    'transferred_to', jsonb_build_array(dst::text)));
  payload2 jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a1-transfer-2', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src2::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease1 uuid;
  lease2 uuid;
  issued jsonb;
  dst_ticket2 uuid;
  r jsonb;
  premium_row boolean;
begin
  -- Delivery 1: the transfer is queued but the provider never answers for
  -- src1 (5xx), so the Edge returns 503 and T1 stays pending.
  lease1 := (public.claim_billing_webhook_delivery('w07a1-transfer-1', payload1)->>'lease_token')::uuid;
  perform public.begin_billing_verification(array[src1, dst], 'w07a1-transfer-1', payload1, lease1);
  if (public.billing_transfer_recovery(dst)->0->>'state') <> 'pending' then
    raise exception 'W07-A1 setup: T1 must be pending';
  end if;

  -- Delivery 2: a second transfer to the same destination. Only the
  -- destination verdict is persisted so far (source verification pending).
  lease2 := (public.claim_billing_webhook_delivery('w07a1-transfer-2', payload2)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src2, dst], 'w07a1-transfer-2', payload2, lease2);
  select (item->>'ticket_id')::uuid into dst_ticket2 from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;

  r := public.persist_billing_verdict(dst, dst_ticket2, active);
  premium_row := exists (select 1 from public.billing_entitlements where user_id = dst and premium);
  raise notice 'W07-A1 persist(dst, T2 ticket) => %', r;
  raise notice 'W07-A1 destination premium row present: %', premium_row;
  raise notice 'W07-A1 recovery(dst) => %', public.billing_transfer_recovery(dst);

  if (r->>'withheld')::boolean and (r->'billing'->>'premium')::boolean then
    raise exception 'W07-A1a: incoherent answer — withheld=true yet billing.premium=true (%)', r;
  end if;
  if premium_row then
    raise exception 'W07-A1b: destination became premium while every source of every transfer it sits in is unconfirmed';
  end if;
end $$;
rollback;
