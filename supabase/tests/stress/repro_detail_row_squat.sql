-- REPRO (deterministic, single session) — F1: any authenticated user can write
-- rows INTO ANOTHER USER'S shot subtree. The detail-table RLS policies only
-- check `auth.uid() = user_id` (the row's own owner column) and never that
-- `shot_id` belongs to the caller
-- (supabase/migrations/20260829120000_progress_data.sql:277-297), so B can
-- insert shot_phases / shot_checkpoints / shot_measurements rows keyed on A's
-- shot id. `authenticated` holds no UPDATE/DELETE on those tables
-- (20260831160000_defense_in_depth.sql:83-85), so A cannot remove the injected
-- rows without deleting the whole shot, and RLS hides them from A entirely.
--
--   docker exec -i <stress pg> psql -U postgres -v ON_ERROR_STOP=1 \
--     -f /tests/stress/repro_detail_row_squat.sql
--
-- Expected: an authenticated user can only attach detail rows to a shot it owns.
-- Observed: B's inserts succeed; A's shot ends up with 3 phase rows and 2
--           checkpoint rows, one of each owned by B and invisible to A.
\set ON_ERROR_STOP on
\set a_id '11111111-1111-4111-8111-111111111111'
\set b_id '22222222-2222-4222-8222-222222222222'
\set shot '33333333-3333-4333-8333-333333333333'

insert into auth.users (id, email, raw_app_meta_data)
values (:'a_id', 'squat-a@stress.local', jsonb_build_object('provider', 'apple')),
       (:'b_id', 'squat-b@stress.local', jsonb_build_object('provider', 'google'));
insert into auth.identities (provider_id, user_id, identity_data, provider)
values ('squat-a', :'a_id', jsonb_build_object('sub', 'squat-a'), 'apple'),
       ('squat-b', :'b_id', jsonb_build_object('sub', 'squat-b'), 'google');
insert into public.analysis_permits (id, user_id, idempotency_key, status)
values ('44444444-4444-4444-8444-444444444444', :'a_id', 'squat-key', 'reserved');

-- 1) A syncs its shot through the intended RPC.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'a_id', 'role', 'authenticated')::text, true);
select public.apply_synced_shot(json_build_object(
  'id', :'shot',
  'analysisPermitId', '44444444-4444-4444-8444-444444444444',
  'shotType', 'forehand_drive', 'cameraView', 'side',
  'capturedAt', now(), 'startMs', 0, 'contactMs', 400, 'endMs', 900,
  'overallScore', 7.25, 'confidence', 0.91, 'resultKind', 'scored',
  'versionVector', json_build_object(
    'appVersion', '1', 'modelBundleVersion', 'b', 'poseModelVersion', 'p',
    'paddleModelVersion', 'pa', 'strokeDetectorVersion', 's',
    'phaseModelVersion', 'ph', 'scoringModelVersion', 'sc',
    'shotConfigVersion', 'c'),
  'phases', json_build_array(
    json_build_object('key','prepare','startMs',0,'representativeMs',100,'endMs',300,'confidence',0.9),
    json_build_object('key','contact','startMs',300,'representativeMs',400,'endMs',500,'confidence',0.95)),
  'checkpoints', json_build_array(
    json_build_object('key','paddle_prep','score',70,'confidence',0.9,'band','green',
                      'direction','ok','severity',0.1,'applicable',true))
)::jsonb) as sync_result;
commit;

-- 2) B, authenticated with RLS on, injects a phase and a checkpoint into A's
--    shot. Both inserts are accepted.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'b_id', 'role', 'authenticated')::text, true);
insert into public.shot_phases
  (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
values (:'shot', :'b_id', 'follow_through', 0, 0, 0, 0.5);
insert into public.shot_checkpoints
  (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
values (:'shot', :'b_id', 'evil_injected', 0, 0.5, 'red', 'fabricated', 1.0, true);
commit;

-- 3) A cannot see them (RLS filters on user_id) and holds no DELETE grant on
--    the detail tables, so A cannot remove them either.
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'a_id', 'role', 'authenticated')::text, true);
select 'phases_visible_to_A' as check, count(*) as n
from public.shot_phases where shot_id = :'shot';
select 'checkpoints_visible_to_A' as check, count(*) as n
from public.shot_checkpoints where shot_id = :'shot';
commit;

-- 4) Ground truth: A's shot now carries B's rows.
select 'phase' as tbl, phase_key as key, user_id = :'b_id' as injected_by_B
from public.shot_phases where shot_id = :'shot'
union all
select 'checkpoint', checkpoint_key, user_id = :'b_id'
from public.shot_checkpoints where shot_id = :'shot'
order by tbl, key;
