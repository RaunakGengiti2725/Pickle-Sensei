-- F2: the WITH CHECK policies on shots / shot_phases / shot_checkpoints /
-- shot_measurements only pin user_id = auth.uid(); the parent FK
-- (shots.session_id → sessions, *.shot_id → shots) is validated by the FK
-- trigger as the table owner, so a client can attach its own rows to ANOTHER
-- user's session/shot. apply_synced_shot() refuses a foreign sessionId
-- (shot.session_not_found) — the direct-table path, which `authenticated`
-- also holds INSERT on, does not. Side effects: (a) existence oracle — a
-- foreign uuid that exists commits, one that does not fails 23503; (b) the
-- other user's cascade delete (session/shot/account) removes this user's rows.
-- Minimized from seeds 2386784841 (index 296, shots.insert with bob's
-- session) and 2206956055 (index 694, shot_phases.insert with alice's shot).
-- Fixtures (repro_rerun.sh): bob owns session 1000…000b and shot 2000…000b;
-- alice holds live reserved permit 3000…000a.
\set ON_ERROR_STOP off
\set QUIET on
\pset format unaligned
\pset tuples_only on

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('50000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-00000000000a',
  '10000000-0000-4000-8000-00000000000b', 'dink', 'side', '2026-05-01T09:06:00Z', 0, 300, 900,
  null, 0.2, 'low_confidence', '1.0.0', 'b', 'p', 'pd', 's', 'ph', 'sc', 'c');
\echo OBSERVED alice insert shots(session_id=bob) sqlstate=:LAST_ERROR_SQLSTATE
select 'OBSERVED alice shots in bob session committed_rows=' || count(*)
from public.shots where user_id = '00000000-0000-4000-8000-00000000000a'
  and session_id = '10000000-0000-4000-8000-00000000000b';

insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
values ('20000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 'backswing', 0, 10, 20, 0.5);
\echo OBSERVED alice insert shot_phases(shot_id=bob) sqlstate=:LAST_ERROR_SQLSTATE
select 'OBSERVED alice phases on bob shot committed_rows=' || count(*)
from public.shot_phases where user_id = '00000000-0000-4000-8000-00000000000a'
  and shot_id = '20000000-0000-4000-8000-00000000000b';

rollback;

-- control: a uuid that exists in no shot → 23503 (the oracle)
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
values ('20000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-00000000000a', 'backswing', 0, 10, 20, 0.5);
\echo OBSERVED alice insert shot_phases(shot_id=nonexistent) sqlstate=:LAST_ERROR_SQLSTATE
rollback;

-- control: the RPC path refuses the same foreign session
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select 'OBSERVED rpc foreign sessionId → ' || public.apply_synced_shot(jsonb_build_object(
  'id', '60000000-0000-4000-8000-0000000000aa', 'analysisPermitId', '30000000-0000-4000-8000-00000000000a',
  'sessionId', '10000000-0000-4000-8000-00000000000b', 'shotType', 'dink', 'cameraView', 'side',
  'capturedAt', '2026-05-01T09:07:00Z', 'startMs', 0, 'contactMs', 300, 'endMs', 900,
  'overallScore', null, 'confidence', 0.2, 'resultKind', 'low_confidence',
  'versionVector', jsonb_build_object('appVersion', '1.0.0', 'modelBundleVersion', 'b', 'poseModelVersion', 'p',
    'paddleModelVersion', 'pd', 'strokeDetectorVersion', 's', 'phaseModelVersion', 'ph',
    'scoringModelVersion', 'sc', 'shotConfigVersion', 'c'),
  'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb));
rollback;
