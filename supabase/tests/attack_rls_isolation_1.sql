-- ============================================================================
-- Pickle Sensei — adversarial pass 3, subsystem db-rls-grants-isolation (#1).
--
-- Runs AFTER shim_auth.sql + every migration on a throwaway Postgres (see
-- run_attack_rls_isolation_1.sh). Unlike security_regression.sql this file
-- is NOT one transaction: several attacks need real wall-clock progress
-- (now() is frozen inside a transaction), so every step autocommits and the
-- caller identity is switched with session-level SET ROLE / SET.
--
-- Each attack records HELD / BROKEN / INFO into public.attack_results instead
-- of aborting on the first failure, so one run reports every scenario. The
-- final block exits non-zero if any verdict is BROKEN.
--
-- Scenarios (coordinator assignment, pass 3):
--   S1  provider column forge (profiles.provider = 'apple' as a Google user)
--   S3  premium expiring 1s after reserve → scored sync must hit the backstop
--   S4  progress_daily / practice_days / player_technique_rating isolation
--   S5  finalized permit reverted to reserved → third free rating refused
--   S6  resultKind 'bogus' → permit neither finalized nor released
--   S7  resultKind 'scored' + overallScore null → shot.write_failed:, permit
--       stays reserved
--   S2 (advisory lock across two sessions) lives in
--       attack_rls_isolation_1_sessions.sh — it needs two connections.
--   X*  extra attacks: corrupt permit state, oversized/unicode keys, forged
--       created_at, malformed ids, EXECUTE dependency of access_lock_key.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

\set alice '00000000-0000-4000-8000-0000000000a1'
\set bob   '00000000-0000-4000-8000-0000000000b1'
\set dave  '00000000-0000-4000-8000-0000000000d1'
\set erin  '00000000-0000-4000-8000-0000000000e1'

-- ──────────────────────────── results ledger ────────────────────────────────
create table if not exists public.attack_results (
  ord serial primary key,
  scenario text not null,
  verdict text not null check (verdict in ('HELD', 'BROKEN', 'INFO')),
  detail text
);
grant select, insert on public.attack_results to authenticated;
grant usage, select on sequence public.attack_results_ord_seq to authenticated;

create or replace function public.attack_record(p_scenario text, p_verdict text, p_detail text)
returns void language sql as $$
  insert into public.attack_results (scenario, verdict, detail)
  values (p_scenario, p_verdict, p_detail)
$$;
grant execute on function public.attack_record(text, text, text) to authenticated;

-- A full, valid scored-shot payload builder so each attack varies ONE thing.
create or replace function public.attack_shot(
  p_id uuid, p_permit uuid, p_kind text, p_score numeric, p_shot_type text default 'drive'
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'resultKind', p_kind,
    'shotType', p_shot_type, 'cameraView', 'side',
    'capturedAt', '2026-09-04T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', p_score, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 400, 'representativeMs', 500,
      'endMs', 600, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object(
      'key', 'contact_position', 'score', 71, 'confidence', 0.9,
      'band', 'green', 'direction', 'ok', 'severity', 0.1,
      'applicable', true))
  )
$$;
grant execute on function public.attack_shot(uuid, uuid, text, numeric, text) to authenticated;

