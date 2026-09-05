-- billing-entitlement-sync audit — sequential free-rating + entitlement
-- invariants against the real migrations (run by
-- wf-billing-entitlement-sync-db.sh after shim_auth.sql + every migration).
--
-- Every block raises on a violated invariant; ON_ERROR_STOP makes psql exit 3.
\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-0000000000a1', 'free@example.com', '{}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000a2', 'stale@example.com', '{}', '{"provider":"apple"}');

-- Minimal scored / abstained shot payloads in the exact shape the Edge
-- Function hands to apply_synced_shot (only the columns the RPC reads).
create function pg_temp.wf_shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', null,
    'shotType', 'dink',
    'cameraView', 'side',
    'capturedAt', now(),
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 6.5 else null end,
    'confidence', 0.9,
    'resultKind', p_kind,
    'versionVector', jsonb_build_object(
      'appVersion', '1', 'modelBundleVersion', '1', 'poseModelVersion', '1',
      'paddleModelVersion', '1', 'strokeDetectorVersion', '1',
      'phaseModelVersion', '1', 'scoringModelVersion', '1', 'shotConfigVersion', '1'),
    'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb)
$$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

-- 1. Fresh account: not premium, nothing used, nothing reserved.
do $$
declare s record;
begin
  select * into s from public.access_state();
  if s.premium or s.scored_count <> 0 or s.reserved_count <> 0 then
    raise exception 'access_state fresh account: %', s;
  end if;
end $$;

-- 2. Two reserves succeed, the third is refused; replaying a key is free.
do $$
declare r record; s record;
begin
  select * into r from public.reserve_analysis_permit('k1');
  if r.result <> 'accepted' then raise exception 'reserve k1: %', r.result; end if;
  select * into r from public.reserve_analysis_permit('k2');
  if r.result <> 'accepted' then raise exception 'reserve k2: %', r.result; end if;
  select * into r from public.reserve_analysis_permit('k3');
  if r.result <> 'access.paywall_required' then raise exception 'reserve k3 should be refused: %', r.result; end if;
  select * into r from public.reserve_analysis_permit('k1');
  if r.result <> 'accepted' then raise exception 'replay k1: %', r.result; end if;
  select * into s from public.access_state();
  if s.reserved_count <> 2 or s.scored_count <> 0 then raise exception 'access_state after 2 reserves: %', s; end if;
  if (select count(*) from public.analysis_permits) <> 2 then raise exception 'permit rows <> 2'; end if;
end $$;

-- 3. An abstention releases its permit and does NOT consume a free rating.
do $$
declare p1 uuid; res text; s record; r record;
begin
  select id into p1 from public.analysis_permits where idempotency_key = 'k1';
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000001', p1, 'low_confidence'));
  if res <> 'accepted' then raise exception 'abstention sync: %', res; end if;
  select * into s from public.access_state();
  if s.scored_count <> 0 or s.reserved_count <> 1 then raise exception 'access_state after abstention: %', s; end if;
  if (select status from public.analysis_permits where id = p1) <> 'released' then raise exception 'abstained permit not released'; end if;
  -- the slot is available again
  select * into r from public.reserve_analysis_permit('k3');
  if r.result <> 'accepted' then raise exception 'reserve k3 after abstention: %', r.result; end if;
end $$;

-- 4. Exactly two scored ratings; then every reserve is refused.
do $$
declare p2 uuid; p3 uuid; res text; s record; r record;
begin
  select id into p2 from public.analysis_permits where idempotency_key = 'k2';
  select id into p3 from public.analysis_permits where idempotency_key = 'k3';
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000002', p2, 'scored'));
  if res <> 'accepted' then raise exception 'scored #1: %', res; end if;
  -- idempotent replay of the same shot id never double counts
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000002', p2, 'scored'));
  if res <> 'accepted' then raise exception 'scored #1 replay: %', res; end if;
  -- a second, DIFFERENT shot on the already-finalized permit is refused
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000009', p2, 'scored'));
  if res <> 'access.permit_not_reserved' then raise exception 'reuse finalized permit: %', res; end if;
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000003', p3, 'scored'));
  if res <> 'accepted' then raise exception 'scored #2: %', res; end if;
  select * into s from public.access_state();
  if s.scored_count <> 2 or s.reserved_count <> 0 then raise exception 'access_state after 2 scored: %', s; end if;
  select * into r from public.reserve_analysis_permit('k4');
  if r.result <> 'access.paywall_required' then raise exception 'reserve after 2 scored must be refused: %', r.result; end if;
