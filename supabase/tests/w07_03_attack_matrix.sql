-- W07-03 adversarial matrix (independent of the candidate's own regression
-- cases in security_regression.sql). Run against a database built exactly like
-- run_rls_tests.sh builds one (shim_auth.sql + every migration in order):
--
--   psql -v ON_ERROR_STOP=1 -q -f supabase/tests/w07_03_attack_matrix.sql
--
-- Sections A1..A12 run inside one transaction and roll back. Section A13 (the
-- concurrency probes) needs autocommitted state and dblink; it creates its own
-- w07a_probe schema and installs dblink there when the extension is absent.
--
-- The first case (A1) drives ONLY the shipping RPC surface that also exists on
-- BASE_SHA (claim -> begin -> persist -> complete) and reads
-- public.billing_entitlements, so on BASE_SHA it fails semantically (the
-- destination becomes premium before the source is provider-confirmed) rather
-- than on a missing relation.
\set ON_ERROR_STOP on

begin;
insert into auth.users (id, email, raw_app_meta_data)
select id, format('w07a-%s@example.test', id), '{"provider":"apple"}'::jsonb
from unnest(array[
  '0000000a-7000-4000-8000-000000000001', '0000000a-7000-4000-8000-000000000002',
  '0000000a-7000-4000-8000-000000000003', '0000000a-7000-4000-8000-000000000004',
  '0000000a-7000-4000-8000-000000000005', '0000000a-7000-4000-8000-000000000006',
  '0000000a-7000-4000-8000-000000000007', '0000000a-7000-4000-8000-000000000008',
  '0000000a-7000-4000-8000-000000000009', '0000000a-7000-4000-8000-00000000000a',
  '0000000a-7000-4000-8000-00000000000b', '0000000a-7000-4000-8000-00000000000c',
  '0000000a-7000-4000-8000-00000000000d', '0000000a-7000-4000-8000-00000000000e',
  '0000000a-7000-4000-8000-00000000000f', '0000000a-7000-4000-8000-000000000010',
  '0000000a-7000-4000-8000-000000000011', '0000000a-7000-4000-8000-000000000012',
  '0000000a-7000-4000-8000-000000000013', '0000000a-7000-4000-8000-000000000014',
  '0000000a-7000-4000-8000-000000000015', '0000000a-7000-4000-8000-000000000016',
  '0000000a-7000-4000-8000-000000000017', '0000000a-7000-4000-8000-000000000018',
  '0000000a-7000-4000-8000-000000000019', '0000000a-7000-4000-8000-00000000001a',
  '0000000a-7000-4000-8000-00000000001b', '0000000a-7000-4000-8000-00000000001c',
  '0000000a-7000-4000-8000-00000000001d', '0000000a-7000-4000-8000-00000000001e',
  '0000000a-7000-4000-8000-00000000001f', '0000000a-7000-4000-8000-000000000020',
  '0000000a-7000-4000-8000-000000000021', '0000000a-7000-4000-8000-000000000022',
  '0000000a-7000-4000-8000-000000000023', '0000000a-7000-4000-8000-000000000024',
  '0000000a-7000-4000-8000-000000000030', '0000000a-7000-4000-8000-000000000031',
  '0000000a-7000-4000-8000-000000000032', '0000000a-7000-4000-8000-000000000033',
  '0000000a-7000-4000-8000-000000000034', '0000000a-7000-4000-8000-000000000035',
  '0000000a-7000-4000-8000-000000000036', '0000000a-7000-4000-8000-000000000037',
  '0000000a-7000-4000-8000-000000000038', '0000000a-7000-4000-8000-000000000039',
  '0000000a-7000-4000-8000-00000000003a', '0000000a-7000-4000-8000-00000000003b',
  '0000000a-7000-4000-8000-00000000003c', '0000000a-7000-4000-8000-00000000003d',
  '0000000a-7000-4000-8000-00000000003e', '0000000a-7000-4000-8000-00000000003f',
  '0000000a-7000-4000-8000-000000000040'
]::uuid[]) as u(id);

-- Shared fixtures: the shipping webhook sequence, condensed.
create schema w07a;
create function w07a.transfer_payload(p_event text, p_from uuid[], p_to uuid[])
returns jsonb language sql immutable as $$
  select jsonb_build_object('event', jsonb_build_object(
    'id', p_event, 'type', 'TRANSFER', 'app_user_id', '$RCAnonymousID:w07a',
    'transferred_from', to_jsonb(p_from), 'transferred_to', to_jsonb(p_to)))
$$;
create function w07a.active(p_expires timestamptz default clock_timestamp() + interval '30 days')
returns jsonb language sql volatile as $$
  select jsonb_build_object('premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', p_expires, 'activeEntitlements', jsonb_build_array('pickle_sensei_pro'))
$$;
create function w07a.inactive()
returns jsonb language sql immutable as $$
  select '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}'::jsonb
$$;
create function w07a.ticket_for(p_issued jsonb, p_user uuid)
returns uuid language sql immutable as $$
  select (item->>'ticket_id')::uuid from jsonb_array_elements(p_issued) item where item->>'user_id' = p_user::text
$$;
create function w07a.is_premium(p_user uuid)
returns boolean language sql stable as $$
  select coalesce((select premium and (expires_at is null or expires_at > now())
    from public.billing_entitlements where user_id = p_user), false)
$$;
grant usage on schema w07a to service_role;
grant execute on all functions in schema w07a to service_role;

-- ----------------------------------------------------------------------------
-- A1 (regress boundary, shipping surface only): destination verified before
-- the source must not be premium; the webhook must stay retryable; the source's
-- provider-confirmed loss releases the destination.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000001';
  dst uuid := '0000000a-7000-4000-8000-000000000002';
  ev text := 'w07a-a1';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid;
  issued jsonb;
  r jsonb;