-- ──────────────────────────── seed users ────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  (:'alice', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  (:'bob',   'bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}'),
  (:'dave',  'dave@example.com',  '{"full_name":"Dave"}',  '{"provider":"google"}'),
  (:'erin',  'erin@example.com',  '{"full_name":"Erin"}',  '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', :'alice', '{"sub":"google-sub-alice"}'),
  ('apple',  'apple-sub-bob',    :'bob',   '{"sub":"apple-sub-bob"}'),
  ('google', 'google-sub-dave',  :'dave',  '{"sub":"google-sub-dave"}'),
  ('apple',  'apple-sub-erin',   :'erin',  '{"sub":"apple-sub-erin"}');

do $$
begin
  if (select count(*) from public.profiles) <> 4 then
    raise exception 'SETUP: handle_new_user did not provision 4 profiles';
  end if;
end $$;

-- ═══════════════════════ Alice (free tier) reaches the limit ═══════════════
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

-- Setup: first free rating through the real reserve → sync path.
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('alice-k1');
  if r.result <> 'accepted' then
    raise exception 'SETUP: alice first reserve must succeed (got %)', r.result;
  end if;
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0a1', r.permit_id, 'scored', 7.1));
  if v <> 'accepted' then
    raise exception 'SETUP: alice first scored sync must be accepted (got %)', v;
  end if;
end $$;

-- S5-pre: a client CAN move a finalized permit back to reserved (column grant
-- on status/outcome, RLS owner row). Record whether that is allowed at all.
do $$
declare n int; v text;
begin
  update public.analysis_permits set status = 'reserved', outcome = null
   where user_id = auth.uid() and status = 'finalized';
  get diagnostics n = row_count;
  perform public.attack_record('S5-pre finalized→reserved revert by owner',
    'INFO', format('rows reverted=%s (grant update(status,outcome) permits it)', n));

  -- Second scored shot on the REUSED permit: still within the 2-rating limit,
  -- so this is expected to be accepted (it is the account's 2nd rating).
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0a2',
    (select id from public.analysis_permits where user_id = auth.uid() and status = 'reserved' limit 1),
    'scored', 6.5));
  perform public.attack_record('S5-pre second rating on reused permit', 'INFO',
    format('result=%s scored_count=%s', v, public.lifetime_scored_count()));
  if public.lifetime_scored_count() <> 2 then
    raise exception 'SETUP: alice must sit at exactly 2 scored (got %)', public.lifetime_scored_count();
  end if;
end $$;

-- S5: revert the finalized permit AGAIN and try a THIRD scored shot on it.
do $$
declare v text; v_permit uuid; v_status text; v_outcome text; v_scored int; v_shot int;
begin
  update public.analysis_permits set status = 'reserved', outcome = null
   where user_id = auth.uid() and status = 'finalized'
  returning id into v_permit;
  if v_permit is null then
    raise exception 'S5 SETUP: no finalized permit to revert';
  end if;

  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0a3', v_permit, 'scored', 8.0));

  select status, outcome into v_status, v_outcome
    from public.analysis_permits where id = v_permit;
  v_scored := public.lifetime_scored_count();
  select count(*) into v_shot from public.shots where id = '00000000-0000-4000-8000-00000000e0a3';

  if v = 'access.paywall_required' and v_status = 'released'
     and v_outcome = 'free_limit_exceeded' and v_scored = 2 and v_shot = 0 then
    perform public.attack_record('S5 reverted permit → 3rd scored shot', 'HELD',
      format('result=%s permit=%s/%s scored=%s shot_rows=%s', v, v_status, v_outcome, v_scored, v_shot));
  else
    perform public.attack_record('S5 reverted permit → 3rd scored shot', 'BROKEN',
      format('result=%s permit=%s/%s scored=%s shot_rows=%s', v, v_status, v_outcome, v_scored, v_shot));
  end if;
end $$;

-- S5b: rapid repeats — revert and retry 5 more times with fresh shot ids.
do $$
declare v text; v_permit uuid; i int; v_bad int := 0;
begin
  select id into v_permit from public.analysis_permits
   where user_id = auth.uid() and outcome = 'free_limit_exceeded' limit 1;
  for i in 1..5 loop
    update public.analysis_permits set status = 'reserved', outcome = null where id = v_permit;
    v := public.apply_synced_shot(public.attack_shot(
      gen_random_uuid(), v_permit, 'scored', 5 + i));
    if v <> 'access.paywall_required' then v_bad := v_bad + 1; end if;
  end loop;
  perform public.attack_record('S5b 5x revert+retry loop', 
    case when v_bad = 0 and public.lifetime_scored_count() = 2 then 'HELD' else 'BROKEN' end,
    format('non-paywall results=%s scored=%s', v_bad, public.lifetime_scored_count()));
end $$;

