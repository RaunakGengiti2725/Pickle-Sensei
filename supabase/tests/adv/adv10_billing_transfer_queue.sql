-- ADV-10 — the RevenueCat TRANSFER queue (20260908150000) driven the way the
-- edge webhook drives it (claim → begin → persist → complete), as
-- service_role: a destination must not GAIN premium through any verdict path
-- (its own sync ticket or the transfer ticket) while the source is
-- unconfirmed; a source the provider still reports entitled parks the
-- transfer as held and nobody is fabricated into or out of premium; a source
-- confirmed inactive confirms the transfer and releases the recorded
-- destination verdict; a deleted source is authoritative absence; the lease,
-- replay and payload-conflict boundaries hold; recovery never fabricates;
-- the three api_private tables and their audit are unreachable/immutable.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000010a1','src@example.com','{}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000010b1','dst@example.com','{}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000010c1','src2@example.com','{}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000010d1','dst2@example.com','{}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000010e1','src3@example.com','{}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000010f1','dst3@example.com','{}','{"provider":"apple"}');
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at) values
 ('00000000-0000-4000-8000-0000000010a1', true, null, now() - interval '1 day'),
 ('00000000-0000-4000-8000-0000000010c1', true, null, now() - interval '1 day'),
 ('00000000-0000-4000-8000-0000000010e1', true, null, now() - interval '1 day');

create temp table adv10_bad (item text);
grant insert on adv10_bad to service_role, authenticated;
create function pg_temp.premium(p uuid) returns boolean language sql as $$
  select coalesce((select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b where b.user_id = p), false) $$;
grant execute on function pg_temp.premium(uuid) to service_role;

set local role service_role;

