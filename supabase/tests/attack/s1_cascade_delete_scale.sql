-- ============================================================================
-- S1 — account deletion at scale: 5,000 shots x 6 phases.
--
-- Attack: the account-deletion cascade is the one bulk write the product
-- performs (POST /v1/me/delete-confirm → auth.admin.deleteUser →
-- auth.users → profiles → every child). The audit test
-- (supabase/functions/api/__wf__/db_migrations_rls_indexes.audit.test.ts:383)
-- runs the same EXPLAIN with ONE shot, where every table fits in a page and
-- any plan looks fine. This scenario asks whether the cascade is index-backed
-- and time-bounded when a real power user is deleted.
--
-- Four probes, all reported at the end so a structural failure still gets
-- costed:
--   A. STRUCTURAL — every FK whose referenced side can be deleted (CASCADE or
--      SET NULL) must have an index whose LEADING column is the referencing
--      column; otherwise Postgres' RI trigger scans the whole child table
--      once per parent row deleted.
--   B. PLAN — the exact lookup each RI trigger issues, EXPLAINed on the
--      POPULATED, ANALYZEd fixture with the planner free to choose
--      (enable_seqscan left ON, unlike matrix case I2, and not on empty
--      tables, where a Seq Scan is the right answer and proves nothing).
--   C. SCALE — 5,000 scored shots x 6 phases x 6 measurements x 6
--      checkpoints, one capture per shot (every analyzed shot came from a
--      capture), then EXPLAIN (ANALYZE, BUFFERS) the real DELETE FROM
--      auth.users and read the per-trigger times back.
--   D. SHAPE — the same delete at 500 and at 5,000 shots; per-shot cost must
--      not grow with the row count. shots_player_rank_refresh recomputes the
--      rank from public.shots on EVERY deleted row, so its per-call cost is
--      checked separately: if it scales with the remaining shot count the
--      account delete is quadratic.
--
-- Seeding note: shots_player_rank_refresh is disabled while the fixture is
-- inserted (5,000 sequential recomputes would time the seed, not the attack)
-- and RE-ENABLED before every measured DELETE, so the deletion path under
-- test is the production one. DDL is transactional; ROLLBACK restores it.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on
\timing off

begin;

\i /attack/_helpers.sql

create temporary table attack_failures (probe text, detail text);

-- ─────────────── A: unindexed foreign keys on deletable parents ────────────
create temporary table attack_fk_audit as
select
  con.conrelid::regclass::text as child_table,
  con.conname,
  con.confrelid::regclass::text as parent_table,
  case con.confdeltype when 'c' then 'cascade' when 'n' then 'set null' end as on_delete,
  (
    select string_agg(a.attname, ',' order by k.ord)
    from unnest(con.conkey) with ordinality k(attnum, ord)
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
  ) as child_columns,
  exists (
    select 1
    from pg_index i
    where i.indrelid = con.conrelid
      and i.indislive
      and i.indkey[0] = con.conkey[1]
  ) as leading_index_exists
from pg_constraint con
where con.contype = 'f'
  and con.connamespace = 'public'::regnamespace
  and con.confdeltype in ('c', 'n');

do $$
declare
  r record;
  v_missing text := '';
begin
  for r in select * from attack_fk_audit order by child_table, conname loop
    raise notice 'OBSERVED fk % on %(%) -> % [%] index_backed=%',
      r.conname, r.child_table, r.child_columns, r.parent_table, r.on_delete,
      r.leading_index_exists;
    if not r.leading_index_exists then
      v_missing := v_missing || format(E'\n  %s.%s (%s %s, %s)',
        r.child_table, r.child_columns, r.on_delete, r.parent_table, r.conname);
    end if;
  end loop;

  if v_missing <> '' then
    insert into attack_failures values ('S1-A',
      'every deletable-parent FK must be index-backed on the child side; unindexed:' || v_missing);
  end if;
end $$;

-- ─────────────── fixture: one account with N shots ─────────────────────────
-- Background population: 200 ordinary accounts x 25 shots (one session per
-- account, a capture per shot). Without it every user_id/session_id column
-- has one distinct value, the planner correctly picks Seq Scan for any
-- equality on it, and probe B would report fixture artefacts instead of
-- missing indexes.
create function attack.seed_background(p_users int, p_shots_each int)
returns void
language plpgsql
as $fn$
declare
  v_uid uuid;
  v_session uuid;
  u int;
