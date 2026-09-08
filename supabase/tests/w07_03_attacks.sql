-- ============================================================================
-- W07-03 adversarial attacks against the billing recovery transfer queue
-- (candidate 041d19a3, migration 20260908150000_billing_recovery_transfer.sql).
--
-- Standalone: run as the database owner against a database that has
-- tests/shim_auth.sql + every migration applied, e.g.
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/w07_03_attacks.sql
-- Every attack asserts the CORRECT behaviour; an assertion failure is a
-- confirmed break and is collected into w07_attack_results. The file exits
-- non-zero (last block raises) when any attack broke the candidate, so the
-- psql exit code doubles as the verdict and the printed table as evidence.
--
-- Concurrency attacks (A10) use dblink sessions and therefore need the DSN
-- of the database under test in the psql variable w07_dsn, for example
--   psql -v w07_dsn="dbname=attack user=postgres password=pg host=127.0.0.1"
-- Without it the concurrency attacks are recorded as SKIPPED (not a pass).
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\if :{?w07_dsn}
\else
\set w07_dsn ''
\endif
select set_config('w07.dsn', :'w07_dsn', false);

create temp table w07_attack_results (
  seq serial primary key,
  attack text not null,
  outcome text not null check (outcome in ('PASS', 'BREAK', 'ERROR', 'SKIPPED')),
  detail text
);

create or replace function pg_temp.w07_record(p_attack text, p_state text, p_msg text)
returns void language sql as $$
  insert into w07_attack_results (attack, outcome, detail) values (p_attack, p_state, p_msg);
$$;

create or replace function pg_temp.w07_user(p_suffix text, p_email text)
returns uuid language plpgsql as $$
declare v_id uuid := ('00000000-0000-4000-8000-0000000a' || lpad(p_suffix, 4, '0'))::uuid;
begin
  insert into auth.users (id, email, raw_app_meta_data)
  values (v_id, p_email, '{"provider":"apple"}')
  on conflict (id) do nothing;
  return v_id;
end $$;

create or replace function pg_temp.w07_transfer(p_event text, p_from text[], p_to text[])
returns jsonb language sql as $$
  select jsonb_build_object('event', jsonb_build_object(
    'id', p_event, 'type', 'TRANSFER',
    'transferred_from', to_jsonb(p_from), 'transferred_to', to_jsonb(p_to)));
$$;

create or replace function pg_temp.w07_active(p_expires timestamptz)
returns jsonb language sql as $$
  select jsonb_build_object('premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', p_expires, 'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
$$;

create or replace function pg_temp.w07_ticket(p_issued jsonb, p_user uuid)
returns uuid language sql as $$
  select (item->>'ticket_id')::uuid from jsonb_array_elements(p_issued) item
  where item->>'user_id' = p_user::text;
$$;

create or replace function pg_temp.w07_tickets(p_issued jsonb)
returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(item->>'user_id', item->>'ticket_id'), '{}'::jsonb)
  from jsonb_array_elements(p_issued) item where item->>'ticket_id' is not null;
$$;

-- hosted-like default privileges revoke EXECUTE from public; the harness
-- helpers are pure and must stay callable while a client/service role is active
grant execute on function pg_temp.w07_transfer(text, text[], text[]) to public;
grant execute on function pg_temp.w07_active(timestamptz) to public;
grant execute on function pg_temp.w07_ticket(jsonb, uuid) to public;
grant execute on function pg_temp.w07_tickets(jsonb) to public;

-- ----------------------------------------------------------------------------
-- A1. Unauthorised roles on the new SQL surface (denied AND allowed paths).
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  a1_dst uuid := pg_temp.w07_user('0101', 'w07a1-dst@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a1', array['00000000-0000-4000-8000-0000000a0100'], array[a1_dst::text]);
  r jsonb;
  denied int := 0;
  attempted int := 0;
  probe text;
  probes text[] := array[
    'select public.enqueue_billing_transfer(''w07-a1'', %L::jsonb, gen_random_uuid())',
    'select public.billing_transfer_recovery(%L::uuid)',
    'select public.begin_billing_verification(array[%L::uuid], ''w07-a1'', ''{}''::jsonb, gen_random_uuid())',
    'select public.persist_billing_verdict(%L::uuid, gen_random_uuid(), ''{}''::jsonb)',
    'select count(*) from api_private.billing_transfers',
    'select count(*) from api_private.billing_transfer_sides',
    'select count(*) from api_private.billing_transfer_audit',
    'insert into api_private.billing_transfer_audit (transfer_id, action) values (gen_random_uuid(), ''enqueued'')',
    'select api_private.billing_destination_blocker(%L::uuid, now())',
    'select api_private.lock_billing_transfers(%L::uuid)',
    'select api_private.reconcile_billing_destination(%L::uuid)',
    'select api_private.settle_billing_transfer(gen_random_uuid())',
    'select api_private.billing_verdict_active(''{}''::jsonb, now())'
  ];
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    execute format('set local role %I', role_name);
    if role_name = 'authenticated' then
      perform set_config('request.jwt.claims', jsonb_build_object('sub', a1_dst, 'role', 'authenticated')::text, true);
    end if;
    foreach probe in array probes loop
      if role_name = 'service_role' and probe like 'select public.%' then
        continue; -- the API helpers are the allowed path for the service role, checked below
      end if;
      attempted := attempted + 1;
      begin
        execute format(probe, case when probe like '%enqueue%' then payload::text else a1_dst::text end);
        raise exception 'BREAK A1: role % may run: %', role_name, probe;
      exception
        when insufficient_privilege then denied := denied + 1;
      end;
    end loop;
    reset role;
  end loop;
  if denied <> attempted or attempted <> 3 * cardinality(probes) - 4 then
    raise exception 'BREAK A1: expected % probes denied, got % denials', attempted, denied;
  end if;
  -- allowed path: the service role drives the queue through the public helpers
  set local role service_role;
  r := public.enqueue_billing_transfer('w07-a1', payload, null);
  reset role;
  raise exception 'BREAK A1: enqueue without a lease must be refused (got %)', r;