-- S5c: an abstention on the reverted permit is still free (contract).
do $$
declare v text; v_permit uuid; v_status text; v_outcome text;
begin
  select id into v_permit from public.analysis_permits
   where user_id = auth.uid() and outcome = 'free_limit_exceeded' limit 1;
  update public.analysis_permits set status = 'reserved', outcome = null where id = v_permit;
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0a4', v_permit, 'low_confidence', null));
  select status, outcome into v_status, v_outcome from public.analysis_permits where id = v_permit;
  perform public.attack_record('S5c abstention on reverted permit',
    case when v = 'accepted' and v_status = 'released' and v_outcome = 'low_confidence'
         then 'HELD' else 'BROKEN' end,
    format('result=%s permit=%s/%s', v, v_status, v_outcome));
end $$;

-- S5d: reserve is refused at the limit (control for the premium test below).
do $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit('alice-k-at-limit');
  perform public.attack_record('S5d reserve at free limit',
    case when r.result = 'access.paywall_required' then 'HELD' else 'BROKEN' end,
    format('result=%s', r.result));
end $$;

-- ═══════════════════════ S1: provider column forge ═════════════════════════
do $$
declare v_before text; v_after text; n int; v_count int;
begin
  select provider into v_before from public.profiles where id = auth.uid();
  update public.profiles set provider = 'apple' where id = auth.uid();
  get diagnostics n = row_count;
  select provider into v_after from public.profiles where id = auth.uid();
  perform public.attack_record('S1 profiles.provider forge google→apple', 'INFO',
    format('update rows=%s before=%s after=%s (column is in the authenticated UPDATE grant)', n, v_before, v_after));

  -- Does the forged provider move the identity ledger / free-rating math?
  v_count := public.lifetime_scored_count();
  perform public.attack_record('S1 forged provider vs lifetime_scored_count()',
    case when v_count = 2 then 'HELD' else 'BROKEN' end,
    format('lifetime_scored_count=%s with profiles.provider=%s (ledger keys on auth.identities, not profiles)', v_count, v_after));

  begin
    update public.profiles set provider = repeat('x', 51) where id = auth.uid();
    perform public.attack_record('S1b provider > 50 chars', 'BROKEN', 'accepted a 51-char provider');
  exception when check_violation then
    perform public.attack_record('S1b provider > 50 chars', 'HELD', sqlerrm);
  end;

  update public.profiles set provider = 'ünïcödé-провайдер-🥒' where id = auth.uid();
  select provider into v_after from public.profiles where id = auth.uid();
  perform public.attack_record('S1c unicode provider', 'INFO', format('stored=%s', v_after));

  update public.profiles set provider = 'google' where id = auth.uid();
end $$;

reset role;
-- S1d (superuser view): the ledger row is keyed by the auth.identities
-- provider, never by profiles.provider — verify the hash that exists.
do $$
declare v_apple_rows int; v_cnt int;
begin
  select l.scored_count into v_cnt
  from public.free_rating_ledger l
  where l.identity_hash = public.free_rating_identity_hash('google', 'google-sub-alice');
  select count(*) into v_apple_rows from public.free_rating_ledger l
  where l.identity_hash = public.free_rating_identity_hash('apple', 'google-sub-alice');
  perform public.attack_record('S1d ledger keyed by auth.identities provider',
    case when v_cnt = 2 and v_apple_rows = 0 then 'HELD' else 'BROKEN' end,
    format('google:google-sub-alice=%s apple:google-sub-alice rows=%s', v_cnt, v_apple_rows));
end $$;

-- ═══════════════════════ S3: premium expiring 1 s after reserve ════════════
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values (:'alice', true, 'pickle_sensei_pro_monthly', clock_timestamp() + interval '1 second');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

do $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit('alice-premium-1s');
  perform public.attack_record('S3-pre premium reserve at limit',
    case when r.result = 'accepted' and r.permit_status = 'reserved' then 'HELD' else 'BROKEN' end,
    format('result=%s status=%s', r.result, r.permit_status));
end $$;

do $$ begin perform pg_sleep(1.6); end $$;

