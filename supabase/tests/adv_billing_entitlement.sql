-- ============================================================================
-- INT-billing-entitlement adversary (attacked head 2994371e) — database layer.
--
-- Sequential attacks against the ordered billing verdict store and the
-- transfer recovery queue, run as the service path does (superuser here; the
-- helpers are SECURITY DEFINER so the effective code path is identical). Every
-- violated invariant aborts the script (ON_ERROR_STOP) with the case name.
-- The concurrent attacks live in
-- supabase/functions/api/__wf__/adv-billing-entitlement-db.sh, which also
-- runs this file first.
--
--   ADV-SQL-1  verifiedAt clamp boundaries: +5min exactly is kept, +5min+1s
--              and -24h-1s collapse to issued_at, 'infinity' and garbage
--              consume nothing; a max-ahead verifiedAt on an OLDER ticket does
--              not outrank a LATER ticket (verification_order, not the clock,
--              orders verdicts) and access_state() follows the later verdict.
--   ADV-SQL-2  a destination that already holds its OWN premium row is not
--              revoked while its transfer verdict is withheld; the withhold
--              snapshot reports the stored truth; the source loss releases it
--              at the transfer's order and the webhook completes.
--   ADV-SQL-3  chained transfers A→B→C: C is withheld only while B (its
--              source) is unverified — once B carries ANY provider verdict C
--              mirrors its own; B is withheld behind A, and B's active verdict
--              parks B→C as held; A's loss releases B; B's later loss confirms
--              B→C; every access_state() answer matches the row.
--   ADV-SQL-4  a destination cannot release itself by re-syncing (three
--              withheld tickets, no row, recovery queue still lists the
--              transfer) but the SOURCE's own /v1/billing/sync ticket — not
--              only the webhook — releases it.
--   ADV-SQL-5  a premium verdict whose expiresAt is already past is stored
--              but answered as non-premium by the persist snapshot AND by
--              access_state(); a later inactive verdict at a lower order is
--              dropped and re-read as the stored (still expired) row.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000ad01', 'adv-be-1@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad02', 'adv-be-2@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad03', 'adv-be-3@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad04', 'adv-be-4@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad05', 'adv-be-5@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad06', 'adv-be-6@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad07', 'adv-be-7@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad08', 'adv-be-8@example.com', '{}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad09', 'adv-be-9@example.com', '{}', '{"provider":"apple"}');

do $$
begin
  if (select count(*) from public.profiles where id::text like '00000000-0000-4000-8000-00000000ad0%') <> 9 then
    raise exception 'SETUP: handle_new_user did not provision the adversary profiles';
  end if;
  -- access_state() checks below run as the app does: through the API gate.
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;