exception
  when others then
    if sqlerrm like 'BREAK%' then
      perform pg_temp.w07_record('A1 role isolation', 'BREAK', sqlerrm);
    elsif sqlstate = '55000' then
      perform pg_temp.w07_record('A1 role isolation', 'PASS', 'every client/service direct path denied; unleased enqueue refused with 55000');
    else
      perform pg_temp.w07_record('A1 role isolation', 'ERROR', sqlstate || ' ' || sqlerrm);
    end if;
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A2. Enqueue boundary values: party-list limits, casing, scalar/garbage
--     parties, empty lists, event-id mismatch, foreign lease.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  dst uuid := pg_temp.w07_user('0201', 'w07a2-dst@example.test');
  src uuid := pg_temp.w07_user('0202', 'w07a2-src@example.test');
  lease uuid;
  other_lease uuid;
  payload jsonb;
  r jsonb;
  many text[];
  i int;
  n int;
begin
  set local role service_role;
  -- 17 distinct parties (16 sources + 1 destination) must be refused as a whole
  many := '{}';
  for i in 1..16 loop
    many := many || ('00000000-0000-4000-8000-0000000a02' || lpad(to_hex(16 + i), 2, '0'));
  end loop;
  payload := pg_temp.w07_transfer('w07-a2-many', many, array[dst::text]);
  begin
    -- either the delivery claim or the enqueue must refuse the oversize list
    lease := (public.claim_billing_webhook_delivery('w07-a2-many', payload)->>'lease_token')::uuid;
    r := public.enqueue_billing_transfer('w07-a2-many', payload, lease);
    raise exception 'BREAK A2: 17 parties accepted: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '22023' then
      raise exception 'BREAK A2: 17 parties raised % instead of 22023', sqlstate;
    end if;
  end;
  -- exactly 16 is the documented maximum and must be accepted
  payload := pg_temp.w07_transfer('w07-a2-16', many[1:15], array[dst::text]);
  lease := (public.claim_billing_webhook_delivery('w07-a2-16', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-a2-16', payload, lease);
  if r->>'outcome' <> 'queued' then
    raise exception 'BREAK A2: 16 parties refused: %', r;
  end if;
  reset role;
  select count(*) into n from api_private.billing_transfer_sides s
    join api_private.billing_transfers t on t.id = s.transfer_id where t.event_id = 'w07-a2-16';
  if n <> 16 then
    raise exception 'BREAK A2: 16-party transfer stored % sides', n;
  end if;
  set local role service_role;
  -- upper-case / braced / urn UUID spellings, numbers, NaN, nested arrays,
  -- nulls, objects: only canonical uuid strings are parties, nothing raises
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-a2-shape', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(upper(src::text), 'NaN', -1, 1e308, null, jsonb_build_array(dst::text),
      jsonb_build_object('id', dst::text), '{' || src::text || '}', 'urn:uuid:' || src::text, ''),
    'transferred_to', dst::text));
  lease := (public.claim_billing_webhook_delivery('w07-a2-shape', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-a2-shape', payload, lease);
  reset role;
  -- the upper-cased source is the one canonical party (as on base); the
  -- scalar destination and every garbage element must be dropped, not raise
  if r->>'outcome' <> 'queued' or jsonb_array_length(r->'sources') <> 1
     or jsonb_array_length(r->'destinations') <> 0 then
    raise exception 'BREAK A2: garbage parties must fold to exactly one source and no destination, got %', r;
  end if;
  select count(*) into n from api_private.billing_transfer_sides s
    join api_private.billing_transfers t on t.id = s.transfer_id where t.event_id = 'w07-a2-shape';
  if n <> 1 then
    raise exception 'BREAK A2: garbage payload stored % sides', n;
  end if;
  set local role service_role;
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-a2-case', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(upper(src::text)),
    'transferred_to', jsonb_build_array(upper(dst::text), dst::text)));
  lease := (public.claim_billing_webhook_delivery('w07-a2-case', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-a2-case', payload, lease);
  reset role;
  select count(*) into n from api_private.billing_transfer_sides s
    join api_private.billing_transfers t on t.id = s.transfer_id where t.event_id = 'w07-a2-case';
  if r->>'outcome' <> 'queued' or n <> 2 then
    raise exception 'BREAK A2: upper-case duplicates must fold to 2 sides (got % / %)', r, n;
  end if;
  set local role service_role;
  -- empty lists
  payload := pg_temp.w07_transfer('w07-a2-empty', '{}'::text[], '{}'::text[]);
  lease := (public.claim_billing_webhook_delivery('w07-a2-empty', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-a2-empty', payload, lease);
  if r->>'outcome' <> 'no_subjects' then
    raise exception 'BREAK A2: empty party lists must be no_subjects, got %', r;
  end if;
  -- event id / payload id mismatch
  payload := pg_temp.w07_transfer('w07-a2-other-id', array[src::text], array[dst::text]);
  begin
    -- refused by the delivery claim or, failing that, by the enqueue
    lease := (public.claim_billing_webhook_delivery('w07-a2-mismatch', payload)->>'lease_token')::uuid;
    r := public.enqueue_billing_transfer('w07-a2-mismatch', payload, lease);
    raise exception 'BREAK A2: event id mismatch accepted: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '22023' then
      raise exception 'BREAK A2: event id mismatch raised %', sqlstate;
    end if;
  end;
  -- a lease that belongs to ANOTHER event must not authorise this one
  payload := pg_temp.w07_transfer('w07-a2-foreign', array[src::text], array[dst::text]);
  other_lease := (public.claim_billing_webhook_delivery('w07-a2-lender', pg_temp.w07_transfer('w07-a2-lender', array[src::text], array[dst::text]))->>'lease_token')::uuid;
  perform public.claim_billing_webhook_delivery('w07-a2-foreign', payload);
  begin
    r := public.enqueue_billing_transfer('w07-a2-foreign', payload, other_lease);
    raise exception 'BREAK A2: foreign lease accepted: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '55000' then
      raise exception 'BREAK A2: foreign lease raised %', sqlstate;
    end if;
  end;
  reset role;
  perform pg_temp.w07_record('A2 enqueue boundaries', 'PASS', '17 parties 22023, 16 accepted, garbage/casing folded, empty no_subjects, id mismatch 22023, foreign lease 55000');
exception
  when others then
    perform pg_temp.w07_record('A2 enqueue boundaries', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A3. Replay / duplicate identities: same event twice, same event with a
--     different payload, two events for the same parties.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  src uuid := pg_temp.w07_user('0301', 'w07a3-src@example.test');
  dst uuid := pg_temp.w07_user('0302', 'w07a3-dst@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a3', array[src::text], array[dst::text]);
  twin jsonb := pg_temp.w07_transfer('w07-a3-twin', array[src::text], array[dst::text]);
  lease uuid; lease2 uuid;
  r jsonb; r2 jsonb; issued jsonb;
  n int;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a3', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-a3', payload, lease);
  r2 := public.enqueue_billing_transfer('w07-a3', payload, lease);
  reset role;
  select count(*) into n from api_private.billing_transfers where event_id = 'w07-a3';
  set local role service_role;
  if r->>'outcome' <> 'queued' or r2->>'outcome' <> 'queued' or r->>'transfer_id' <> r2->>'transfer_id' or n <> 1 then
    raise exception 'BREAK A3: replayed enqueue must return the same single transfer (% / % / rows %)', r, r2, n;
  end if;
  begin
    r2 := public.enqueue_billing_transfer('w07-a3', payload || jsonb_build_object('extra', 1), lease);
    raise exception 'BREAK A3: same event id with a different payload accepted: %', r2;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '22023' then raise exception 'BREAK A3: conflicting payload raised %', sqlstate; end if;
  end;
  -- second delivery of the SAME transfer under a different event id (RevenueCat
  -- re-emits TRANSFER on every login); one source verdict must settle both
  lease2 := (public.claim_billing_webhook_delivery('w07-a3-twin', twin)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-a3-twin', twin, lease2);
  r := public.persist_billing_verdict(dst, pg_temp.w07_ticket(issued, dst), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'withheld')::boolean or (r->'billing'->>'premium')::boolean then
    raise exception 'BREAK A3: destination gained before either twin transfer was confirmed: %', r;
  end if;
  r := public.persist_billing_verdict(src, pg_temp.w07_ticket(issued, src), inactive);
  reset role;
  select count(*) into n from api_private.billing_transfers where event_id in ('w07-a3', 'w07-a3-twin') and state = 'confirmed';
  if n <> 2 then
    raise exception 'BREAK A3: one source loss must settle both twin transfers, confirmed=%', n;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'BREAK A3: destination not premium after both twins settled';
  end if;
  select count(*) into n from api_private.billing_transfer_sides where user_id = dst and role = 'destination' and applied_at is null;
  if n <> 0 then
    raise exception 'BREAK A3: % destination sides left open after settlement', n;
  end if;
  perform pg_temp.w07_record('A3 replay and twins', 'PASS', 'replay idempotent, conflicting payload 22023, twin events settled by one source loss');
exception
  when others then
    perform pg_temp.w07_record('A3 replay and twins', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A4. Barrier core through the shipping sequence: the destination verdict
--     arrives first, the webhook cannot complete, the source loss releases it.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  src uuid := pg_temp.w07_user('0401', 'w07a4-src@example.test');
  dst uuid := pg_temp.w07_user('0402', 'w07a4-dst@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a4', array[src::text], array[dst::text]);
  lease uuid; issued jsonb; r jsonb;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a4', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-a4', payload, lease);
  r := public.persist_billing_verdict(dst, pg_temp.w07_ticket(issued, dst), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean or (r->'billing'->>'premium')::boolean then
    raise exception 'BREAK A4: destination gained before source confirmation: %', r;
  end if;
  reset role;
  if exists (select 1 from public.billing_entitlements where user_id = dst) then
    raise exception 'BREAK A4: a withheld destination has an entitlement row';
  end if;
  set local role service_role;
  begin
    r := public.complete_billing_webhook('w07-a4', payload, pg_temp.w07_tickets(issued), lease);
    raise exception 'BREAK A4: webhook completed while the destination was withheld: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '55000' then raise exception 'BREAK A4: completion raised % instead of 55000', sqlstate; end if;
  end;
  r := public.persist_billing_verdict(src, pg_temp.w07_ticket(issued, src), inactive);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean then
    raise exception 'BREAK A4: source loss not applied: %', r;
  end if;
  reset role;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium and expires_at > clock_timestamp()) then
    raise exception 'BREAK A4: destination not premium after the source confirmed loss';
  end if;
  set local role service_role;
  r := public.complete_billing_webhook('w07-a4', payload, pg_temp.w07_tickets(issued), lease);
  if not (r->>'received')::boolean then
    raise exception 'BREAK A4: completion failed after settlement: %', r;
  end if;
  reset role;
  perform pg_temp.w07_record('A4 barrier core', 'PASS', 'destination withheld (no row, completion 55000) until source loss; then premium and completed');
exception
  when others then
    perform pg_temp.w07_record('A4 barrier core', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A5a. Held-transfer starvation on a single-destination transfer.
--      Account switch S -> D -> S on one device: the stale S->D TRANSFER is
--      delivered after the switch back, so the provider reports S active and
--      D inactive -> the transfer is 'held'. D later buys its own
--      subscription (INITIAL_PURCHASE for D alone); the provider confirms D
--      active on D's own ticket. S holds a LIFETIME product, so the held
--      transfer never lapses.
--      Expected: D's own confirmed purchase is honoured (the held transfer
--      has nothing to grant D and must not bar D's independent purchase), and
--      D's INITIAL_PURCHASE delivery completes.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('0501', 'w07a5a-s@example.test');
  d uuid := pg_temp.w07_user('0502', 'w07a5a-d@example.test');
  stale jsonb := pg_temp.w07_transfer('w07-a5a-stale', array[s::text], array[d::text]);
  purchase jsonb := jsonb_build_object('event', jsonb_build_object('id', 'w07-a5a-buy', 'type', 'INITIAL_PURCHASE', 'app_user_id', d::text));
  lifetime jsonb := jsonb_build_object('premium', true, 'productKey', 'pickle_sensei_pro_lifetime',
    'expiresAt', null, 'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid; issued jsonb; r jsonb; completion text; retry jsonb;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a5a-stale', stale)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a5a-stale', stale, lease);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), lifetime);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), inactive);
  r := public.complete_billing_webhook('w07-a5a-stale', stale, pg_temp.w07_tickets(issued), lease);
  if not (r->>'received')::boolean then
    raise exception 'BREAK A5a: held transfer delivery could not complete: %', r;
  end if;
  -- D buys a subscription of its own: INITIAL_PURCHASE webhook for D alone
  lease := (public.claim_billing_webhook_delivery('w07-a5a-buy', purchase)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[d], 'w07-a5a-buy', purchase, lease);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  begin
    completion := public.complete_billing_webhook('w07-a5a-buy', purchase, pg_temp.w07_tickets(issued), lease)::text;
  exception when others then
    completion := 'raised ' || sqlstate || ' ' || sqlerrm;
  end;
  -- a redelivery of D's own purchase (what RevenueCat does after a 5xx) fares no better
  retry := public.persist_billing_verdict(d, pg_temp.w07_ticket(public.begin_billing_verification(array[d]), d),
    pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  reset role;
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean
     or completion like 'raised%' or not (retry->>'applied')::boolean
     or not exists (select 1 from public.billing_entitlements where user_id = d and premium) then
    raise exception 'BREAK A5a: D''s own provider-confirmed INITIAL_PURCHASE is withheld by a held stale transfer whose source holds a lifetime product: verdict=% completion=% retry=% row=% recovery=%',
      r, completion, retry,
      (select to_jsonb(e) from public.billing_entitlements e where user_id = d),
      public.billing_transfer_recovery(d);
  end if;
  perform pg_temp.w07_record('A5a held starvation (single destination)', 'PASS', 'independent purchase applied despite held stale transfer');
exception
  when others then
    perform pg_temp.w07_record('A5a held starvation (single destination)', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A5b. Already-applied destination re-barred. S -> [D1, D2]; S confirmed
--      lost, D1 confirmed and APPLIED through this transfer, D2 never syncs.
--      S later buys a new subscription (legitimate, unrelated). Expected: D1's
--      renewal (provider-confirmed) applies — D1's side is already settled.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('0511', 'w07a5b-s@example.test');
  d1 uuid := pg_temp.w07_user('0512', 'w07a5b-d1@example.test');
  d2 uuid := pg_temp.w07_user('0513', 'w07a5b-d2@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a5b', array[s::text], array[d1::text, d2::text]);
  lease uuid; issued jsonb; r jsonb; e record;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a5b', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d1, d2], 'w07-a5b', payload, lease);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), inactive);
  r := public.persist_billing_verdict(d1, pg_temp.w07_ticket(issued, d1), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean then
    raise exception 'BREAK A5b: D1 not applied after source loss: %', r;
  end if;
  -- S re-subscribes on its own account
  issued := public.begin_billing_verification(array[s]);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), pg_temp.w07_active(clock_timestamp() + interval '300 days'));
  -- D1 renews
  issued := public.begin_billing_verification(array[d1]);
  r := public.persist_billing_verdict(d1, pg_temp.w07_ticket(issued, d1), pg_temp.w07_active(clock_timestamp() + interval '60 days'));
  reset role;
  select * into e from public.billing_entitlements where user_id = d1;
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean
     or e.expires_at < clock_timestamp() + interval '59 days' then
    raise exception 'BREAK A5b: renewal of an already-applied destination withheld after the source re-subscribed: % / row expires % / recovery %',
      r, e.expires_at, public.billing_transfer_recovery(d1);
  end if;
  perform pg_temp.w07_record('A5b applied destination re-barred', 'PASS', 'renewal applied');
exception
  when others then
    perform pg_temp.w07_record('A5b applied destination re-barred', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A6. Mutual hold: S->D and D->S both unsettled and the provider reports both
--     active (each holds purchases of their own). Expected: at least the
--     side the provider confirms active on its own account is not starved
--     forever; concretely neither confirmed-active user may end non-premium
--     with no path to premium other than the other user's expiry.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('0601', 'w07a6-s@example.test');
  d uuid := pg_temp.w07_user('0602', 'w07a6-d@example.test');
  t1 jsonb := pg_temp.w07_transfer('w07-a6-t1', array[s::text], array[d::text]);
  t2 jsonb := pg_temp.w07_transfer('w07-a6-t2', array[d::text], array[s::text]);
  lease1 uuid; lease2 uuid; issued1 jsonb; issued2 jsonb; rs jsonb; rd jsonb;
begin
  set local role service_role;
  lease1 := (public.claim_billing_webhook_delivery('w07-a6-t1', t1)->>'lease_token')::uuid;
  issued1 := public.begin_billing_verification(array[s, d], 'w07-a6-t1', t1, lease1);
  lease2 := (public.claim_billing_webhook_delivery('w07-a6-t2', t2)->>'lease_token')::uuid;
  issued2 := public.begin_billing_verification(array[d, s], 'w07-a6-t2', t2, lease2);
  rs := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued1, s), pg_temp.w07_active(clock_timestamp() + interval '300 days'));
  rd := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued1, d), pg_temp.w07_active(clock_timestamp() + interval '300 days'));
  rs := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued2, s), pg_temp.w07_active(clock_timestamp() + interval '300 days'));
  rd := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued2, d), pg_temp.w07_active(clock_timestamp() + interval '300 days'));
  reset role;
  if not exists (select 1 from public.billing_entitlements where user_id = s and premium)
     and not exists (select 1 from public.billing_entitlements where user_id = d and premium) then
    raise exception 'BREAK A6: both provider-confirmed-active users are non-premium (mutual hold): s=% d=% recovery=%',
      rs, rd, public.billing_transfer_recovery(s);
  end if;
  perform pg_temp.w07_record('A6 mutual hold', 'PASS', 'at least one confirmed-active user premium');
