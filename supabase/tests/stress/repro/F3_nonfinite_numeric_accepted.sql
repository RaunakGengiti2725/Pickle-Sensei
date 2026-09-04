-- F3: shot_measurements.value (double precision) and the confidence columns of
-- shot_phases / shot_checkpoints / shot_measurements (numeric(5,4)) carry no
-- range/finiteness CHECK, so NaN, ±Infinity, -1 and >1 are stored — via a
-- direct table insert AND via apply_synced_shot(jsonb) (whose
-- (entry ->> 'confidence')::numeric cast accepts 'NaN'). The edge function
-- parser (index.ts parseSyncShot, unit-interval check) refuses these, so only
-- a direct PostgREST caller with a user JWT reaches the database with them.
-- shots.analysis_confidence / severity / score DO have [0,1]/[0,100] checks
-- and refuse NaN (NaN <= 1 is false in numeric) — control below.
-- Minimized from seeds 2638025914 (index 549, value "-Infinity"),
-- 1007732075 (index 880, confidence -1), 2517095080 (index 907, RPC checkpoint
-- confidence "NaN"), 1615607319 (index 1865, 1.00005), 533043253 (index 2838, -1).
-- Fixtures (repro_rerun.sh): alice owns shot 2000…000a in session 1000…000a
-- and holds live reserved permit 3000…000a.
\set ON_ERROR_STOP off
\set QUIET on
\pset format unaligned
\pset tuples_only on

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
values ('20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'm-nan', 'NaN', -1, 'ms'),
       ('20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'm-neginf', '-Infinity', 1.00005, 'ms');
\echo OBSERVED table insert value=NaN/-Infinity confidence=-1/1.00005 sqlstate=:LAST_ERROR_SQLSTATE
select 'OBSERVED stored ' || metric_key || ' value=' || value::text || ' confidence=' || confidence::text
from public.shot_measurements
where user_id = '00000000-0000-4000-8000-00000000000a' and metric_key in ('m-nan', 'm-neginf')
order by metric_key;

select 'OBSERVED rpc checkpoint confidence NaN → ' || public.apply_synced_shot(jsonb_build_object(
  'id', '70000000-0000-4000-8000-0000000000aa', 'analysisPermitId', '30000000-0000-4000-8000-00000000000a',
  'sessionId', '10000000-0000-4000-8000-00000000000a', 'shotType', 'dink', 'cameraView', 'side',
  'capturedAt', '2026-05-01T09:08:00Z', 'startMs', 0, 'contactMs', 300, 'endMs', 900,
  'overallScore', 7.5, 'confidence', 0.9, 'resultKind', 'scored',
  'versionVector', jsonb_build_object('appVersion', '1.0.0', 'modelBundleVersion', 'b', 'poseModelVersion', 'p',
    'paddleModelVersion', 'pd', 'strokeDetectorVersion', 's', 'phaseModelVersion', 'ph',
    'scoringModelVersion', 'sc', 'shotConfigVersion', 'c'),
  'phases', jsonb_build_array(jsonb_build_object('key', 'backswing', 'startMs', 0, 'representativeMs', 10, 'endMs', 20,
    'confidence', -1)),
  'checkpoints', jsonb_build_array(jsonb_build_object('key', 'paddle_height', 'score', 50, 'confidence', 'NaN',
    'band', 'green', 'direction', 'up', 'severity', 0.1, 'applicable', true))));
select 'OBSERVED rpc stored checkpoint confidence=' || c.confidence::text || ' phase confidence=' || p.confidence::text
from public.shot_checkpoints c
join public.shot_phases p on p.shot_id = c.shot_id
where c.shot_id = '70000000-0000-4000-8000-0000000000aa';

-- control: columns WITH a range check refuse NaN
insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
values ('20000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'ctrl', 50, 0.5, 'green', 'up', 'NaN', true);
\echo OBSERVED control severity=NaN sqlstate=:LAST_ERROR_SQLSTATE
rollback;