begin
  r := public.claim_billing_webhook_delivery(ev, payload);
  if r->>'outcome' <> 'claimed' then
    raise exception 'A1: fresh delivery must be claimed (got %)', r;
  end if;
  lease := (r->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if w07a.is_premium(dst) then
    raise exception 'A1: destination became premium before the source was provider-confirmed (got %)', r;
  end if;
  if r->>'outcome' <> 'persisted' or (r->>'applied')::boolean is distinct from false then
    raise exception 'A1: destination verdict must persist without applying (got %)', r;
  end if;
  begin
    perform public.complete_billing_webhook(ev, payload,
      jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
    raise exception 'A1: webhook must not complete while the destination is barred';
  exception when object_not_in_prerequisite_state then null;
  end;
  if exists (select 1 from public.webhook_events where id = ev and processed_at is not null) then
    raise exception 'A1: no completion marker while barred';
  end if;
  r := public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.inactive());
  if (r->>'applied')::boolean is distinct from true or w07a.is_premium(src) then
    raise exception 'A1: source loss must apply immediately (got %)', r;
  end if;
  if not w07a.is_premium(dst) then
    raise exception 'A1: destination must gain premium once the source loss is confirmed';
  end if;
  r := public.complete_billing_webhook(ev, payload,
    jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A1: confirmed transfer must complete the webhook (got %)', r;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from api_private.billing_transfers where event_id = 'w07a-a1' and state = 'confirmed' and settled_at is not null) <> 1 then
    raise exception 'A1: exactly one confirmed transfer row expected';
  end if;
  if (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
        join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07a-a1')
     <> array['enqueued', 'destination_verified', 'destination_withheld', 'source_verified', 'destination_applied', 'confirmed'] then
    raise exception 'A1: unexpected audit trail %', (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
        join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07a-a1');
  end if;
end $$;

\echo W07-03 attack A1: passed
-- ----------------------------------------------------------------------------
-- A2 (reentrancy / double submit of the same withheld ticket): a retried
-- persist with the identical verdict is a no-op, a divergent one is rejected,
-- and neither writes audit rows or grants premium.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000003';
  dst uuid := '0000000a-7000-4000-8000-000000000004';
  ev text := 'w07a-a2';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  verdict jsonb := w07a.active();
  first jsonb;
  again jsonb;
begin
  first := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), verdict);
  again := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), verdict);
  if again - 'billing' <> first - 'billing' or (again->>'withheld')::boolean is distinct from true then
    raise exception 'A2: replaying a withheld ticket must answer identically (% vs %)', first, again;
  end if;
  begin
    perform public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active(clock_timestamp() + interval '31 days'));
    raise exception 'A2: a divergent verdict on a sealed ticket must be rejected';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.inactive());
    raise exception 'A2: an inactive verdict on a sealed active ticket must be rejected';
  exception when invalid_parameter_value then null;
  end;
  if w07a.is_premium(dst) then
    raise exception 'A2: destination must not gain premium through replay';
  end if;
end $$;
reset role;
do $$
declare acts text[];
begin
  select array_agg(a.action order by a.id) into acts from api_private.billing_transfer_audit a
    join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07a-a2';
  if acts <> array['enqueued', 'destination_verified', 'destination_withheld'] then
    raise exception 'A2: replay must not append audit rows (got %)', acts;
  end if;
end $$;

\echo W07-03 attack A2: passed
-- ----------------------------------------------------------------------------
-- A3 (process death between steps): the isolate dies after the source loss is
-- persisted and before the destination is verified; the lease simply lapses
-- (no release). Redelivery must take the event over, reuse the queued transfer
-- (no duplicate transfer/sides/enqueue audit), verify the destination on a
-- fresh ticket and complete.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000005';
  dst uuid := '0000000a-7000-4000-8000-000000000006';
  ev text := 'w07a-a3';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r jsonb;
begin
  r := public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.inactive());
  if (r->>'applied')::boolean is distinct from true then
    raise exception 'A3: source loss must apply (got %)', r;
  end if;
  -- crash here: nothing else happens on this delivery.
  r := public.claim_billing_webhook_delivery(ev, payload);
  if r->>'outcome' <> 'in_progress' then
    raise exception 'A3: a live lease must still shield the event (got %)', r;
  end if;
end $$;
reset role;
update api_private.billing_webhook_claims set lease_expires_at = clock_timestamp() - interval '1 second' where event_id = 'w07a-a3';
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000005';
  dst uuid := '0000000a-7000-4000-8000-000000000006';
  ev text := 'w07a-a3';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid;
  issued jsonb;
  r jsonb;
begin
  r := public.claim_billing_webhook_delivery(ev, payload);
  if r->>'outcome' <> 'claimed' then
    raise exception 'A3: redelivery after a lapsed lease must be claimed (got %)', r;
  end if;
  lease := (r->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r := public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.inactive());
  if r->>'outcome' <> 'persisted' or (r->>'withheld')::boolean is distinct from false or w07a.is_premium(src) then
    raise exception 'A3: re-verifying the already-lost source keeps it lost (got %)', r;
  end if;
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'applied')::boolean is distinct from true or not w07a.is_premium(dst) then
    raise exception 'A3: destination must apply once the source is confirmed (got %)', r;
  end if;
  r := public.complete_billing_webhook(ev, payload,
    jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A3: redelivered transfer must complete (got %)', r;
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'A3: confirmed transfer must leave recovery';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from api_private.billing_transfers where event_id = 'w07a-a3') <> 1
     or (select count(*) from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id where t.event_id = 'w07a-a3') <> 2
     or (select count(*) from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07a-a3' and a.action = 'enqueued') <> 1
     or (select state from api_private.billing_transfers where event_id = 'w07a-a3') <> 'confirmed' then
    raise exception 'A3: redelivery duplicated or failed to settle the queued transfer';
  end if;
end $$;

\echo W07-03 attack A3: passed
-- ----------------------------------------------------------------------------
-- A4 (crash after a withheld destination; stale-lease replay): the isolate
-- persisted the withheld destination, complete raised 55000, then died without
-- releasing. Old-lease calls must be refused after takeover, and the barrier
-- must hold across the redelivery until the source is confirmed.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000007';
  dst uuid := '0000000a-7000-4000-8000-000000000008';
  ev text := 'w07a-a4';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r jsonb;
begin
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'withheld')::boolean is distinct from true or w07a.is_premium(dst) then
    raise exception 'A4: destination must be withheld (got %)', r;
  end if;
  begin
    perform public.complete_billing_webhook(ev, payload,
      jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
    raise exception 'A4: withheld transfer must not complete';
  exception when object_not_in_prerequisite_state then null;
  end;
  create temp table w07a_a4 as select lease as old_lease, issued as old_issued;
end $$;
reset role;
update api_private.billing_webhook_claims set lease_expires_at = clock_timestamp() - interval '1 second' where event_id = 'w07a-a4';
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000007';
  dst uuid := '0000000a-7000-4000-8000-000000000008';
  ev text := 'w07a-a4';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  old_lease uuid := (select old_lease from w07a_a4);
  old_issued jsonb := (select old_issued from w07a_a4);
  lease uuid;
  issued jsonb;
  r jsonb;
begin
  r := public.claim_billing_webhook_delivery(ev, payload);
  if r->>'outcome' <> 'claimed' then
    raise exception 'A4: takeover expected (got %)', r;
  end if;
  lease := (r->>'lease_token')::uuid;
  -- the dead isolate wakes up and keeps going with its old lease
  begin
    perform public.begin_billing_verification(array[src, dst], ev, payload, old_lease);
    raise exception 'A4: a lapsed lease must not admit verification';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.enqueue_billing_transfer(ev, payload, old_lease);
    raise exception 'A4: a lapsed lease must not requeue';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.persist_billing_verdict(src, w07a.ticket_for(old_issued, src), w07a.inactive());
    raise exception 'A4: a ticket issued under a lapsed lease must not persist';
  exception when object_not_in_prerequisite_state then null;
  end;
  if w07a.is_premium(dst) then
    raise exception 'A4: destination must still be barred after takeover';
  end if;
  issued := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  -- Redelivery verifies the destination first again (RC order is not ours).
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'withheld')::boolean is distinct from true or w07a.is_premium(dst) then
    raise exception 'A4: destination must stay withheld on redelivery (got %)', r;
  end if;
  r := public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.inactive());
  if not w07a.is_premium(dst) or w07a.is_premium(src) then
    raise exception 'A4: source loss must release the destination on redelivery (got %)', r;
  end if;
  r := public.complete_billing_webhook(ev, payload,
    jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A4: redelivery must complete (got %)', r;
  end if;
end $$;
reset role;

\echo W07-03 attack A4: passed
-- ----------------------------------------------------------------------------
-- A5 (identity boundaries): duplicates, case, both-sides, malformed entries,
-- exactly 16 parties admitted, 17 refused (22023) at begin and at enqueue.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000009';
  dst uuid := '0000000a-7000-4000-8000-00000000000a';
  dual uuid := '0000000a-7000-4000-8000-00000000000b';
  ev text := 'w07a-a5-fold';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', ev, 'type', 'TRANSFER', 'app_user_id', '$RCAnonymousID:x',
    'transferred_from', jsonb_build_array(src::text, upper(src::text), dual::text, 'not-a-uuid', 42, null, '{' || src::text || '}'),
    'transferred_to', jsonb_build_array(dst::text, dst::text, upper(dual::text), '', jsonb_build_object('id', dst::text))));
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  q jsonb;
  many uuid[];
  many_payload jsonb;
  many_lease uuid;
  i integer;
