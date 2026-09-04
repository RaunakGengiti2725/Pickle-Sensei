-- Helper: as Alice, sync one scored shot against permit :'permit' with shot id
-- :'shot'. Optional :'presleep' seconds run BEFORE the call and :'postsleep'
-- seconds are spent inside the transaction AFTER the call (holds the advisory
-- lock + permit FOR UPDATE) before commit. Prints "SYNC <shot> <result>".
\set ON_ERROR_STOP on
\set QUIET on
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select pg_sleep(:presleep) as _s1 \gset
select 'SYNC ' || :'shot' || ' ' || public.apply_synced_shot(jsonb_build_object(
  'id', :'shot'::uuid,
  'analysisPermitId', :'permit'::uuid,
  'resultKind', 'scored',
  'shotType', 'drive', 'cameraView', 'side',
  'capturedAt', '2026-08-31T10:00:00Z',
  'startMs', 0, 'contactMs', 500, 'endMs', 1000,
  'overallScore', 7.1, 'confidence', 0.9,
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
)) as line \gset
select pg_sleep(:postsleep) as _s2 \gset
commit;
\echo :line
