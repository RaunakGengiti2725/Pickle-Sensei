-- Adjudication probe (database-3 stress): a client-inserted reserved permit with
-- created_at='infinity' bypasses reserve_analysis_permit() but must NOT let a FREE
-- user exceed the 2 lifetime scored ratings. Expected: shots 1-2 accepted, shot 3
-- access.paywall_required (permit released free_limit_exceeded), and a direct
-- scored insert into public.shots refused by enforce_scored_shot_permit().
-- Run: docker exec -i pickle-stress-pgcron psql -U postgres -f - < supabase/tests/stress/repro/adjudicate_permit_self_insert_allowance.sql
-- Disposable DB only.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000ad', 'adj-a@example.test') on conflict (id) do nothing;
insert into public.profiles (id, email) values ('00000000-0000-4000-8000-0000000000ad', 'adj-a@example.test') on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000ad';
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000ad","role":"authenticated"}';

-- three self-issued permits, bypassing reserve_analysis_permit()
insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000ad','adj-p1','reserved','infinity'),
 ('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000ad','adj-p2','reserved','infinity'),
 ('00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000ad','adj-p3','reserved','infinity');

select premium, scored_count, reserved_count from public.access_state();

create function pg_temp.adj_shot(shot uuid, permit uuid) returns text language sql as $f$
  select public.apply_synced_shot(jsonb_build_object(
    'id', shot, 'analysisPermitId', permit, 'sessionId', null,
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z', 'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object('appVersion','1.0.0','modelBundleVersion','b','poseModelVersion','p',
      'paddleModelVersion','pa','strokeDetectorVersion','s','phaseModelVersion','ph','scoringModelVersion','sc','shotConfigVersion','c'),
    'phases', jsonb_build_array(jsonb_build_object('key','contact','startMs',400,'representativeMs',500,'endMs',600,'confidence',0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object('key','contact_position','score',71,'confidence',0.9,'band','green','direction','ok','severity',0.1,'applicable',true))
  ))
$f$;

select 'shot1' as step, pg_temp.adj_shot('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000b1') as status
union all select 'shot2', pg_temp.adj_shot('00000000-0000-4000-8000-0000000000c2','00000000-0000-4000-8000-0000000000b2')
union all select 'shot3', pg_temp.adj_shot('00000000-0000-4000-8000-0000000000c3','00000000-0000-4000-8000-0000000000b3');

select count(*) as scored_shots from public.shots where user_id = '00000000-0000-4000-8000-0000000000ad' and result_kind = 'scored';
select idempotency_key, status, outcome from public.analysis_permits where user_id = '00000000-0000-4000-8000-0000000000ad' order by 1;
select premium, scored_count, reserved_count from public.access_state();

-- direct table insert of a scored shot with a self-issued permit is also gated
insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values
 ('00000000-0000-4000-8000-0000000000b4','00000000-0000-4000-8000-0000000000ad','adj-p4','reserved','infinity');
\set ON_ERROR_STOP off
savepoint direct_shot;
insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
values ('00000000-0000-4000-8000-0000000000c4','00000000-0000-4000-8000-0000000000ad','drive','side',now(),0,500,1000,7.1,0.9,'scored',
  '1','b','p','pa','s','ph','sc','c','sync');
rollback to savepoint direct_shot;
\set ON_ERROR_STOP on
select count(*) as scored_shots_after_direct_insert from public.shots where user_id = '00000000-0000-4000-8000-0000000000ad' and result_kind = 'scored';
rollback;