exception
  when others then
    perform pg_temp.w07_record('A6 mutual hold', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A7. Clock boundaries on the source verdict: far-future expiry holds,
--     infinity is refused, a past expiry is not a live source, an expiry that
--     lapses while the transfer is held releases the destination without any
--     further source confirmation (documented behaviour, asserted so a
--     change shows up).
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('0701', 'w07a7-s@example.test');
  d uuid := pg_temp.w07_user('0702', 'w07a7-d@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a7', array[s::text], array[d::text]);
  lease uuid; issued jsonb; r jsonb;
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a7', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a7', payload, lease);
  begin
    r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), pg_temp.w07_active('infinity'::timestamptz));
    raise exception 'BREAK A7: infinite expiry accepted: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '22023' then raise exception 'BREAK A7: infinity raised %', sqlstate; end if;
  end;
  begin
    r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), pg_temp.w07_active(clock_timestamp()) || '{"expiresAt":"not-a-time"}'::jsonb);
    raise exception 'BREAK A7: garbage expiry accepted: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate not in ('22007', '22023', '22008') then raise exception 'BREAK A7: garbage expiry raised %', sqlstate; end if;
  end;
  -- far-future active source: destination must stay withheld
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), pg_temp.w07_active('9999-12-31T00:00:00Z'::timestamptz));
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'withheld')::boolean or r->'transfer'->>'state' <> 'held' then
    raise exception 'BREAK A7: far-future active source did not hold: %', r;
  end if;
  -- source re-verifies with an expiry 1.5s ahead (still active): still held
  issued := public.begin_billing_verification(array[s]);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), pg_temp.w07_active(clock_timestamp() + interval '1500 milliseconds'));
  issued := public.begin_billing_verification(array[d]);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'withheld')::boolean then
    raise exception 'BREAK A7: source active for 1.5s more but destination applied: %', r;
  end if;
  perform pg_sleep(1.6);
  -- the recorded source expiry has lapsed; the next destination sync applies
  -- with no fresh source verdict (provider confirmed the expiry date itself)
  issued := public.begin_billing_verification(array[d]);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  reset role;
  if (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'BREAK A7: destination still withheld after the source expiry lapsed: %', r;
  end if;
  if not exists (select 1 from api_private.billing_transfers where event_id = 'w07-a7' and state = 'confirmed') then
    raise exception 'BREAK A7: transfer not confirmed after the source expiry lapsed';
  end if;
  -- source: active with an expiry already in the past must not be a live source
  perform pg_temp.w07_record('A7 clock boundaries', 'PASS', 'infinity/garbage 22023, far-future holds, lapse releases without new source verdict');
exception
  when others then
    perform pg_temp.w07_record('A7 clock boundaries', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A8. Corrupt / partially persisted history: every mutation of settled or
--     audited state must be refused, even for the table owner; row-level
--     TRUNCATE by the owner is recorded for the report.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('0801', 'w07a8-s@example.test');
  d uuid := pg_temp.w07_user('0802', 'w07a8-d@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a8', array[s::text], array[d::text]);
  lease uuid; issued jsonb; r jsonb; tid uuid;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  stmt text;
  stmts text[];
  refused int := 0;
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a8', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a8', payload, lease);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), inactive);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  reset role;
  select id into strict tid from api_private.billing_transfers where event_id = 'w07-a8' and state = 'confirmed';
  stmts := array[
    format('delete from api_private.billing_transfers where id = %L', tid),
    format('delete from api_private.billing_transfer_sides where transfer_id = %L', tid),
    format('delete from api_private.billing_transfer_audit where transfer_id = %L', tid),
    format('update api_private.billing_transfers set state = ''pending'', settled_at = null where id = %L', tid),
    format('update api_private.billing_transfers set event_id = ''w07-a8-renamed'' where id = %L', tid),
    format('update api_private.billing_transfers set payload_hash = sha256(''x''::bytea) where id = %L', tid),
    format('update api_private.billing_transfers set enqueued_at = now() - interval ''1 year'' where id = %L', tid),
    format('update api_private.billing_transfer_sides set applied_at = null where transfer_id = %L and role = ''destination''', tid),
    format('update api_private.billing_transfer_sides set verdict = ''{"premium":false}'' where transfer_id = %L and role = ''destination''', tid),
    format('update api_private.billing_transfer_sides set role = ''source'' where transfer_id = %L and role = ''destination''', tid),
    format('update api_private.billing_transfer_sides set user_id = %L where transfer_id = %L and role = ''source''', d, tid),
    format('update api_private.billing_transfer_audit set action = ''held'' where transfer_id = %L', tid),
    format('update api_private.billing_transfer_audit set detail = ''{}'' where transfer_id = %L', tid)
  ];
  foreach stmt in array stmts loop
    begin
      execute stmt;
      raise exception 'BREAK A8: owner mutated settled history: %', stmt;
    exception when others then
      if sqlerrm like 'BREAK%' then raise; end if;
      refused := refused + 1;
    end;
  end loop;
  if refused <> cardinality(stmts) then
    raise exception 'BREAK A8: % of % mutations refused', refused, cardinality(stmts);
  end if;
  perform pg_temp.w07_record('A8 history guards', 'PASS', format('%s owner mutations of settled/audit rows refused', refused));
