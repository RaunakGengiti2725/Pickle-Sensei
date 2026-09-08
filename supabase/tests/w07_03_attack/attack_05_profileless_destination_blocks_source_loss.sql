-- W07-03 attack A5 — corrupt/partial persisted state between two steps: the
-- destination's verdict is recorded (withheld), then its public.profiles row
-- disappears (crash/restart window, profile repair, manual cleanup) before the
-- source is provider-confirmed inactive.
--
-- Objective: "source loses" — the source verdict is documented as applying
-- immediately, independent of the destination. On BASE the source's loss was
-- persisted before anything about the destination was touched. On the
-- candidate the source's persist settles the transfer inside the same
-- transaction and apply_billing_transfer_side raises 23503 for the
-- destination, rolling the SOURCE's loss back as well. The Edge maps that
-- 23503 (source user exists in Auth) to `retryable` -> 503, so the source
-- keeps premium on every redelivery until somebody repairs the destination.
--
-- Expected: the source's entitlement row is non-premium after its verdict is
-- persisted. A raise below is a confirmed break.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a501', 'w07a5-src@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a502', 'w07a5-dst@example.test', '{"provider":"apple"}');

create temp table w07a5_state (src_ticket uuid, dst_ticket uuid, lease uuid);
grant select, insert on w07a5_state to service_role;

set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-00000000a501';
  dst uuid := '00000000-0000-4000-8000-00000000a502';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a5-transfer', 'type', 'TRANSFER',
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
  -- The source is premium today (earlier sync).
  issued := public.begin_billing_verification(array[src]);
  perform public.persist_billing_verdict(src, (issued->0->>'ticket_id')::uuid, active);
  if not exists (select 1 from public.billing_entitlements where user_id = src and premium) then
    raise exception 'W07-A5 setup: source must start premium';
  end if;
  lease := (public.claim_billing_webhook_delivery('w07a5-transfer', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07a5-transfer', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if not (r->>'withheld')::boolean then
    raise exception 'W07-A5 setup: destination must be withheld (%)', r;
  end if;
  insert into pg_temp.w07a5_state values (src_ticket, dst_ticket, lease);
end $$;
reset role;

-- The destination's profile row goes away while the transfer is pending.
delete from public.profiles where id = '00000000-0000-4000-8000-00000000a502';

set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-00000000a501';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  src_ticket uuid := (select src_ticket from pg_temp.w07a5_state);
  r jsonb;
  outcome text;
begin
  begin
    r := public.persist_billing_verdict(src, src_ticket, inactive);
    outcome := r::text;
  exception when others then
    outcome := format('raised %s %s', sqlstate, sqlerrm);
  end;
  raise notice 'W07-A5 persist(src, inactive) => %', outcome;
  if exists (select 1 from public.billing_entitlements where user_id = src and premium) then
    raise exception 'W07-A5: the source keeps premium after a provider-confirmed loss because the destination has no profile row (%)', outcome;
  end if;
end $$;
rollback;