begin
  q := public.enqueue_billing_transfer(ev, payload, lease);
  if q->>'outcome' <> 'queued' or jsonb_array_length(q->'sources') <> 1 or jsonb_array_length(q->'destinations') <> 1
     or q->'sources'->0->>'user_id' <> src::text or q->'destinations'->0->>'user_id' <> dst::text then
    raise exception 'A5: parties must fold to one source and one destination, both-sides id dropped (got %)', q;
  end if;
  -- empty after folding: every id on both sides -> nothing queued, delivery not poisoned
  q := public.enqueue_billing_transfer('w07a-a5-empty',
    w07a.transfer_payload('w07a-a5-empty', array[dual], array[dual]),
    (public.claim_billing_webhook_delivery('w07a-a5-empty', w07a.transfer_payload('w07a-a5-empty', array[dual], array[dual]))->>'lease_token')::uuid);
  if q->>'outcome' <> 'no_subjects' then
    raise exception 'A5: a transfer with no parties after folding queues nothing (got %)', q;
  end if;
  -- non-array party fields: no sides at all
  q := public.enqueue_billing_transfer('w07a-a5-str',
    jsonb_build_object('event', jsonb_build_object('id', 'w07a-a5-str', 'type', 'TRANSFER', 'transferred_from', src::text, 'transferred_to', dst::text)),
    (public.claim_billing_webhook_delivery('w07a-a5-str', jsonb_build_object('event', jsonb_build_object('id', 'w07a-a5-str', 'type', 'TRANSFER', 'transferred_from', src::text, 'transferred_to', dst::text)))->>'lease_token')::uuid);
  if q->>'outcome' <> 'no_subjects' then
    raise exception 'A5: string-typed party fields carry no parties (got %)', q;
  end if;
  -- exactly 16 parties admitted
  many := '{}';
  for i in 48..62 loop
    many := array_append(many, ('0000000a-7000-4000-8000-0000000000' || lpad(to_hex(i), 2, '0'))::uuid);
  end loop;
  many_payload := w07a.transfer_payload('w07a-a5-16', many, array['0000000a-7000-4000-8000-00000000003f'::uuid]);
  many_lease := (public.claim_billing_webhook_delivery('w07a-a5-16', many_payload)->>'lease_token')::uuid;
  q := public.enqueue_billing_transfer('w07a-a5-16', many_payload, many_lease);
  if jsonb_array_length(q->'sources') <> 15 or jsonb_array_length(q->'destinations') <> 1 then
    raise exception 'A5: sixteen parties must be admitted (got %)', q;
  end if;
  -- 17 parties refused at admission and at enqueue
  many := array_append(many, '0000000a-7000-4000-8000-000000000040'::uuid);
  many_payload := w07a.transfer_payload('w07a-a5-17', many, array['0000000a-7000-4000-8000-00000000003f'::uuid]);
  begin
    perform public.claim_billing_webhook_delivery('w07a-a5-17', many_payload);
    raise exception 'A5: seventeen parties must be refused at claim';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_billing_transfer('w07a-a5-17', many_payload, gen_random_uuid());
    raise exception 'A5: seventeen parties must be refused at enqueue';
  exception when invalid_parameter_value then null;
  end;
  -- event binding: id mismatch, wrong type, non-object payload
  begin
    perform public.enqueue_billing_transfer('w07a-a5-other', payload, lease);
    raise exception 'A5: payload bound to another event id must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_billing_transfer(ev, jsonb_set(payload, '{event,type}', '"INITIAL_PURCHASE"'), lease);
    raise exception 'A5: a non-TRANSFER event must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_billing_transfer(ev, '[]'::jsonb, lease);
    raise exception 'A5: a non-object payload must be refused';
  exception when invalid_parameter_value then null;
  end;
end $$;
reset role;
do $$
begin
  if (select count(*) from api_private.billing_transfers where event_id like 'w07a-a5-%') <> 2 then
    raise exception 'A5: only the folded and the 16-party transfers may be queued';
  end if;
  if (select count(*) from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id where t.event_id = 'w07a-a5-16') <> 16 then
    raise exception 'A5: sixteen sides expected';
  end if;
end $$;

\echo W07-03 attack A5: passed
-- ----------------------------------------------------------------------------
-- A6 (clock boundaries): a source the provider still reports premium but with
-- an already-passed expiresAt is not entitled and must release the destination;
-- 'infinity'/NaN-like timestamps are refused; a far-future destination expiry
-- applies. A held source whose entitlement expires by wall clock stops holding
-- the transfer on the next reconciliation.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-00000000000c';
  dst uuid := '0000000a-7000-4000-8000-00000000000d';
  ev text := 'w07a-a6';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r jsonb;