begin
  alter table public.shots disable trigger shots_player_rank_refresh;
  for u in 1 .. p_users loop
    v_uid := gen_random_uuid();
    v_session := gen_random_uuid();
    perform attack.new_user(v_uid, 'bg-' || u || '@attack.example', 'google');
    insert into public.sessions (id, user_id, started_at)
    values (v_session, v_uid, now() - interval '2 days');
    insert into public.shots (
      id, user_id, session_id, shot_type, camera_view, captured_at, start_ms,
      contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version, source)
    select
      gen_random_uuid(), v_uid, v_session, 'dink', 'side',
      now() - (g || ' hours')::interval, 0, 500, 1000, 6.5, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1', 'real'
    from generate_series(1, p_shots_each) g;
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms,
                                    representative_ms, end_ms, confidence)
    select s.id, v_uid, 'phase-' || p, p * 10, p * 10 + 5, p * 10 + 9, 0.9
    from public.shots s, generate_series(1, 6) p
    where s.user_id = v_uid;
    insert into public.captures (id, user_id, session_id, shot_id, captured_at,
                                 duration_ms, fps, capture_mode, evidence_status,
                                 status)
    select gen_random_uuid(), v_uid, v_session, s.id, s.captured_at, 1200, 60.0,
           'automatic_pose_trigger', 'valid', 'analyzed'
    from public.shots s
    where s.user_id = v_uid;
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (v_uid, 'bg-permit-' || u, 'finalized', 'scored');
    insert into public.analysis_feedback (analysis_id, user_id, rating)
    values (gen_random_uuid(), v_uid, 'accurate');
    insert into public.account_deletion_feedback (user_id, reason)
    values (v_uid, 'other');
  end loop;
  alter table public.shots enable trigger shots_player_rank_refresh;
end;
$fn$;

create function attack.seed_account(p_shots int)
returns uuid
language plpgsql
as $fn$
declare
  v_uid uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
begin
  perform attack.new_user(v_uid, v_uid::text || '@attack.example', 'google');

  insert into public.sessions (id, user_id, started_at)
  values (v_session, v_uid, now() - interval '1 day');

  alter table public.shots disable trigger shots_player_rank_refresh;

  insert into public.shots (
    id, user_id, session_id, shot_type, camera_view, captured_at, start_ms,
    contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version,
    paddle_model_version, stroke_detector_version, phase_model_version,
    scoring_model_version, shot_config_version, source)
  select
    gen_random_uuid(), v_uid, v_session,
    (array['dink', 'drive', 'serve', 'volley', 'drop'])[1 + (g % 5)],
    'side', now() - (g || ' minutes')::interval, 0, 500, 1000,
    round((5 + (g % 50) / 10.0)::numeric, 2), 0.9, 'scored', '1.0.0',
    'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1',
    'config-1', 'real'
  from generate_series(1, p_shots) g;

  insert into public.shot_phases (shot_id, user_id, phase_key, start_ms,
                                  representative_ms, end_ms, confidence)
  select s.id, v_uid, 'phase-' || p, p * 10, p * 10 + 5, p * 10 + 9, 0.9
  from public.shots s, generate_series(1, 6) p
  where s.user_id = v_uid;

  insert into public.shot_measurements (shot_id, user_id, metric_key, value,
                                        confidence, unit)
  select s.id, v_uid, 'metric-' || m, m::float8, 0.9, 'normalized'
  from public.shots s, generate_series(1, 6) m
  where s.user_id = v_uid;

  insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score,
                                       confidence, band, direction, severity,
                                       applicable)
  select s.id, v_uid, 'checkpoint-' || c, 7.0, 0.9, 'green', 'none', 0.1, true
  from public.shots s, generate_series(1, 6) c
  where s.user_id = v_uid;

  insert into public.captures (id, user_id, session_id, shot_id, captured_at,
                               duration_ms, fps, capture_mode, evidence_status,
                               status)
  select gen_random_uuid(), v_uid, v_session, s.id, s.captured_at, 1200, 60.0,
         'automatic_pose_trigger', 'valid', 'analyzed'
  from public.shots s
  where s.user_id = v_uid;

  insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
  select v_uid, 'permit-' || g, 'finalized', 'scored'
  from generate_series(1, 50) g;

  insert into public.analysis_feedback (analysis_id, user_id, rating)
  select gen_random_uuid(), v_uid, 'accurate'
  from generate_series(1, 50) g;

  insert into public.account_deletion_feedback (user_id, reason)
  values (v_uid, 'other');

  -- The measured path uses the production trigger set.
  alter table public.shots enable trigger shots_player_rank_refresh;
  analyze public.shots;
  analyze public.sessions;
  analyze public.shot_phases;
  analyze public.shot_measurements;
  analyze public.shot_checkpoints;
  analyze public.captures;
  analyze public.analysis_permits;
  analyze public.analysis_feedback;
  analyze public.account_deletion_feedback;
  return v_uid;