exception
  when others then
    perform pg_temp.w07_record('A8 history guards', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- Owner TRUNCATE bypasses row triggers by design; recorded as a fact (not a
-- client path) so the report can weigh it.
begin;
do $$
begin
  truncate api_private.billing_transfer_audit;
  raise exception 'INFO A8t: owner TRUNCATE of billing_transfer_audit succeeded (row triggers do not fire)';
exception
  when others then
    if sqlerrm like 'INFO%' then
      perform pg_temp.w07_record('A8t owner truncate', 'PASS', sqlerrm || ' -- privileged owner only, rolled back');
    else
      perform pg_temp.w07_record('A8t owner truncate', 'PASS', 'truncate refused: ' || sqlerrm);
    end if;
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A9. Source deleted while the transfer is HELD (source verified active,
--     then the account is deleted): the destination must be released on its
--     next sync and the deletion audited as source_missing{verified:true}.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('0901', 'w07a9-s@example.test');
  d uuid := pg_temp.w07_user('0902', 'w07a9-d@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a9', array[s::text], array[d::text]);
  lease uuid; issued jsonb; r jsonb;
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a9', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a9', payload, lease);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), pg_temp.w07_active(clock_timestamp() + interval '300 days'));
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if r->'transfer'->>'state' <> 'held' then
    raise exception 'BREAK A9: precondition failed, transfer not held: %', r;
  end if;
  reset role;
  delete from auth.users where id = s;
  set local role service_role;
  issued := public.begin_billing_verification(array[d]);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  reset role;
  if (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'BREAK A9: destination still withheld after the held source was deleted: %', r;
  end if;
  if not exists (select 1 from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id
                 where t.event_id = 'w07-a9' and a.action = 'source_missing' and (a.detail->>'verified')::boolean) then
    raise exception 'BREAK A9: deleted held source not audited as source_missing{verified:true}';
  end if;
  perform pg_temp.w07_record('A9 held source deleted', 'PASS', 'released and audited');
exception
  when others then
    perform pg_temp.w07_record('A9 held source deleted', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A10. Concurrency through dblink sessions: (a) source and destination
--      verdicts of one transfer persisted simultaneously; (b) a second
--      TRANSFER sharing the destination enqueued while the first source's
--      verdict is persisting. No deadlock (40P01), no lost write, final
--      state confirmed with the destination premium exactly once.
-- ----------------------------------------------------------------------------
create extension if not exists dblink;
create temp table w07_a10_setup (lease uuid, lease2 uuid, issued jsonb);
begin;
do $$
declare
  s uuid := pg_temp.w07_user('1001', 'w07a10-s@example.test');
  d uuid := pg_temp.w07_user('1002', 'w07a10-d@example.test');
  s2 uuid := pg_temp.w07_user('1003', 'w07a10-s2@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a10', array[s::text], array[d::text]);
  payload2 jsonb := pg_temp.w07_transfer('w07-a10-b', array[s2::text], array[d::text]);
  lease uuid; lease2 uuid; issued jsonb;
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a10', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a10', payload, lease);
  lease2 := (public.claim_billing_webhook_delivery('w07-a10-b', payload2)->>'lease_token')::uuid;
  reset role;
  insert into w07_a10_setup values (lease, lease2, issued);
end $$;
commit;
-- the dblink sessions only see committed state, hence the separate block
begin;
do $$
declare
  dsn text := current_setting('w07.dsn', true);
  s uuid := '00000000-0000-4000-8000-0000000a1001';
  d uuid := '00000000-0000-4000-8000-0000000a1002';
  s2 uuid := '00000000-0000-4000-8000-0000000a1003';
  payload2 jsonb := pg_temp.w07_transfer('w07-a10-b', array[s2::text], array[d::text]);
  setup w07_a10_setup%rowtype;
  issued jsonb; lease2 uuid;
  q1 text; q2 text; q3 text;
  res1 text; res2 text; res3 text;
  n int; premium_rows int;
  inactive text := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  if coalesce(dsn, '') = '' then
    perform pg_temp.w07_record('A10 concurrency', 'SKIPPED', 'w07_dsn not provided; concurrency attacks NOT run');
    return;
  end if;
  select * into strict setup from w07_a10_setup;
  issued := setup.issued;
  lease2 := setup.lease2;
  perform dblink_connect('c1', dsn);
  perform dblink_connect('c2', dsn);
  perform dblink_connect('c3', dsn);
  q1 := format('begin; set local role service_role; select public.persist_billing_verdict(%L, %L, %L::jsonb)::text; select pg_sleep(0.3); commit;',
    s, pg_temp.w07_ticket(issued, s), inactive);
  q2 := format('begin; set local role service_role; select public.persist_billing_verdict(%L, %L, %L::jsonb)::text; select pg_sleep(0.3); commit;',
    d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days')::text);
  q3 := format('begin; set local role service_role; select public.begin_billing_verification(array[%L::uuid, %L::uuid], %L, %L::jsonb, %L::uuid)::text; select pg_sleep(0.3); commit;',
    s2, d, 'w07-a10-b', payload2::text, lease2);
  perform dblink_send_query('c1', q1);
  perform dblink_send_query('c2', q2);
  perform dblink_send_query('c3', q3);
  -- drain every result set (multi-statement scripts return several)
  loop
    select string_agg(t, ' ') into res1 from dblink_get_result('c1') as x(t text);
    exit when res1 is null;
  end loop;
  loop
    select string_agg(t, ' ') into res2 from dblink_get_result('c2') as x(t text);
    exit when res2 is null;
  end loop;
  loop
    select string_agg(t, ' ') into res3 from dblink_get_result('c3') as x(t text);
    exit when res3 is null;
  end loop;
  if dblink_error_message('c1') <> 'OK' or dblink_error_message('c2') <> 'OK' or dblink_error_message('c3') <> 'OK' then
    raise exception 'BREAK A10: concurrent session failed: c1=% c2=% c3=%',
      dblink_error_message('c1'), dblink_error_message('c2'), dblink_error_message('c3');
  end if;
  perform dblink_disconnect('c1');
  perform dblink_disconnect('c2');
  perform dblink_disconnect('c3');
  select count(*) into n from api_private.billing_transfers where event_id = 'w07-a10' and state = 'confirmed';
  if n <> 1 then
    raise exception 'BREAK A10: first transfer not confirmed after concurrent verdicts';
  end if;
  select count(*) into premium_rows from public.billing_entitlements where user_id = d and premium;
  if premium_rows <> 1 then
    raise exception 'BREAK A10: destination premium rows = %', premium_rows;
  end if;
  select count(*) into n from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id
    where t.event_id = 'w07-a10' and a.action = 'destination_applied';
  if n <> 1 then
    raise exception 'BREAK A10: destination_applied audited % times', n;
  end if;
  if not exists (select 1 from api_private.billing_transfers where event_id = 'w07-a10-b' and state = 'pending') then
    raise exception 'BREAK A10: concurrently enqueued second transfer missing or not pending';
  end if;
  perform pg_temp.w07_record('A10 concurrency', 'PASS', 'no deadlock; confirmed once; destination premium once; second transfer pending');
exception
  when others then
    begin perform dblink_disconnect('c1'); exception when others then null; end;
    begin perform dblink_disconnect('c2'); exception when others then null; end;
    begin perform dblink_disconnect('c3'); exception when others then null; end;
    perform pg_temp.w07_record('A10 concurrency', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A11. Stale ticket replay after settlement: replaying the destination's
--      original (withheld) ticket verdict after the transfer confirmed must
--      be idempotent — no second application, no extra audit rows, no
--      regression of the stored row.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('1101', 'w07a11-s@example.test');
  d uuid := pg_temp.w07_user('1102', 'w07a11-d@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a11', array[s::text], array[d::text]);
  lease uuid; issued jsonb; r jsonb; verdict jsonb;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  before_audit int; after_audit int; before_order bigint; after_order bigint;
begin
  set local role service_role;
  verdict := pg_temp.w07_active(clock_timestamp() + interval '30 days');
  lease := (public.claim_billing_webhook_delivery('w07-a11', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a11', payload, lease);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), verdict);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), inactive);
  -- destination renews once more so the stored row outranks the ticket
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(public.begin_billing_verification(array[d]), d),
    pg_temp.w07_active(clock_timestamp() + interval '60 days'));
  reset role;
  select count(*) into before_audit from api_private.billing_transfer_audit;
  select verification_order into before_order from public.billing_entitlements where user_id = d;
  set local role service_role;
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), verdict);
  reset role;
  select count(*) into after_audit from api_private.billing_transfer_audit;
  select verification_order into after_order from public.billing_entitlements where user_id = d;
  if (r->>'withheld')::boolean or (r->>'applied')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'BREAK A11: stale ticket replay changed the outcome: %', r;
  end if;
  if after_audit <> before_audit or after_order <> before_order then
    raise exception 'BREAK A11: stale replay wrote audit (% -> %) or moved the row order (% -> %)', before_audit, after_audit, before_order, after_order;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = d and expires_at > clock_timestamp() + interval '59 days') then
    raise exception 'BREAK A11: stale replay regressed the stored expiry';
  end if;
  -- a conflicting verdict on the same ticket must still be refused
  set local role service_role;
  begin
    r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), inactive);
    raise exception 'BREAK A11: conflicting replay accepted: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '22023' then raise exception 'BREAK A11: conflicting replay raised %', sqlstate; end if;
  end;
  reset role;
  perform pg_temp.w07_record('A11 stale ticket replay', 'PASS', 'idempotent, no audit growth, conflicting replay 22023');