do $$
declare v text; v_permit uuid; v_status text; v_outcome text; v_premium boolean;
begin
  select premium into v_premium from public.access_state();
  select id into v_permit from public.analysis_permits
   where user_id = auth.uid() and idempotency_key = 'alice-premium-1s';
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0a5', v_permit, 'scored', 9.0));
  select status, outcome into v_status, v_outcome from public.analysis_permits where id = v_permit;
  perform public.attack_record('S3 premium expired between reserve and sync',
    case when v = 'access.paywall_required' and v_status = 'released'
              and v_outcome = 'free_limit_exceeded' and v_premium = false
              and public.lifetime_scored_count() = 2
         then 'HELD' else 'BROKEN' end,
    format('access_state.premium=%s result=%s permit=%s/%s scored=%s',
           v_premium, v, v_status, v_outcome, public.lifetime_scored_count()));
end $$;

-- S3b control: a still-valid premium bypasses the limit (3rd scored accepted).
reset role;
update public.billing_entitlements set expires_at = clock_timestamp() + interval '1 hour'
 where user_id = :'alice';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('alice-premium-1h');
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0a6', r.permit_id, 'scored', 9.5));
  perform public.attack_record('S3b valid premium bypasses the limit',
    case when r.result = 'accepted' and v = 'accepted' and public.lifetime_scored_count() = 3
         then 'HELD' else 'BROKEN' end,
    format('reserve=%s sync=%s scored=%s', r.result, v, public.lifetime_scored_count()));
end $$;

-- S3c: premium cannot be self-granted or extended by the client.
do $$
begin
  begin
    update public.billing_entitlements set expires_at = now() + interval '10 years'
     where user_id = auth.uid();
    perform public.attack_record('S3c client extends own entitlement', 'BROKEN', 'update succeeded');
  exception when insufficient_privilege then
    perform public.attack_record('S3c client extends own entitlement', 'HELD', sqlerrm);
  end;
  begin
    insert into public.billing_entitlements (user_id, premium) values (auth.uid(), true);
    perform public.attack_record('S3c client inserts entitlement', 'BROKEN', 'insert succeeded');
  exception when insufficient_privilege or unique_violation then
    perform public.attack_record('S3c client inserts entitlement', 'HELD', sqlerrm);
  end;
end $$;

-- Drop Alice's premium for the rest of the run.
reset role;
delete from public.billing_entitlements where user_id = :'alice';

-- ═══════════════════════ S4: derived views isolation ═══════════════════════
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('bob-k1');
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0b1', r.permit_id, 'scored', 4.2, 'dink'));
  if r.result <> 'accepted' or v <> 'accepted' then
    raise exception 'S4 SETUP: bob scored sync failed (%/%)', r.result, v;
  end if;
  -- practice_days reads captures: one valid automatic capture for bob
  insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
  values ('00000000-0000-4000-8000-00000000c0b1', auth.uid(), '2026-09-03T10:00:00Z',
          1500, 30, 'automatic_pose_trigger', 'valid');
end $$;

set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
values ('00000000-0000-4000-8000-00000000c0a1', '00000000-0000-4000-8000-0000000000a1',
        '2026-09-04T10:00:00Z', 1500, 30, 'automatic_pose_trigger', 'valid');

set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare
  v_pd_other int; v_pd_own int;
  v_pr_other int; v_pr_own int;
  v_tr_other int; v_tr_own int;
  v_opts text[];
