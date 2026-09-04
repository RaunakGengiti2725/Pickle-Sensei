-- ADVERSARIAL PASS 3 — edge-billing-webhook: database-level confirmations
-- against the REAL migrations on a throwaway postgres:16 (run by
-- attack_billing_webhook_3_pg.sh after shim_auth.sql + every migration).
--
-- Mirrors the writes handleRevenueCatWebhook performs through PostgREST as
-- service_role (RLS bypassed) so the deno-harness observations in
-- attack_billing_webhook_3.test.ts are pinned to actual PG behaviour:
--   S4  a 4000-byte event.id fails the webhook_events_pkey btree row-size limit
--       (SQLSTATE 54000) — the audit row is NEVER written, so the event is
--       never deduplicated.
--   S5  an UPPERCASE uuid text upserted into billing_entitlements.user_id is
--       folded onto the existing lowercase row (no duplicate) and its verdict
--       OVERWRITES that row (premium true → false).
--   S3  a 4.9 MB jsonb payload is accepted by webhook_events with no size cap.
--
-- Every block raises on a violated expectation; ON_ERROR_STOP makes psql exit 3.
\set ON_ERROR_STOP on
\set QUIET on

begin;

-- Same identity as the edge function's service-role client.
set local role service_role;

-- ───────────────────────────── S4: 4000-byte event.id ─────────────────────
-- Deterministic incompressible text: chained md5 hex, seeded. btree compresses
-- oversized index datums before applying the 2704-byte limit, so the outcome
-- depends on the id's ENTROPY, not just its length — both cases are pinned.
create function pg_temp.noise(seed text, n int) returns text language sql immutable as $$
  select left(string_agg(md5(seed || ':' || i), '' order by i), n)
  from generate_series(1, (n + 31) / 32) i
$$;

do $$
declare
  noisy_id text := 's4-' || pg_temp.noise('attack3-s4', 3997);
  flat_id  text := 's4-' || repeat('a', 3997);
  n int;
begin
  if octet_length(noisy_id) <> 4000 or octet_length(flat_id) <> 4000 then
    raise exception 'setup: ids are % / % bytes', octet_length(noisy_id), octet_length(flat_id);
  end if;

  -- (a) incompressible 4000-byte id: exactly the upsert the function issues
  -- (resolution=ignore-duplicates) → 54000, no row, hence no dedupe ever.
  begin
    insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
    values (noisy_id, 'revenuecat', 'RENEWAL', null, '{"event":{"type":"RENEWAL"}}'::jsonb)
    on conflict (id) do nothing;
    raise exception 'S4 UNEXPECTED: incompressible 4000-byte id was accepted by webhook_events_pkey';
  exception
    when program_limit_exceeded then
      raise notice 'S4a CONFIRMED (incompressible id) sqlstate=% message=%', sqlstate, sqlerrm;
  end;
  select count(*) into n from public.webhook_events where id = noisy_id;
  if n <> 0 then raise exception 'S4a: row unexpectedly present (%)', n; end if;

  -- (b) the SAME length made of one repeated byte compresses inside the index
  -- tuple and IS stored — the audit row exists and the replay dedupes.
  insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
  values (flat_id, 'revenuecat', 'RENEWAL', null, '{"event":{"type":"RENEWAL"}}'::jsonb)
  on conflict (id) do nothing;
  select count(*) into n from public.webhook_events where id = flat_id;
  if n <> 1 then raise exception 'S4b: repeated-byte 4000-byte id was NOT stored (%)', n; end if;
  raise notice 'S4b CONFIRMED (repeat(''a'',3997) id) stored: 4000-byte id accepted thanks to index-tuple compression';
end $$;

-- Where exactly does the limit sit for incompressible ids? Largest length
-- that inserts (bisection over the same statement), reported for the record.
do $$
declare
  lo int := 1; hi int := 4000; mid int; ok boolean;
begin
  while lo < hi loop
    mid := (lo + hi + 1) / 2;
    begin
      insert into public.webhook_events (id, payload)
      values ('bisect-' || pg_temp.noise('attack3-bisect-' || mid, mid), '{}'::jsonb);
      ok := true;
    exception when program_limit_exceeded then
      ok := false;
    end;
    if ok then lo := mid; else hi := mid - 1; end if;
  end loop;
  raise notice 'S4 largest incompressible event.id that fits webhook_events_pkey here: % bytes (+7 prefix)', lo;
  if lo < 2000 or lo > 3000 then
    raise exception 'S4: btree limit outside the expected ~2704-byte band: %', lo;
  end if;
  delete from public.webhook_events where id like 'bisect-%';
end $$;

-- ─────────────────────── S5: uppercase uuid folds onto the victim ─────────
do $$
declare
  victim uuid := 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  upper_text text := upper(victim::text);
  rows int; is_premium boolean; stored text;
