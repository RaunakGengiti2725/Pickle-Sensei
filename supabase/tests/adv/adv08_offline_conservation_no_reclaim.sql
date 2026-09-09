-- ADV-08 — offline allocation conservation: allocation is a hold, not a
-- consumption; a released ticket still counts; a consumed ticket cannot be
-- consumed again with another shot or released back; holds + online
-- reservations + lifetime scored never exceed the two free ratings across a
-- second installation, an online reservation and a re-issued generation; the
-- ledger is append-only for every role (client, service_role, owner); a
-- Pro lease is bounded by min(now+7d, entitlement expiry) and an expired
-- entitlement does not lease at all; account deletion keeps the ledger and
-- the same sign-in identity on a fresh account still owes the holds.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000008a1','pia@example.com','{"full_name":"Pia"}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000008b1','pro@example.com','{"full_name":"Pro"}','{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv08-pia','00000000-0000-4000-8000-0000000008a1','{"sub":"adv08-pia"}'),
 ('apple','adv08-pro','00000000-0000-4000-8000-0000000008b1','{"sub":"adv08-pro"}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000008a2','00000000-0000-4000-8000-0000000008a1'),
 ('00000000-0000-4000-8000-0000000008b2','00000000-0000-4000-8000-0000000008b1');
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
  values ('00000000-0000-4000-8000-0000000008b1', true, now() + interval '3 days', now());

create function pg_temp.shot(p_id uuid, p_kind text) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'resultKind', p_kind,
    'shotType', 'drive', 'capturedAt', '2026-09-08T10:00:00Z', 'startMs', 0, 'endMs', 1000,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'overallScore', case when p_kind = 'scored' then 7.2 else null end,
    'versionVector', jsonb_build_object('appVersion', '1.0.0', 'modelBundleVersion', 'b', 'poseModelVersion', 'p',
      'paddleModelVersion', 'p', 'strokeDetectorVersion', 's', 'phaseModelVersion', 'p', 'scoringModelVersion', 's',
      'shotConfigVersion', 'c'))
$$;
grant execute on function pg_temp.shot(uuid, text) to authenticated;

create function pg_temp.as_user(p_uid uuid, p_session uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('session_id', p_session)::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid) to authenticated;

