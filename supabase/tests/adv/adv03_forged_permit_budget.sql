-- ADV-03 — direct client permit rows cannot buy a third free rating.
--
-- `authenticated` holds INSERT (user_id, idempotency_key, status, outcome) on
-- public.analysis_permits, so a client that talks to PostgREST through the
-- Edge key can mint reserved permits without reserve_analysis_permit() and its
-- one-live-reservation budget. The product invariant is enforced one layer
-- down: apply_synced_shot() re-counts lifetime_scored_count() under
-- access_lock_key(uid) before it writes, and the shots trigger does the same.
--
-- Expected: three forged reserved permits yield at most two scored shots for a
-- free account; the third sync is refused without writing a shot; forged rows
-- for another account are refused by RLS; forged permits also deny the
-- offline grant path (holds+reservations exhaust the allowance) rather than
-- widening it.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000003a1','fay@example.com','{"full_name":"Fay"}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000003b1','gus@example.com','{"full_name":"Gus"}','{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv03-fay','00000000-0000-4000-8000-0000000003a1','{"sub":"adv03-fay"}'),
 ('google','adv03-gus','00000000-0000-4000-8000-0000000003b1','{"sub":"adv03-gus"}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000003a2','00000000-0000-4000-8000-0000000003a1');

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
grant execute on function pg_temp.shot(uuid, uuid, text) to authenticated;

do $$ begin perform set_config('request.headers',
  jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000003a1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000003a2"}';

do $$
declare
  fay uuid := '00000000-0000-4000-8000-0000000003a1';
  gus uuid := '00000000-0000-4000-8000-0000000003b1';
  p1 uuid; p2 uuid; p3 uuid; p4 uuid;
  v text;
  r record;
  st record;
begin
  -- cross-account forgery is refused by RLS
  begin
    insert into public.analysis_permits (user_id, idempotency_key) values (gus, 'adv03-for-gus');
    raise exception 'ADV-03 BREAK: a client minted a permit for another account';
  exception when insufficient_privilege then null;
  end;

  -- three forged live reservations for the caller (the RPC would allow one)
  insert into public.analysis_permits (user_id, idempotency_key) values (fay, 'adv03-f1') returning id into p1;
  insert into public.analysis_permits (user_id, idempotency_key) values (fay, 'adv03-f2') returning id into p2;
  insert into public.analysis_permits (user_id, idempotency_key) values (fay, 'adv03-f3') returning id into p3;
  select * into st from public.access_state();
  raise notice 'ADV-03 after 3 forged reservations access_state=%', st;

  -- the RPC budget is bypassed, but the offline grant path must not widen
  select * into r from public.register_offline_device('adv03-inst', 'production', true);
  select * into r from public.issue_offline_grant('adv03-inst', 2);
  raise notice 'ADV-03 offline grant with 3 live forged reservations -> %', r.result;
  if r.result = 'accepted' then
    raise exception 'ADV-03 BREAK: forged reservations did not exhaust the offline grant allowance (got %)', r;
  end if;

  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000003c1', p1, 'scored'));
  if v <> 'accepted' then raise exception 'ADV-03 precondition: first forged permit sync must be accepted (got %)', v; end if;
  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000003c2', p2, 'scored'));
  if v <> 'accepted' then raise exception 'ADV-03 precondition: second forged permit sync must be accepted (got %)', v; end if;

  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000003c3', p3, 'scored'));
  raise notice 'ADV-03 third scored sync on a forged live permit -> %', v;
  if v = 'accepted' or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000003c3') then
    raise exception 'ADV-03 BREAK: a third free rating was written through a forged permit (got %)', v;
  end if;
  if (select count(*) from public.shots where user_id = fay and result_kind = 'scored') <> 2 then
    raise exception 'ADV-03 BREAK: scored shot count is not 2';
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'ADV-03 BREAK: lifetime_scored_count is % (expected 2)', public.lifetime_scored_count();
  end if;

  -- a forged settled row backs nothing and the forged reserved one stays reserved (never fabricated into consumed)
  insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (fay, 'adv03-settled', 'finalized', 'scored');
  v := public.apply_synced_shot(pg_temp.shot('00000000-0000-4000-8000-0000000003c4',
        (select id from public.analysis_permits where idempotency_key = 'adv03-settled'), 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'ADV-03 BREAK: a forged finalized permit backed a shot (got %)', v;
  end if;
  -- the refused permit is settled as released/free_limit_exceeded, never left live
  if (select status || '/' || outcome from public.analysis_permits where id = p3) <> 'released/free_limit_exceeded' then
    raise exception 'ADV-03 BREAK: the refused forged permit is % (expected released/free_limit_exceeded)',
      (select status || '/' || outcome from public.analysis_permits where id = p3);
  end if;
  insert into public.analysis_permits (user_id, idempotency_key) values (fay, 'adv03-f4') returning id into p4;

  -- the trigger backstop: a direct scored INSERT naming the forged live permit
  begin
    perform set_config('pickle.sync_permit_id', p4::text, true);
    insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind, analysis_permit_id,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values ('00000000-0000-4000-8000-0000000003c5', fay, 'drive', now(), 0, 1000, 7.2, 0.9, 'scored', p4,
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
    raise exception 'ADV-03 BREAK: direct scored INSERT vouching a forged permit was accepted';
  exception when others then
    perform set_config('pickle.sync_permit_id', '', true);
    if sqlstate not in ('42501', '23514', 'PKP02') then
      raise;
    end if;
    raise notice 'ADV-03 direct scored INSERT with forged live permit refused: % %', sqlstate, sqlerrm;
  end;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000003c5') then
    raise exception 'ADV-03 BREAK: the refused direct insert left a shot behind';
  end if;
  raise notice 'ADV-03: PASS';
end $$;
rollback;
