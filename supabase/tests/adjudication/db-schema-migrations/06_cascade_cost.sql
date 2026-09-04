-- Candidate: account-deletion cascade cost — FK columns with no supporting
-- index (captures.shot_id, captures.session_id, account_deletion_feedback.user_id)
-- and the per-row rank trigger (recompute_player_rank re-scans public.shots on
-- EVERY deleted shot row => O(n^2) for a heavy user).
\echo '== 06: FK columns referencing profiles/shots/sessions with no index whose leading column is the FK column =='
with fks as (
  select c.conrelid::regclass as tbl, c.conname, a.attname as col, c.confrelid::regclass as ref
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace
)
select tbl, col, ref,
  exists (
    select 1 from pg_index i
    where i.indrelid = tbl::regclass
      and (select attname from pg_attribute where attrelid = i.indrelid and attnum = i.indkey[0]) = col
  ) as leading_index
from fks order by leading_index, tbl::text, col;

\echo '== 06: shots triggers firing per row on DELETE =='
select tgname, tgtype & 8 <> 0 as fires_on_delete from pg_trigger
where tgrelid = 'public.shots'::regclass and not tgisinternal;

\echo '== 06: seed bob with N shots + N captures + details; time the cascade =='
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-00000000000b', now());
alter table public.shots disable trigger shots_player_rank_refresh;
alter table public.shots disable trigger shots_record_free_rating_ledger;
insert into public.shots (id, user_id, session_id, shot_type, camera_view, captured_at,
    start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
select gen_random_uuid(), '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-0000000000d2',
  (array['drive','dink','serve','volley'])[1 + g % 4], 'side', now() - (g || ' minutes')::interval,
  0, 500, 1000, 5 + (g % 5), 0.9, 'scored', '1', '1', '1', '1', '1', '1', '1', '1'
from generate_series(1, :N) g;
alter table public.shots enable trigger shots_player_rank_refresh;
alter table public.shots enable trigger shots_record_free_rating_ledger;
insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
select id, user_id, 'contact_position', 70, 0.9, 'green', 'ok', 0.1, true from public.shots where user_id = '00000000-0000-4000-8000-00000000000b';
insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
select id, user_id, 'contact', 400, 500, 600, 0.9 from public.shots where user_id = '00000000-0000-4000-8000-00000000000b';
insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status, status)
select gen_random_uuid(), user_id, session_id, id, captured_at, 3000, 30, 'automatic_pose_trigger', 'valid', 'analyzed'
from public.shots where user_id = '00000000-0000-4000-8000-00000000000b';
analyze public.shots; analyze public.captures; analyze public.shot_checkpoints; analyze public.shot_phases;
select count(*) as shots from public.shots where user_id = '00000000-0000-4000-8000-00000000000b';

\echo '== 06: EXPLAIN ANALYZE delete from auth.users (N shots, rank trigger per row) =='
begin;
explain (analyze, timing off, summary) delete from auth.users where id = '00000000-0000-4000-8000-00000000000b';
rollback;

\echo '== 06-control: same delete with the rank trigger disabled (isolates per-row recompute cost) =='
begin;
alter table public.shots disable trigger shots_player_rank_refresh;
explain (analyze, timing off, summary) delete from auth.users where id = '00000000-0000-4000-8000-00000000000b';
rollback;

\echo '== 06-control-2: rank trigger disabled AND captures(shot_id) indexed (isolates the missing FK index) =='
begin;
alter table public.shots disable trigger shots_player_rank_refresh;
create index captures_shot_idx_probe on public.captures (shot_id);
explain (analyze, timing off, summary) delete from auth.users where id = '00000000-0000-4000-8000-00000000000b';
rollback;