exception
  when others then
    perform pg_temp.w07_record('A11 stale ticket replay', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A12. Source with an Auth user but no profile row (partially persisted
--      account): the source can never be verified (23503), so the destination
--      is barred indefinitely; the recovery view must at least expose it.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('1201', 'w07a12-s@example.test');
  d uuid := pg_temp.w07_user('1202', 'w07a12-d@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a12', array[s::text], array[d::text]);
  lease uuid; issued jsonb; r jsonb;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  delete from public.profiles where id = s;
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a12', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a12', payload, lease);
  begin
    r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), inactive);
    raise exception 'INFO A12: profile-less source verdict persisted: %', r;
  exception when others then
    if sqlerrm like 'INFO%' then raise; end if;
    if sqlstate <> '23503' then raise exception 'BREAK A12: profile-less source raised %', sqlstate; end if;
  end;
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'withheld')::boolean then
    raise exception 'BREAK A12: destination applied although the source was never verified: %', r;
  end if;
  r := public.billing_transfer_recovery(d);
  reset role;
  if jsonb_array_length(r) <> 1 or (r->0->'sources'->0->>'verified')::boolean then
    raise exception 'BREAK A12: recovery does not expose the unverifiable source: %', r;
  end if;
  perform pg_temp.w07_record('A12 profile-less source', 'PASS', 'source unverifiable (23503, base behaviour); destination withheld and visible in recovery');
