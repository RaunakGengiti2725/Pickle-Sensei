-- S7: Alice has two linked identities (google, apple) whose ledger rows hold
-- 0 and 5. One scored sync must set BOTH rows to 6 (identity-max + 1), and
-- before the sync lifetime_scored_count() must already read 5 (so reserve is
-- refused — the account is over the free limit through its apple identity).
-- Then the same with 0 and 1 (under the limit): sync accepted, both become 2.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _seed_alice.sql

insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-alice', '00000000-0000-4000-8000-00000000000a',
        '{"sub":"apple-sub-alice","email":"alice@example.com"}');

insert into public.free_rating_ledger (identity_hash, scored_count)
values (public.free_rating_identity_hash('google', 'google-sub-alice'), 0),
       (public.free_rating_identity_hash('apple', 'apple-sub-alice'), 5);

-- Over-issued permit so the sync can be attempted regardless of reserve.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a5',
        '00000000-0000-4000-8000-00000000000a', 'alice-p5');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare r record; v text;
begin
  raise notice 'RESULT S7: pre-sync identity_scored_count=% lifetime_scored_count=%',
    public.identity_scored_count(), public.lifetime_scored_count();
  if public.lifetime_scored_count() <> 5 then
    raise exception 'S7: lifetime must read the identity max 5 (got %)', public.lifetime_scored_count();
  end if;
  select * into r from public.reserve_analysis_permit('alice-k');
  if r.result <> 'access.paywall_required' then
    raise exception 'S7: reserve must be refused at identity-max 5 (%)', r.result;
  end if;
  -- Backstop: a scored sync at 5 must be refused (5 >= 2) — the ledger must
  -- therefore NOT move at all here.
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e5',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a5',
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
  raise notice 'RESULT S7: scored sync at identity-max 5 → %', v;
  if v <> 'access.paywall_required' then
    raise exception 'S7: BROKEN scored sync accepted at identity-max 5 (%)', v;
  end if;
end $$;
reset role;

-- The 0/5 → 6/6 write itself is the trigger's job; exercise it directly with a
-- premium entitlement so the backstop lets the scored insert through.
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values ('00000000-0000-4000-8000-00000000000a', true, 'pickle_sensei_pro_monthly', null);
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a6',
        '00000000-0000-4000-8000-00000000000a', 'alice-p6');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e6',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a6',
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
    raise exception 'S7: premium scored sync must be accepted (%)', v;
  end if;
  raise notice 'RESULT S7: post-sync identity_scored_count=% lifetime_scored_count=%',
    public.identity_scored_count(), public.lifetime_scored_count();
end $$;
reset role;

do $$
declare v_g int; v_a int;
begin
  select scored_count into v_g from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('google', 'google-sub-alice');
  select scored_count into v_a from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-alice');
  raise notice 'RESULT S7: ledger after one scored sync google=% apple=%', v_g, v_a;
  if v_g <> 6 or v_a <> 6 then
    raise exception 'S7: BROKEN expected both rows = 6 (identity-max + 1), got google=% apple=%', v_g, v_a;
  end if;
  raise notice 'RESULT S7: HELD 0/5 → 6/6 identity-max+1 semantics';
end $$;

rollback;

-- S7b: under-the-limit variant 0/1 → sync accepted as a FREE user → 2/2, and
-- lifetime reads 2 so a further reserve is refused.
begin;
\ir _seed_alice.sql
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-alice', '00000000-0000-4000-8000-00000000000a',
        '{"sub":"apple-sub-alice","email":"alice@example.com"}');
insert into public.free_rating_ledger (identity_hash, scored_count)
values (public.free_rating_identity_hash('google', 'google-sub-alice'), 0),
       (public.free_rating_identity_hash('apple', 'apple-sub-alice'), 1);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare r record; v text;
begin
  if public.lifetime_scored_count() <> 1 then
    raise exception 'S7b: lifetime must be 1 (got %)', public.lifetime_scored_count();
  end if;
  select * into r from public.reserve_analysis_permit('alice-k1');
  if r.result <> 'accepted' then
    raise exception 'S7b: one free rating left, reserve must be accepted (%)', r.result;
  end if;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e7',
    'analysisPermitId', r.permit_id,
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
    raise exception 'S7b: free scored sync at 1 must be accepted (%)', v;
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S7b: lifetime must read 2 after sync (got %)', public.lifetime_scored_count();
  end if;
  select * into r from public.reserve_analysis_permit('alice-k2');
  if r.result <> 'access.paywall_required' then
    raise exception 'S7b: reserve must be refused at 2 (%)', r.result;
  end if;
end $$;
reset role;

do $$
declare v_g int; v_a int;
begin
  select scored_count into v_g from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('google', 'google-sub-alice');
  select scored_count into v_a from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-alice');
  raise notice 'RESULT S7b: ledger after one scored sync google=% apple=%', v_g, v_a;
  if v_g <> 2 or v_a <> 2 then
    raise exception 'S7b: BROKEN expected both rows = 2, got google=% apple=%', v_g, v_a;
  end if;
  raise notice 'RESULT S7b: HELD 0/1 → 2/2 and reserve refused afterwards';
end $$;
rollback;
\echo S7 DONE
