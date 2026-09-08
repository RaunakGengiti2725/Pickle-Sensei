-- Shared fixture for the W01-03 adversarial SQL tests: one user, one reserved
-- permit, one scored shot settled through the REAL apply_synced_shot(jsonb)
-- with a settlementReceipt (receipt row written by the definer trigger).
--
-- Run as superuser; leaves the temp table attack_fixture (attack_user,
-- attack_shot, attack_permit) for the attack file run in the same session.
--
-- The receipt bytes are built in SQL. apply_synced_shot only requires
-- sha256(canonical) = sha256 and a parseable object, so jsonb text output is
-- accepted here even though it is not RFC 8785 canonical.
\set ON_ERROR_STOP on

create extension if not exists pgcrypto;

do $fixture$
declare
  v_user uuid := gen_random_uuid();
  v_shot uuid := gen_random_uuid();
  v_permit uuid;
  v_result text;
  v_payload jsonb;
  v_binding jsonb;
  v_receipt jsonb;
  v_canonical text;
  v_sub text := 'attack-w0103-' || replace(v_user::text, '-', '');
begin
  insert into auth.users (id, email, raw_app_meta_data)
  values (v_user, v_user::text || '@example.com', '{"provider":"google"}');
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('google', v_sub, v_user, jsonb_build_object('sub', v_sub));

  -- Act as the owner through the API gate for the RPCs (RLS applies).
  perform set_config('request.headers',
    jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  set local role authenticated;

  select x.permit_id into v_permit
  from public.reserve_analysis_permit('attack-w0103-permit-' || v_user::text) x;
  if v_permit is null then
    raise exception 'fixture: permit reservation failed';
  end if;

  v_payload := jsonb_build_object(
    'id', v_shot, 'analysisPermitId', v_permit, 'sessionId', null,
    'shotType', 'dink', 'cameraView', 'side', 'capturedAt', '2026-09-08T10:00:00.000Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.5, 'confidence', 0.9,
    'resultKind', 'scored', 'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1',
      'shotConfigVersion', 'config-1'));
  v_binding := jsonb_build_object(
    'ownerId', v_user, 'shotId', v_shot, 'analysisPermitId', v_permit, 'resultKind', 'scored',
    'installationKeyId', 'ik_attack', 'grant', null, 'ticket', null, 'operationId', 'op_attack',
    'payloadSha256', encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex'));
  v_receipt := jsonb_build_object(
    'schemaVersion', 1, 'kind', 'settlement_receipt', 'binding', v_binding,
    'bindingSha256', encode(sha256(convert_to(v_binding::text, 'UTF8')), 'hex'),
    'policy', jsonb_build_object('version', 'attack-policy-1',
      'sha256', encode(sha256('attack-policy-1'::bytea), 'hex')));
  v_canonical := v_receipt::text;

  select public.apply_synced_shot(v_payload || jsonb_build_object('settlementReceipt',
    jsonb_build_object('canonical', v_canonical,
      'sha256', encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex'))))
  into v_result;
  if v_result <> 'accepted' then
    raise exception 'fixture: settlement was not accepted: %', v_result;
  end if;

  reset role;
  if (select count(*) from public.settlement_receipts where shot_id = v_shot) <> 1 then
    raise exception 'fixture: receipt row missing';
  end if;

  create temp table attack_fixture as
    select v_user as attack_user, v_shot as attack_shot, v_permit as attack_permit;
end
$fixture$;

select attack_user, attack_shot, attack_permit from attack_fixture;
