-- @fresh
-- P10 — Account deletion cost is bounded: cascading a heavy user's shots
-- must not recompute the player rank once per deleted row.
--
-- Suspect: 20260829150000_player_rank.sql:184-186 fires
-- handle_shot_rank_refresh AFTER DELETE FOR EACH ROW, and every call runs
-- recompute_player_rank(user_id) over the user's remaining scored history
-- (a window over all rows) — O(N^2) work to delete an account with N scored
-- shots, all inside the auth.users delete (Auth admin deleteUser in
-- POST /v1/account/delete). player_rank_state itself cascades from
-- profiles, so the recomputes are pure waste. This probe commits fixture
-- data and reads pg_stat_user_functions, hence @fresh.
\set ON_ERROR_STOP on
set track_functions = 'all';
\i /probes/_seed.psql

-- 600 scored shots for Alice, written as the service owner (bypasses quota;
-- the rank + ledger triggers fire as they would for real inserts).
insert into public.shots (
  id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
select gen_random_uuid(), '00000000-0000-4000-8000-00000000000a',
       (array['drive', 'dink', 'serve', 'volley'])[1 + (g % 4)], 'side',
       timestamptz '2026-08-01T10:00:00Z' + (g || ' minutes')::interval, 0, 500, 1000,
       5 + (g % 5), 0.9, 'scored',
       '1.0.0', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c', 'real'
from generate_series(1, 600) g;

insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
select id, user_id, 'paddle_prep', 7, 0.8, 'green', 'hold', 0.1, true from public.shots;

-- Let the backend flush its function statistics, then baseline.
select pg_sleep(1.5);
select pg_stat_clear_snapshot();
select coalesce((select calls from pg_stat_user_functions where funcname = 'recompute_player_rank'), 0) as calls_before \gset

\timing on
delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';
\timing off

select pg_sleep(1.5);
select pg_stat_clear_snapshot();
select coalesce((select calls from pg_stat_user_functions where funcname = 'recompute_player_rank'), 0) - :calls_before as calls_during_delete \gset

begin;
select pg_temp.check('cascade removed every shot / checkpoint / rank row for the user',
  not exists (select 1 from public.shots where user_id = '00000000-0000-4000-8000-00000000000a')
  and not exists (select 1 from public.shot_checkpoints where user_id = '00000000-0000-4000-8000-00000000000a')
  and not exists (select 1 from public.player_rank_state where user_id = '00000000-0000-4000-8000-00000000000a'));
select pg_temp.check('deleting a 600-shot account recomputes rank a bounded number of times (<= 2), observed ' || :calls_during_delete,
  :calls_during_delete <= 2);
select pg_temp.finish();
rollback;