-- ── ADV-SQL-1 verifiedAt clamp boundaries and ordering ──────────────────────
do $$
declare
  u uuid := '00000000-0000-4000-8000-00000000ad01';
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid;
  issued timestamptz;
  ticket api_private.billing_verification_tickets%rowtype;
  row_ public.billing_entitlements%rowtype;
  r jsonb;
  active jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":"2999-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  -- t1: max-ahead clock (issued_at + 5 min exactly) is kept verbatim.
  t1 := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  select issued_at into strict issued from api_private.billing_verification_tickets where id = t1;
  r := public.persist_billing_verdict(u, t1, active || jsonb_build_object('verifiedAt', issued + interval '5 minutes'));
  select * into strict ticket from api_private.billing_verification_tickets where id = t1;
  if ticket.verified_at <> issued + interval '5 minutes' then
    raise exception 'ADV-SQL-1a: verifiedAt exactly 5 min ahead must be kept (got % vs %)', ticket.verified_at, issued;
  end if;
  if (r->'billing'->>'premium')::boolean is distinct from true or (r->>'applied')::boolean is distinct from true then
    raise exception 'ADV-SQL-1a: the active verdict must apply (got %)', r;
  end if;

  -- t2: one second past the bound collapses to the ticket's issued_at.
  t2 := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  select issued_at into strict issued from api_private.billing_verification_tickets where id = t2;
  r := public.persist_billing_verdict(u, t2, inactive || jsonb_build_object('verifiedAt', issued + interval '5 minutes 1 second'));
  select * into strict ticket from api_private.billing_verification_tickets where id = t2;
  if ticket.verified_at <> issued then
    raise exception 'ADV-SQL-1b: verifiedAt 5min+1s ahead must collapse to issued_at (got % vs %)', ticket.verified_at, issued;
  end if;
  select * into strict row_ from public.billing_entitlements where user_id = u;
  -- The LATER ticket wins even though the OLDER verdict carries the later clock.
  if row_.premium or row_.verification_order <> ticket.verification_order then
    raise exception 'ADV-SQL-1b: the later ticket must outrank an older verdict with a later clock (got %)', row_;
  end if;
  if row_.verified_at < ticket.verified_at then
    raise exception 'ADV-SQL-1b: the row verified_at must never move backwards (got % < %)', row_.verified_at, ticket.verified_at;
  end if;
  if (r->'billing'->>'premium')::boolean or (r->>'applied')::boolean is distinct from true then
    raise exception 'ADV-SQL-1b: the later inactive verdict must be applied and answered (got %)', r;
  end if;

  -- t3: 24h + 1s behind collapses to issued_at too; exactly 24h behind is kept.
  t3 := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  select issued_at into strict issued from api_private.billing_verification_tickets where id = t3;
  perform public.persist_billing_verdict(u, t3, inactive || jsonb_build_object('verifiedAt', issued - interval '24 hours 1 second'));
  select * into strict ticket from api_private.billing_verification_tickets where id = t3;
  if ticket.verified_at <> issued then
    raise exception 'ADV-SQL-1c: verifiedAt 24h+1s behind must collapse to issued_at (got % vs %)', ticket.verified_at, issued;
  end if;
  t4 := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  select issued_at into strict issued from api_private.billing_verification_tickets where id = t4;
  perform public.persist_billing_verdict(u, t4, inactive || jsonb_build_object('verifiedAt', issued - interval '24 hours'));
  select * into strict ticket from api_private.billing_verification_tickets where id = t4;
  if ticket.verified_at <> issued - interval '24 hours' then
    raise exception 'ADV-SQL-1c: verifiedAt exactly 24h behind must be kept (got % vs %)', ticket.verified_at, issued;
  end if;

  -- t5: non-finite / unparsable verifiedAt consumes nothing.
  t5 := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  begin
    perform public.persist_billing_verdict(u, t5, active || '{"verifiedAt":"infinity"}'::jsonb);
    raise exception 'ADV-SQL-1d: an infinite verifiedAt must be rejected';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(u, t5, active || '{"verifiedAt":"not-a-timestamp"}'::jsonb);
    raise exception 'ADV-SQL-1d: an unparsable verifiedAt must be rejected';
  exception when invalid_datetime_format or invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(u, t5, active || '{"verifiedAt":1725000000000}'::jsonb);
    raise exception 'ADV-SQL-1d: a numeric verifiedAt must be rejected';
  exception when invalid_parameter_value then null;
  end;
  select * into strict ticket from api_private.billing_verification_tickets where id = t5;
  if ticket.verdict is not null then
    raise exception 'ADV-SQL-1d: a rejected verdict must not consume the ticket';
  end if;
  select * into strict row_ from public.billing_entitlements where user_id = u;
  if row_.premium or row_.verification_order <> (select verification_order from api_private.billing_verification_tickets where id = t4) then
    raise exception 'ADV-SQL-1d: rejected verdicts must leave the row at t4 (got %)', row_;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad01';
do $$
begin
  if (select count(*) from public.billing_entitlements) <> 1 then
    raise exception 'ADV-SQL-1e: the owner must see exactly its own entitlement row (visibility precondition)';
  end if;
  if (select premium from public.access_state()) then
    raise exception 'ADV-SQL-1e: access_state() must follow the later (inactive) verdict, not the older verdict''s later clock';
  end if;
end $$;
reset role;

