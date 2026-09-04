-- ============================================================================
-- Pickle Sensei — adversarial pass 3 / tester #2: db-rls-grants-isolation.
--
-- Runs AFTER every migration (see run_attack_db_rls_grants_isolation_2.sh),
-- against a throwaway Postgres, never against the hosted project. Every
-- case is written as an ATTACK performed by Alice (authenticated) and
-- asserts the exact outcome. Any assertion failure aborts the script
-- (ON_ERROR_STOP) naming the case. Facts that are observed-but-not-asserted
-- are printed with \echo / raise notice so the run log is the artifact.
--
-- Assigned scenarios (coordinator numbering S1..S7):
--   S1  reserve_analysis_permit(NULL) / ('') — 23502 vs accepted; no
--       NULL/empty-key permits accumulate.
--   S2  Alice deletes her own session that has shots — delete succeeds,
--       shots survive with session_id null, lifetime_scored_count()
--       unchanged.
--   S3  permit created_at = now() - 24h EXACTLY — access_state().
--       reserved_count and apply_synced_shot()'s expiry branch agree.
--   S4  five direct INSERTs into public.shots (scored, 10.0, NO permit) —
--       effect on player_rank_state / free_rating_ledger / access_state().
--   S5  INSERT into public.shots with source='fixture' → check_violation.
--   S6  INSERT/UPDATE/DELETE on Alice's own public.captures row — which
--       operations succeed (is the unused grant narrowable?).
--   S7  reserve with a 129-char idempotency key → check_violation (not
--       access.paywall_required) and no permit row created.
-- Own additions (X1..X6): unicode / huge keys, seeded rapid-replay fuzz,
--   future-dated (clock-skew) permits, FK-check-bypasses-RLS probe on the
--   detail tables, cross-user permit/capture writes, savepoint cancellation.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- ──────────────────────────── seed (as postgres) ───────────────────────────
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000000c', 'carol@example.com',
   '{"full_name":"Carol"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice","email":"alice@example.com"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-00000000000b',
   '{"sub":"apple-sub-bob","email":"bob@example.com"}'),
  ('google', 'google-sub-carol', '00000000-0000-4000-8000-00000000000c',
   '{"sub":"google-sub-carol","email":"carol@example.com"}');

do $$
begin
  if (select count(*) from public.profiles) <> 3 then
    raise exception 'SETUP: handle_new_user trigger did not provision profiles';
  end if;
end $$;

