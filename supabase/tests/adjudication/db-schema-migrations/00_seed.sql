-- Adjudication seed: two users through the auth trigger path (same shape as
-- supabase/tests/security_regression.sql). Loaded by run.sh before every probe.
\set QUIET on
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice","email":"alice@example.com"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-00000000000b',
   '{"sub":"apple-sub-bob","email":"bob@example.com"}');

-- Helper: canonical scored-shot payload for apply_synced_shot.
create or replace function pg_temp.shot_payload(
  p_id uuid, p_permit uuid, p_session uuid, p_kind text, p_captured text,
  p_start int default 0, p_contact int default 500, p_end int default 1000,
  p_score numeric default 7.1
) returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'resultKind', p_kind,
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', p_captured,
    'startMs', p_start, 'contactMs', p_contact, 'endMs', p_end,
    'overallScore', case when p_kind = 'scored' then p_score else null end,
    'confidence', 0.9,
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
      'applicable', true)))
$$;

-- Helper: raw row insert into public.shots (bypasses the RPC on purpose).
create or replace function pg_temp.raw_shot(
  p_id uuid, p_user uuid, p_session uuid, p_kind text, p_score numeric, p_captured timestamptz,
  p_start int default 0, p_contact int default 500, p_end int default 1000
) returns void language sql as $$
  insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at,
    start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
  values (p_id, p_user, p_session, 'drive', 'side', p_captured, p_start, p_contact, p_end,
    p_score, 0.9, p_kind, '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
    'scoring-1', 'config-1')
$$;
\set QUIET off