begin
  begin
    perform public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.active() || '{"expiresAt":"infinity"}'::jsonb);
    raise exception 'A6: an infinite expiry must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.active() || '{"expiresAt":"not-a-date"}'::jsonb);
    raise exception 'A6: a malformed expiry must be refused';
  exception when invalid_parameter_value or invalid_datetime_format then null;
  end;
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active('9999-12-31T00:00:00Z'::timestamptz));
  if (r->>'withheld')::boolean is distinct from true or w07a.is_premium(dst) then
    raise exception 'A6: destination barred before source confirmation (got %)', r;
  end if;
  -- provider says premium=true but the entitlement expired an hour ago
  r := public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.active(clock_timestamp() - interval '1 hour'));
  if w07a.is_premium(src) then
    raise exception 'A6: an expired source verdict must not be premium';
  end if;
  if not w07a.is_premium(dst) then
    raise exception 'A6: an expired source is a lost source; the destination must be released (got %)', r;
  end if;
  if (select expires_at from public.billing_entitlements where user_id = dst) <> '9999-12-31T00:00:00Z'::timestamptz then
    raise exception 'A6: the destination must mirror its own verdict expiry';
  end if;
  r := public.complete_billing_webhook(ev, payload,
    jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A6: must complete (got %)', r;
  end if;
end $$;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-00000000000e';
  dst uuid := '0000000a-7000-4000-8000-00000000000f';
  ev text := 'w07a-a6-held';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  sync jsonb;
  r jsonb;
begin
  -- source still entitled for ~1.2 s: transfer parks as held
  r := public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.active(clock_timestamp() + interval '1200 milliseconds'));
  r := public.billing_transfer_recovery(src);
  if r->0->>'state' <> 'held' then
    raise exception 'A6: an entitled source must park the transfer as held (got %)', r;
  end if;
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'applied')::boolean is distinct from true or not w07a.is_premium(dst) then
    raise exception 'A6: a held transfer must not withhold the destination''s own confirmed verdict (got %)', r;
  end if;
  r := public.complete_billing_webhook(ev, payload,
    jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A6: a held transfer with both sides mirrored must complete (got %)', r;
  end if;
  perform pg_sleep(1.4);
  -- the destination syncs after the source entitlement lapsed by wall clock
  sync := public.begin_billing_verification(array[dst]);
  r := public.persist_billing_verdict(dst, w07a.ticket_for(sync, dst), w07a.active());
  if (r->>'applied')::boolean is distinct from true or not w07a.is_premium(dst) then
    raise exception 'A6: destination sync must keep applying (got %)', r;
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(src)) <> 0 or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'A6: once the held source''s entitlement lapsed the transfer must confirm (got %)', public.billing_transfer_recovery(src);
  end if;
end $$;
reset role;
do $$
begin
  if (select state from api_private.billing_transfers where event_id = 'w07a-a6-held') <> 'confirmed' then
    raise exception 'A6: held transfer must be confirmed after the source entitlement lapsed';
  end if;
end $$;

\echo W07-03 attack A6: passed
-- ----------------------------------------------------------------------------
-- A7 (unauthorised roles on the new surfaces, denied paths): anon,
-- authenticated and service_role against private tables/helpers/sequence;
-- clients against the public transfer RPCs; service_role allowed path is A1.
-- ----------------------------------------------------------------------------
do $$
declare
  r text;
  stmt text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    foreach stmt in array array[
      'select count(*) from api_private.billing_transfers',
      'select count(*) from api_private.billing_transfer_sides',
      'select count(*) from api_private.billing_transfer_audit',
      'insert into api_private.billing_transfer_audit (transfer_id, event_id, action) values (gen_random_uuid(), ''x'', ''enqueued'')',
      'update api_private.billing_transfers set state = ''confirmed'', settled_at = now()',
      'delete from api_private.billing_transfer_sides',
      'select nextval(''api_private.billing_transfer_audit_id_seq'')',
      'select api_private.billing_destination_blocker(''0000000a-7000-4000-8000-000000000002'')',
      'select api_private.settle_billing_transfer(gen_random_uuid())',
      'select api_private.reconcile_billing_destination(''0000000a-7000-4000-8000-000000000002'')',
      'select api_private.reconcile_billing_transfer_sources(gen_random_uuid())',
      'select api_private.lock_billing_transfers(''0000000a-7000-4000-8000-000000000002'')',
      'select api_private.billing_transfer_party_ids(''{}''::jsonb, ''transferred_from'')',
      'select api_private.billing_verdict_active(''{"premium":true}''::jsonb, now())'
    ] loop
      begin
        execute format('set local role %I', r);
        execute stmt;
        reset role;
        raise exception 'A7: % must not run: %', r, stmt;
      exception when insufficient_privilege then reset role;
      end;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    foreach stmt in array array[
      'select public.enqueue_billing_transfer(''w07a-a1'', ''{}''::jsonb, gen_random_uuid())',
      'select public.billing_transfer_recovery(''0000000a-7000-4000-8000-000000000002'')',
      'select public.begin_billing_verification(array[''0000000a-7000-4000-8000-000000000002''::uuid])',
      'select public.persist_billing_verdict(''0000000a-7000-4000-8000-000000000002'', gen_random_uuid(), ''{}''::jsonb)'
    ] loop
      begin
        execute format('set local role %I', r);
        execute stmt;
        reset role;
        raise exception 'A7: % must not run: %', r, stmt;
      exception when insufficient_privilege then reset role;
      end;
    end loop;
  end loop;
end $$;
-- a signed-in user impersonating the destination via RLS gets nothing
set local role authenticated;
set local request.jwt.claim.sub = '0000000a-7000-4000-8000-000000000002';
do $$
begin
  begin
    perform 1 from api_private.billing_transfers;
    raise exception 'A7: the destination user must not read the queue through RLS';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
reset request.jwt.claim.sub;

\echo W07-03 attack A7: passed
-- ----------------------------------------------------------------------------
-- A8 (corrupt / partial persisted state): the webhook bookkeeping (claim row,
-- webhook_events row) is swept while the transfer is still pending; a
-- destination side keeps a ticket id whose ticket row is gone. Redelivery must
-- still reconcile the SAME transfer and recovery must still read it.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000010';
  dst uuid := '0000000a-7000-4000-8000-000000000011';
  ev text := 'w07a-a8';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r jsonb;
begin
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'withheld')::boolean is distinct from true then
    raise exception 'A8: destination withheld expected (got %)', r;
  end if;
end $$;
reset role;
delete from api_private.billing_webhook_claims where event_id = 'w07a-a8';
delete from public.webhook_events where id = 'w07a-a8';
delete from api_private.billing_verification_tickets where user_id in ('0000000a-7000-4000-8000-000000000010', '0000000a-7000-4000-8000-000000000011');
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000010';
  dst uuid := '0000000a-7000-4000-8000-000000000011';
  ev text := 'w07a-a8';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid;
  issued jsonb;
  r jsonb;