-- Bob's session + one synced-looking shot with a 'contact' phase, so the
-- cross-user probes have a real target. Written as postgres (table owner),
-- exactly like the sync path would have left them.
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-00000000000b', now());
insert into public.shots (
  id, user_id, session_id, shot_type, camera_view, captured_at,
  start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values (
  '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-0000000000d2', 'drive', 'side', '2026-08-30T10:00:00Z',
  0, 500, 1000, 6.5, 0.9, 'scored',
  '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b',
        'contact', 400, 500, 600, 0.9);

-- Snapshot of Bob's state the cross-user probes must leave untouched.
create temp table bob_before as
select
  (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-00000000000b') as shots,
  (select count(*) from public.shot_phases where user_id = '00000000-0000-4000-8000-00000000000b') as phases,
  (select coalesce(max(l.scored_count), 0)
     from auth.identities i
     join public.free_rating_ledger l
       on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
    where i.user_id = '00000000-0000-4000-8000-00000000000b') as ledger,
  (select rating from public.player_rank_state where user_id = '00000000-0000-4000-8000-00000000000b') as rating;

-- A reusable shot-row writer for Alice's DIRECT (non-RPC) inserts. Owned by
-- postgres but SECURITY INVOKER, so it runs under whatever role calls it
-- (grants + RLS apply exactly as to a hand-written INSERT).
create function pg_temp.alice_direct_shot(
  p_id uuid, p_session uuid, p_result text, p_score numeric, p_source text default 'real')
returns void language plpgsql security invoker as $$
begin
  insert into public.shots (
    id, user_id, session_id, shot_type, camera_view, captured_at,
    start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, source,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
  values (
    p_id, '00000000-0000-4000-8000-00000000000a', p_session, 'drive', 'side', now(),
    0, 500, 1000, p_score, 0.9, p_result, p_source,
    '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
end $$;

create function pg_temp.sync_payload(p_shot uuid, p_permit uuid, p_session uuid, p_kind text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_shot, 'analysisPermitId', p_permit, 'sessionId', p_session,
    'resultKind', p_kind, 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'guidance', case when p_kind = 'scored' then null else 'move back' end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb)
$$;

grant execute on function pg_temp.alice_direct_shot(uuid, uuid, text, numeric, text) to authenticated;
grant execute on function pg_temp.sync_payload(uuid, uuid, uuid, text) to authenticated;

-- ═══════════════════════════ become Alice ═══════════════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

\echo [S1] reserve_analysis_permit(NULL) / (empty) / (whitespace)
do $$
declare r record; v_state text; v_first uuid; v_second uuid; n int;
begin
  -- NULL: the fast-path lookup (key = NULL) never matches, the function
  -- takes the lock, passes the allowance check and hits the NOT NULL
  -- column → 23502 raised out of the RPC (no accepted row, no swallow).
  begin
    select * into r from public.reserve_analysis_permit(null);
    raise exception 'S1: reserve(NULL) returned % instead of raising', r.result;
  exception
    when not_null_violation then
      get stacked diagnostics v_state = returned_sqlstate;
      raise notice 'S1: reserve(NULL) raised SQLSTATE % (not_null_violation) — as expected', v_state;
  end;
  select count(*) into n from public.analysis_permits where idempotency_key is null;
  if n <> 0 then
    raise exception 'S1: % NULL-key permit(s) exist after reserve(NULL)', n;
  end if;

  -- '' : the table has no minimum-length check, so the DB layer ACCEPTS an
  -- empty key. Assert the observed contract precisely: accepted, ONE row,
  -- replays are idempotent (no accumulation), it costs one allowance slot.
  select * into r from public.reserve_analysis_permit('');
  if r.result <> 'accepted' then
    raise exception 'S1: reserve('''') result % (expected accepted at the DB layer — edge fn is the only guard)', r.result;
  end if;
  v_first := r.permit_id;
  select * into r from public.reserve_analysis_permit('');
  select * into r from public.reserve_analysis_permit('');
  if r.result <> 'accepted' or r.permit_id <> v_first then
    raise exception 'S1: replaying '''' must return the same permit (got % / %)', r.result, r.permit_id;
  end if;
  select count(*) into n from public.analysis_permits where idempotency_key = '';
  if n <> 1 then
    raise exception 'S1: empty-key permits accumulated (%)', n;
  end if;

  -- whitespace-only is a DISTINCT key at the DB layer (edge fn trims).
  select * into r from public.reserve_analysis_permit('   ');
  if r.result <> 'accepted' then
    raise exception 'S1: reserve(''   '') result % (expected accepted at the DB layer)', r.result;
  end if;
  v_second := r.permit_id;
  if v_second = v_first then
    raise exception 'S1: whitespace key collided with empty key';
  end if;
  select reserved_count into n from public.access_state();
  if n <> 2 then
    raise exception 'S1: reserved_count % after two degenerate keys (expected 2)', n;
  end if;
  -- Both allowance slots are now held by degenerate keys: a real key is refused.
  select * into r from public.reserve_analysis_permit('alice-real-key');
  if r.result <> 'access.paywall_required' then
    raise exception 'S1: third reserve got % (expected access.paywall_required)', r.result;
  end if;
  raise notice 'S1: DB accepts '''' and ''   '' as idempotency keys (1 permit each, idempotent replays, each occupies an allowance slot); edge fn index.ts rejects !idempotencyKey.trim() before the RPC';

  -- Release both so the remaining cases start from a clean allowance.
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup'
   where id in (v_first, v_second);
  select reserved_count into n from public.access_state();
  if n <> 0 then
    raise exception 'S1: cleanup failed, reserved_count=%', n;
  end if;
end $$;

\echo [S2] delete own session that has shots
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now());
do $$
declare v text; r record; v_before int; v_after int; v_rating numeric; v_rating_after numeric; n int;
begin
  -- One scored shot through the real sync path (permit → apply_synced_shot)
  -- and one low_confidence shot the same way, both in session d1.
  select * into r from public.reserve_analysis_permit('s2-permit-scored');
  v := public.apply_synced_shot(pg_temp.sync_payload(
    '00000000-0000-4000-8000-0000000000e1', r.permit_id,
    '00000000-0000-4000-8000-0000000000d1', 'scored'));
  if v <> 'accepted' then raise exception 'S2 setup: scored sync got %', v; end if;
  select * into r from public.reserve_analysis_permit('s2-permit-abstain');
  v := public.apply_synced_shot(pg_temp.sync_payload(
    '00000000-0000-4000-8000-0000000000e2', r.permit_id,
    '00000000-0000-4000-8000-0000000000d1', 'low_confidence'));
  if v <> 'accepted' then raise exception 'S2 setup: abstention sync got %', v; end if;

  select count(*) into n from public.shots
   where session_id = '00000000-0000-4000-8000-0000000000d1';
  if n <> 2 then raise exception 'S2 setup: expected 2 shots in d1, got %', n; end if;
  v_before := public.lifetime_scored_count();
  select rating into v_rating from public.player_rank_state
   where user_id = '00000000-0000-4000-8000-00000000000a';
  if v_before <> 1 or v_rating is null then
    raise exception 'S2 setup: lifetime=% rating=%', v_before, v_rating;
  end if;

  -- THE ATTACK: delete the session. FK shots.session_id ON DELETE SET NULL
  -- runs as the table owner (RI bypasses RLS); the shots must survive.
  delete from public.sessions where id = '00000000-0000-4000-8000-0000000000d1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'S2: session delete affected % rows', n; end if;
  if exists (select 1 from public.sessions where id = '00000000-0000-4000-8000-0000000000d1') then
    raise exception 'S2: session still visible after delete';
  end if;
  select count(*) into n from public.shots
   where id in ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2')
     and session_id is null;
  if n <> 2 then
    raise exception 'S2: expected both shots to survive with session_id null, got %', n;
  end if;
  v_after := public.lifetime_scored_count();
  if v_after <> v_before then
    raise exception 'S2: lifetime_scored_count changed % → % on session delete', v_before, v_after;
  end if;
  select rating into v_rating_after from public.player_rank_state
   where user_id = '00000000-0000-4000-8000-00000000000a';
  if v_rating_after is distinct from v_rating then
    raise exception 'S2: rank rating changed % → % on session delete', v_rating, v_rating_after;
  end if;
  select scored_count into n from public.access_state();
  if n <> 1 then raise exception 'S2: access_state.scored_count=% (expected 1)', n; end if;
  raise notice 'S2: session delete OK; 2 shots orphaned (session_id null); lifetime_scored_count=% unchanged; rating=% unchanged', v_after, v_rating_after;
end $$;

\echo [S3] permit created_at = now() - interval 24 hours EXACTLY
-- now() is frozen for the whole transaction, so "exactly" is deterministic:
-- the row's created_at equals the value every predicate below compares to.
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-00000000000a',
        's3-boundary', now() - interval '24 hours');
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-00000000000a',
        's3-boundary-plus-1us', now() - interval '24 hours' + interval '1 microsecond');
do $$
declare v text; r record; n int; st text; oc text;
begin
  -- access_state(): `created_at > now() - 24h` is STRICT, so the exact
  -- boundary row is NOT counted; the +1µs row IS.
  select reserved_count into n from public.access_state();
  if n <> 1 then
    raise exception 'S3: access_state.reserved_count=% (expected 1: boundary excluded, +1us included)', n;
  end if;
  -- reserve_analysis_permit() uses the same strict predicate: with
  -- scored=1 (from S2) and one fresh reserved (+1µs), remaining is 0 → the
  -- boundary permit must NOT be what blocks; the +1µs one is. Prove the
  -- boundary row is excluded from the reserve count by releasing +1µs and
  -- showing a new reserve is then accepted.
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup'
   where id = '00000000-0000-4000-8000-0000000000a4';
  select * into r from public.reserve_analysis_permit('s3-fresh');
  if r.result <> 'accepted' then
    raise exception 'S3: reserve with only the boundary permit outstanding got % (boundary must not count)', r.result;
  end if;
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup'
   where id = r.permit_id;

  -- apply_synced_shot(): `created_at <= now() - 24h` — boundary row IS expired.
  v := public.apply_synced_shot(pg_temp.sync_payload(
    '00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000a3',
    null, 'low_confidence'));
  if v <> 'access.permit_expired' then
    raise exception 'S3: sync with boundary permit returned % (expected access.permit_expired)', v;
  end if;
  select status, outcome into st, oc from public.analysis_permits
   where id = '00000000-0000-4000-8000-0000000000a3';
  if st <> 'released' or oc <> 'expired' then
    raise exception 'S3: boundary permit left as %/% (expected released/expired)', st, oc;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000e3') then
    raise exception 'S3: expired-permit sync wrote a shot';
  end if;

  -- +1µs row: re-reserve it (status back to reserved) and sync → accepted.
  update public.analysis_permits set status = 'reserved', outcome = null
   where id = '00000000-0000-4000-8000-0000000000a4';
  v := public.apply_synced_shot(pg_temp.sync_payload(
    '00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000a4',
    null, 'low_confidence'));
  if v <> 'accepted' then
    raise exception 'S3: sync with boundary+1us permit returned % (expected accepted)', v;
  end if;
  select reserved_count into n from public.access_state();
  if n <> 0 then raise exception 'S3: reserved_count=% after cleanup (expected 0)', n; end if;
  raise notice 'S3: boundary agrees — access_state excludes (>), reserve excludes (>), apply_synced_shot expires (<=); +1us row counted and accepted';
end $$;

\echo [S4] five direct INSERTs into public.shots (scored, 10.0, NO permit)
do $$
declare i int; n int; v_rating numeric; v_tier text; v_scored int; r record;
begin
  for i in 1..5 loop
    perform pg_temp.alice_direct_shot(
      ('00000000-0000-4000-8000-0000000000f' || i)::uuid, null, 'scored', 10);
  end loop;
  select count(*) into n from public.shots
   where user_id = '00000000-0000-4000-8000-00000000000a' and result_kind = 'scored';
  if n <> 6 then  -- 1 from S2 + 5 forged
    raise exception 'S4: expected 6 scored shots visible to Alice, got %', n;
  end if;
  select rating, tier into v_rating, v_tier from public.player_rank_state
   where user_id = '00000000-0000-4000-8000-00000000000a';
  select scored_count into v_scored from public.access_state();
  raise notice 'S4: after 5 forged scored shots — player_rank_state rating=% tier=%; access_state.scored_count=%; lifetime_scored_count=%',
    v_rating, v_tier, v_scored, public.lifetime_scored_count();
  -- Assert the consequence precisely (this is the accepted threat model:
  -- authenticated INSERT on shots is granted, RLS only pins user_id).
  if v_scored <> 6 or public.lifetime_scored_count() <> 6 then
    raise exception 'S4: forged shots must count against the free allowance (scored_count=%)', v_scored;
  end if;
  -- v2 formula: recent-8 recency-weighted window mixes the 7.1 sync shot
  -- with the five 10.0 forgeries; the tier must still be diamond.
  if v_tier <> 'diamond' then
    raise exception 'S4: 5x 10.0 must land diamond under the v2 formula (got % / %)', v_tier, v_rating;
  end if;
  select * into r from public.reserve_analysis_permit('s4-after-forgery');
  if r.result <> 'access.paywall_required' then
    raise exception 'S4: reserve after forgery got % (expected paywall — forgery burns, never gains, free ratings)', r.result;
  end if;
  -- The forged rows are immutable afterwards (no UPDATE/DELETE grant).
  begin
    update public.shots set overall_score = 0 where id = '00000000-0000-4000-8000-0000000000f1';
    raise exception 'S4: client UPDATE on shots must be denied';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.shots where id = '00000000-0000-4000-8000-0000000000f1';
    raise exception 'S4: client DELETE on shots must be denied';
  exception when insufficient_privilege then null; end;
end $$;

\echo [S5] INSERT into public.shots with source=fixture
do $$
declare v_state text; v_constraint text; n int;
begin
  begin
    perform pg_temp.alice_direct_shot('00000000-0000-4000-8000-0000000000f6'::uuid, null, 'scored', 5, 'fixture');
    raise exception 'S5: source=''fixture'' must be rejected';
  exception when check_violation then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
    raise notice 'S5: source=''fixture'' → SQLSTATE % constraint %', v_state, v_constraint;
    if v_constraint <> 'shots_source_check' then
      raise exception 'S5: rejected by % (expected shots_source_check)', v_constraint;
    end if;
  end;
  -- Case / padding variants are equally rejected (exact-match check).
  begin
    perform pg_temp.alice_direct_shot('00000000-0000-4000-8000-0000000000f7'::uuid, null, 'scored', 5, 'REAL');
    raise exception 'S5: source=''REAL'' must be rejected';
  exception when check_violation then null; end;
  begin
    perform pg_temp.alice_direct_shot('00000000-0000-4000-8000-0000000000f8'::uuid, null, 'scored', 5, 'real ');
    raise exception 'S5: source=''real '' must be rejected';
  exception when check_violation then null; end;
  begin
    perform pg_temp.alice_direct_shot('00000000-0000-4000-8000-0000000000f9'::uuid, null, 'scored', 5, '');
    raise exception 'S5: source='''' must be rejected';
  exception when check_violation then null; end;
  select count(*) into n from public.shots where source <> 'real';
  if n <> 0 then raise exception 'S5: % non-real shot(s) exist', n; end if;
end $$;

\echo [S6] INSERT / UPDATE / DELETE on Alice-owned public.captures row
do $$
declare n int; ok_ins boolean := false; ok_upd boolean := false; ok_del boolean := false;
begin
  begin
    insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000a',
            now(), 1500, 30, 'automatic_pose_trigger', 'valid');
    ok_ins := true;
  exception when insufficient_privilege then null; end;
  begin
    update public.captures set status = 'analyzed', width = 1920, height = 1080
     where id = '00000000-0000-4000-8000-0000000000c1';
    get diagnostics n = row_count;
    ok_upd := (n = 1);
  exception when insufficient_privilege then null; end;
  begin
    delete from public.captures where id = '00000000-0000-4000-8000-0000000000c1';
    get diagnostics n = row_count;
    ok_del := (n = 1);
  exception when insufficient_privilege then null; end;
  raise notice 'S6: captures owner grants — INSERT=% UPDATE=% DELETE=% (edge fn supabase/functions/api never touches public.captures: grep -n captures supabase/functions/api/*.ts → 0 hits)',
    ok_ins, ok_upd, ok_del;
  -- Pin the CURRENT state so any narrowing shows up here as a deliberate change.
  if not (ok_ins and ok_upd and ok_del) then
    raise exception 'S6: captures grants changed from the pinned INSERT/UPDATE/DELETE=true (got %/%/%)', ok_ins, ok_upd, ok_del;
  end if;
  -- Cross-user: Alice cannot plant a capture on Bob's user_id, nor touch his rows.
  begin
    insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-00000000000b',
            now(), 1500, 30, 'automatic_pose_trigger', 'valid');
    raise exception 'S6: capture INSERT with Bob''s user_id must be denied by RLS';
  exception when insufficient_privilege then null; end;
end $$;

\echo [S7] reserve with a 129-char idempotency key
-- (a) a user WITH allowance (Bob: 1 scored, remaining=1): the key-bounds
--     CHECK fires at insert time → check_violation, no row.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare r record; v_state text; v_constraint text; n int; k129 text := repeat('k', 129);
begin
  begin
    select * into r from public.reserve_analysis_permit(k129);
    raise exception 'S7: 129-char key returned % instead of raising', r.result;
  exception when check_violation then
    get stacked diagnostics v_state = returned_sqlstate, v_constraint = constraint_name;
    raise notice 'S7: 129-char key (user with allowance) → SQLSTATE % constraint %', v_state, v_constraint;
    if v_constraint <> 'analysis_permits_key_bounds' then
      raise exception 'S7: rejected by % (expected analysis_permits_key_bounds)', v_constraint;
    end if;
  end;
  select count(*) into n from public.analysis_permits where idempotency_key = k129;
  if n <> 0 then raise exception 'S7: 129-char permit row exists'; end if;
  select count(*) into n from public.analysis_permits where length(idempotency_key) > 128;
  if n <> 0 then raise exception 'S7: % over-length permit(s) exist', n; end if;
  select reserved_count into n from public.access_state();
  if n <> 0 then raise exception 'S7: reserved_count=% after the rejected reserve (expected 0)', n; end if;
  -- exactly 128 chars is the boundary: accepted, one row. Release it again.
  select * into r from public.reserve_analysis_permit(repeat('k', 128));
  if r.result <> 'accepted' then
    raise exception 'S7: 128-char key with allowance got % (expected accepted)', r.result;
  end if;
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup' where id = r.permit_id;
end $$;
-- (b) OBSERVED ORDERING, documented: a user AT the limit (Alice, 6 scored)
--     never reaches the insert, so the same 129-char key yields
--     access.paywall_required rather than a raise. The edge fn rejects
--     length > 128 before the RPC (index.ts idempotencyKey guard), so this
--     ordering is unreachable from a client; pinned here so a change shows.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare r record; n int;
begin
  select * into r from public.reserve_analysis_permit(repeat('k', 129));
  if r.result <> 'access.paywall_required' then
    raise exception 'S7: 129-char key AT the limit got % (expected paywall_required: allowance check precedes the insert-time CHECK)', r.result;
  end if;
  select count(*) into n from public.analysis_permits where length(idempotency_key) > 128;
  if n <> 0 then raise exception 'S7: over-length permit stored at the limit'; end if;
  raise notice 'S7: at the limit the allowance check answers first (paywall_required); with allowance the CHECK raises 23514 — no over-length row in either case';
end $$;

-- ═══════════════════════════ own additions ═══════════════════════════
\echo [X1] unicode / huge keys through reserve_analysis_permit (Bob, fresh allowance)
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare r record; n int; v_first uuid;
begin
  -- Bob already has one scored shot (seed) → remaining = 1.
  -- 128 multibyte chars = 384 bytes: length() counts characters, accepted.
  select * into r from public.reserve_analysis_permit(repeat('日', 128));
  if r.result <> 'accepted' then raise exception 'X1: 128 CJK chars got %', r.result; end if;
  v_first := r.permit_id;
  -- NFC vs NFD 'é' are byte-distinct keys → replay of the NFD form is NOT the
  -- same permit; at remaining=0 it is refused rather than over-issued.
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup' where id = v_first;
  select * into r from public.reserve_analysis_permit(E'caf\u00e9');
  if r.result <> 'accepted' then raise exception 'X1: NFC key got %', r.result; end if;
  select * into r from public.reserve_analysis_permit(E'cafe\u0301');
  if r.result <> 'access.paywall_required' then
    raise exception 'X1: NFD variant must be a distinct key and be refused at the limit (got %)', r.result;
  end if;
  -- free the slot again so the over-length probes reach the insert-time CHECK
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup'
   where user_id = '00000000-0000-4000-8000-00000000000b' and status = 'reserved';
  -- 129 CJK chars → check_violation (character count, not bytes).
  begin
    select * into r from public.reserve_analysis_permit(repeat('日', 129));
    raise exception 'X1: 129 CJK chars returned %', r.result;
  exception when check_violation then null; end;
  -- 1 MiB key → check_violation, nothing stored.
  begin
    select * into r from public.reserve_analysis_permit(repeat('x', 1048576));
    raise exception 'X1: 1MiB key returned %', r.result;
  exception when check_violation then null; end;
  select count(*) into n from public.analysis_permits where length(idempotency_key) > 128;
  if n <> 0 then raise exception 'X1: over-length permit stored'; end if;
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup'
   where user_id = '00000000-0000-4000-8000-00000000000b' and status = 'reserved';
end $$;

\echo [X2] seeded rapid-replay fuzz of reserve (seed 0.42, 300 calls over 5 keys, Bob remaining=1)
do $$
declare i int; k text; r record; n_acc int := 0; n_pay int := 0; n int; r_seed float := 0.42;
begin
  perform setseed(r_seed);
  for i in 1..300 loop
    k := 'fuzz-' || (1 + floor(random() * 5))::int;
    select * into r from public.reserve_analysis_permit(k);
    if r.result = 'accepted' then n_acc := n_acc + 1;
    elsif r.result = 'access.paywall_required' then n_pay := n_pay + 1;
    else raise exception 'X2: unexpected result % on iteration % key %', r.result, i, k;
    end if;
  end loop;
  select count(*) into n from public.analysis_permits
   where user_id = '00000000-0000-4000-8000-00000000000b' and status = 'reserved';
  raise notice 'X2: seed=% accepted=% paywall=% reserved rows=%', r_seed, n_acc, n_pay, n;
  if n <> 1 then
    raise exception 'X2: fuzz over-issued: % reserved permits for remaining=1', n;
  end if;
  select count(distinct idempotency_key) into n from public.analysis_permits
   where user_id = '00000000-0000-4000-8000-00000000000b' and idempotency_key like 'fuzz-%';
  if n <> 1 then raise exception 'X2: % distinct fuzz keys were stored (expected 1)', n; end if;
  update public.analysis_permits set status = 'released', outcome = 'test_cleanup'
   where user_id = '00000000-0000-4000-8000-00000000000b' and status = 'reserved';
end $$;

\echo [X3] clock skew: Bob inserts a permit dated one year in the FUTURE
do $$
declare v text; n int; r record;
begin
  insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-00000000000b',
          'x3-future', now() + interval '1 year');
  select reserved_count into n from public.access_state();
  if n <> 1 then raise exception 'X3: future permit not counted as reserved (%)', n; end if;
  -- It never expires, but it buys nothing: the scored backstop still applies.
  -- Bob has 1 scored; a scored sync on it is accepted (2nd rating)...
  v := public.apply_synced_shot(pg_temp.sync_payload(
    '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a5', null, 'scored'));
  if v <> 'accepted' then raise exception 'X3: 2nd rating on future permit got %', v; end if;
  -- ...and a second future-dated permit cannot become a 3rd rating.
  insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-0000000000a6', '00000000-0000-4000-8000-00000000000b',
          'x3-future-2', now() + interval '1 year');
  v := public.apply_synced_shot(pg_temp.sync_payload(
    '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000a6', null, 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'X3: 3rd rating via future-dated permit got % (expected paywall)', v;
  end if;
  select status, outcome into r from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a6';
  if r.status <> 'released' or r.outcome <> 'free_limit_exceeded' then
    raise exception 'X3: backstop left permit %/%', r.status, r.outcome;
  end if;
  raise notice 'X3: future-dated permit counts as reserved forever (self-DoS only) and cannot exceed the lifetime limit';
end $$;

\echo [X4] FK checks bypass RLS: Alice attaches detail rows to Bob shot / session
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare n int; ok_phase boolean := false; ok_cp boolean := false; ok_shot_sess boolean := false;
        ok_capture boolean := false; oracle_exists boolean := false; oracle_missing boolean := false;
begin
  -- 1. shot_phases row with Alice's user_id but BOB's shot_id.
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000a',
            'recover', 900, 950, 1000, 0.5);
    ok_phase := true;
  exception when insufficient_privilege or foreign_key_violation then null; end;
  -- 2. shot_checkpoints likewise.
  begin
    insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000a',
            'contact_position', 1, 0.9, 'red', 'ok', 0.9, true);
    ok_cp := true;
  exception when insufficient_privilege or foreign_key_violation then null; end;
  -- 3. a shot of Alice's pointing at BOB's session.
  begin
    perform pg_temp.alice_direct_shot('00000000-0000-4000-8000-0000000000fa'::uuid,
      '00000000-0000-4000-8000-0000000000d2', 'low_confidence', null);
    ok_shot_sess := true;
  exception when insufficient_privilege or foreign_key_violation then null; end;
  -- 4. a capture of Alice's pointing at BOB's shot.
  begin
    insert into public.captures (id, user_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-00000000000a',
            '00000000-0000-4000-8000-0000000000b1', now(), 1500, 30, 'automatic_pose_trigger', 'valid');
    ok_capture := true;
  exception when insufficient_privilege or foreign_key_violation then null; end;
  -- 5. existence oracle: PK (shot_id, phase_key) collides with Bob's real
  --    'contact' phase → unique_violation reveals the row exists; a random
  --    uuid → foreign_key_violation reveals it does not.
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000a',
            'contact', 0, 1, 2, 0.1);
  exception when unique_violation then oracle_exists := true;
           when insufficient_privilege or foreign_key_violation then null; end;
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-00000000000a',
            'contact', 0, 1, 2, 0.1);
  exception when foreign_key_violation then oracle_missing := true;
           when insufficient_privilege then null; end;
  raise notice 'X4: cross-owner FK writes — phase_on_bob_shot=% checkpoint_on_bob_shot=% shot_in_bob_session=% capture_on_bob_shot=%; existence oracle: pk_collision=% fk_missing=%',
    ok_phase, ok_cp, ok_shot_sess, ok_capture, oracle_exists, oracle_missing;
  -- Pin the observed behaviour so a fix (e.g. a policy/trigger that checks
  -- the parent's owner) shows up as a deliberate change here.
  if not (ok_phase and ok_cp and ok_shot_sess and ok_capture and oracle_exists and oracle_missing) then
    raise exception 'X4: FK-bypass behaviour changed (phase=% cp=% shot=% capture=% oracle=%/%)',
      ok_phase, ok_cp, ok_shot_sess, ok_capture, oracle_exists, oracle_missing;
  end if;
  -- Whatever Alice attached is invisible to Alice-as-reader-of-Bob and
  -- visible only under her own user_id (RLS still pins reads).
  select count(*) into n from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000b1';
  if n <> 1 then raise exception 'X4: Alice sees % phase rows on Bob''s shot (expected only her own 1)', n; end if;
end $$;
-- Bob's view of his own shot must be unchanged by Alice's attachments.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare n int;
begin
  select count(*) into n from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000b1';
  if n <> 1 then raise exception 'X4: Bob sees % phase rows on his shot (expected 1, his own)', n; end if;
  if exists (select 1 from public.shot_phases where user_id <> '00000000-0000-4000-8000-00000000000b') then
    raise exception 'X4: Bob can read a foreign phase row';
  end if;
  if exists (select 1 from public.shot_checkpoints where shot_id = '00000000-0000-4000-8000-0000000000b1') then
    raise exception 'X4: Bob sees Alice''s checkpoint on his shot';
  end if;
end $$;

\echo [X5] cross-user permit writes are denied
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare n int;
begin
  begin
    insert into public.analysis_permits (user_id, idempotency_key)
    values ('00000000-0000-4000-8000-00000000000b', 'alice-plants-on-bob');
    raise exception 'X5: permit INSERT with Bob''s user_id must be denied';
  exception when insufficient_privilege then null; end;
  update public.analysis_permits set status = 'released'
   where user_id = '00000000-0000-4000-8000-00000000000b';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'X5: Alice released % of Bob''s permits', n; end if;
  begin
    update public.analysis_permits set user_id = '00000000-0000-4000-8000-00000000000b'
     where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'X5: permit user_id must not be client-writable';
  exception when insufficient_privilege then null; end;
  begin
    update public.analysis_permits set created_at = now()
     where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'X5: permit created_at must not be client-updatable';
  exception when insufficient_privilege then null; end;
end $$;

\echo [X6] cancellation mid-flight: reserve inside a rolled-back savepoint leaves nothing (Carol, fresh)
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
savepoint x6;
do $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit('x6-cancelled');
  if r.result <> 'accepted' then raise exception 'X6 setup: got %', r.result; end if;
end $$;
rollback to savepoint x6;
do $$
declare r record; n int;
begin
  if exists (select 1 from public.analysis_permits where idempotency_key = 'x6-cancelled') then
    raise exception 'X6: cancelled reserve left a permit';
  end if;
  select * into r from public.reserve_analysis_permit('x6-retry');
  if r.result <> 'accepted' then raise exception 'X6: retry after cancellation got %', r.result; end if;
  select reserved_count into n from public.access_state();
  if n <> 1 then raise exception 'X6: reserved_count=% (expected 1)', n; end if;
end $$;

-- ═══════════════════════════ back to postgres: invariants ═══════════════════════════
reset role;
do $$
declare b record; a_ledger int; bob_ledger int; n int;
begin
  select * into b from bob_before;
  -- Bob: seed shot + the X3 rating = 2 scored; Alice's attacks changed nothing else of his.
  select count(*) into n from public.shots where user_id = '00000000-0000-4000-8000-00000000000b';
  if n <> b.shots + 1 then raise exception 'INV: Bob shots % (expected %)', n, b.shots + 1; end if;
  select count(*) into n from public.shot_phases where user_id = '00000000-0000-4000-8000-00000000000b';
  if n <> b.phases then raise exception 'INV: Bob phase rows changed'; end if;
  select coalesce(max(l.scored_count), 0) into bob_ledger
    from auth.identities i
    join public.free_rating_ledger l
      on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
   where i.user_id = '00000000-0000-4000-8000-00000000000b';
  -- seed shot (written as postgres) fired the ledger trigger once; X3's
  -- accepted sync adds exactly one more.
  if bob_ledger <> b.ledger + 1 then
    raise exception 'INV: Bob ledger % (expected %)', bob_ledger, b.ledger + 1;
  end if;
  -- Alice: the definer ledger trigger fired for every direct insert too —
  -- S2 sync (1) + S4 forged (5) = 6.
  select coalesce(max(l.scored_count), 0) into a_ledger
    from auth.identities i
    join public.free_rating_ledger l
      on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
   where i.user_id = '00000000-0000-4000-8000-00000000000a';
  if a_ledger <> 6 then raise exception 'INV: Alice ledger % (expected 6)', a_ledger; end if;
  raise notice 'INV: Alice free_rating_ledger=% (forged direct inserts DO burn identity-lifetime ratings); Bob ledger=% untouched by Alice', a_ledger, bob_ledger;
  -- No NULL / over-length keys anywhere; no non-real shots anywhere.
  if exists (select 1 from public.analysis_permits where idempotency_key is null or length(idempotency_key) > 128) then
    raise exception 'INV: bad permit key stored';
  end if;
  if exists (select 1 from public.shots where source <> 'real') then
    raise exception 'INV: non-real shot stored';
  end if;
  -- The pg_cron sweep predicate (`created_at < now() - 24h`, STRICT) does
  -- NOT collect a permit sitting exactly on the boundary in the same
  -- instant access_state() already ignores it — the next hourly run does.
  -- Documented, not a defect: recreate the S3 boundary row and run the
  -- sweep statement verbatim.
  insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
  values ('00000000-0000-4000-8000-0000000000a7', '00000000-0000-4000-8000-00000000000a',
          'inv-boundary', now() - interval '24 hours');
  update public.analysis_permits set status = 'released', outcome = 'expired'
   where status = 'reserved' and created_at < now() - interval '24 hours';
  get diagnostics n = row_count;
  raise notice 'INV: sweep (`<`) released % boundary row(s) — strict on both sides means the exact-boundary permit is invisible to access_state() yet swept only on the next run', n;
end $$;

rollback;
\echo ATTACK db-rls-grants-isolation-2: ALL ASSERTIONS PASSED
