-- W07-03 attack A9 — process death between steps + redelivery convergence.
-- Delivery 1: begin, destination verified (withheld), isolate dies before the
-- source is verified and before complete/release (lease lapses).
-- Delivery 2 (after the lease lapsed): fresh tickets; the source is confirmed
-- inactive, destination confirmed premium; completion must succeed; the
-- queue must be confirmed, recovery empty, audit strictly append-only across
-- both deliveries (no row rewritten, count monotonic), and a stale completion
-- attempt with the DEAD lease must be refused.
-- Runs as the table owner so the private queue rows can be inspected.
-- A raise below is a confirmed break.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a901', 'w07a9-src@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a902', 'w07a9-dst@example.test', '{"provider":"apple"}');

do $$
declare
  src uuid := '00000000-0000-4000-8000-00000000a901';
  dst uuid := '00000000-0000-4000-8000-00000000a902';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a9-transfer', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  dead_lease uuid;
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  r jsonb;
  outcome text;
  audit_snapshot jsonb;
  audit_count bigint;
  broken text[] := '{}';
begin
  -- delivery 1
  dead_lease := (public.claim_billing_webhook_delivery('w07a9-transfer', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07a9-transfer', payload, dead_lease);
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if not (r->>'withheld')::boolean then
    raise exception 'W07-A9 setup: destination must be withheld (%)', r;
  end if;
  -- isolate dies here: no complete, no release. Simulate the lapse of the lease.
  update api_private.billing_webhook_claims set lease_expires_at = clock_timestamp() - interval '1 second' where event_id = 'w07a9-transfer';
  update public.webhook_events set claimed_at = clock_timestamp() - interval '6 minutes' where id = 'w07a9-transfer';
  select jsonb_agg(to_jsonb(a) order by a.id), count(*) into audit_snapshot, audit_count
    from api_private.billing_transfer_audit a where a.event_id = 'w07a9-transfer';

  -- delivery 2
  r := public.claim_billing_webhook_delivery('w07a9-transfer', payload);
  lease := (r->>'lease_token')::uuid;
  if lease is null then
    raise exception 'W07-A9 setup: redelivery could not claim the lapsed lease (%)', r;
  end if;
  issued := public.begin_billing_verification(array[src, dst], 'w07a9-transfer', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  r := public.persist_billing_verdict(src, src_ticket, inactive);
  raise notice 'W07-A9 redelivery persist(src) => %', r;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  raise notice 'W07-A9 redelivery persist(dst) => %', r;
  if (r->>'withheld')::boolean or not (r->>'applied')::boolean or not (r->'billing'->>'premium')::boolean then
    broken := array_append(broken, format('redelivery destination not released (%s)', r));
  end if;
  -- the dead isolate's lease must not complete the delivery
  begin
    r := public.complete_billing_webhook('w07a9-transfer', payload, jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), dead_lease);
    outcome := 'ACCEPTED ' || r::text;
  exception when others then
    outcome := sqlstate;
  end;
  raise notice 'W07-A9 completion with the dead lease => %', outcome;
  if outcome like 'ACCEPTED%' then
    broken := array_append(broken, format('dead lease completed the webhook (%s)', outcome));
  end if;
  r := public.complete_billing_webhook('w07a9-transfer', payload, jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
  raise notice 'W07-A9 completion with the live lease => %', r;
  if not (r->>'verified')::boolean then
    broken := array_append(broken, format('live lease could not complete (%s)', r));
  end if;
  if (select state from api_private.billing_transfers where event_id = 'w07a9-transfer') <> 'confirmed'
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0
     or jsonb_array_length(public.billing_transfer_recovery(src)) <> 0
     or exists (select 1 from public.billing_entitlements where user_id = src and premium)
     or not exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    broken := array_append(broken, 'end state after redelivery is not confirmed/released');
  end if;
  -- audit append-only across deliveries
  if (select jsonb_agg(to_jsonb(a) order by a.id) from (
        select * from api_private.billing_transfer_audit where event_id = 'w07a9-transfer' order by id limit audit_count) a)
     is distinct from audit_snapshot then
    broken := array_append(broken, 'audit rows from delivery 1 were rewritten');
  end if;
  if (select count(*) from api_private.billing_transfer_audit where event_id = 'w07a9-transfer') <= audit_count then
    broken := array_append(broken, 'redelivery recorded no audit');
  end if;
  raise notice 'W07-A9 audit => %', (select jsonb_agg(action order by id) from api_private.billing_transfer_audit where event_id = 'w07a9-transfer');
  if cardinality(broken) > 0 then
    raise exception 'W07-A9: %', array_to_string(broken, ' | ');
  end if;
end $$;
rollback;
