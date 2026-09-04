-- Adversarial pass 3 — Postgres side of the computePlayerRank cross-check.
-- Run AFTER supabase/tests/shim_auth.sql + every supabase/migrations/*.sql on a
-- THROWAWAY database (see run_player_rank_crosscheck.sh). Emits one JSON
-- document on stdout that packages/shared-types/test/attack3.playerRank.postgres.test.ts
-- compares against the TypeScript implementation.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-0000000000aa', 'attack3@example.com',
        '{"full_name":"Attack3"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-attack3', '00000000-0000-4000-8000-0000000000aa',
        '{"sub":"google-sub-attack3","email":"attack3@example.com"}');
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000aa', now());

-- helper: insert a scored real shot directly (superuser; RLS irrelevant here —
-- the column cast is identical to apply_synced_shot's (shot->>'overallScore')::numeric)
create temp table attack3_results (k text primary key, v jsonb);
grant all on attack3_results to authenticated;

create or replace function pg_temp.shot(p_id uuid, p_type text, p_at timestamptz, p_score numeric)
returns void language plpgsql as $$
begin
  insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, contact_ms, end_ms,
    overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
    paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version,
    shot_config_version, source)
  values (p_id, '00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000d3', p_type, p_at,
    0, 500, 1000, p_score, 0.9, 'scored', '1.0.0', 'b', 'p', 'pd', 's', 'ph', 'sc', 'c', 'real');
end $$;

create or replace function pg_temp.rank_row()
returns jsonb language sql as $$
  select coalesce(
    (select jsonb_build_object('rating', rating, 'tier', tier, 'technique_count', technique_count,
                               'scored_shot_count', scored_shot_count)
       from public.player_rank_state where user_id = '00000000-0000-4000-8000-0000000000aa'),
    'null'::jsonb)
$$;

-- ── Case A: overallScore 10.0000001 through the numeric(4,2) column ──────────
do $$
begin
  perform pg_temp.shot('00000000-0000-4000-8000-0000000000e1', 'dink', '2026-01-01T00:00:00Z', 10.0000001);
  insert into attack3_results values ('A_stored_score',
    (select to_jsonb(overall_score) from public.shots where id = '00000000-0000-4000-8000-0000000000e1'));
  insert into attack3_results values ('A_rank', pg_temp.rank_row());
end $$;
delete from public.shots where user_id = '00000000-0000-4000-8000-0000000000aa';
insert into attack3_results values ('A_rank_after_delete', pg_temp.rank_row());

-- ── Case A2: the same value via apply_synced_shot (the authenticated RPC) ────
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000aa', 'permit-attack3');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e2',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a3',
    'sessionId', '00000000-0000-4000-8000-0000000000d3',
    'resultKind', 'scored', 'shotType', 'dink', 'cameraView', 'side',
    'capturedAt', '2026-01-01T00:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 10.0000001, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb));
  insert into attack3_results values ('A2_rpc_result', to_jsonb(v));
end $$;
reset role;
insert into attack3_results values ('A2_stored_score',
  (select coalesce(to_jsonb(overall_score), 'null'::jsonb) from public.shots where id = '00000000-0000-4000-8000-0000000000e2'));
insert into attack3_results values ('A2_rank', pg_temp.rank_row());
delete from public.shots where user_id = '00000000-0000-4000-8000-0000000000aa';

-- ── Case B: same captured_at, distinct ids, scores 2 and 9 (id desc = newest)
select pg_temp.shot('00000000-0000-4000-8000-000000000001', 'dink', '2026-01-01T00:00:00Z', 2);
select pg_temp.shot('00000000-0000-4000-8000-000000000002', 'dink', '2026-01-01T00:00:00Z', 9);
insert into attack3_results values ('B_rank', pg_temp.rank_row());
delete from public.shots where user_id = '00000000-0000-4000-8000-0000000000aa';

-- ── Case C: duplicate id is impossible at the storage layer ────────────────
do $$
begin
  perform pg_temp.shot('00000000-0000-4000-8000-000000000001', 'dink', '2026-01-01T00:00:00Z', 2);
  begin
    perform pg_temp.shot('00000000-0000-4000-8000-000000000001', 'dink', '2026-01-01T00:00:00Z', 9);
    insert into attack3_results values ('C_duplicate_id', '"accepted"'::jsonb);
  exception when unique_violation then
    insert into attack3_results values ('C_duplicate_id', '"unique_violation"'::jsonb);
  end;
end $$;
delete from public.shots where user_id = '00000000-0000-4000-8000-0000000000aa';

-- ── Case D: uuid byte order vs text order for the id tie-break ─────────────
select pg_temp.shot('00000000-0000-4000-8000-00000000000a', 'dink', '2026-01-01T00:00:00Z', 2);
select pg_temp.shot('00000000-0000-4000-8000-000000000009', 'dink', '2026-01-01T00:00:00Z', 9);
insert into attack3_results values ('D_rank', pg_temp.rank_row());
delete from public.shots where user_id = '00000000-0000-4000-8000-0000000000aa';

-- ── Case E: numeric(4,2) rounding at the 10 boundary ───────────────────────
do $$
declare s numeric; stored jsonb;
begin
  foreach s in array array[9.994, 9.995, 9.999, 10.004, 10.005]::numeric[] loop
    begin
      perform pg_temp.shot('00000000-0000-4000-8000-0000000000f1', 'dink', '2026-01-01T00:00:00Z', s);
      select to_jsonb(overall_score) into stored from public.shots where id = '00000000-0000-4000-8000-0000000000f1';
      insert into attack3_results values ('E_' || s::text, jsonb_build_object('stored', stored, 'rank', pg_temp.rank_row()));
      delete from public.shots where id = '00000000-0000-4000-8000-0000000000f1';
    exception when check_violation then
      insert into attack3_results values ('E_' || s::text, jsonb_build_object('stored', 'check_violation'));
    end;
  end loop;
end $$;

-- ── Case F: player_rank_tier at every threshold ± one hundredth ────────────
insert into attack3_results
select 'F_tier', jsonb_object_agg(r::text, public.player_rank_tier(r))
from unnest(array[0, 3.49, 3.5, 4.99, 5.0, 6.49, 6.5, 7.49, 7.5, 10]::numeric[]) as r;

select jsonb_pretty(jsonb_object_agg(k, v)) from attack3_results;

rollback;
