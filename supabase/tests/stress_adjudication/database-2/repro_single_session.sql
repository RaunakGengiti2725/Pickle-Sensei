-- database-2 adjudication — single-connection reproductions against the shim +
-- every migration (same harness as run_rls_tests.sh). Each block RAISES if the
-- current (defective) behaviour is NOT observed, so a fix flips the block.
--
--   docker exec <c> psql -U postgres -v ON_ERROR_STOP=1 \
--     -f /tests/stress_adjudication/database-2/repro_single_session.sql
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 'adj-a@example.com', '{"full_name":"A"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000b1', 'adj-b@example.com', '{"full_name":"B"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'adj-sub-a', '00000000-0000-4000-8000-0000000000a1', '{"sub":"adj-sub-a"}'),
  ('google', 'adj-sub-b', '00000000-0000-4000-8000-0000000000b1', '{"sub":"adj-sub-b"}');

-- A owns a session and a shot (direct inserts, as the PostgREST path allows).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000a1', now());
insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
  pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
  scoring_model_version, shot_config_version)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-0000000000d1', 'dink', now(), 0, 200, null, 0.5, 'low_confidence',
  '1', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c');
reset role;

-- ---------------------------------------------------------------------------
-- DB2-1  Cross-user FK attachment: B may attach a shot to A's session and
--        detail rows to A's shot. Policies check only user_id; the comment in
--        20260829120000 §7 claims the FK + shots RLS "closes the loop" — it does
--        not (FK checks bypass RLS).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
do $$
begin
  insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms,
    overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
    pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
    scoring_model_version, shot_config_version)
  values ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000b1',
    '00000000-0000-4000-8000-0000000000d1', 'dink', now(), 0, 200, null, 0.5, 'low_confidence',
    '1', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c');
  insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
    'squat_metric', 1, 0.5, 'ratio');
  insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
    'contact', 0, 1, 2, 0.5);
  insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band,
    direction, severity, applicable)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1',
    'squat_cp', 50, 0.5, 'green', 'up', 0.1, true);
  raise notice 'DB2-1 REPRODUCED: B attached a shot to A''s session and 3 detail rows to A''s shot';
exception when others then
  raise exception 'DB2-1 NOT reproduced (fixed?): %', sqlerrm;
end $$;
reset role;
-- A now cannot insert the same detail keys on her own shot: PK squatted by B.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
begin
  insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1',
    'squat_metric', 2, 0.9, 'ratio');
  raise exception 'DB2-1b NOT reproduced: A''s own metric row inserted despite B''s squat';
exception when unique_violation then
  raise notice 'DB2-1b REPRODUCED: A''s own shot_measurements(%) insert fails with 23505 (PK squatted by B)', 'squat_metric';
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- DB2-2  Non-finite / out-of-range detail numerics accepted on direct insert
--        (value double precision unchecked; confidence numeric(5,4) unchecked).
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
begin
  insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit) values
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'm_nan', 'NaN', 0.5, 'ratio'),
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'm_inf', 'Infinity', 0.5, 'ratio'),
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'm_cneg', 1, -1, 'ratio'),
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'm_cbig', 1, 9.9999, 'ratio'),
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'm_cnan', 1, 'NaN', 'ratio');
  insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'ready', 0, 1, 2, -1);
  insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'cp_nan', 50, 'NaN', 'green', 'up', 0.1, true);
  raise notice 'DB2-2 REPRODUCED: NaN/Infinity value, confidence -1 / 9.9999 / NaN stored in shot detail rows';
exception when others then
  raise exception 'DB2-2 NOT reproduced (fixed?): %', sqlerrm;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- DB2-3  user_saved_drills.saved_at is client-writable and unbounded; one
--        'infinity' row makes GET /v1/me/saved-drills unparseable on the
--        client (training/api.ts parseSavedDrill → isIso fails for the LIST).
--        Also: authenticated holds an UPDATE grant the edge fn never uses.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare v text;
begin
  insert into public.user_saved_drills (user_id, slug, saved_at)
  values ('00000000-0000-4000-8000-0000000000a1', 'good-drill', now());
  insert into public.user_saved_drills (user_id, slug, saved_at)
  values ('00000000-0000-4000-8000-0000000000a1', 'poison-drill', 'infinity');
  update public.user_saved_drills set saved_at = '2999-01-01'
   where user_id = '00000000-0000-4000-8000-0000000000a1' and slug = 'good-drill';
  select saved_at::text into v from public.user_saved_drills
   where user_id = '00000000-0000-4000-8000-0000000000a1' and slug = 'poison-drill';
  if v <> 'infinity' then raise exception 'DB2-3 NOT reproduced: saved_at=%', v; end if;
  raise notice 'DB2-3 REPRODUCED: saved_at accepted ''infinity'' on INSERT and a client UPDATE moved saved_at to 2999';
exception when insufficient_privilege or check_violation then
  raise exception 'DB2-3 NOT reproduced (fixed?): %', sqlerrm;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- DB2-4  Derived views carry full default privileges for authenticated; DML
--        on them fails with 55000 (object_not_in_prerequisite_state), which
--        PostgREST maps to HTTP 500 — instead of 42501 → 401/403.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
declare n int := 0; v text;
begin
  foreach v in array array['progress_daily', 'practice_days', 'player_technique_rating'] loop
    begin
      execute format('delete from public.%I where user_id = %L', v, '00000000-0000-4000-8000-0000000000a1');
      raise exception 'DB2-4 NOT reproduced: delete on view % succeeded', v;
    exception
      when object_not_in_prerequisite_state then n := n + 1;
      when insufficient_privilege then raise exception 'DB2-4 NOT reproduced (fixed?): view % → 42501', v;
    end;
  end loop;
  raise notice 'DB2-4 REPRODUCED: DELETE on % views → 55000 (not 42501)', n;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- DB2-5  billing_entitlements: verified_at is not a monotonic guard. The edge
--        fn upserts unconditionally (persistBillingVerdict), so an OLDER
--        verdict committing last overwrites a NEWER premium=true row.
-- ---------------------------------------------------------------------------
set local role service_role;
do $$
declare p boolean; v timestamptz;
begin
  insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values ('00000000-0000-4000-8000-0000000000a1', true, 'pickle_sensei_pro_monthly', null, now())
  on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at;
  -- the stale (earlier-verified) non-premium verdict lands second — same statement shape as PostgREST merge-duplicates
  insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values ('00000000-0000-4000-8000-0000000000a1', false, null, null, now() - interval '30 seconds')
  on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key,
    expires_at = excluded.expires_at, verified_at = excluded.verified_at;
  select premium, verified_at into p, v from public.billing_entitlements
   where user_id = '00000000-0000-4000-8000-0000000000a1';
  if p then raise exception 'DB2-5 NOT reproduced (fixed?): newer premium verdict survived'; end if;
  raise notice 'DB2-5 REPRODUCED: older non-premium verdict (verified_at %) overwrote newer premium=true row', v;
end $$;
reset role;

rollback;