-- ── ADV-SQL-2 destination with its own premium row ──────────────────────────
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000ad02';
  b uuid := '00000000-0000-4000-8000-00000000ad03';
  payload jsonb := '{"event":{"id":"adv-be-transfer-own-row","type":"TRANSFER","transferred_from":["00000000-0000-4000-8000-00000000ad02"],"transferred_to":["00000000-0000-4000-8000-00000000ad03"]}}';
  active jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_annual","expiresAt":"2999-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  own_ticket uuid; a_ticket uuid; b_ticket uuid; lease uuid;
  issued jsonb; r jsonb;
  own_order bigint; transfer_order bigint;
  row_ public.billing_entitlements%rowtype;
begin
  -- B holds premium from its own earlier verification.
  own_ticket := (public.begin_billing_verification(array[b])->0->>'ticket_id')::uuid;
  perform public.persist_billing_verdict(b, own_ticket, active);
  select verification_order into strict own_order from public.billing_entitlements where user_id = b;

  lease := (public.claim_billing_webhook_delivery('adv-be-transfer-own-row', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[a, b], 'adv-be-transfer-own-row', payload, lease);
  select (item->>'ticket_id')::uuid into strict a_ticket from jsonb_array_elements(issued) item where item->>'user_id' = a::text;
  select (item->>'ticket_id')::uuid into strict b_ticket from jsonb_array_elements(issued) item where item->>'user_id' = b::text;
  select verification_order into strict transfer_order from api_private.billing_verification_tickets where id = b_ticket;

  r := public.persist_billing_verdict(b, b_ticket, active);
  if (r->>'withheld')::boolean is distinct from true or (r->>'applied')::boolean is distinct from false then
    raise exception 'ADV-SQL-2a: the destination verdict must be withheld while the source is unverified (got %)', r;
  end if;
  if (r->'billing'->>'premium')::boolean is distinct from true then
    raise exception 'ADV-SQL-2a: the withhold snapshot must report the destination''s OWN stored premium, not revoke it (got %)', r;
  end if;
  select * into strict row_ from public.billing_entitlements where user_id = b;
  if not row_.premium or row_.verification_order <> own_order then
    raise exception 'ADV-SQL-2a: a withheld transfer verdict must not touch the destination''s own row (got %)', row_;
  end if;
  begin
    perform public.complete_billing_webhook('adv-be-transfer-own-row', payload,
      jsonb_build_object(a::text, a_ticket, b::text, b_ticket), lease);
    raise exception 'ADV-SQL-2b: the delivery must not complete with the source unverified';
  exception when object_not_in_prerequisite_state or invalid_parameter_value then null;
  end;

  r := public.persist_billing_verdict(a, a_ticket, inactive);
  if (r->>'applied')::boolean is distinct from true or (r->'billing'->>'premium')::boolean then
    raise exception 'ADV-SQL-2c: the source loss must apply immediately (got %)', r;
  end if;
  select * into strict row_ from public.billing_entitlements where user_id = b;
  if not row_.premium or row_.verification_order <> transfer_order or row_.product_key <> 'pickle_sensei_pro_annual' then
    raise exception 'ADV-SQL-2c: the released destination must be applied at the transfer order (got %)', row_;
  end if;
  if (select state from api_private.billing_transfers where event_id = 'adv-be-transfer-own-row') <> 'confirmed' then
    raise exception 'ADV-SQL-2c: the transfer must confirm once both sides are applied';
  end if;
  r := public.complete_billing_webhook('adv-be-transfer-own-row', payload,
    jsonb_build_object(a::text, a_ticket, b::text, b_ticket), lease);
  if (r->>'received')::boolean is distinct from true or (r->>'verified')::boolean is distinct from true then
    raise exception 'ADV-SQL-2d: the delivery must complete as verified (got %)', r;
  end if;
  if public.billing_transfer_recovery(b) <> '[]'::jsonb or public.billing_transfer_recovery(a) <> '[]'::jsonb then
    raise exception 'ADV-SQL-2d: a confirmed transfer must leave both recovery queues';
  end if;
end $$;

-- ── ADV-SQL-3 chained transfers A→B→C ───────────────────────────────────────
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000ad04';
  b uuid := '00000000-0000-4000-8000-00000000ad05';
  c uuid := '00000000-0000-4000-8000-00000000ad06';
  p1 jsonb := '{"event":{"id":"adv-be-chain-1","type":"TRANSFER","transferred_from":["00000000-0000-4000-8000-00000000ad04"],"transferred_to":["00000000-0000-4000-8000-00000000ad05"]}}';
  p2 jsonb := '{"event":{"id":"adv-be-chain-2","type":"TRANSFER","transferred_from":["00000000-0000-4000-8000-00000000ad05"],"transferred_to":["00000000-0000-4000-8000-00000000ad06"]}}';
  active jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":"2999-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  l1 uuid; l2 uuid; i1 jsonb; i2 jsonb;
  a1 uuid; b1 uuid; b2 uuid; c2 uuid; b_sync uuid;
  r jsonb;
begin
  l1 := (public.claim_billing_webhook_delivery('adv-be-chain-1', p1)->>'lease_token')::uuid;
  i1 := public.begin_billing_verification(array[a, b], 'adv-be-chain-1', p1, l1);
  l2 := (public.claim_billing_webhook_delivery('adv-be-chain-2', p2)->>'lease_token')::uuid;
  i2 := public.begin_billing_verification(array[b, c], 'adv-be-chain-2', p2, l2);
  select (item->>'ticket_id')::uuid into strict a1 from jsonb_array_elements(i1) item where item->>'user_id' = a::text;
  select (item->>'ticket_id')::uuid into strict b1 from jsonb_array_elements(i1) item where item->>'user_id' = b::text;
  select (item->>'ticket_id')::uuid into strict b2 from jsonb_array_elements(i2) item where item->>'user_id' = b::text;
  select (item->>'ticket_id')::uuid into strict c2 from jsonb_array_elements(i2) item where item->>'user_id' = c::text;

  -- C first: withheld behind B (source of chain-2, unverified).
  r := public.persist_billing_verdict(c, c2, active);
  if (r->>'withheld')::boolean is distinct from true or (r->'billing'->>'premium')::boolean then
    raise exception 'ADV-SQL-3a: C must be withheld behind an unverified B (got %)', r;
  end if;
  -- B (chain-1 ticket, older order) says active: withheld behind A for chain-1
  -- and, as chain-2's source, parks chain-2 as held.
  r := public.persist_billing_verdict(b, b1, active);
  if (r->>'withheld')::boolean is distinct from true or (r->'billing'->>'premium')::boolean then
    raise exception 'ADV-SQL-3b: B must be withheld behind an unverified A (got %)', r;
  end if;
  if exists (select 1 from public.billing_entitlements where user_id = b) then
    raise exception 'ADV-SQL-3b: a withheld destination may not own a row';
  end if;
  -- B is now provider-confirmed, so C mirrors its own provider verdict even
  -- though B still holds the entitlement (chain-2 parks as held, not pending).
  if not exists (select 1 from public.billing_entitlements where user_id = c and premium) then
    raise exception 'ADV-SQL-3b: C must mirror its provider verdict once its source B is provider-confirmed';
  end if;
  -- B's chain-2 ticket carries the same active verdict (same RevenueCat truth).
  r := public.persist_billing_verdict(b, b2, active);
  if (r->>'withheld')::boolean is distinct from true then
    raise exception 'ADV-SQL-3b: B''s second ticket is still withheld (got %)', r;
  end if;
  if (select state from api_private.billing_transfers where event_id = 'adv-be-chain-2') <> 'held' then
    raise exception 'ADV-SQL-3b: chain-2 must be held while its source B still holds the entitlement (got %)',
      (select state from api_private.billing_transfers where event_id = 'adv-be-chain-2');
  end if;

  -- A loses: chain-1 confirms and B gains at once; chain-2 stays held, C stays out.
  r := public.persist_billing_verdict(a, a1, inactive);
  if (r->>'applied')::boolean is distinct from true then
    raise exception 'ADV-SQL-3c: the source loss must apply (got %)', r;
  end if;
  if (select state from api_private.billing_transfers where event_id = 'adv-be-chain-1') <> 'confirmed' then
    raise exception 'ADV-SQL-3c: chain-1 must confirm once A is confirmed lost';
  end if;
  if not (select premium from public.billing_entitlements where user_id = b) then
    raise exception 'ADV-SQL-3c: B must gain premium once A is confirmed lost';
  end if;
  if (select state from api_private.billing_transfers where event_id = 'adv-be-chain-2') <> 'held' then
    raise exception 'ADV-SQL-3c: chain-2 must remain held while B holds the entitlement';
  end if;
  if public.billing_transfer_recovery(c) = '[]'::jsonb then
    raise exception 'ADV-SQL-3c: C''s recovery queue must still list chain-2';
  end if;
  r := public.complete_billing_webhook('adv-be-chain-1', p1, jsonb_build_object(a::text, a1, b::text, b1), l1);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'ADV-SQL-3c: chain-1 must complete (got %)', r;
  end if;
  -- Both chain-2 sides are provider-confirmed: the delivery completes even
  -- though the transfer is parked as held (a later verdict releases it).
  r := public.complete_billing_webhook('adv-be-chain-2', p2, jsonb_build_object(b::text, b2, c::text, c2), l2);
  if (r->>'verified')::boolean is distinct from true then
    raise exception 'ADV-SQL-3c: a held transfer with both sides confirmed must complete its delivery (got %)', r;
  end if;
  if (select state from api_private.billing_transfers where event_id = 'adv-be-chain-2') <> 'held' then
    raise exception 'ADV-SQL-3c: completing the delivery must not settle a held transfer';
  end if;

  -- B's own later sync says the entitlement left B: chain-2 confirms, C gains.
  b_sync := (public.begin_billing_verification(array[b])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(b, b_sync, inactive);
  if (r->>'applied')::boolean is distinct from true or (r->'billing'->>'premium')::boolean then
    raise exception 'ADV-SQL-3d: B''s loss must apply (got %)', r;
  end if;
  if (select state from api_private.billing_transfers where event_id = 'adv-be-chain-2') <> 'confirmed' then
    raise exception 'ADV-SQL-3d: chain-2 must confirm once B is confirmed lost (got %)',
      (select state from api_private.billing_transfers where event_id = 'adv-be-chain-2');
  end if;
  if not (select premium from public.billing_entitlements where user_id = c) then
    raise exception 'ADV-SQL-3d: C must gain premium once B is confirmed lost';
  end if;
  if (select premium from public.billing_entitlements where user_id = b) then
    raise exception 'ADV-SQL-3d: B must no longer be premium';
  end if;
  r := public.complete_billing_webhook('adv-be-chain-2', p2, jsonb_build_object(b::text, b2, c::text, c2), l2);
  if (r->>'duplicate')::boolean is distinct from true then
    raise exception 'ADV-SQL-3d: a completed delivery replayed after settlement is a duplicate, never re-processed (got %)', r;
  end if;
  if public.billing_transfer_recovery(a) <> '[]'::jsonb or public.billing_transfer_recovery(b) <> '[]'::jsonb
     or public.billing_transfer_recovery(c) <> '[]'::jsonb then
    raise exception 'ADV-SQL-3d: every recovery queue must be empty';
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad06';
do $$
begin
  if not (select premium from public.access_state()) then
    raise exception 'ADV-SQL-3e: C''s access_state() must be premium after the chain settles';
  end if;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad05';
do $$
begin
  if (select count(*) from public.billing_entitlements where premium = false) <> 1 then
    raise exception 'ADV-SQL-3e: B must see exactly its own (inactive) entitlement row';
  end if;
  if (select premium from public.access_state()) then
    raise exception 'ADV-SQL-3e: B''s access_state() must not be premium after the chain settles';
  end if;
end $$;
reset role;

-- ── ADV-SQL-4 destination re-sync storm vs source sync release ──────────────
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000ad07';
  b uuid := '00000000-0000-4000-8000-00000000ad08';
  payload jsonb := '{"event":{"id":"adv-be-storm","type":"TRANSFER","transferred_from":["00000000-0000-4000-8000-00000000ad07"],"transferred_to":["00000000-0000-4000-8000-00000000ad08"]}}';
  active jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_lifetime","expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid; t uuid; a_sync uuid; r jsonb; i integer;
  last_order bigint;
begin
  lease := (public.claim_billing_webhook_delivery('adv-be-storm', payload)->>'lease_token')::uuid;
  perform public.begin_billing_verification(array[a, b], 'adv-be-storm', payload, lease);
  -- The webhook worker died before verifying anyone; the lease lapses.
  update api_private.billing_webhook_claims set lease_expires_at = clock_timestamp() - interval '1 second'
    where event_id = 'adv-be-storm';
  for i in 1..3 loop
    t := (public.begin_billing_verification(array[b])->0->>'ticket_id')::uuid;
    r := public.persist_billing_verdict(b, t, active);
    if (r->>'withheld')::boolean is distinct from true or (r->'billing'->>'premium')::boolean then
      raise exception 'ADV-SQL-4a: destination sync % must stay withheld (got %)', i, r;
    end if;
    select verification_order into strict last_order from api_private.billing_verification_tickets where id = t;
  end loop;
  if exists (select 1 from public.billing_entitlements where user_id = b) then
    raise exception 'ADV-SQL-4a: a withheld destination must own no row';
  end if;
  if (select verification_order from api_private.billing_transfer_sides s
      join api_private.billing_transfers tr on tr.id = s.transfer_id
      where tr.event_id = 'adv-be-storm' and s.user_id = b) <> last_order then
    raise exception 'ADV-SQL-4a: the destination side must carry its NEWEST recorded verdict order';
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(b)) <> 1 then
    raise exception 'ADV-SQL-4a: the recovery queue must still list the transfer';
  end if;
  -- The source opens the app: its ordinary sync ticket carries the loss.
  a_sync := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(a, a_sync, inactive);
  if (r->>'applied')::boolean is distinct from true then
    raise exception 'ADV-SQL-4b: the source sync loss must apply (got %)', r;
  end if;
  if (select state from api_private.billing_transfers where event_id = 'adv-be-storm') <> 'confirmed' then
    raise exception 'ADV-SQL-4b: a source SYNC (not only the webhook) must confirm the transfer';
  end if;
  if not (select premium from public.billing_entitlements where user_id = b)
     or (select verification_order from public.billing_entitlements where user_id = b) <> last_order then
    raise exception 'ADV-SQL-4b: the destination must be applied with its newest recorded verdict';
  end if;
end $$;

-- ── ADV-SQL-5 expired premium verdict ───────────────────────────────────────
do $$
declare
  u uuid := '00000000-0000-4000-8000-00000000ad09';
  t_old uuid; t_new uuid; r jsonb;
  row_ public.billing_entitlements%rowtype;
  expired jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":"2020-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  t_old := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  t_new := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(u, t_new, expired);
  if (r->>'applied')::boolean is distinct from true or (r->'billing'->>'premium')::boolean
     or r->'billing'->>'expiresAt' is not null or r->'billing'->>'productKey' is not null
     or r->'billing'->'activeEntitlements' <> '[]'::jsonb then
    raise exception 'ADV-SQL-5a: an already-expired premium verdict must be answered as canonical non-premium (got %)', r;
  end if;
  select * into strict row_ from public.billing_entitlements where user_id = u;
  if not row_.premium or row_.expires_at <> '2020-01-01T00:00:00Z'::timestamptz then
    raise exception 'ADV-SQL-5a: the stored row keeps the provider verdict verbatim (got %)', row_;
  end if;
  -- The older ticket arrives late with an inactive verdict: dropped, re-read.
  r := public.persist_billing_verdict(u, t_old, inactive);
  if (r->>'applied')::boolean is distinct from false or (r->'billing'->>'premium')::boolean then
    raise exception 'ADV-SQL-5b: a stale verdict must be dropped and answered from the stored row (got %)', r;
  end if;
  select * into strict row_ from public.billing_entitlements where user_id = u;
  if not row_.premium or row_.verification_order <> (select verification_order from api_private.billing_verification_tickets where id = t_new) then
    raise exception 'ADV-SQL-5b: the stale verdict must not overwrite the newer stored row (got %)', row_;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad09';
do $$
begin
  if (select count(*) from public.billing_entitlements where premium) <> 1 then
    raise exception 'ADV-SQL-5c: the owner must see its stored premium row (visibility precondition)';
  end if;
  if (select premium from public.access_state()) then
    raise exception 'ADV-SQL-5c: access_state() must not grant premium for a stored premium row past its expires_at';
  end if;
end $$;
reset role;

commit;
\echo ADV-SQL BILLING ENTITLEMENT SEQUENTIAL ATTACKS: ALL PASSED