begin
  r := public.billing_transfer_recovery(dst);
  if jsonb_array_length(r) <> 1 or r->0->>'state' <> 'pending' or (r->0->'destinations'->0->>'verified')::boolean is distinct from true then
    raise exception 'A8: recovery must still expose the pending transfer with its recorded destination verdict (got %)', r;
  end if;
  if w07a.is_premium(dst) then
    raise exception 'A8: swept bookkeeping must not release the destination';
  end if;
  -- destination syncs on its own while the bookkeeping is gone: still barred
  issued := public.begin_billing_verification(array[dst]);
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'withheld')::boolean is distinct from true or w07a.is_premium(dst) then
    raise exception 'A8: destination sync must stay barred (got %)', r;
  end if;
  r := public.claim_billing_webhook_delivery(ev, payload);
  if r->>'outcome' <> 'claimed' then
    raise exception 'A8: redelivery after sweep must be claimed (got %)', r;
  end if;
  lease := (r->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r := public.persist_billing_verdict(src, w07a.ticket_for(issued, src), w07a.inactive());
  if not w07a.is_premium(dst) then
    raise exception 'A8: source confirmation must release the destination on the same transfer (got %)', r;
  end if;
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'applied')::boolean is distinct from true or not w07a.is_premium(dst) then
    raise exception 'A8: the redelivered destination verdict applies (got %)', r;
  end if;
  r := public.complete_billing_webhook(ev, payload,
    jsonb_build_object(src::text, w07a.ticket_for(issued, src), dst::text, w07a.ticket_for(issued, dst)), lease);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A8: must complete (got %)', r;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from api_private.billing_transfers where event_id = 'w07a-a8') <> 1
     or (select state from api_private.billing_transfers where event_id = 'w07a-a8') <> 'confirmed' then
    raise exception 'A8: exactly one confirmed transfer expected after redelivery';
  end if;
end $$;

\echo W07-03 attack A8: passed
-- ----------------------------------------------------------------------------
-- A9 (interleaved account switch A->B->C, both delivery orders): only the
-- account the provider confirms active ends premium; both transfers confirm.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  a uuid := '0000000a-7000-4000-8000-000000000012';
  b uuid := '0000000a-7000-4000-8000-000000000013';
  c uuid := '0000000a-7000-4000-8000-000000000014';
  ev1 text := 'w07a-a9-ab';
  ev2 text := 'w07a-a9-bc';
  p1 jsonb := w07a.transfer_payload(ev1, array[a], array[b]);
  p2 jsonb := w07a.transfer_payload(ev2, array[b], array[c]);
  l1 uuid := (public.claim_billing_webhook_delivery(ev1, p1)->>'lease_token')::uuid;
  l2 uuid := (public.claim_billing_webhook_delivery(ev2, p2)->>'lease_token')::uuid;
  i1 jsonb;
  i2 jsonb;
  r jsonb;
begin
  -- both deliveries admitted before either is verified
  i1 := public.begin_billing_verification(array[a, b], ev1, p1, l1);
  i2 := public.begin_billing_verification(array[b, c], ev2, p2, l2);
  -- second hop verified first; the provider says B lost (moved on) and C has it
  r := public.persist_billing_verdict(c, w07a.ticket_for(i2, c), w07a.active());
  if (r->>'withheld')::boolean is distinct from true or w07a.is_premium(c) then
    raise exception 'A9: C barred until B is confirmed (got %)', r;
  end if;
  r := public.persist_billing_verdict(b, w07a.ticket_for(i2, b), w07a.inactive());
  if (r->>'applied')::boolean is distinct from true or w07a.is_premium(b) or not w07a.is_premium(c) then
    raise exception 'A9: B''s loss applies (as source of T2 and as inactive destination of T1) and releases C (got %)', r;
  end if;
  r := public.complete_billing_webhook(ev2, p2, jsonb_build_object(b::text, w07a.ticket_for(i2, b), c::text, w07a.ticket_for(i2, c)), l2);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A9: T2 must complete (got %)', r;
  end if;
  -- first hop: A lost, B (already inactive on the older T1 ticket) replays inactive
  r := public.persist_billing_verdict(b, w07a.ticket_for(i1, b), w07a.inactive());
  r := public.persist_billing_verdict(a, w07a.ticket_for(i1, a), w07a.inactive());
  if w07a.is_premium(a) or w07a.is_premium(b) or not w07a.is_premium(c) then
    raise exception 'A9: only C may be premium';
  end if;
  r := public.complete_billing_webhook(ev1, p1, jsonb_build_object(a::text, w07a.ticket_for(i1, a), b::text, w07a.ticket_for(i1, b)), l1);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A9: T1 must complete (got %)', r;
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(a)) + jsonb_array_length(public.billing_transfer_recovery(b))
     + jsonb_array_length(public.billing_transfer_recovery(c)) <> 0 then
    raise exception 'A9: both hops must be confirmed';
  end if;
end $$;
reset role;

\echo W07-03 attack A9: passed
-- ----------------------------------------------------------------------------
-- A10 (replay with permuted identity order): the same event redelivered with
-- the parties in a different array order is a different payload; it must be
-- refused as conflicting and must not duplicate or re-scope the queued
-- transfer.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  s1 uuid := '0000000a-7000-4000-8000-000000000015';
  s2 uuid := '0000000a-7000-4000-8000-000000000016';
  dst uuid := '0000000a-7000-4000-8000-000000000017';
  ev text := 'w07a-a10';
  payload jsonb := w07a.transfer_payload(ev, array[s1, s2], array[dst]);
  permuted jsonb := w07a.transfer_payload(ev, array[s2, s1], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  q jsonb := public.enqueue_billing_transfer(ev, payload, lease);
  r jsonb;
begin
  begin
    perform public.claim_billing_webhook_delivery(ev, permuted);
    raise exception 'A10: a permuted payload for the same event must be refused at claim';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_billing_transfer(ev, permuted, lease);
    raise exception 'A10: a permuted payload must not re-scope the queued transfer';
  exception when invalid_parameter_value then null;
  end;
  r := public.enqueue_billing_transfer(ev, payload, lease);
  if (r->>'transfer_id')::uuid <> (q->>'transfer_id')::uuid then
    raise exception 'A10: the original payload must still map to the same transfer';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from api_private.billing_transfers where event_id = 'w07a-a10') <> 1 then
    raise exception 'A10: exactly one transfer for the event';
  end if;
end $$;

\echo W07-03 attack A10: passed
-- ----------------------------------------------------------------------------
-- A11 (two sources, split verdicts; source deleted while held): S1 lost, S2
-- still entitled -> held, destination applies its own verdict; S2 later deleted
-- from Auth -> the transfer confirms on the next reconciliation.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  s1 uuid := '0000000a-7000-4000-8000-000000000018';
  s2 uuid := '0000000a-7000-4000-8000-000000000019';
  dst uuid := '0000000a-7000-4000-8000-00000000001a';
  ev text := 'w07a-a11';
  payload jsonb := w07a.transfer_payload(ev, array[s1, s2], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[s1, s2, dst], ev, payload, lease);
  r jsonb;
begin
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  r := public.persist_billing_verdict(s1, w07a.ticket_for(issued, s1), w07a.inactive());
  if w07a.is_premium(dst) then
    raise exception 'A11: one confirmed source of two must not release the destination';
  end if;
  r := public.persist_billing_verdict(s2, w07a.ticket_for(issued, s2), w07a.active());
  if not w07a.is_premium(s2) or not w07a.is_premium(dst) then
    raise exception 'A11: once every source is confirmed the destination mirrors its own verdict (got %)', r;
  end if;
  r := public.billing_transfer_recovery(dst);
  if r->0->>'state' <> 'held' then
    raise exception 'A11: an entitled source parks the transfer as held (got %)', r;
  end if;