begin
  select count(*) filter (where user_id <> auth.uid()), count(*) filter (where user_id = auth.uid())
    into v_pd_other, v_pd_own from public.progress_daily;
  select count(*) filter (where user_id <> auth.uid()), count(*) filter (where user_id = auth.uid())
    into v_pr_other, v_pr_own from public.practice_days;
  select count(*) filter (where user_id <> auth.uid()), count(*) filter (where user_id = auth.uid())
    into v_tr_other, v_tr_own from public.player_technique_rating;

  perform public.attack_record('S4 progress_daily isolation',
    case when v_pd_other = 0 and v_pd_own > 0 then 'HELD' else 'BROKEN' end,
    format('other_rows=%s own_rows=%s', v_pd_other, v_pd_own));
  perform public.attack_record('S4 practice_days isolation',
    case when v_pr_other = 0 and v_pr_own > 0 then 'HELD' else 'BROKEN' end,
    format('other_rows=%s own_rows=%s', v_pr_other, v_pr_own));
  perform public.attack_record('S4 player_technique_rating isolation',
    case when v_tr_other = 0 and v_tr_own > 0 then 'HELD' else 'BROKEN' end,
    format('other_rows=%s own_rows=%s', v_tr_other, v_tr_own));

  -- Bob's dink must not leak through any aggregate row either.
  if exists (select 1 from public.progress_daily where shot_type = 'dink')
     or exists (select 1 from public.player_technique_rating where user_id <> auth.uid()) then
    perform public.attack_record('S4 bob dink visible to alice', 'BROKEN', 'dink aggregate visible');
  else
    perform public.attack_record('S4 bob dink visible to alice', 'HELD', 'no dink rows for alice');
  end if;

  -- Structural pin: all three views are security_invoker.
  select array_agg(c.relname order by c.relname) into v_opts
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('progress_daily', 'practice_days', 'player_technique_rating')
    and 'security_invoker=true' = any (c.reloptions);
  perform public.attack_record('S4 views declare security_invoker=true',
    case when coalesce(array_length(v_opts, 1), 0) = 3 then 'HELD' else 'BROKEN' end,
    format('security_invoker views=%s', v_opts));
end $$;

-- S4b: Bob sees his own rows and none of Alice's (the views are not empty).
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
do $$
declare v_other int; v_own int;
begin
  select count(*) filter (where user_id <> auth.uid()), count(*) filter (where user_id = auth.uid())
    into v_other, v_own from public.player_technique_rating;
  perform public.attack_record('S4b bob technique rating isolation',
    case when v_other = 0 and v_own > 0 then 'HELD' else 'BROKEN' end,
    format('other_rows=%s own_rows=%s', v_other, v_own));
end $$;

-- ═══════════════════════ S6: resultKind 'bogus' ════════════════════════════
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-00000000a0a6', '00000000-0000-4000-8000-0000000000a1', 'alice-bogus');
do $$
declare v text; v_status text; v_outcome text; v_shots int; v_phases int;
begin
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0a7', '00000000-0000-4000-8000-00000000a0a6', 'bogus', 7.0));
  select status, outcome into v_status, v_outcome
    from public.analysis_permits where id = '00000000-0000-4000-8000-00000000a0a6';
  select count(*) into v_shots from public.shots where id = '00000000-0000-4000-8000-00000000e0a7';
  select count(*) into v_phases from public.shot_phases where shot_id = '00000000-0000-4000-8000-00000000e0a7';
  perform public.attack_record('S6 resultKind bogus → permit untouched',
    case when v like 'shot.write_failed:%' and v_status = 'reserved' and v_outcome is null
              and v_shots = 0 and v_phases = 0
         then 'HELD' else 'BROKEN' end,
    format('result=%s permit=%s/%s shot_rows=%s phase_rows=%s', v, v_status, coalesce(v_outcome, '<null>'), v_shots, v_phases));
end $$;

-- ═══════════════════════ S7: scored + null overallScore ════════════════════
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-00000000a0b7', '00000000-0000-4000-8000-0000000000b1', 'bob-nullscore');
do $$
declare v text; v_status text; v_outcome text; v_shots int; v_before int; v_after int;
begin
  v_before := public.lifetime_scored_count();
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0b7', '00000000-0000-4000-8000-00000000a0b7', 'scored', null));
  v_after := public.lifetime_scored_count();
  select status, outcome into v_status, v_outcome
    from public.analysis_permits where id = '00000000-0000-4000-8000-00000000a0b7';
  select count(*) into v_shots from public.shots where id = '00000000-0000-4000-8000-00000000e0b7';
  perform public.attack_record('S7 scored + null score → write_failed, permit reserved',
    case when v like 'shot.write_failed:%' and v like '%scored_shots_have_scores%'
              and v_status = 'reserved' and v_outcome is null and v_shots = 0 and v_before = v_after
         then 'HELD' else 'BROKEN' end,
    format('result=%s permit=%s/%s shot_rows=%s scored %s→%s', v, v_status, coalesce(v_outcome, '<null>'), v_shots, v_before, v_after));

