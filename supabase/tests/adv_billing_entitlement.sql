-- INT-billing-entitlement adversary (attacked head
-- 30a4065036a917514fb4984fde73f87867f38619). Database-layer attacks on the
-- ordered verification RPCs and public.billing_entitlements: expired premium
-- rows, provider clock skew in the reported verifiedAt, malformed verdict
-- shapes and client-role reachability. Runs after shim_auth.sql + every
-- migration (same preconditions as security_regression.sql):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/adv_billing_entitlement.sql
-- Every failure raises; a clean exit is the pass.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000ad01', 'adv-billing-1@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000ad02', 'adv-billing-2@example.test', '{"provider":"apple"}');

-- ADV-S1 expired premium row: a verified premium verdict whose expiry has
-- already passed is stored but is NOT premium anywhere the DB answers.
set local role service_role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000ad01';
  t uuid;
  r jsonb;
begin
  t := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(a, t, jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', to_char(clock_timestamp() - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro')));
  if r->>'outcome' <> 'persisted' or r->>'applied' <> 'true' then
    raise exception 'ADV-S1a: an expired-but-verified verdict must still persist (it is the newest truth)';
  end if;
  if (r->'billing'->>'premium')::boolean or r->'billing'->>'productKey' is not null
     or r->'billing'->>'expiresAt' is not null or r->'billing'->'activeEntitlements' <> '[]'::jsonb then
    raise exception 'ADV-S1b: the RPC answered premium for a row past expires_at: %', r->'billing';
  end if;
  if not (select premium from public.billing_entitlements where user_id = a) then
    raise exception 'ADV-S1c: the stored row keeps the provider premium flag; only the effective read is false';
  end if;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad01';
do $$
declare s record;
begin
  select * into s from public.access_state();
  if s.premium then
    raise exception 'ADV-S1d: access_state() must not report premium for an expired row';
  end if;
end $$;
reset role;

-- ADV-S2 provider clock skew in the REPORTED verifiedAt: far ahead / far
-- behind / infinite / garbage clocks never become the row's verified_at key.
set local role service_role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000ad01';
  t uuid;
  r jsonb;
  issued timestamptz;
  active jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":"2099-01-01T00:00:00.000Z","activeEntitlements":["pickle_sensei_pro"]}';
  before_row record;