end $$;
reset role;
delete from auth.users where id = '0000000a-7000-4000-8000-000000000019';
set local role service_role;
do $$
declare
  dst uuid := '0000000a-7000-4000-8000-00000000001a';
  sync jsonb := public.begin_billing_verification(array[dst]);
  r jsonb;
begin
  r := public.persist_billing_verdict(dst, w07a.ticket_for(sync, dst), w07a.active());
  if (r->>'applied')::boolean is distinct from true or not w07a.is_premium(dst) then
    raise exception 'A11: destination sync must apply (got %)', r;
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'A11: a held transfer whose entitled source vanished from Auth must confirm (got %)', public.billing_transfer_recovery(dst);
  end if;
end $$;
reset role;

\echo W07-03 attack A11: passed
-- ----------------------------------------------------------------------------
-- A12 (double submit of admission): the same delivery admitted twice under the
-- same lease (edge retry after a timed-out RPC) issues fresh tickets but never
-- a second transfer, side or 'enqueued' audit row; verdicts on the first
-- tickets still settle the transfer.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-00000000001b';
  dst uuid := '0000000a-7000-4000-8000-00000000001c';
  ev text := 'w07a-a12';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  i1 jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  i2 jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  r jsonb;
begin
  if w07a.ticket_for(i1, src) = w07a.ticket_for(i2, src) then
    raise exception 'A12: a second admission issues fresh tickets';
  end if;
  r := public.persist_billing_verdict(dst, w07a.ticket_for(i1, dst), w07a.active());
  r := public.persist_billing_verdict(src, w07a.ticket_for(i1, src), w07a.inactive());
  if not w07a.is_premium(dst) then
    raise exception 'A12: first-admission tickets must settle the transfer';
  end if;
  r := public.complete_billing_webhook(ev, payload, jsonb_build_object(src::text, w07a.ticket_for(i1, src), dst::text, w07a.ticket_for(i1, dst)), lease);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A12: must complete (got %)', r;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from api_private.billing_transfers where event_id = 'w07a-a12') <> 1
     or (select count(*) from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id where t.event_id = 'w07a-a12') <> 2
     or (select count(*) from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07a-a12' and action = 'enqueued') <> 1 then
    raise exception 'A12: double admission must not duplicate the queue';
  end if;
end $$;

\echo W07-03 attack A12: passed
-- ----------------------------------------------------------------------------
-- A14 (destination vanishes while withheld; cross-account isolation): the
-- withheld destination is deleted from Auth before the source confirms -> no
-- entitlement row is fabricated for it, the transfer still confirms; an
-- unrelated user's sync is never withheld or touched by the queue.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-00000000001d';
  dst uuid := '0000000a-7000-4000-8000-00000000001e';
  other uuid := '0000000a-7000-4000-8000-00000000001f';
  ev text := 'w07a-a14';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  sync jsonb := public.begin_billing_verification(array[other]);
  r jsonb;
begin
  r := public.persist_billing_verdict(dst, w07a.ticket_for(issued, dst), w07a.active());
  if (r->>'withheld')::boolean is distinct from true then
    raise exception 'A14: destination is withheld (got %)', r;
  end if;
  r := public.persist_billing_verdict(other, w07a.ticket_for(sync, other), w07a.active());
  if (r->>'applied')::boolean is distinct from true or (r->>'withheld')::boolean is distinct from false or not w07a.is_premium(other) then
    raise exception 'A14: an unrelated user is never withheld (got %)', r;
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(other)) <> 0 then
    raise exception 'A14: an unrelated user has no recoverable transfers';
  end if;
  create temp table w07a_a14 as select w07a.ticket_for(issued, src) as src_ticket;
end $$;
reset role;
delete from auth.users where id = '0000000a-7000-4000-8000-00000000001e';
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-00000000001d';
  dst uuid := '0000000a-7000-4000-8000-00000000001e';
  r jsonb;
  ticket uuid := (select src_ticket from w07a_a14);
begin
  r := public.persist_billing_verdict(src, ticket, w07a.inactive());
  if w07a.is_premium(src) then
    raise exception 'A14: source loses (got %)', r;
  end if;
  if exists (select 1 from public.billing_entitlements where user_id = dst) then
    raise exception 'A14: no entitlement row may be fabricated for a destination absent from Auth';
  end if;
  r := public.persist_billing_verdict(dst, ticket, w07a.active());
  if r->>'outcome' <> 'user_missing' then
    raise exception 'A14: verdicts for a missing user report user_missing (got %)', r;
  end if;
end $$;
reset role;
do $$
begin
  if (select state from api_private.billing_transfers where event_id = 'w07a-a14') <> 'confirmed'
     or (select s.user_missing_at from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id
         where t.event_id = 'w07a-a14' and s.user_id = '0000000a-7000-4000-8000-00000000001e') is null then
    raise exception 'A14: a transfer whose destination vanished confirms with the side marked missing';
  end if;
end $$;

\echo W07-03 attack A14: passed
-- ----------------------------------------------------------------------------
-- A15 (stale verdict resurrection via out-of-order tickets): a newer inactive
-- sync supersedes the destination's withheld active verdict; the older
-- TRANSFER ticket persisted afterwards must neither raise nor regress the
-- side, and the source's confirmation must apply the NEWEST verdict (not
-- premium), never resurrecting the stale active one.
-- ----------------------------------------------------------------------------
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000020';
  dst uuid := '0000000a-7000-4000-8000-000000000021';
  ev text := 'w07a-a15';
  payload jsonb := w07a.transfer_payload(ev, array[src], array[dst]);
  lease uuid := (public.claim_billing_webhook_delivery(ev, payload)->>'lease_token')::uuid;
  issued jsonb := public.begin_billing_verification(array[src, dst], ev, payload, lease);
  sync jsonb := public.begin_billing_verification(array[dst]);
  r jsonb;
begin
  create temp table w07a_a15 as
    select w07a.ticket_for(issued, src) as src_ticket, w07a.ticket_for(issued, dst) as dst_ticket, w07a.ticket_for(sync, dst) as sync_ticket;
  -- newest ticket first: inactive, applies directly
  r := public.persist_billing_verdict(dst, w07a.ticket_for(sync, dst), w07a.inactive());
  if (r->>'applied')::boolean is distinct from true or (r->>'withheld')::boolean is distinct from false then
    raise exception 'A15: an inactive verdict is never withheld (got %)', r;
  end if;
end $$;
reset role;
create temp table w07a_a15_side as
  select s.verification_order from api_private.billing_transfer_sides s
  join api_private.billing_transfers t on t.id = s.transfer_id
  where t.event_id = 'w07a-a15' and s.user_id = '0000000a-7000-4000-8000-000000000021';
grant select on w07a_a15_side to service_role;
set local role service_role;
do $$
declare
  dst uuid := '0000000a-7000-4000-8000-000000000021';
  r jsonb;
