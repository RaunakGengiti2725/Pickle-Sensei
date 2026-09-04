-- S6: a premium entitlement that expired one second ago must not count.
-- Alice sits at the free limit (2 scored); billing_entitlements says
-- premium=true but expires_at = now() - 1s. access_state().premium must be
-- false, reserve must be refused, and the sync backstop must still refuse a
-- third scored shot on an over-issued permit. Also probes the boundary:
-- expires_at = now() exactly (not > now(), so expired) and +1s (still premium).
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _seed_alice.sql

-- Alice spends both free ratings.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare v text; p uuid; i int;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('alice-key-' || i);
    v := public.apply_synced_shot(jsonb_build_object(
      'id', ('00000000-0000-4000-8000-0000000000e' || i)::uuid,
      'analysisPermitId', p,
      'resultKind', 'scored',
      'shotType', 'drive', 'cameraView', 'side',
      'capturedAt', '2026-08-31T10:00:00Z',
      'startMs', 0, 'contactMs', 500, 'endMs', 1000,
      'overallScore', 7.1, 'confidence', 0.9,
      'versionVector', jsonb_build_object(
        'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
        'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
        'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
        'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
    ));
    if v <> 'accepted' then
      raise exception 'S6 setup: scored shot % must be accepted (got %)', i, v;
    end if;
  end loop;
end $$;
reset role;

-- Superuser (stand-in for the service-role billing sync) writes an entitlement
-- that expired one second ago.
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values ('00000000-0000-4000-8000-00000000000a', true, 'pickle_sensei_pro_monthly',
        now() - interval '1 second');
-- Over-issued permit (what a lost reserve race leaves behind).
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000af',
        '00000000-0000-4000-8000-00000000000a', 'alice-raced');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare a record; r record; v text;
begin
  select * into a from public.access_state();
  raise notice 'RESULT S6: expires_at=now()-1s → premium=% scored_count=% reserved_count=%',
    a.premium, a.scored_count, a.reserved_count;
  if a.premium then
    raise exception 'S6: BROKEN expired entitlement reported premium=true';
  end if;

  select * into r from public.reserve_analysis_permit('alice-key-3');
  if r.result <> 'access.paywall_required' then
    raise exception 'S6: BROKEN reserve accepted with expired premium (%)', r.result;
  end if;

  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e9',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000af',
    'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'access.paywall_required' then
    raise exception 'S6: BROKEN sync backstop accepted a third scored shot with expired premium (%)', v;
  end if;
  if (select count(*) from public.shots
      where user_id = '00000000-0000-4000-8000-00000000000a'
        and result_kind = 'scored') <> 2 then
    raise exception 'S6: scored shot count moved past 2';
  end if;
  raise notice 'RESULT S6: HELD expired premium → premium=false, reserve refused, backstop refused';
end $$;
reset role;

-- S6b: boundary — expires_at exactly now() within this transaction. now() is
-- frozen per transaction, and the check is `expires_at > now()`, so this must
-- be NOT premium.
update public.billing_entitlements set expires_at = now()
where user_id = '00000000-0000-4000-8000-00000000000a';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare a record;
begin
  select * into a from public.access_state();
  raise notice 'RESULT S6b: expires_at=now() → premium=%', a.premium;
  if a.premium then
    raise exception 'S6b: BROKEN expires_at = now() counted as premium';
  end if;
end $$;
reset role;

-- S6c: control — one second in the future is premium and reserve/sync pass.
update public.billing_entitlements set expires_at = now() + interval '1 second'
where user_id = '00000000-0000-4000-8000-00000000000a';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare a record; r record;
begin
  select * into a from public.access_state();
  if not a.premium then
    raise exception 'S6c: unexpired premium must be true';
  end if;
  select * into r from public.reserve_analysis_permit('alice-key-4');
  if r.result <> 'accepted' then
    raise exception 'S6c: premium reserve must be accepted (%)', r.result;
  end if;
  raise notice 'RESULT S6c: HELD expires_at=now()+1s → premium=true and reserve accepted';
end $$;
reset role;

-- S6d: an authenticated client cannot extend its own expiry (no UPDATE grant).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
begin
  begin
    update public.billing_entitlements set expires_at = now() + interval '10 years'
    where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'S6d: BROKEN client extended its own entitlement';
  exception when insufficient_privilege then
    raise notice 'RESULT S6d: HELD client update of billing_entitlements refused';
  end;
  begin
    insert into public.billing_entitlements (user_id, premium)
    values ('00000000-0000-4000-8000-00000000000b', true);
    raise exception 'S6d: BROKEN client inserted an entitlement';
  exception when insufficient_privilege then
    raise notice 'RESULT S6d: HELD client insert of billing_entitlements refused';
  end;
end $$;
reset role;

rollback;
\echo S6 DONE