begin
  -- one year ahead → clamped to the ticket's issue time
  t := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  issued := clock_timestamp();
  r := public.persist_billing_verdict(a, t, active || '{"verifiedAt":"2027-09-08T00:00:00Z"}'::jsonb);
  if (r->'billing'->>'verifiedAt')::timestamptz > issued + interval '5 seconds'
     or (r->'billing'->>'verifiedAt')::timestamptz < issued - interval '5 seconds' then
    raise exception 'ADV-S2a: a far-future provider clock became verified_at: %', r->'billing'->>'verifiedAt';
  end if;
  -- two days behind → clamped as well; the row must not go backwards
  t := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  issued := clock_timestamp();
  r := public.persist_billing_verdict(a, t, active || to_jsonb(jsonb_build_object(
    'verifiedAt', to_char(clock_timestamp() - interval '2 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
  if (r->'billing'->>'verifiedAt')::timestamptz < issued - interval '5 seconds' then
    raise exception 'ADV-S2b: a provider clock two days behind moved verified_at backwards: %', r->'billing'->>'verifiedAt';
  end if;
  -- four minutes ahead → within tolerance, trusted as the verdict clock
  t := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(a, t, active || to_jsonb(jsonb_build_object(
    'verifiedAt', to_char(clock_timestamp() + interval '4 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
  if (r->'billing'->>'verifiedAt')::timestamptz < clock_timestamp() + interval '3 minutes' then
    raise exception 'ADV-S2c: an in-tolerance provider clock must be the verdict clock: %', r->'billing'->>'verifiedAt';
  end if;
  select * into before_row from public.billing_entitlements where user_id = a;
  -- infinity / garbage are rejected before any write, and the row is untouched
  t := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  begin
    perform public.persist_billing_verdict(a, t, active || '{"verifiedAt":"infinity"}'::jsonb);
    raise exception 'ADV-S2d: verifiedAt=infinity must be rejected';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(a, t, active || '{"verifiedAt":"not-a-clock"}'::jsonb);
    raise exception 'ADV-S2e: an unparsable verifiedAt must be rejected';
  exception when invalid_datetime_format or invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(a, t, active || '{"verifiedAt":12345}'::jsonb);
    raise exception 'ADV-S2f: a numeric verifiedAt must be rejected';
  exception when invalid_parameter_value then null;
  end;
  if (select verification_order from public.billing_entitlements where user_id = a) <> before_row.verification_order
     or (select verified_at from public.billing_entitlements where user_id = a) <> before_row.verified_at then
    raise exception 'ADV-S2g: a rejected verdict mutated the entitlement row';
  end if;
end $$;
reset role;

-- ADV-S3 malformed verdict shapes: every inconsistent body is refused as
-- 22023 (so the edge fn fails closed) and nothing is written.
set local role service_role;
do $$
declare
  b uuid := '00000000-0000-4000-8000-00000000ad02';
  t uuid;
  bad jsonb;
  label text;
begin
  for label, bad in
    select * from (values
      ('premium without any entitlement',
       '{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":null,"activeEntitlements":[]}'::jsonb),
      ('non-premium carrying an expiry',
       '{"premium":false,"productKey":null,"expiresAt":"2099-01-01T00:00:00Z","activeEntitlements":[]}'::jsonb),
      ('non-premium carrying a product',
       '{"premium":false,"productKey":"pickle_sensei_pro_lifetime","expiresAt":null,"activeEntitlements":[]}'::jsonb),
      ('unknown entitlement name',
       '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pro"]}'::jsonb),
      ('entitlements but premium false',
       '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}'::jsonb),
      ('premium as string',
       '{"premium":"true","productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}'::jsonb),
      ('extra key smuggled in',
       '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"],"verificationOrder":9}'::jsonb),
      ('infinite expiry',
       '{"premium":true,"productKey":null,"expiresAt":"infinity","activeEntitlements":["pickle_sensei_pro"]}'::jsonb),
      ('array body', '[]'::jsonb),
      ('null body', 'null'::jsonb)
    ) as cases(label, body)
  loop
    t := (public.begin_billing_verification(array[b])->0->>'ticket_id')::uuid;
    begin
      perform public.persist_billing_verdict(b, t, bad);
      raise exception 'ADV-S3: % must be rejected', label;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  if exists (select 1 from public.billing_entitlements where user_id = b) then
    raise exception 'ADV-S3: a rejected verdict created an entitlement row';
  end if;
end $$;
reset role;

-- ADV-S4 client roles can neither drive the verification RPCs nor read or
-- write another account's entitlement row.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad02';
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000ad01';
  b uuid := '00000000-0000-4000-8000-00000000ad02';
begin
  begin
    perform public.begin_billing_verification(array[b]);
    raise exception 'ADV-S4a: authenticated must not issue verification tickets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.persist_billing_verdict(b, gen_random_uuid(),
      '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}');
    raise exception 'ADV-S4b: authenticated must not persist verdicts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_billing_webhook_delivery('adv-s4', '{"event":{"id":"adv-s4"}}');
    raise exception 'ADV-S4c: authenticated must not claim webhook deliveries';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.billing_entitlements where user_id = a) then
    raise exception 'ADV-S4d: another account''s entitlement row is visible';
  end if;
  begin
    delete from public.billing_entitlements where user_id = a;
    if found then
      raise exception 'ADV-S4e: another account''s entitlement row was deleted';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.begin_billing_verification(array['00000000-0000-4000-8000-00000000ad01'::uuid]);
    raise exception 'ADV-S4f: anon must not issue verification tickets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.billing_entitlements;
    raise exception 'ADV-S4g: anon must not read billing_entitlements';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