end $$;

-- 5. Sync backstop: an over-issued permit (inserted around the RPC) still
--    cannot become a third free rating; the permit is released.
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'rogue');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare res text; s record;
begin
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'scored'));
  if res <> 'access.paywall_required' then raise exception 'third free scored shot accepted: %', res; end if;
  if (select outcome from public.analysis_permits where id = '20000000-0000-4000-8000-000000000001') <> 'free_limit_exceeded' then
    raise exception 'rogue permit not released';
  end if;
  select * into s from public.access_state();
  if s.scored_count <> 2 then raise exception 'scored_count drifted: %', s; end if;
  -- a NON-scored result on an over-issued permit is still recorded (abstentions are free)
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', 'low_confidence'));
  if res <> 'access.permit_not_reserved' then raise exception 'released permit reuse: %', res; end if;
end $$;

-- 6. Entitlement predicate: expired row = not premium; unexpired or lifetime
--    (null expires_at) = premium, which bypasses the free limit entirely.
reset role;
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values ('00000000-0000-4000-8000-0000000000a1', true, 'pickle_sensei_pro_monthly', now() - interval '1 second');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare s record; r record;
begin
  select * into s from public.access_state();
  if s.premium then raise exception 'expired entitlement reported premium'; end if;
  select * into r from public.reserve_analysis_permit('k5');
  if r.result <> 'access.paywall_required' then raise exception 'expired premium reserved: %', r.result; end if;
  -- the client role can never write the verdict
  begin
    update public.billing_entitlements set expires_at = now() + interval '1 day';
    if (select expires_at > now() from public.billing_entitlements) then
      raise exception 'authenticated role rewrote billing_entitlements';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
update public.billing_entitlements set expires_at = now() + interval '1 hour';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare s record; r record; res text;
begin
  select * into s from public.access_state();
  if not s.premium then raise exception 'unexpired entitlement not premium'; end if;
  select * into r from public.reserve_analysis_permit('k6');
  if r.result <> 'accepted' then raise exception 'premium reserve refused: %', r.result; end if;
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000006', r.permit_id, 'scored'));
  if res <> 'accepted' then raise exception 'premium third scored shot refused: %', res; end if;
  select * into s from public.access_state();
  if s.scored_count <> 3 then raise exception 'premium scored count: %', s; end if;
end $$;
reset role;
update public.billing_entitlements set expires_at = null;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare s record;
begin
  select * into s from public.access_state();
  if not s.premium then raise exception 'lifetime (null expires_at) not premium'; end if;
end $$;

-- 7. Stale reservations (>24h) do not count against the allowance — the user
--    regains the slot for reserve/access_state without any sweep having run —
--    but a rating captured against one is NOT lost: a late sync (device offline
--    for a day) is still accepted, whether the permit is still 'reserved' or
--    the hourly sweep already flipped it to released/expired. The lifetime
--    scored count — not permit age — is what caps free ratings: once the two
--    late shots are recorded, the fresh reservation hits the backstop.
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'old1', now() - interval '25 hours'),
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a2', 'old2', now() - interval '25 hours');
update public.analysis_permits set status = 'released', outcome = 'expired'
 where id = '30000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
