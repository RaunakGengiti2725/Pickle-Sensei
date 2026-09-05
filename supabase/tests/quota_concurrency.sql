create schema quota_test;
revoke all on schema quota_test from public;
grant usage on schema quota_test to authenticated;

create function quota_test.shot(p_id uuid, p_permit uuid, p_kind text default 'scored')
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-04T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', 'local-test', 'modelBundleVersion', 'local-test',
      'poseModelVersion', 'local-test', 'paddleModelVersion', 'local-test',
      'strokeDetectorVersion', 'local-test', 'phaseModelVersion', 'local-test',
      'scoringModelVersion', 'local-test', 'shotConfigVersion', 'local-test'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 400, 'representativeMs', 500,
      'endMs', 600, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object(
      'key', 'contact_position', 'score', 71, 'confidence', 0.9,
      'band', 'green', 'direction', 'ok', 'severity', 0.1, 'applicable', true))
  )
$$;

create function quota_test.insert_shots(
  p_ids uuid[], p_kind text default 'scored', p_user uuid default auth.uid()
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_constraint text;
begin
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms,
    overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version,
    paddle_model_version, stroke_detector_version, phase_model_version,
    scoring_model_version, shot_config_version
  )
  select id, p_user, 'drive', '2026-09-04T10:00:00Z'::timestamptz, 0, 1000,
    case when p_kind = 'scored' then 7.1 else null end, 0.9, p_kind,
    'local-test', 'local-test', 'local-test', 'local-test',
    'local-test', 'local-test', 'local-test', 'local-test'
  from unnest(p_ids) as ids(id)
  on conflict (id) do nothing;
  return 'accepted';
exception when check_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if sqlerrm <> 'access.paywall_required' or v_constraint <> 'shots_free_rating_quota' then
    raise;
  end if;
  return sqlstate || ':' || sqlerrm;
end;
$$;

revoke all on function quota_test.shot(uuid, uuid, text) from public;
revoke all on function quota_test.insert_shots(uuid[], text, uuid) from public;
grant execute on function quota_test.shot(uuid, uuid, text) to authenticated;
grant execute on function quota_test.insert_shots(uuid[], text, uuid) to authenticated;