begin
  -- older TRANSFER ticket afterwards: active, must not regress the side or apply
  r := public.persist_billing_verdict(dst, (select dst_ticket from w07a_a15), w07a.active());
  if (r->>'applied')::boolean is distinct from false or w07a.is_premium(dst) then
    raise exception 'A15: an older active verdict must not outrank the newer inactive one (got %)', r;
  end if;
end $$;
reset role;
do $$
begin
  if (select s.verification_order from api_private.billing_transfer_sides s
      join api_private.billing_transfers t on t.id = s.transfer_id
      where t.event_id = 'w07a-a15' and s.user_id = '0000000a-7000-4000-8000-000000000021')
     <> (select verification_order from w07a_a15_side) then
    raise exception 'A15: an older ticket must not rewrite the side';
  end if;
end $$;
set local role service_role;
do $$
declare
  src uuid := '0000000a-7000-4000-8000-000000000020';
  dst uuid := '0000000a-7000-4000-8000-000000000021';
  r jsonb;
begin
  r := public.persist_billing_verdict(src, (select src_ticket from w07a_a15), w07a.inactive());
  if w07a.is_premium(dst) or w07a.is_premium(src) then
    raise exception 'A15: settling must not resurrect the stale active destination verdict';
  end if;
  if (select verification_order from public.billing_entitlements where user_id = dst) <> (select verification_order from w07a_a15_side) then
    raise exception 'A15: the entitlement row keeps the newest verification order';
  end if;
end $$;
reset role;
do $$
begin
  if (select state from api_private.billing_transfers where event_id = 'w07a-a15') <> 'confirmed' then
    raise exception 'A15: transfer confirms with the newest destination verdict applied';
  end if;
end $$;

\echo W07-03 attack A15: passed
\echo W07-03 ATTACK MATRIX (A1-A12, A14-A15): ALL CASES PASSED
rollback;

-- ----------------------------------------------------------------------------
-- A13 (concurrency, autocommitted): simultaneous source and destination
-- persistence for the same transfer in both serialisation orders; two
-- destinations racing after the source is confirmed; a second transfer being
-- enqueued for the destination while the first source is being confirmed.
-- Assertions: no deadlock/error, one entitlement row per user, transfer state
-- consistent with the sides, no destination premium while any unconfirmed,
-- present source exists.
-- ----------------------------------------------------------------------------
create schema w07a_probe;
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'dblink') then
    create extension dblink with schema w07a_probe;
  else
    execute format('grant usage on schema %I to public', (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'dblink'));
  end if;
end $$;
do $$ begin
  perform set_config('search_path', 'public, w07a_probe, ' || (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'dblink'), false);
end $$;

create function w07a_probe.await_lock(p_application text)
returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then
      return;
    end if;
    if clock_timestamp() > deadline then
      raise exception 'A13: the second connection never blocked on a database lock';
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;
create function w07a_probe.collect(p_connection text)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  select value into r from dblink_get_result(p_connection, true) as result(value jsonb);
  perform 1 from dblink_get_result(p_connection, false) as result(value jsonb);
  return r;
end $$;
create function w07a_probe.q(p_connection text, p_sql text)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  select value into r from dblink(p_connection, p_sql) as result(value jsonb);
  return r;
end $$;

insert into auth.users (id, email, raw_app_meta_data)
select id, format('w07a-%s@example.test', id), '{"provider":"apple"}'::jsonb
from unnest(array[
  '0000000a-7000-4000-8000-0000000000c1', '0000000a-7000-4000-8000-0000000000c2',
  '0000000a-7000-4000-8000-0000000000c3', '0000000a-7000-4000-8000-0000000000c4',
  '0000000a-7000-4000-8000-0000000000c5', '0000000a-7000-4000-8000-0000000000c6',
  '0000000a-7000-4000-8000-0000000000c7', '0000000a-7000-4000-8000-0000000000c8',
  '0000000a-7000-4000-8000-0000000000c9', '0000000a-7000-4000-8000-0000000000ca'
]::uuid[]) as u(id);

do $$
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  c text;
  active jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  src uuid;
  dst uuid;
  d2 uuid;
  s2 uuid;
  ev text;
  ev2 text;
  payload jsonb;
  p2 jsonb;
  lease uuid;
  l2 uuid;
  issued jsonb;
  i2 jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  d2_ticket uuid;
  first jsonb;
  second jsonb;
  r jsonb;
  src_first boolean;
  scenarios integer := 0;