exception
  when others then
    perform pg_temp.w07_record('A12 profile-less source', case when sqlerrm like 'BREAK%' then 'BREAK' when sqlerrm like 'INFO%' then 'PASS' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A14. Process death between steps: the isolate verifies the source (lost)
--      and dies before the destination's verdict / completion; the lease
--      lapses, RevenueCat redelivers, a fresh lease and fresh tickets are
--      issued. Expected: the redelivery completes with the destination
--      premium exactly once, one transfer row, confirmed once, and the
--      queue does not fork under the new lease.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  s uuid := pg_temp.w07_user('1401', 'w07a14-s@example.test');
  d uuid := pg_temp.w07_user('1402', 'w07a14-d@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a14', array[s::text], array[d::text]);
  lease uuid; lease2 uuid; issued jsonb; issued2 jsonb; r jsonb; claim jsonb;
  n int; confirmed int;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a14', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'w07-a14', payload, lease);
  -- destination verdict first (withheld), then the source is confirmed lost,
  -- then the isolate dies before complete_billing_webhook
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'withheld')::boolean then raise exception 'BREAK A14: destination not withheld before source loss: %', r; end if;
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued, s), inactive);
  -- a second delivery attempt while the lease is live must be refused
  claim := public.claim_billing_webhook_delivery('w07-a14', payload);
  if claim->>'outcome' <> 'in_progress' then raise exception 'BREAK A14: live lease re-claimed: %', claim; end if;
  reset role;
  -- time passes: the lease and the visibility window lapse
  update api_private.billing_webhook_claims set lease_expires_at = clock_timestamp() - interval '1 second' where event_id = 'w07-a14';
  update public.webhook_events set claimed_at = clock_timestamp() - interval '6 minutes' where id = 'w07-a14';
  set local role service_role;
  claim := public.claim_billing_webhook_delivery('w07-a14', payload);
  if claim->>'outcome' <> 'claimed' then raise exception 'BREAK A14: lapsed lease not reclaimable: %', claim; end if;
  lease2 := (claim->>'lease_token')::uuid;
  -- the old lease is dead: nothing may be persisted or completed under it
  begin
    r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
    raise exception 'BREAK A14: stale-lease ticket still accepted a verdict: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '55000' then raise exception 'BREAK A14: stale-lease verdict raised % instead of 55000', sqlstate; end if;
  end;
  begin
    r := public.complete_billing_webhook('w07-a14', payload, pg_temp.w07_tickets(issued), lease);
    raise exception 'BREAK A14: completion under the dead lease accepted: %', r;
  exception when others then
    if sqlerrm like 'BREAK%' then raise; end if;
    if sqlstate <> '55000' then raise exception 'BREAK A14: dead-lease completion raised % instead of 55000', sqlstate; end if;
  end;
  issued2 := public.begin_billing_verification(array[s, d], 'w07-a14', payload, lease2);
  r := public.persist_billing_verdict(s, pg_temp.w07_ticket(issued2, s), inactive);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued2, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean then
    raise exception 'BREAK A14: destination not applied on redelivery after the source loss: %', r;
  end if;
  r := public.complete_billing_webhook('w07-a14', payload, pg_temp.w07_tickets(issued2), lease2);
  if not (r->>'received')::boolean then raise exception 'BREAK A14: redelivery could not complete: %', r; end if;
  reset role;
  select count(*) into n from api_private.billing_transfers where event_id = 'w07-a14';
  select count(*) into confirmed from api_private.billing_transfer_audit a
    join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-a14' and a.action = 'confirmed';
  if n <> 1 or confirmed <> 1
     or not exists (select 1 from api_private.billing_transfers where event_id = 'w07-a14' and state = 'confirmed')
     or not exists (select 1 from public.billing_entitlements where user_id = d and premium)
     or exists (select 1 from public.billing_entitlements where user_id = s and premium)
     or not exists (select 1 from public.webhook_events where id = 'w07-a14' and processed_at is not null) then
    raise exception 'BREAK A14: redelivery left % transfer rows, % confirmations, recovery %', n, confirmed, public.billing_transfer_recovery(d);
  end if;
  perform pg_temp.w07_record('A14 process death + redelivery', 'PASS', 'dead lease refused (55000), redelivery completed once, one transfer confirmed once');