end;
$fn$;

-- EXPLAIN (ANALYZE, BUFFERS) the real account delete; return timings and the
-- per-trigger breakdown the executor reports.
create function attack.measure_delete(p_uid uuid)
returns jsonb
language plpgsql
as $fn$
declare
  v_plan jsonb;
  v_started timestamptz;
  v_elapsed_ms numeric;
  v_shots int;
begin
  select count(*) into v_shots from public.shots where user_id = p_uid;
  v_started := clock_timestamp();
  execute format(
    'explain (analyze, buffers, format json) delete from auth.users where id = %L',
    p_uid) into v_plan;
  v_elapsed_ms := extract(epoch from clock_timestamp() - v_started) * 1000;
  return jsonb_build_object(
    'shots', v_shots,
    'wall_ms', round(v_elapsed_ms, 1),
    'execution_ms', round(((v_plan -> 0 ->> 'Execution Time'))::numeric, 1),
    'triggers', coalesce(v_plan -> 0 -> 'Triggers', '[]'::jsonb)
  );
end;
$fn$;

create function attack.trigger_ms(p_run jsonb, p_key text, p_value text)
returns numeric
language sql
as $fn$
  select coalesce(sum((t ->> 'Time')::numeric), 0)
  from jsonb_array_elements(p_run -> 'triggers') t
  where t ->> p_key = p_value;
$fn$;

do $$
declare
  v_uid uuid;
  v_small jsonb;
  v_large jsonb;
  r record;
  v_plan jsonb;
  v_bad text := '';
  v_probe_user uuid;
  v_probe_session uuid;
  v_probe_shot uuid;
  v_control jsonb;
  v_rank_small numeric;
  v_rank_large numeric;
  v_rank_ratio numeric;
  v_ratio numeric;