end $$;

-- S7c (bob still has 1 scored, so the backstop does not pre-empt the write):
-- the same CHECK trip via score out of range (10.5) and via oversized
-- shot_type (65 chars) — every write failure must leave the permit reserved.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-00000000a0b8', '00000000-0000-4000-8000-0000000000b1', 'bob-badwrites');
do $$
declare v1 text; v2 text; v_status text;
begin
  v1 := public.apply_synced_shot(public.attack_shot(
    gen_random_uuid(), '00000000-0000-4000-8000-00000000a0b8', 'scored', 10.5));
  v2 := public.apply_synced_shot(public.attack_shot(
    gen_random_uuid(), '00000000-0000-4000-8000-00000000a0b8', 'scored', 5.0, repeat('ü', 65)));
  select status into v_status from public.analysis_permits where id = '00000000-0000-4000-8000-00000000a0b8';
  perform public.attack_record('S7c score>10 and 65-char shot_type → write_failed',
    case when v1 like 'shot.write_failed:%' and v2 like 'shot.write_failed:%' and v_status = 'reserved'
         then 'HELD' else 'BROKEN' end,
    format('v1=%s | v2=%s | permit=%s', v1, v2, v_status));
end $$;

-- S7b: the null-score permit is still usable for a clean retry.
do $$
declare v text; v_status text; v_outcome text;
begin
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0b7', '00000000-0000-4000-8000-00000000a0b7', 'scored', 6.0));
  select status, outcome into v_status, v_outcome
    from public.analysis_permits where id = '00000000-0000-4000-8000-00000000a0b7';
  perform public.attack_record('S7b retry after write_failed consumes the permit',
    case when v = 'accepted' and v_status = 'finalized' and v_outcome = 'scored' then 'HELD' else 'BROKEN' end,
    format('result=%s permit=%s/%s scored=%s', v, v_status, v_outcome, public.lifetime_scored_count()));
end $$;

-- ═══════════════════════ X: extra attacks ══════════════════════════════════
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

-- X1: corrupt permit state — status outside the CHECK vocabulary.
do $$
begin
  begin
    update public.analysis_permits set status = 'bogus'
     where id = '00000000-0000-4000-8000-00000000a0a6';
    perform public.attack_record('X1 permit.status = bogus', 'BROKEN', 'accepted');
  exception when check_violation then
    perform public.attack_record('X1 permit.status = bogus', 'HELD', sqlerrm);
  end;
  begin
    update public.analysis_permits set outcome = repeat('o', 51)
     where id = '00000000-0000-4000-8000-00000000a0a6';
    perform public.attack_record('X1b permit.outcome 51 chars', 'BROKEN', 'accepted');
  exception when check_violation then
    perform public.attack_record('X1b permit.outcome 51 chars', 'HELD', sqlerrm);
  end;
end $$;

-- X2 (as Dave, who has quota so the INSERT is actually reached): idempotency
-- key bounds — 129 chars must be refused by the DB even if the edge fn
-- validation (<=128) were bypassed; 128 multibyte chars are fine.
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000d1';
do $$
declare r record; n int;
begin
  begin
    select * into r from public.reserve_analysis_permit(repeat('k', 129));
    perform public.attack_record('X2 reserve 129-char key', 'BROKEN', format('result=%s', r.result));
  exception when check_violation then
    perform public.attack_record('X2 reserve 129-char key', 'HELD', 'check_violation: ' || sqlerrm);
  end;
  begin
    select * into r from public.reserve_analysis_permit(repeat('🥒', 128));
    perform public.attack_record('X2b reserve 128-emoji key', 'INFO', format('result=%s', r.result));
    update public.analysis_permits set status = 'released', outcome = 'cancelled'
     where id = r.permit_id and status = 'reserved';
  exception when others then
    perform public.attack_record('X2b reserve 128-emoji key', 'INFO', 'error: ' || sqlerrm);
  end;
  begin
    select * into r from public.reserve_analysis_permit(null);
    perform public.attack_record('X2c reserve null key', 'INFO', format('result=%s', r.result));
  exception when others then
    perform public.attack_record('X2c reserve null key', 'INFO', 'error(' || sqlstate || '): ' || sqlerrm);
  end;
  select count(*) into n from public.analysis_permits where user_id = auth.uid() and status = 'reserved';
  perform public.attack_record('X2d dave holds no reserved permits after key probes',
    case when n = 0 then 'HELD' else 'BROKEN' end, format('reserved=%s', n));