do $$
declare s record; r record; res text; p record;
begin
  select * into s from public.access_state();
  if s.reserved_count <> 0 then raise exception 'stale permits counted: %', s; end if;
  select * into r from public.reserve_analysis_permit('fresh1');
  if r.result <> 'accepted' then raise exception 'reserve with stale holds: %', r.result; end if;
  -- 25h-old, still reserved (sweep has not run yet)
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000007', '30000000-0000-4000-8000-000000000001', 'scored'));
  if res <> 'accepted' then raise exception 'late reserved permit refused: %', res; end if;
  select * into p from public.analysis_permits where id = '30000000-0000-4000-8000-000000000001';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'late permit not finalized like a fresh one: %/%', p.status, p.outcome;
  end if;
  -- swept by expire-stale-analysis-permits before the device came back online
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000002', 'scored'));
  if res <> 'accepted' then raise exception 'swept (released/expired) permit refused: %', res; end if;
  select * into p from public.analysis_permits where id = '30000000-0000-4000-8000-000000000002';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'swept permit not finalized like a fresh one: %/%', p.status, p.outcome;
  end if;
  -- a second, different shot on the consumed late permit is refused
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000001', 'scored'));
  if res <> 'access.permit_not_reserved' then raise exception 'late permit backed two shots: %', res; end if;
  -- both free ratings are now spent: the fresh reservation hits the backstop
  select * into s from public.access_state();
  if s.scored_count <> 2 then raise exception 'late syncs must count: %', s; end if;
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-00000000000b', r.permit_id, 'scored'));
  if res <> 'access.paywall_required' then raise exception 'third scored via fresh permit after late syncs: %', res; end if;
  if (select count(*) from public.shots where user_id = (select auth.uid()) and result_kind = 'scored') <> 2 then
    raise exception 'free account exceeded two scored shots';
  end if;
end $$;

-- 8. Cross-user isolation: user a2 cannot consume a1's permit.
reset role;
do $$
begin
  perform set_config('wf.foreign_permit', (select id::text from public.analysis_permits where idempotency_key = 'k6'), true);
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
do $$
declare res text;
begin
  res := public.apply_synced_shot(pg_temp.wf_shot('10000000-0000-4000-8000-000000000008', current_setting('wf.foreign_permit')::uuid, 'scored'));
  if res <> 'access.permit_not_found' then raise exception 'foreign permit consumed: %', res; end if;
end $$;

-- 9. verified_at is monotonic: the exact upsert the edge function issues
--    (PostgREST `on_conflict=user_id`, merge-duplicates) with an OLDER
--    verified_at must not overwrite a newer verdict, an EQUAL one is an
--    idempotent replay, and a NEWER one wins. Guards the race where a slow
--    RevenueCat round trip lands after a faster, fresher one.
reset role;
do $$
declare row_ record;
begin
  -- newest verdict first: expired at T
  insert into public.billing_entitlements as be (user_id, premium, product_key, expires_at, verified_at)
  values ('00000000-0000-4000-8000-0000000000a2', false, null, null, '2026-09-04T12:00:00Z')
  on conflict (user_id) do update set
    premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at;

  -- stale verdict (T - 5 min) says premium: must be dropped
  insert into public.billing_entitlements as be (user_id, premium, product_key, expires_at, verified_at)
  values ('00000000-0000-4000-8000-0000000000a2', true, 'pickle_sensei_pro_monthly', '2026-10-04T12:00:00Z', '2026-09-04T11:55:00Z')
  on conflict (user_id) do update set
    premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at;
  select * into row_ from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000a2';
  if row_.premium or row_.verified_at <> '2026-09-04T12:00:00Z'::timestamptz or row_.product_key is not null then
    raise exception 'stale verdict overwrote the newer one: %', row_;
  end if;

  -- equal verified_at (redelivery of the same verification) is accepted
  insert into public.billing_entitlements as be (user_id, premium, product_key, expires_at, verified_at)
  values ('00000000-0000-4000-8000-0000000000a2', false, null, null, '2026-09-04T12:00:00Z')
  on conflict (user_id) do update set
    premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at;
  select * into row_ from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000a2';
  if row_.premium or row_.verified_at <> '2026-09-04T12:00:00Z'::timestamptz then
    raise exception 'equal-timestamp replay rejected: %', row_;
  end if;

  -- newer verdict (T + 1 min) says premium again: must win
  insert into public.billing_entitlements as be (user_id, premium, product_key, expires_at, verified_at)
  values ('00000000-0000-4000-8000-0000000000a2', true, 'pickle_sensei_pro_monthly', '2026-10-04T12:00:00Z', '2026-09-04T12:01:00Z')
  on conflict (user_id) do update set
    premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at;
  select * into row_ from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000a2';
  if not row_.premium or row_.verified_at <> '2026-09-04T12:01:00Z'::timestamptz
     or row_.product_key <> 'pickle_sensei_pro_monthly' then
    raise exception 'newer verdict did not win: %', row_;
  end if;
end $$;

rollback;
\echo SEQUENTIAL FREE-RATING / ENTITLEMENT INVARIANTS: ALL PASSED
