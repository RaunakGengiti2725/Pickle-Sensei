-- ADV-04 — settlement receipt binding forgery, tampered bytes, replay lineage.
--
-- apply_synced_shot(jsonb) accepts an optional settlementReceipt
-- {canonical, sha256}. It must (a) refuse bytes whose digest does not match,
-- (b) refuse a receipt bound to another owner / permit / shot / result kind,
-- (c) refuse a scored receipt with no release-policy lineage, (d) persist the
-- receipt with the shot, (e) decide replay on binding + policy — same bytes
-- replay as accepted, a different policy or an absent receipt replays as
-- shot.receipt_mismatch — and (f) never let a client write/alter/delete a
-- receipt directly or read another account's receipt.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000004a1','hana@example.com','{"full_name":"Hana"}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000004b1','ivan@example.com','{"full_name":"Ivan"}','{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv04-hana','00000000-0000-4000-8000-0000000004a1','{"sub":"adv04-hana"}'),
 ('google','adv04-ivan','00000000-0000-4000-8000-0000000004b1','{"sub":"adv04-ivan"}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000004a2','00000000-0000-4000-8000-0000000004a1'),
 ('00000000-0000-4000-8000-0000000004b2','00000000-0000-4000-8000-0000000004b1');

create function pg_temp.shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-09-08T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.2 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
-- A receipt exactly as the edge function shapes it (schemaVersion 1).
create function pg_temp.receipt(p_owner uuid, p_shot uuid, p_permit uuid, p_kind text, p_policy jsonb) returns jsonb
language sql as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'kind', 'settlement_receipt',
    'binding', jsonb_build_object(
      'ownerId', p_owner, 'shotId', p_shot, 'analysisPermitId', p_permit, 'resultKind', p_kind,
      'payloadSha256', repeat('a', 64), 'installationKeyId', 'inst-adv04', 'operationId', 'op-adv04',
      'grant', null, 'ticket', null),
    'bindingSha256', repeat('b', 64),
    'policy', p_policy)
$$;
create function pg_temp.transport(p_receipt jsonb) returns jsonb
language sql as $$
  select jsonb_build_object('canonical', p_receipt::text,
    'sha256', encode(sha256(convert_to(p_receipt::text, 'UTF8')), 'hex'))
$$;
grant execute on function pg_temp.shot(uuid, uuid, text) to authenticated;
grant execute on function pg_temp.receipt(uuid, uuid, uuid, text, jsonb) to authenticated;
grant execute on function pg_temp.transport(jsonb) to authenticated;