end $$;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';

-- X3: forged created_at on a self-inserted permit (INSERT grant is whole-row).
do $$
declare v text; v_status text; v_outcome text; v_reserved int;
begin
  insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-00000000a0a9', auth.uid(), 'alice-old', now() - interval '25 hours');
  v := public.apply_synced_shot(public.attack_shot(
    gen_random_uuid(), '00000000-0000-4000-8000-00000000a0a9', 'low_confidence', null));
  select status, outcome into v_status, v_outcome
    from public.analysis_permits where id = '00000000-0000-4000-8000-00000000a0a9';
  perform public.attack_record('X3 25h-old permit → expired',
    case when v = 'access.permit_expired' and v_status = 'released' and v_outcome = 'expired'
         then 'HELD' else 'BROKEN' end,
    format('result=%s permit=%s/%s', v, v_status, v_outcome));

  insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-00000000a0aa', auth.uid(), 'alice-future', now() + interval '1 year');
  select reserved_count into v_reserved from public.access_state();
  v := public.apply_synced_shot(public.attack_shot(
    gen_random_uuid(), '00000000-0000-4000-8000-00000000a0aa', 'scored', 7.7));
  perform public.attack_record('X3b future-dated self-inserted permit', 
    case when v = 'access.paywall_required' and public.lifetime_scored_count() = 3 then 'HELD' else 'BROKEN' end,
    format('scored sync=%s (backstop still applies) reserved_count=%s scored=%s', v, v_reserved, public.lifetime_scored_count()));
end $$;

-- X4: malformed ids raise (never silently accept) and write nothing.
do $$
declare v text; v_n int;
begin
  begin
    v := public.apply_synced_shot(jsonb_build_object('id', 'not-a-uuid', 'analysisPermitId', 'x', 'resultKind', 'scored'));
    perform public.attack_record('X4 non-uuid shot id', 'INFO', format('returned %s', v));
  exception when others then
    perform public.attack_record('X4 non-uuid shot id', 'INFO', 'raised(' || sqlstate || '): ' || sqlerrm);
  end;
  begin
    v := public.apply_synced_shot('{}'::jsonb);
    perform public.attack_record('X4b empty payload', 'INFO', format('returned %s', v));
  exception when others then
    perform public.attack_record('X4b empty payload', 'INFO', 'raised(' || sqlstate || '): ' || sqlerrm);
  end;
  begin
    v := public.apply_synced_shot(null);
    perform public.attack_record('X4c null payload', 'INFO', format('returned %s', coalesce(v, '<null>')));
  exception when others then
    perform public.attack_record('X4c null payload', 'INFO', 'raised(' || sqlstate || '): ' || sqlerrm);
  end;
  select count(*) into v_n from public.shots where user_id = auth.uid();
  perform public.attack_record('X4d malformed calls wrote nothing',
    case when v_n = 4 then 'HELD' else 'BROKEN' end, format('alice shots=%s (expected 4: 3 scored + 1 low_confidence)', v_n));
end $$;

-- X5: apply_synced_shot with a permit that is not the caller's (Bob's).
do $$
declare v text; v_status text;
begin
  v := public.apply_synced_shot(public.attack_shot(
    gen_random_uuid(), '00000000-0000-4000-8000-00000000a0b8', 'low_confidence', null));
  execute 'reset role';
  select status into v_status from public.analysis_permits where id = '00000000-0000-4000-8000-00000000a0b8';
  perform public.attack_record('X5 spend bob permit as alice',
    case when v = 'access.permit_not_found' and v_status = 'reserved' then 'HELD' else 'BROKEN' end,
    format('result=%s bob permit=%s', v, v_status));