-- Scenario A: source confirmed inactive → transfer confirms → destination applied
do $$
declare
  s uuid := '00000000-0000-4000-8000-0000000010a1'; d uuid := '00000000-0000-4000-8000-0000000010b1';
  payload jsonb := jsonb_build_object('event', jsonb_build_object('id', 'adv10-a', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(s), 'transferred_to', jsonb_build_array(d)));
  active jsonb := '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid; issued jsonb; st uuid; dt uuid; own uuid; r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('adv10-a', payload)->>'lease_token')::uuid;
  -- wrong lease
  begin
    perform public.begin_billing_verification(array[s, d], 'adv10-a', payload, gen_random_uuid());
    insert into adv10_bad values ('stale_lease_accepted');
  exception when sqlstate '55000' then null;
  end;
  issued := public.begin_billing_verification(array[s, d], 'adv10-a', payload, lease);
  select (i->>'ticket_id')::uuid into st from jsonb_array_elements(issued) i where i->>'user_id' = s::text;
  select (i->>'ticket_id')::uuid into dt from jsonb_array_elements(issued) i where i->>'user_id' = d::text;
  if public.billing_transfer_recovery(d)->0->>'state' <> 'pending' then insert into adv10_bad values ('recovery_not_pending'); end if;

  -- the destination's OWN sync ticket, provider says active: barred
  own := (public.begin_billing_verification(array[d])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(d, own, active);
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean or pg_temp.premium(d) then
    insert into adv10_bad values ('destination_gained_via_own_sync:' || r::text);
  end if;
  -- the transfer's own destination ticket: barred too
  r := public.persist_billing_verdict(d, dt, active);
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean or pg_temp.premium(d) then
    insert into adv10_bad values ('destination_gained_via_transfer_ticket:' || r::text);
  end if;
  -- webhook cannot complete while the destination is withheld
  begin
    perform public.complete_billing_webhook('adv10-a', payload, jsonb_build_object(s::text, st, d::text, dt), lease);
    insert into adv10_bad values ('completed_while_withheld');
  exception when object_not_in_prerequisite_state or invalid_parameter_value then null;
  end;
  if pg_temp.premium(d) or not pg_temp.premium(s) then insert into adv10_bad values ('premium_moved_before_source_confirmed'); end if;

  -- source confirmed inactive: source loses now, transfer confirms, recorded destination verdict applies
  r := public.persist_billing_verdict(s, st, inactive);
  if pg_temp.premium(s) then insert into adv10_bad values ('source_kept_premium_after_inactive'); end if;
  if not pg_temp.premium(d) then insert into adv10_bad values ('destination_not_released_after_source_confirmed'); end if;
  if public.billing_transfer_recovery(d) <> '[]'::jsonb then insert into adv10_bad values ('confirmed_transfer_still_in_recovery'); end if;
  r := public.complete_billing_webhook('adv10-a', payload, jsonb_build_object(s::text, st, d::text, dt), lease);
  if r->>'verified' <> 'true' then insert into adv10_bad values ('complete_after_repair=' || r::text); end if;

  -- replay of the same delivery is a duplicate, not a second transfer
  r := public.claim_billing_webhook_delivery('adv10-a', payload);
  if r->>'outcome' not in ('duplicate', 'completed', 'verified') then insert into adv10_bad values ('replay_claim=' || r::text); end if;
  -- same event id, different payload: conflict, never a second queue row
  begin
    perform public.claim_billing_webhook_delivery('adv10-a', jsonb_set(payload, '{event,transferred_to}', jsonb_build_array('00000000-0000-4000-8000-0000000010d1')));
    perform public.begin_billing_verification(array[s, '00000000-0000-4000-8000-0000000010d1'::uuid], 'adv10-a',
      jsonb_set(payload, '{event,transferred_to}', jsonb_build_array('00000000-0000-4000-8000-0000000010d1')), lease);
    insert into adv10_bad values ('conflicting_payload_requeued');
  exception when invalid_parameter_value or sqlstate '55000' or object_not_in_prerequisite_state then null;
  end;
  if pg_temp.premium('00000000-0000-4000-8000-0000000010d1') then insert into adv10_bad values ('bystander_gained_premium'); end if;
end $$;

-- Scenario B: provider still reports the source entitled → held; each side mirrors the provider's own answer
do $$
declare
  s uuid := '00000000-0000-4000-8000-0000000010c1'; d uuid := '00000000-0000-4000-8000-0000000010d1';
  payload jsonb := jsonb_build_object('event', jsonb_build_object('id', 'adv10-b', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(s), 'transferred_to', jsonb_build_array(d)));
  active jsonb := '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  lease uuid; issued jsonb; st uuid; dt uuid; r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('adv10-b', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'adv10-b', payload, lease);
  select (i->>'ticket_id')::uuid into st from jsonb_array_elements(issued) i where i->>'user_id' = s::text;
  select (i->>'ticket_id')::uuid into dt from jsonb_array_elements(issued) i where i->>'user_id' = d::text;
  r := public.persist_billing_verdict(d, dt, active);
  r := public.persist_billing_verdict(s, st, active);
  if not pg_temp.premium(s) then insert into adv10_bad values ('held_source_lost_premium'); end if;
  -- held: both accounts mirror exactly what the provider confirmed for each of them (the migration's contract)
  if not pg_temp.premium(d) then insert into adv10_bad values ('held_destination_own_verdict_withheld'); end if;
  r := public.billing_transfer_recovery(d);
  if r->0->>'state' <> 'held' then insert into adv10_bad values ('held_not_reported=' || r::text); end if;
  if public.billing_transfer_recovery(s)->0->>'state' <> 'held' then insert into adv10_bad values ('held_not_reported_for_source'); end if;
end $$;

-- Scenario C: the source account is deleted mid-flight → authoritative absence → destination applies
do $$
declare
  s uuid := '00000000-0000-4000-8000-0000000010e1'; d uuid := '00000000-0000-4000-8000-0000000010f1';
  payload jsonb := jsonb_build_object('event', jsonb_build_object('id', 'adv10-c', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(s), 'transferred_to', jsonb_build_array(d)));
  active jsonb := '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  lease uuid; issued jsonb; dt uuid; r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('adv10-c', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[s, d], 'adv10-c', payload, lease);
  select (i->>'ticket_id')::uuid into dt from jsonb_array_elements(issued) i where i->>'user_id' = d::text;
  r := public.persist_billing_verdict(d, dt, active);
  if pg_temp.premium(d) then insert into adv10_bad values ('c_destination_gained_early'); end if;
  perform set_config('adv10.c_dt', dt::text, true);
  perform set_config('adv10.c_lease', lease::text, true);
end $$;
reset role;
delete from auth.users where id = '00000000-0000-4000-8000-0000000010e1';
set local role service_role;
do $$
declare
  s uuid := '00000000-0000-4000-8000-0000000010e1'; d uuid := '00000000-0000-4000-8000-0000000010f1';
  active jsonb := '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  r jsonb; st uuid;
begin
  -- the provider is asked about the deleted source: begin() reports user_missing, and the transfer settles
  r := public.begin_billing_verification(array[s]);
  if r->0->>'outcome' <> 'user_missing' then insert into adv10_bad values ('deleted_source_not_missing=' || r::text); end if;
  r := public.billing_transfer_recovery(d);
  if r <> '[]'::jsonb and not pg_temp.premium(d) then
    -- still open: the barrier must release once the source side is marked missing; try the destination again
    r := public.persist_billing_verdict(d, current_setting('adv10.c_dt')::uuid, active);
  end if;
  if not pg_temp.premium(d) then insert into adv10_bad values ('c_destination_never_applied:' || public.billing_transfer_recovery(d)::text); end if;
end $$;

-- boundaries
do $$
declare r jsonb;
begin
  begin
    perform public.billing_transfer_recovery(null);
    insert into adv10_bad values ('recovery_null_accepted');
  exception when invalid_parameter_value then null;
  end;
  if public.billing_transfer_recovery(gen_random_uuid()) <> '[]'::jsonb then insert into adv10_bad values ('recovery_fabricated'); end if;
  -- a transfer to oneself has no subjects
  r := public.claim_billing_webhook_delivery('adv10-self', '{"event":{"id":"adv10-self","type":"TRANSFER","transferred_from":["00000000-0000-4000-8000-0000000010b1"],"transferred_to":["00000000-0000-4000-8000-0000000010b1"]}}');
  r := public.enqueue_billing_transfer('adv10-self', '{"event":{"id":"adv10-self","type":"TRANSFER","transferred_from":["00000000-0000-4000-8000-0000000010b1"],"transferred_to":["00000000-0000-4000-8000-0000000010b1"]}}', (r->>'lease_token')::uuid);
  if r->>'outcome' <> 'no_subjects' then insert into adv10_bad values ('self_transfer=' || r::text); end if;
  -- malformed subjects are skipped, not cast
  r := public.claim_billing_webhook_delivery('adv10-garbage', '{"event":{"id":"adv10-garbage","type":"TRANSFER","transferred_from":["not-a-uuid", 7, null],"transferred_to":[{"x":1}]}}');
  r := public.enqueue_billing_transfer('adv10-garbage', '{"event":{"id":"adv10-garbage","type":"TRANSFER","transferred_from":["not-a-uuid", 7, null],"transferred_to":[{"x":1}]}}', (r->>'lease_token')::uuid);
  if r->>'outcome' <> 'no_subjects' then insert into adv10_bad values ('garbage_subjects=' || r::text); end if;
  begin
    perform public.enqueue_billing_transfer('adv10-x', '{"event":{"id":"adv10-y","type":"TRANSFER"}}', gen_random_uuid());
    insert into adv10_bad values ('event_id_mismatch_accepted');
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.enqueue_billing_transfer('adv10-z', '{"event":{"id":"adv10-z","type":"RENEWAL"}}', gen_random_uuid());
    insert into adv10_bad values ('non_transfer_enqueued');
  exception when invalid_parameter_value then null;
  end;
  -- service_role has no table path at all
  begin
    perform 1 from api_private.billing_transfers;
    insert into adv10_bad values ('service_reads_transfers');
  exception when insufficient_privilege then null;
  end;
  begin
    update api_private.billing_transfers set state = 'confirmed', settled_at = now() where event_id = 'adv10-b';
    insert into adv10_bad values ('service_updates_transfers');
  exception when insufficient_privilege then null;
  end;
  begin
    delete from api_private.billing_transfer_audit;
    insert into adv10_bad values ('service_deletes_audit');
  exception when insufficient_privilege then null;
  end;
end $$;

-- owner: the audit and the settled transfer are immutable even for the table owner
reset role;
do $$
begin
  begin
    delete from api_private.billing_transfer_audit where event_id = 'adv10-a';
    insert into adv10_bad values ('owner_deleted_audit');
  exception when insufficient_privilege then null;
  end;
  begin
    update api_private.billing_transfer_audit set action = 'confirmed' where event_id = 'adv10-b';
    insert into adv10_bad values ('owner_rewrote_audit');
  exception when insufficient_privilege then null;
  end;
  begin
    update api_private.billing_transfers set state = 'pending', settled_at = null where event_id = 'adv10-a';
    insert into adv10_bad values ('owner_reopened_confirmed_transfer');
  exception when check_violation then null;
  end;
  begin
    update api_private.billing_transfers set source_user_ids = '{}' where event_id = 'adv10-b';
    insert into adv10_bad values ('owner_rewrote_transfer_parties');
  exception when check_violation then null;
  end;
  begin
    delete from api_private.billing_transfers where event_id = 'adv10-b';
    insert into adv10_bad values ('owner_deleted_transfer');
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
end $$;

-- clients: nothing
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000010b1';
do $$
begin
  begin
    perform public.billing_transfer_recovery('00000000-0000-4000-8000-0000000010b1');
    insert into adv10_bad values ('client_recovery');
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.enqueue_billing_transfer('adv10-client', '{"event":{"id":"adv10-client","type":"TRANSFER"}}', gen_random_uuid());
    insert into adv10_bad values ('client_enqueue');
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
declare bad text[];
begin
  select coalesce(array_agg(item order by item), '{}') into bad from adv10_bad;
  raise notice 'ADV-10 findings: %', bad;
  if cardinality(bad) > 0 then raise exception 'ADV-10 BREAK: %', bad; end if;
  raise notice 'ADV-10: PASS';
end $$;
rollback;