begin
  foreach c in array array['w07a_setup', 'w07a_first', 'w07a_second'] loop
    perform dblink_connect(c, connection || ' application_name=' || c);
    perform dblink_exec(c, 'set statement_timeout = ''5s''');
  end loop;
  perform dblink_exec('w07a_setup', 'set role service_role');

  -- (a)/(b): source vs destination of the same transfer, both orders.
  foreach src_first in array array[true, false] loop
    src := case when src_first then '0000000a-7000-4000-8000-0000000000c1' else '0000000a-7000-4000-8000-0000000000c3' end;
    dst := case when src_first then '0000000a-7000-4000-8000-0000000000c2' else '0000000a-7000-4000-8000-0000000000c4' end;
    ev := 'w07a-a13-' || case when src_first then 'sd' else 'ds' end;
    payload := jsonb_build_object('event', jsonb_build_object('id', ev, 'type', 'TRANSFER', 'app_user_id', '$RCAnonymousID:w07a',
      'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text)));
    lease := (w07a_probe.q('w07a_setup', format('select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', ev, payload))->>'lease_token')::uuid;
    issued := w07a_probe.q('w07a_setup', format('select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[src, dst]::text, ev, payload, lease));
    select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
    select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
    perform dblink_exec('w07a_first', 'begin; set local role service_role');
    first := w07a_probe.q('w07a_first', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)',
      case when src_first then src else dst end, case when src_first then src_ticket else dst_ticket end, case when src_first then inactive else active end));
    perform dblink_exec('w07a_second', 'begin; set local role service_role');
    perform dblink_send_query('w07a_second', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)',
      case when src_first then dst else src end, case when src_first then dst_ticket else src_ticket end, case when src_first then active else inactive end));
    perform w07a_probe.await_lock('w07a_second');
    perform dblink_exec('w07a_first', 'commit');
    second := w07a_probe.collect('w07a_second');
    perform dblink_exec('w07a_second', 'commit');
    if src_first then
      if (first->>'applied')::boolean is distinct from true or (second->>'applied')::boolean is distinct from true or (second->>'withheld')::boolean is distinct from false then
        raise exception 'A13(a): source first, destination after commit must apply (% / %)', first, second;
      end if;
    else
      if (first->>'withheld')::boolean is distinct from true or (second->>'applied')::boolean is distinct from true then
        raise exception 'A13(b): destination first is withheld, source loss then releases it (% / %)', first, second;
      end if;
    end if;
    if not (select premium from public.billing_entitlements where user_id = dst)
       or (select premium from public.billing_entitlements where user_id = src)
       or (select state from api_private.billing_transfers where event_id = ev) <> 'confirmed' then
      raise exception 'A13: after both verdicts the destination is premium, the source is not, the transfer is confirmed (%)', ev;
    end if;
    r := w07a_probe.q('w07a_setup', format('select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb,%L::uuid)', ev, payload,
      jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease));
    if (r->>'verified')::boolean is distinct from true then
      raise exception 'A13: webhook must complete after the race (%)', r;
    end if;
    scenarios := scenarios + 1;
  end loop;

  -- (c): two destinations race after the source is confirmed lost; each applies
  -- exactly once and the transfer confirms once.
  src := '0000000a-7000-4000-8000-0000000000c5'; dst := '0000000a-7000-4000-8000-0000000000c6'; d2 := '0000000a-7000-4000-8000-0000000000c7';
  ev := 'w07a-a13-two-dst';
  payload := jsonb_build_object('event', jsonb_build_object('id', ev, 'type', 'TRANSFER', 'app_user_id', '$RCAnonymousID:w07a',
    'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text, d2::text)));
  lease := (w07a_probe.q('w07a_setup', format('select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', ev, payload))->>'lease_token')::uuid;
  issued := w07a_probe.q('w07a_setup', format('select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[src, dst, d2]::text, ev, payload, lease));
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  select (item->>'ticket_id')::uuid into d2_ticket from jsonb_array_elements(issued) item where item->>'user_id' = d2::text;
  perform w07a_probe.q('w07a_setup', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', src, src_ticket, inactive));
  perform dblink_exec('w07a_first', 'begin; set local role service_role');
  first := w07a_probe.q('w07a_first', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', dst, dst_ticket, active));
  perform dblink_exec('w07a_second', 'begin; set local role service_role');
  perform dblink_send_query('w07a_second', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', d2, d2_ticket, active));
  perform w07a_probe.await_lock('w07a_second');
  perform dblink_exec('w07a_first', 'commit');
  second := w07a_probe.collect('w07a_second');
  perform dblink_exec('w07a_second', 'commit');
  if (first->>'applied')::boolean is distinct from true or (second->>'applied')::boolean is distinct from true
     or not (select premium from public.billing_entitlements where user_id = dst)
     or not (select premium from public.billing_entitlements where user_id = d2)
     or (select state from api_private.billing_transfers where event_id = ev) <> 'confirmed'
     or (select count(*) from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = ev and a.action = 'confirmed') <> 1
     or (select count(*) from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = ev and a.action = 'destination_applied') <> 2 then
    raise exception 'A13(c): racing destinations must each apply once and confirm once (% / %)', first, second;
  end if;
  r := w07a_probe.q('w07a_setup', format('select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb,%L::uuid)', ev, payload,
    jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket, d2::text, d2_ticket), lease));
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'A13(c): webhook must complete (%)', r;
  end if;
  scenarios := scenarios + 1;

  -- (d): a second transfer S2->D is admitted while S1's loss for S1->D is
  -- being committed. Whatever serialises first, D must never be premium while
  -- an unconfirmed present source of an unapplied destination side exists.
  src := '0000000a-7000-4000-8000-0000000000c8'; dst := '0000000a-7000-4000-8000-0000000000c9'; s2 := '0000000a-7000-4000-8000-0000000000ca';
  ev := 'w07a-a13-t1'; ev2 := 'w07a-a13-t2';
  payload := jsonb_build_object('event', jsonb_build_object('id', ev, 'type', 'TRANSFER', 'app_user_id', '$RCAnonymousID:w07a',
    'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text)));
  p2 := jsonb_build_object('event', jsonb_build_object('id', ev2, 'type', 'TRANSFER', 'app_user_id', '$RCAnonymousID:w07a',
    'transferred_from', jsonb_build_array(s2::text), 'transferred_to', jsonb_build_array(dst::text)));
  lease := (w07a_probe.q('w07a_setup', format('select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', ev, payload))->>'lease_token')::uuid;
  l2 := (w07a_probe.q('w07a_setup', format('select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', ev2, p2))->>'lease_token')::uuid;
  issued := w07a_probe.q('w07a_setup', format('select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[src, dst]::text, ev, payload, lease));
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  perform w07a_probe.q('w07a_setup', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', dst, dst_ticket, active));
  perform dblink_exec('w07a_first', 'begin; set local role service_role');
  first := w07a_probe.q('w07a_first', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', src, src_ticket, inactive));
  perform dblink_exec('w07a_second', 'begin; set local role service_role');
  perform dblink_send_query('w07a_second', format('select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[s2, dst]::text, ev2, p2, l2));
  perform w07a_probe.await_lock('w07a_second');
  perform dblink_exec('w07a_first', 'commit');
  i2 := w07a_probe.collect('w07a_second');
  perform dblink_exec('w07a_second', 'commit');
  if (first->>'applied')::boolean is distinct from true or jsonb_array_length(i2) <> 2 then
    raise exception 'A13(d): both operations must succeed (% / %)', first, i2;
  end if;
  if (select state from api_private.billing_transfers where event_id = ev) <> 'confirmed'
     or (select state from api_private.billing_transfers where event_id = ev2) <> 'pending'
     or not (select premium from public.billing_entitlements where user_id = dst) then
    raise exception 'A13(d): T1 committed first must confirm and apply D; T2 stays pending';
  end if;
  -- D now sits as an unapplied destination of T2 with S2 unconfirmed: a fresh
  -- active sync is withheld (D keeps what it already holds), S2's confirmed loss releases it.
  select (item->>'ticket_id')::uuid into s2 from jsonb_array_elements(i2) item where item->>'user_id' = '0000000a-7000-4000-8000-0000000000ca';
  select (item->>'ticket_id')::uuid into d2_ticket from jsonb_array_elements(i2) item where item->>'user_id' = dst::text;
  r := w07a_probe.q('w07a_setup', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', dst, d2_ticket, active));
  if (r->>'withheld')::boolean is distinct from true then
    raise exception 'A13(d): D is barred by T2 until S2 is confirmed (%)', r;
  end if;
  r := w07a_probe.q('w07a_setup', format('select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', '0000000a-7000-4000-8000-0000000000ca'::uuid, s2, inactive));
  if (select state from api_private.billing_transfers where event_id = ev2) <> 'confirmed'
     or not (select premium from public.billing_entitlements where user_id = dst) then
    raise exception 'A13(d): S2 confirmed lost must confirm T2';
  end if;
  scenarios := scenarios + 1;

  foreach c in array array['w07a_setup', 'w07a_first', 'w07a_second'] loop
    perform dblink_disconnect(c);
  end loop;
  if scenarios <> 4 then
    raise exception 'A13: expected 4 concurrency scenarios, ran %', scenarios;
  end if;
  raise notice 'W07-03 ATTACK CONCURRENCY (A13): % scenarios passed', scenarios;
end $$;

\echo W07-03 ATTACK MATRIX: ALL CASES PASSED