end $$;

-- X6: the ledger is untouched by a client, and identity_scored_count() is
-- caller-scoped: alice cannot read bob's count via any argument.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare v int; v_sig int;
begin
  begin
    perform 1 from public.free_rating_ledger;
    perform public.attack_record('X6 client reads free_rating_ledger', 'BROKEN', 'select succeeded');
  exception when insufficient_privilege then
    perform public.attack_record('X6 client reads free_rating_ledger', 'HELD', sqlerrm);
  end;
  begin
    perform public.free_rating_identity_hash('apple', 'apple-sub-bob');
    perform public.attack_record('X6b client computes ledger hash', 'BROKEN', 'execute succeeded');
  exception when insufficient_privilege then
    perform public.attack_record('X6b client computes ledger hash', 'HELD', sqlerrm);
  end;
  select count(*) into v_sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'identity_scored_count' and p.pronargs > 0;
  v := public.identity_scored_count();
  perform public.attack_record('X6c identity_scored_count() caller-scoped',
    case when v_sig = 0 and v = 3 then 'HELD' else 'BROKEN' end,
    format('overloads_with_args=%s alice_count=%s', v_sig, v));
end $$;

-- X7: EXECUTE on access_lock_key is load-bearing for the invoker RPCs — if it
-- were revoked from authenticated, reserve_analysis_permit itself breaks.
reset role;
do $$
declare r record; v_err text;
begin
  revoke execute on function public.access_lock_key(uuid) from authenticated;
  execute 'set local role authenticated';
  execute $q$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000e1', true)$q$;
  begin
    select * into r from public.reserve_analysis_permit('erin-noexec');
    v_err := format('reserve returned %s', r.result);
  exception when insufficient_privilege then
    v_err := 'insufficient_privilege: ' || sqlerrm;
  end;
  execute 'reset role';
  grant execute on function public.access_lock_key(uuid) to authenticated;
  perform public.attack_record('X7 reserve without EXECUTE on access_lock_key', 'INFO', v_err);
end $$;

-- X8: pg_advisory_xact_lock and access_lock_key are callable by authenticated
-- (the S2 two-session probe relies on this; recorded as fact here).
do $$
begin
  perform public.attack_record('X8 authenticated EXECUTE facts', 'INFO', format(
    'access_lock_key=%s pg_advisory_xact_lock(bigint)=%s hashtextextended=%s',
    has_function_privilege('authenticated', 'public.access_lock_key(uuid)', 'execute'),
    has_function_privilege('authenticated', 'pg_catalog.pg_advisory_xact_lock(bigint)', 'execute'),
    has_function_privilege('authenticated', 'pg_catalog.hashtextextended(text, bigint)', 'execute')));
end $$;

-- ═══════ Setup for the multi-session script (attack_rls_isolation_1_sessions.sh)
-- Dave: 1 scored rating + 5 directly inserted reserved permits.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000d1';
do $$
declare r record; v text; i int;
begin
  select * into r from public.reserve_analysis_permit('dave-k1');
  v := public.apply_synced_shot(public.attack_shot(
    '00000000-0000-4000-8000-00000000e0d1', r.permit_id, 'scored', 6.0));
  if r.result <> 'accepted' or v <> 'accepted' then
    raise exception 'DAVE SETUP failed (%/%)', r.result, v;
  end if;
  for i in 1..5 loop
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values (('00000000-0000-4000-8000-00000000d0d' || i)::uuid, auth.uid(), 'dave-direct-' || i);
  end loop;
end $$;
reset role;

-- ──────────────────────────── report ────────────────────────────────────────
\set QUIET off
\pset format aligned
\pset border 2
select ord, scenario, verdict, detail from public.attack_results order by ord;

do $$
declare v_broken int;
begin
  select count(*) into v_broken from public.attack_results where verdict = 'BROKEN';
  if v_broken > 0 then
    raise exception 'ATTACK SQL: % BROKEN scenario(s)', v_broken;
  end if;
end $$;
\echo ATTACK SQL (single-session scenarios): NO BROKEN VERDICTS