exception
  when others then
    perform pg_temp.w07_record('A14 process death + redelivery', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- A13. Anonymous-only source ($RCAnonymousID) and destination-only transfer:
--      nothing to confirm, the destination must gain on its own verdict and
--      the transfer must not linger as a barrier.
-- ----------------------------------------------------------------------------
begin;
do $$
declare
  d uuid := pg_temp.w07_user('1301', 'w07a13-d@example.test');
  payload jsonb := pg_temp.w07_transfer('w07-a13', array['$RCAnonymousID:abcdef0123456789abcdef0123456789'], array[d::text]);
  lease uuid; issued jsonb; r jsonb;
begin
  set local role service_role;
  lease := (public.claim_billing_webhook_delivery('w07-a13', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[d], 'w07-a13', payload, lease);
  r := public.persist_billing_verdict(d, pg_temp.w07_ticket(issued, d), pg_temp.w07_active(clock_timestamp() + interval '30 days'));
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'BREAK A13: destination with an anonymous source withheld: %', r;
  end if;
  r := public.complete_billing_webhook('w07-a13', payload, pg_temp.w07_tickets(issued), lease);
  reset role;
  if exists (select 1 from api_private.billing_transfers where event_id = 'w07-a13' and state <> 'confirmed') then
    raise exception 'BREAK A13: anonymous-source transfer left unsettled';
  end if;
  perform pg_temp.w07_record('A13 anonymous source', 'PASS', 'destination applied; transfer confirmed; webhook completed');
exception
  when others then
    perform pg_temp.w07_record('A13 anonymous source', case when sqlerrm like 'BREAK%' then 'BREAK' else 'ERROR' end, sqlstate || ' ' || sqlerrm);
end $$;
commit;

-- ----------------------------------------------------------------------------
-- Report.
-- ----------------------------------------------------------------------------
\set QUIET off
\pset format aligned
select attack, outcome, left(detail, 160) as detail from w07_attack_results order by seq;
select outcome, count(*) from w07_attack_results group by outcome order by outcome;
-- full evidence for every non-PASS attack
\pset format unaligned
select 'FULL ' || attack || ': ' || detail from w07_attack_results where outcome <> 'PASS' order by seq;
\pset format aligned
do $$
declare n int;
begin
  select count(*) into n from w07_attack_results where outcome in ('BREAK', 'ERROR');
  if n > 0 then
    raise exception 'W07-03 attacks: % attack(s) broke or errored against the candidate', n;
  end if;
end $$;
