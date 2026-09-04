-- xc-security adjudication — SQL-plane reproductions against the shim +
-- every migration (same harness as run_rls_tests.sh). Each block RAISES if the
-- current (defective) behaviour is NOT observed, so a fix flips the block.
--
--   docker exec <c> psql -U postgres -v ON_ERROR_STOP=1 -f /tests/xc_adjudication/xc_adjudication_repro.sql
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-0000000000aa', 'xc@example.com',
        '{"full_name":"Xc"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-xc', '00000000-0000-4000-8000-0000000000aa',
        '{"sub":"google-sub-xc","email":"xc@example.com"}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';

insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000dd',
        '00000000-0000-4000-8000-0000000000aa', now());

-- ── XC-SQL-1 (defect): captures.declared_stroke / recognized_shot_type have
--    no size cap although every sibling text column got one in
--    20260831160000_defense_in_depth.sql. authenticated has INSERT on captures.
do $$
declare v_len int;
begin
  insert into public.captures (
    id, user_id, session_id, captured_at, duration_ms, fps, capture_mode,
    declared_stroke, recognized_shot_type, evidence_status)
  values (
    '00000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000aa',
    '00000000-0000-4000-8000-0000000000dd',
    now(), 1000, 30, 'automatic_pose_trigger',
    repeat('x', 5 * 1024 * 1024), repeat('y', 5 * 1024 * 1024), 'valid');
  select length(declared_stroke) into v_len from public.captures
    where id = '00000000-0000-4000-8000-0000000000c1';
  if v_len <> 5 * 1024 * 1024 then
    raise exception 'XC-SQL-1: expected the 5 MiB declared_stroke to be stored (defect); got length %', v_len;
  end if;
  raise notice 'XC-SQL-1 REPRODUCED: 5 MiB declared_stroke + 5 MiB recognized_shot_type stored in one captures row';
end $$;

-- ── XC-SQL-2 (defect): apply_synced_shot() casts capturedAt inside the
--    function and its WHEN OTHERS handler returns 'shot.write_failed:'||sqlerrm,
--    echoing the client-controlled value back into the result (→ edge logs).
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a9',
        '00000000-0000-4000-8000-0000000000aa', 'xc-permit-1');
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e9',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a9',
    'sessionId', '00000000-0000-4000-8000-0000000000dd',
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', E'XCSEC_CANARY\n[api] forged log line',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb));
  if v not like 'shot.write_failed:%' or position('XCSEC_CANARY' in v) = 0 then
    raise exception 'XC-SQL-2: expected sqlerrm echo of the canary (defect); got %', v;
  end if;
  raise notice 'XC-SQL-2 REPRODUCED: result = %', replace(v, E'\n', '\n');
end $$;

-- ── XC-SQL-3 (defect): the same RPC accepts 'infinity' as capturedAt — the
--    edge validates capturedAt with Date.parse, but the RPC is directly
--    callable by any authenticated bearer via PostgREST.
do $$
declare v text; v_at timestamptz;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e8',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a9',
    'sessionId', '00000000-0000-4000-8000-0000000000dd',
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', 'infinity',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb));
  if v <> 'accepted' then
    raise exception 'XC-SQL-3: expected accepted (defect); got %', v;
  end if;
  select captured_at into v_at from public.shots where id = '00000000-0000-4000-8000-0000000000e8';
  if v_at <> 'infinity'::timestamptz then
    raise exception 'XC-SQL-3: expected infinity stored; got %', v_at;
  end if;
  raise notice 'XC-SQL-3 REPRODUCED: shots.captured_at = %', v_at;
end $$;

-- Does an infinite captured_at break the aggregate view the Progress screen reads?
do $$
declare n int;
begin
  select count(*) into n from public.progress_daily;
  raise notice 'XC-SQL-3b: progress_daily still readable (% rows) with an infinite captured_at', n;
exception when others then
  raise notice 'XC-SQL-3b: progress_daily FAILS with infinite captured_at: % (%)', sqlerrm, sqlstate;
end $$;

reset role;

-- ── XC-SQL-4: player_rank_tier(numeric) — anon revoke exists, but PUBLIC
--    EXECUTE (Postgres default for functions) still lets anon call it.
do $$
declare v_anon boolean; v_public boolean;
begin
  select has_function_privilege('anon', 'public.player_rank_tier(numeric)', 'execute') into v_anon;
  select has_function_privilege('public.player_rank_tier(numeric)', 'execute') into v_public;
  raise notice 'XC-SQL-4: anon can execute player_rank_tier(numeric) = % (PUBLIC grant present = %)', v_anon,
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'player_rank_tier' and p.proacl is null);
end $$;

rollback;