begin
  if upper_text = victim::text then raise exception 'setup: uuid has no letters'; end if;

  -- The victim exists and holds a real, verified lifetime entitlement.
  reset role;
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (victim, 'victim@example.com', '{}', '{"provider":"apple"}');
  set local role service_role;
  insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values (victim::text::uuid, true, 'pickle_sensei_pro_lifetime', null, now() - interval '1 hour');

  -- The webhook upsert for the UPPERCASE spelling, verdict from a subscriber
  -- RevenueCat has never seen (premium=false, no product, no expiry).
  insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values (upper_text::uuid, false, null, null, now())
  on conflict (user_id) do update set
    premium = excluded.premium,
    product_key = excluded.product_key,
    expires_at = excluded.expires_at,
    verified_at = excluded.verified_at;

  select count(*) into rows from public.billing_entitlements
  where user_id = victim;
  if rows <> 1 then raise exception 'S5: expected 1 row for the victim, got %', rows; end if;

  select premium, user_id::text into is_premium, stored from public.billing_entitlements
  where user_id = victim;
  if stored <> lower(upper_text) then
    raise exception 'S5: PG did not normalise the uuid: %', stored;
  end if;
  if is_premium then
    raise exception 'S5 UNEXPECTED: victim row still premium after the uppercase upsert';
  end if;
  raise notice 'S5 CONFIRMED uppercase % -> stored % ; rows=% ; premium now=%',
    upper_text, stored, rows, is_premium;

  -- And a mixed-case spelling is the same key too (S5c: three upserts, one row).
  insert into public.billing_entitlements (user_id, premium)
  values (('ABCDEFab-cdef-4ABC-8def-ABCDEFabcdef')::uuid, true)
  on conflict (user_id) do update set premium = excluded.premium;
  select count(*) into rows from public.billing_entitlements where user_id = victim;
  if rows <> 1 then raise exception 'S5c: duplicate row (%)', rows; end if;
end $$;

-- ───────────────────────── S3: 4.9 MB payload is accepted ─────────────────
do $$
declare
  huge jsonb;
  stored_bytes bigint; toast_bytes bigint;
  caps int;
begin
  huge := jsonb_build_object(
    'api_version', '1.0',
    'event', jsonb_build_object('id', 's3-huge', 'type', 'TEST', 'pad', repeat('x', 4899930)));
  if octet_length(huge::text) < 4900000 then
    raise exception 'setup: payload is only % bytes', octet_length(huge::text);
  end if;
  insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
  values ('s3-huge', 'revenuecat', 'TEST', null, huge)
  on conflict (id) do nothing;

  select octet_length(payload::text), pg_column_size(payload)
    into stored_bytes, toast_bytes
  from public.webhook_events where id = 's3-huge';
  if stored_bytes < 4900000 then
    raise exception 'S3: payload truncated to % bytes', stored_bytes;
  end if;

  -- No CHECK constraint bounds webhook_events.payload (the defense-in-depth
  -- migration caps other tables, not this one).
  select count(*) into caps from pg_constraint
  where conrelid = 'public.webhook_events'::regclass and contype = 'c';
  raise notice 'S3a CONFIRMED repetitive payload text=% bytes, on-disk(compressed)=% bytes, check constraints on webhook_events=%',
    stored_bytes, toast_bytes, caps;
  if caps <> 0 then
    raise exception 'S3: a check constraint exists on webhook_events — re-evaluate the finding';
  end if;

  -- An attacker sends INCOMPRESSIBLE bytes: TOAST cannot shrink it, so the
  -- on-disk cost is the full ~4.9 MB per delivery.
  huge := jsonb_build_object(
    'api_version', '1.0',
    'event', jsonb_build_object('id', 's3-noise', 'type', 'TEST',
      'pad', pg_temp.noise('attack3-s3', 4899930)));
  insert into public.webhook_events (id, payload) values ('s3-noise', huge);
  select octet_length(payload::text), pg_column_size(payload)
    into stored_bytes, toast_bytes
  from public.webhook_events where id = 's3-noise';
  if toast_bytes < 4800000 then
    raise exception 'S3b: incompressible payload unexpectedly shrank to % bytes', toast_bytes;
  end if;
  raise notice 'S3b CONFIRMED incompressible payload text=% bytes, on-disk=% bytes', stored_bytes, toast_bytes;
end $$;

-- The audit table is service-only: client roles cannot read the amplified
-- rows back (so the amplification is cost/storage, not disclosure).
do $$
declare ok boolean := false;
begin
  set local role authenticated;
  begin
    perform 1 from public.webhook_events limit 1;
  exception when insufficient_privilege then
    ok := true;
  end;
  set local role service_role;
  if not ok then raise exception 'webhook_events readable by authenticated'; end if;
  raise notice 'webhook_events: authenticated SELECT denied (42501) as expected';
end $$;

rollback;
