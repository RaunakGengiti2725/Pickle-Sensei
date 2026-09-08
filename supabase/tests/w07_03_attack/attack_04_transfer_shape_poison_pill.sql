-- W07-03 attack A4 — boundary / duplicate-identity payload shapes on the
-- shipping webhook path. begin_billing_verification(uuid[],text,jsonb,uuid)
-- is the FIRST RPC the Edge webhook calls after claiming the delivery; any
-- error there is mapped to `retryable` -> 503 -> RevenueCat redelivers the
-- same event forever (nothing ever verifies its subjects, nothing marks it).
--
-- On BASE (api_private.billing_webhook_subjects) an id present in BOTH
-- transferred_from and transferred_to is simply deduplicated and verified once.
-- Each case below feeds begin_billing_verification exactly what the Edge would
-- send (its subjectIds set, deduplicated) and requires tickets to be issued
-- like BASE does. A raise below is a behaviour regression (poison-pill event).
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a401', 'w07a4-a@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a402', 'w07a4-b@example.test', '{"provider":"apple"}');

set local role service_role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000a401';
  b uuid := '00000000-0000-4000-8000-00000000a402';
  payload jsonb;
  lease uuid;
  issued jsonb;
  broken text[] := '{}';
  outcome text;
begin
  -- Case 1: alias overlap — the destination alias list repeats the source id.
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a4-overlap', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(a::text),
    'transferred_to', jsonb_build_array(a::text, b::text)));
  lease := (public.claim_billing_webhook_delivery('w07a4-overlap', payload)->>'lease_token')::uuid;
  begin
    issued := public.begin_billing_verification(array[a, b], 'w07a4-overlap', payload, lease);
    outcome := format('issued %s tickets', jsonb_array_length(issued));
  exception when others then
    outcome := format('raised %s %s', sqlstate, sqlerrm);
    broken := broken || format('W07-A4a: overlapping transfer aliases poison the delivery (%s)', outcome);
  end;
  raise notice 'W07-A4 case 1 (overlap) => %', outcome;

  -- Case 2: transferred_from delivered as a scalar string, transferred_to
  -- absent. BASE ignores the malformed field and verifies app_user_id.
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a4-scalar', 'type', 'TRANSFER', 'app_user_id', b::text,
    'transferred_from', a::text));
  lease := (public.claim_billing_webhook_delivery('w07a4-scalar', payload)->>'lease_token')::uuid;
  begin
    issued := public.begin_billing_verification(array[b], 'w07a4-scalar', payload, lease);
    outcome := format('issued %s tickets', jsonb_array_length(issued));
  exception when others then
    outcome := format('raised %s %s', sqlstate, sqlerrm);
    broken := broken || format('W07-A4b: a TRANSFER without array parties poisons the delivery (%s)', outcome);
  end;
  raise notice 'W07-A4 case 2 (scalar parties) => %', outcome;

  -- Case 3: 16 distinct uuid subjects across both arrays — the documented
  -- maximum — must still be accepted (no off-by-one in the new cap).
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a4-sixteen', 'type', 'TRANSFER',
    'transferred_from', (select jsonb_agg(format('00000000-0000-4000-8000-0000000004%s', lpad(i::text, 2, '0'))) from generate_series(1, 8) i),
    'transferred_to', (select jsonb_agg(format('00000000-0000-4000-8000-0000000004%s', lpad(i::text, 2, '0'))) from generate_series(9, 16) i)));
  lease := (public.claim_billing_webhook_delivery('w07a4-sixteen', payload)->>'lease_token')::uuid;
  begin
    issued := public.begin_billing_verification(
      (select array_agg(format('00000000-0000-4000-8000-0000000004%s', lpad(i::text, 2, '0'))::uuid) from generate_series(1, 16) i),
      'w07a4-sixteen', payload, lease);
    outcome := format('%s entries', jsonb_array_length(issued));
  exception when others then
    outcome := format('raised %s %s', sqlstate, sqlerrm);
    broken := broken || format('W07-A4c: 16 transfer subjects rejected (%s)', outcome);
  end;
  raise notice 'W07-A4 case 3 (sixteen subjects) => %', outcome;

  -- Case 4: uppercase + duplicated + anonymous ids normalise to one side each.
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07a4-normalise', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(upper(a::text), a::text, '$RCAnonymousID:abc', 42, null),
    'transferred_to', jsonb_build_array(upper(b::text), '$RCAnonymousID:def')));
  lease := (public.claim_billing_webhook_delivery('w07a4-normalise', payload)->>'lease_token')::uuid;
  begin
    issued := public.begin_billing_verification(array[a, b], 'w07a4-normalise', payload, lease);
    outcome := public.billing_transfer_recovery(a)::text;
    if jsonb_array_length(public.billing_transfer_recovery(a)) <> 1
       or jsonb_array_length(public.billing_transfer_recovery(a)->0->'sources') <> 1
       or jsonb_array_length(public.billing_transfer_recovery(a)->0->'destinations') <> 1 then
      broken := broken || format('W07-A4d: normalisation produced the wrong scope (%s)', outcome);
    end if;
  exception when others then
    outcome := format('raised %s %s', sqlstate, sqlerrm);
    broken := broken || format('W07-A4d: normalisable parties rejected (%s)', outcome);
  end;
  raise notice 'W07-A4 case 4 (normalise) => %', outcome;

  if cardinality(broken) > 0 then
    raise exception '%', array_to_string(broken, ' | ');
  end if;
end $$;
rollback;