begin
  perform attack.seed_background(200, 25);

  -- D baseline: 500 shots.
  v_uid := attack.seed_account(500);
  v_small := attack.measure_delete(v_uid);
  raise notice 'OBSERVED delete_500 = %', v_small;

  -- C fixture: 5,000 shots x 6 phases (+ 6 measurements, 6 checkpoints, a
  -- capture per shot).
  v_uid := attack.seed_account(5000);
  raise notice 'OBSERVED fixture_rows = %', (
    select jsonb_build_object(
      'shots', (select count(*) from public.shots where user_id = v_uid),
      'shot_phases', (select count(*) from public.shot_phases where user_id = v_uid),
      'shot_measurements', (select count(*) from public.shot_measurements where user_id = v_uid),
      'shot_checkpoints', (select count(*) from public.shot_checkpoints where user_id = v_uid),
      'captures', (select count(*) from public.captures where user_id = v_uid)));

  -- B: the RI trigger's lookup, planned against the populated fixture for an
  -- ordinary (background) account: its user, its session, one of its shots.
  select u.id, s.session_id, s.id into v_probe_user, v_probe_session, v_probe_shot
  from auth.users u
  join public.shots s on s.user_id = u.id
  where u.email = 'bg-1@attack.example'
  limit 1;
  -- Tables under 1,000 rows are skipped: there a Seq Scan is the cheapest
  -- plan whether or not an index exists (probe A already covers structure).
  for r in select f.*, c.reltuples::bigint as rows_est
           from attack_fk_audit f
           join pg_class c on c.oid = f.child_table::regclass
           where f.child_columns not like '%,%' and c.reltuples >= 1000
           order by f.child_table, f.conname loop
    execute format(
      'explain (format json) select 1 from %s where %I = %L::uuid',
      r.child_table, r.child_columns,
      case r.child_columns
        when 'shot_id' then v_probe_shot
        when 'session_id' then v_probe_session
        else v_probe_user
      end) into v_plan;
    if exists (
      select 1 from jsonb_path_query(v_plan, 'strict $.**.Plan') p
      where p ->> 'Node Type' = 'Seq Scan'
        and p ->> 'Relation Name' = split_part(r.child_table, '.', 1)
    ) or exists (
      select 1 from jsonb_path_query(v_plan, 'strict $.**.Plans[*]') p
      where p ->> 'Node Type' = 'Seq Scan'
        and p ->> 'Relation Name' = split_part(r.child_table, '.', 1)
    ) then
      v_bad := v_bad || format(E'\n  %s.%s (%s, ~%s rows) -> Seq Scan', r.child_table,
                               r.child_columns, r.on_delete, r.rows_est);
    end if;
  end loop;
  if v_bad <> '' then
    insert into attack_failures values ('S1-B',
      'RI lookups on the populated fixture must not sequentially scan the child table:' || v_bad);
  end if;

  v_large := attack.measure_delete(v_uid);
  raise notice 'OBSERVED delete_5000 = %', v_large;

  v_rank_small := attack.trigger_ms(v_small, 'Trigger Name', 'shots_player_rank_refresh');
  v_rank_large := attack.trigger_ms(v_large, 'Trigger Name', 'shots_player_rank_refresh');
  raise notice 'OBSERVED rank_refresh_ms_500 = %, rank_refresh_ms_5000 = %, share_of_delete_5000 = %%%',
    v_rank_small, v_rank_large,
    round(100 * v_rank_large / nullif((v_large ->> 'execution_ms')::numeric, 0), 1);
  raise notice 'OBSERVED captures_shot_id_fkey_ms_5000 = %, shot_phases_shot_id_fkey_ms_5000 = %',
    attack.trigger_ms(v_large, 'Constraint Name', 'captures_shot_id_fkey'),
    attack.trigger_ms(v_large, 'Constraint Name', 'shot_phases_shot_id_fkey');

  -- Bound 1: deleting one account must stay inside the Edge Function's own
  -- request budget. 10 s for 5,000 shots is already generous — the function
  -- calls auth.admin.deleteUser inside an HTTP request.
  if (v_large ->> 'execution_ms')::numeric > 10000 then
    insert into attack_failures values ('S1-C', format(
      'DELETE FROM auth.users for 5,000 shots took %s ms (bound 10000 ms)',
      v_large ->> 'execution_ms'));
  end if;

  -- Bound 2: the rank trigger must not dominate the delete in absolute terms.
  if v_rank_large > 5000 then
    insert into attack_failures values ('S1-C', format(
      'shots_player_rank_refresh cost %s ms of the delete (bound 5000 ms)', v_rank_large));
  end if;

  -- Bound 3: shape of the whole delete — per-shot cost at 5,000 must stay
  -- within 3x of per-shot cost at 500.
  v_ratio := round(((v_large ->> 'execution_ms')::numeric / 5000)
                   / nullif((v_small ->> 'execution_ms')::numeric / 500, 0), 2);
  raise notice 'OBSERVED per_shot_ms_500 = %, per_shot_ms_5000 = %, ratio = %',
    round((v_small ->> 'execution_ms')::numeric / 500, 4),
    round((v_large ->> 'execution_ms')::numeric / 5000, 4), v_ratio;
  if v_ratio > 3 then
    insert into attack_failures values ('S1-D', format(
      'per-shot deletion cost grew %sx from 500 to 5,000 shots (bound 3x) — cascade is superlinear', v_ratio));
  end if;

  -- Bound 4: shape of the rank trigger alone. Each call recomputes from
  -- public.shots; a per-CALL cost that grows with the row count means the
  -- trigger does O(remaining shots) work per deleted row, i.e. O(n²) per
  -- account. Bound: per-call cost at 5,000 within 3x of per-call at 500.
  v_rank_ratio := round((v_rank_large / 5000) / nullif(v_rank_small / 500, 0), 2);
  raise notice 'OBSERVED rank_refresh_per_call_us_500 = %, rank_refresh_per_call_us_5000 = %, ratio = %',
    round(1000 * v_rank_small / 500, 2), round(1000 * v_rank_large / 5000, 2), v_rank_ratio;
  if v_rank_ratio > 3 then
    insert into attack_failures values ('S1-D', format(
      'shots_player_rank_refresh per-call cost grew %sx from 500 to 5,000 shots (bound 3x) — recompute_player_rank is O(remaining shots) per deleted row', v_rank_ratio));
  end if;

  -- E: CONTROL (reported, not asserted). Same 5,000-shot delete with the two
  -- missing captures indexes present, to size what A/B cost. Transactional
  -- DDL; rolled back with everything else.
  create index attack_control_captures_shot_idx on public.captures (shot_id);
  create index attack_control_captures_session_idx on public.captures (session_id);
  v_uid := attack.seed_account(5000);
  v_control := attack.measure_delete(v_uid);
  raise notice 'OBSERVED control_delete_5000_with_captures_indexes = {"execution_ms": %, "captures_shot_id_fkey_ms": %, "rank_refresh_ms": %}',
    v_control ->> 'execution_ms',
    attack.trigger_ms(v_control, 'Constraint Name', 'captures_shot_id_fkey'),
    attack.trigger_ms(v_control, 'Trigger Name', 'shots_player_rank_refresh');
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'S1 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo S1: HELD