do $$ begin perform set_config('request.headers',
  jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000004a1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000004a2"}';

do $$
declare
  hana uuid := '00000000-0000-4000-8000-0000000004a1';
  ivan uuid := '00000000-0000-4000-8000-0000000004b1';
  s1 uuid := '00000000-0000-4000-8000-0000000004c1';
  s2 uuid := '00000000-0000-4000-8000-0000000004c2';
  pol jsonb := jsonb_build_object('version', 'policy-2026-09-07', 'sha256', repeat('c', 64));
  pol2 jsonb := jsonb_build_object('version', 'policy-2026-09-08', 'sha256', repeat('d', 64));
  p1 uuid;
  t jsonb; v text;
  bad text[] := '{}';
begin
  select permit_id into p1 from public.reserve_analysis_permit('adv04-k1');
  if p1 is null then raise exception 'ADV-04 precondition: no permit'; end if;

  -- (a) tampered canonical bytes: digest of different bytes
  t := pg_temp.transport(pg_temp.receipt(hana, s1, p1, 'scored', pol));
  t := jsonb_set(t, '{canonical}', to_jsonb(replace(t ->> 'canonical', 'op-adv04', 'op-evil')));
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt', t));
  if v <> 'shot.receipt_invalid' then bad := bad || ('tampered_bytes=' || v); end if;

  -- (b) receipt bound to another owner / another permit / another shot / other kind
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(ivan, s1, p1, 'scored', pol))));
  if v <> 'shot.receipt_invalid' then bad := bad || ('other_owner=' || v); end if;
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(hana, s1, gen_random_uuid(), 'scored', pol))));
  if v <> 'shot.receipt_invalid' then bad := bad || ('other_permit=' || v); end if;
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(hana, s2, p1, 'scored', pol))));
  if v <> 'shot.receipt_invalid' then bad := bad || ('other_shot=' || v); end if;
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(hana, s1, p1, 'low_confidence', pol))));
  if v <> 'shot.receipt_invalid' then bad := bad || ('other_kind=' || v); end if;

  -- (c) scored settlement without release-policy lineage / with a corrupt policy digest
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(hana, s1, p1, 'scored', 'null'::jsonb))));
  if v <> 'shot.receipt_invalid' then bad := bad || ('no_policy=' || v); end if;
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(hana, s1, p1, 'scored', jsonb_build_object('version', 'x', 'sha256', 'nope')))));
  if v <> 'shot.receipt_invalid' then bad := bad || ('bad_policy_digest=' || v); end if;
  -- malformed transport shapes
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt', '"just-a-string"'::jsonb));
  if v <> 'shot.receipt_invalid' then bad := bad || ('string_transport=' || v); end if;
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        jsonb_build_object('canonical', 'not json', 'sha256', encode(sha256(convert_to('not json', 'UTF8')), 'hex'))));
  if v <> 'shot.receipt_invalid' then bad := bad || ('non_json_canonical=' || v); end if;

  if exists (select 1 from public.shots where id = s1) or exists (select 1 from public.settlement_receipts where shot_id = s1)
     or (select status from public.analysis_permits where id = p1) <> 'reserved' then
    bad := bad || 'refused_receipts_left_state_behind';
  end if;

  -- (d) the genuine receipt settles and is persisted
  t := pg_temp.transport(pg_temp.receipt(hana, s1, p1, 'scored', pol));
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt', t));
  if v <> 'accepted' then raise exception 'ADV-04 precondition: genuine receipt refused (%)', v; end if;
  if (select count(*) from public.settlement_receipts where shot_id = s1 and user_id = hana
        and receipt_canonical = (t ->> 'canonical') and receipt_sha256 = (t ->> 'sha256')
        and policy_version = 'policy-2026-09-07') <> 1 then
    bad := bad || 'receipt_not_persisted_verbatim';
  end if;

  -- (e) replay lineage
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt', t));
  if v <> 'accepted' then bad := bad || ('same_bytes_replay=' || v); end if;
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(hana, s1, p1, 'scored', pol2))));
  if v <> 'shot.receipt_mismatch' then bad := bad || ('other_policy_replay=' || v); end if;
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'scored'));
  if v <> 'shot.receipt_mismatch' then bad := bad || ('receiptless_replay=' || v); end if;
  -- a replay that re-labels the settled rating as an abstention must not be accepted
  v := public.apply_synced_shot(pg_temp.shot(s1, p1, 'low_confidence') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt(hana, s1, p1, 'low_confidence', 'null'::jsonb))));
  if v <> 'shot.receipt_mismatch' then bad := bad || ('kind_flip_replay=' || v); end if;
  if (select result_kind from public.shots where id = s1) <> 'scored'
     or (select count(*) from public.settlement_receipts where shot_id = s1) <> 1 then
    bad := bad || 'replay_mutated_settlement';
  end if;

  -- (f) direct client access to the receipt table
  begin
    insert into public.settlement_receipts (shot_id, user_id, analysis_permit_id, result_kind, payload_sha256,
      binding_sha256, receipt, receipt_canonical, receipt_sha256)
    values (s1, hana, p1, 'scored', repeat('a', 64), repeat('b', 64), '{}', '{}', repeat('e', 64));
    bad := bad || 'client_insert_receipt_accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.settlement_receipts set policy_version = 'rewritten' where shot_id = s1;
    bad := bad || 'client_update_receipt_accepted';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    delete from public.settlement_receipts where shot_id = s1;
    bad := bad || 'client_delete_receipt_accepted';
  exception when insufficient_privilege or check_violation then null;
  end;

  raise notice 'ADV-04 findings: %', bad;
  if cardinality(bad) > 0 then
    raise exception 'ADV-04 BREAK: %', bad;
  end if;
end $$;

-- other account: the receipt is invisible, and Ivan cannot replay Hana's settlement
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000004b1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000004b2"}';
do $$
declare
  v text;
  p uuid;
  s1 uuid := '00000000-0000-4000-8000-0000000004c1';
begin
  if (select count(*) from public.settlement_receipts) <> 0 then
    raise exception 'ADV-04 BREAK: another account can read settlement receipts';
  end if;
  select permit_id into p from public.reserve_analysis_permit('adv04-ivan');
  -- Ivan syncs a shot whose id is Hana's settled shot, with his own live permit
  v := public.apply_synced_shot(pg_temp.shot(s1, p, 'scored') || jsonb_build_object('settlementReceipt',
        pg_temp.transport(pg_temp.receipt('00000000-0000-4000-8000-0000000004b1', s1, p, 'scored',
          jsonb_build_object('version', 'policy-2026-09-07', 'sha256', repeat('c', 64))))));
  raise notice 'ADV-04 other account settling an existing shot id -> %', v;
  if v = 'accepted' or (select status from public.analysis_permits where id = p) <> 'reserved' then
    raise exception 'ADV-04 BREAK: another account took over a settled shot id (%)', v;
  end if;
  raise notice 'ADV-04: PASS';
end $$;
reset role;
do $$
begin
  if (select count(*) from public.shots where id = '00000000-0000-4000-8000-0000000004c1'
        and user_id = '00000000-0000-4000-8000-0000000004a1' and result_kind = 'scored') <> 1
     or (select count(*) from public.settlement_receipts where shot_id = '00000000-0000-4000-8000-0000000004c1') <> 1 then
    raise exception 'ADV-04 BREAK: the other account altered the settled shot or its receipt';
  end if;
end $$;
rollback;