do $$ begin perform set_config('request.headers',
  jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;

do $$
declare
  pia uuid := '00000000-0000-4000-8000-0000000008a1';
  pro uuid := '00000000-0000-4000-8000-0000000008b1';
  r record; g record; v text; bad text[] := '{}';
  t1 uuid; t2 uuid;
begin
  perform pg_temp.as_user(pia, '00000000-0000-4000-8000-0000000008a2');
  select * into r from public.register_offline_device('adv08-inst-a', 'production', true);
  if r.result <> 'accepted' then raise exception 'ADV-08 precondition: register %', r.result; end if;

  -- asking for more than the lifetime allowance is malformed input, not a bigger grant
  select * into g from public.issue_offline_grant('adv08-inst-a', 5);
  if g.result <> 'offline.invalid_input' then bad := array_append(bad, 'over_request=' || g.result); end if;
  select * into g from public.issue_offline_grant('adv08-inst-a', 2);
  if g.result <> 'accepted' or cardinality(g.ticket_ids) <> 2 then
    bad := array_append(bad, format('first_grant=%s tickets=%s', g.result, cardinality(g.ticket_ids)));
  end if;
  t1 := g.ticket_ids[1]; t2 := g.ticket_ids[2];
  if public.offline_hold_count() <> 2 then bad := array_append(bad, 'hold_count_after_alloc=' || public.offline_hold_count()); end if;

  -- holds block the online path and a second installation
  select result into v from public.reserve_analysis_permit('adv08-online-1');
  if v <> 'access.paywall_required' then bad := array_append(bad, 'online_reserve_over_holds=' || v); end if;
  select * into r from public.register_offline_device('adv08-inst-b', 'production', true);
  select * into g from public.issue_offline_grant('adv08-inst-b', 2);
  if g.result <> 'access.paywall_required' then bad := array_append(bad, 'second_installation_grant=' || g.result); end if;

  -- release t1: still a hold, never re-credited, re-issue returns only t2
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'accepted' then bad := array_append(bad, 'release=' || v); end if;
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'accepted' then bad := array_append(bad, 'release_replay=' || v); end if;
  if public.offline_hold_count() <> 2 then bad := array_append(bad, 'hold_count_after_release=' || public.offline_hold_count()); end if;
  select * into g from public.issue_offline_grant('adv08-inst-a', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[t2] then
    bad := array_append(bad, format('reissue_after_release=%s tickets=%s', g.result, g.ticket_ids));
  end if;
  -- the released ticket cannot be consumed
  v := public.consume_offline_ticket(t1, pg_temp.shot('00000000-0000-4000-8000-0000000008c0', 'scored'));
  if v <> 'offline.ticket_released' then bad := array_append(bad, 'consume_released=' || v); end if;

  -- a partial / low_confidence result never consumes the ticket
  v := public.consume_offline_ticket(t2, pg_temp.shot('00000000-0000-4000-8000-0000000008c1', 'partial'));
  if v <> 'offline.shot_not_chargeable' then bad := array_append(bad, 'consume_partial=' || v); end if;
  v := public.consume_offline_ticket(t2, pg_temp.shot('00000000-0000-4000-8000-0000000008c1', 'low_confidence'));
  if v <> 'offline.shot_not_chargeable' then bad := array_append(bad, 'consume_low=' || v); end if;
  if exists (select 1 from public.shots where user_id = pia) then bad := array_append(bad, 'unchargeable_result_wrote_shot'); end if;

  -- consume t2 with a scored shot: exactly one shot, exactly one consumed event; replay same shot idempotent;
  -- another shot on the same ticket refused; release after consume refused
  v := public.consume_offline_ticket(t2, pg_temp.shot('00000000-0000-4000-8000-0000000008c2', 'scored'));
  if v <> 'accepted' then bad := array_append(bad, 'consume=' || v); end if;
  v := public.consume_offline_ticket(t2, pg_temp.shot('00000000-0000-4000-8000-0000000008c2', 'scored'));
  if v <> 'accepted' then bad := array_append(bad, 'consume_replay=' || v); end if;
  v := public.consume_offline_ticket(t2, pg_temp.shot('00000000-0000-4000-8000-0000000008c3', 'scored'));
  if v <> 'offline.ticket_consumed' then bad := array_append(bad, 'consume_twice=' || v); end if;
  v := public.release_offline_ticket(t2, 'unused_ticket_returned');
  if v <> 'offline.ticket_consumed' then bad := array_append(bad, 'release_consumed=' || v); end if;
  if (select count(*) from public.shots where user_id = pia) <> 1 then bad := array_append(bad, 'shot_count'); end if;
  if public.lifetime_scored_count() <> 1 then bad := array_append(bad, 'lifetime=' || public.lifetime_scored_count()); end if;
  if public.offline_hold_count() <> 1 then bad := array_append(bad, 'hold_after_consume=' || public.offline_hold_count()); end if;
  -- 1 scored + 1 released hold = 2 → nothing left online or offline
  select result into v from public.reserve_analysis_permit('adv08-online-2');
  if v <> 'access.paywall_required' then bad := array_append(bad, 'online_after_offline_spend=' || v); end if;
  select * into g from public.issue_offline_grant('adv08-inst-a', 2);
  if g.result <> 'access.paywall_required' then bad := array_append(bad, 'grant_after_spend=' || g.result); end if;
  -- malformed
  v := public.consume_offline_ticket(t2, '"string"'::jsonb);
  if v <> 'offline.invalid_input' then bad := array_append(bad, 'consume_string=' || v); end if;
  v := public.consume_offline_ticket(null, pg_temp.shot(gen_random_uuid(), 'scored'));
  if v <> 'offline.invalid_input' then bad := array_append(bad, 'consume_null_ticket=' || v); end if;
  v := public.release_offline_ticket(t1, 'support_review');
  if v <> 'offline.invalid_input' then bad := array_append(bad, 'client_support_review=' || v); end if;
  select * into g from public.issue_offline_grant('adv08-inst-a', -1);
  if g.result <> 'offline.invalid_input' then bad := array_append(bad, 'negative_tickets=' || g.result); end if;
  select * into g from public.issue_offline_grant('adv08-never-registered', 1);
  if g.result <> 'offline.device_not_registered' then bad := array_append(bad, 'unregistered=' || g.result); end if;

  -- the client cannot touch the ledger or the grants directly
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id)
      values (pia, gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), 'allocated', '{}', 'x');
    bad := array_append(bad, 'client_ledger_insert');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_allocation_ledger set event = 'allocated' where ticket_id = t2 and event = 'consumed';
    bad := array_append(bad, 'client_ledger_update');
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.offline_allocation_ledger where ticket_id = t1;
    bad := array_append(bad, 'client_ledger_delete');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_grants set expires_at = now() + interval '365 days' where user_id = pia;
    bad := array_append(bad, 'client_grant_extend');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at)
      select pia, id, 'free', 99, now(), now() + interval '365 days' from public.offline_devices where user_id = pia limit 1;
    bad := array_append(bad, 'client_grant_forge');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_devices set attestation_state = 'attested' where user_id = pia;
    bad := array_append(bad, 'client_attest_self');
  exception when insufficient_privilege then null;
  end;

  -- Pro: lease bounded by entitlement expiry (3 days < 7), no tickets; expired entitlement → free path
  perform pg_temp.as_user(pro, '00000000-0000-4000-8000-0000000008b2');
  select * into r from public.register_offline_device('adv08-inst-pro', 'production', true);
  select * into g from public.issue_offline_grant('adv08-inst-pro', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'verified_store' or cardinality(coalesce(g.ticket_ids, '{}')) <> 0 then
    bad := array_append(bad, format('pro_grant=%s src=%s tickets=%s', g.result, g.entitlement_source, g.ticket_ids));
  end if;
  if g.expires_at > now() + interval '3 days 1 minute' or g.expires_at > g.entitlement_expires_at then
    bad := array_append(bad, 'pro_lease_exceeds_entitlement');
  end if;
  perform set_config('adv08.t1', t1::text, true);
  perform set_config('adv08.t2', t2::text, true);
  perform set_config('adv08.bad', bad::text, true);
end $$;

reset role;
update public.billing_entitlements set expires_at = now() - interval '1 second' where user_id = '00000000-0000-4000-8000-0000000008b1';
set local role authenticated;
do $$
declare g record; bad text[] := current_setting('adv08.bad')::text[];
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-0000000008b1', '00000000-0000-4000-8000-0000000008b2');
  select * into g from public.issue_offline_grant('adv08-inst-pro', 2);
  if g.entitlement_source = 'verified_store' then bad := array_append(bad, 'expired_entitlement_leased_pro'); end if;
  if (select premium from public.access_state()) then bad := array_append(bad, 'expired_entitlement_premium'); end if;
  perform set_config('adv08.bad', bad::text, true);
end $$;

-- service_role and the owner cannot rewrite or erase ledger history
reset role;
do $$
declare bad text[] := current_setting('adv08.bad')::text[]; t2 uuid := current_setting('adv08.t2')::uuid;
begin
  begin
    update public.offline_allocation_ledger set event = 'allocated' where ticket_id = t2 and event = 'consumed';
    bad := array_append(bad, 'owner_ledger_update');
  exception when others then null;
  end;
  begin
    delete from public.offline_allocation_ledger where ticket_id = t2 and event = 'consumed';
    bad := array_append(bad, 'owner_ledger_delete');
  exception when others then null;
  end;
  perform set_config('adv08.bad', bad::text, true);
end $$;
set local role service_role;
do $$
declare bad text[] := current_setting('adv08.bad')::text[]; t2 uuid := current_setting('adv08.t2')::uuid;
begin
  begin
    update public.offline_allocation_ledger set event = 'allocated' where ticket_id = t2 and event = 'consumed';
    bad := array_append(bad, 'service_ledger_update');
  exception when others then null;
  end;
  begin
    delete from public.offline_allocation_ledger where ticket_id = t2;
    bad := array_append(bad, 'service_ledger_delete');
  exception when others then null;
  end;
  begin
    truncate public.offline_allocation_ledger;
    bad := array_append(bad, 'service_ledger_truncate');
  exception when others then null;
  end;
  perform set_config('adv08.bad', bad::text, true);
end $$;

-- account deletion keeps the ledger; the same Apple identity on a new account still owes the holds
reset role;
delete from auth.users where id = '00000000-0000-4000-8000-0000000008a1';
do $$
declare bad text[] := current_setting('adv08.bad')::text[];
begin
  if (select count(*) from public.offline_allocation_ledger where installation_key_id = 'adv08-inst-a') <> 4 then
    bad := array_append(bad, 'ledger_lost_on_deletion=' || (select count(*) from public.offline_allocation_ledger where installation_key_id = 'adv08-inst-a'));
  end if;
  if exists (select 1 from public.offline_devices where user_id = '00000000-0000-4000-8000-0000000008a1') then
    bad := array_append(bad, 'device_rows_survived_deletion');
  end if;
  perform set_config('adv08.bad', bad::text, true);
end $$;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000008d1','pia2@example.com','{"full_name":"Pia"}','{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv08-pia','00000000-0000-4000-8000-0000000008d1','{"sub":"adv08-pia"}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000008d2','00000000-0000-4000-8000-0000000008d1');
set local role authenticated;
do $$
declare g record; v text; bad text[] := current_setting('adv08.bad')::text[]; t1 uuid := current_setting('adv08.t1')::uuid;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-0000000008d1', '00000000-0000-4000-8000-0000000008d2');
  if public.lifetime_scored_count() <> 1 then bad := array_append(bad, 'relinked_lifetime=' || public.lifetime_scored_count()); end if;
  if public.offline_hold_count() <> 1 then bad := array_append(bad, 'relinked_hold=' || public.offline_hold_count()); end if;
  select result into v from public.reserve_analysis_permit('adv08-online-3');
  if v <> 'access.paywall_required' then bad := array_append(bad, 'relinked_online_reserve=' || v); end if;
  -- the original installation recovers its (released) ticket but earns no new one on the fresh account
  perform public.register_offline_device('adv08-inst-a', 'production', true);
  select * into g from public.issue_offline_grant('adv08-inst-a', 2);
  if g.result = 'accepted' and exists (select 1 from unnest(g.ticket_ids) t where t <> t1) then
    bad := array_append(bad, format('fresh_account_new_ticket=%s', g.ticket_ids));
  end if;
  -- and a new installation on the fresh account gets nothing
  perform public.register_offline_device('adv08-inst-c', 'production', true);
  select * into g from public.issue_offline_grant('adv08-inst-c', 2);
  if g.result <> 'access.paywall_required' then bad := array_append(bad, 'fresh_account_new_installation=' || g.result); end if;
  raise notice 'ADV-08 findings: %', bad;
  if cardinality(bad) > 0 then raise exception 'ADV-08 BREAK: %', bad; end if;
  raise notice 'ADV-08: PASS';
end $$;
rollback;
