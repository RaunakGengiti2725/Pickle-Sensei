-- Exact SQL reproducers for the anomalies found by
-- supabase/tests/stress/db_rank_boundary_malformed.mjs (campaign seed
-- "db-rank-boundary-malformed-v1"). Run against a disposable database built by
-- pg_up.sh (shim_auth.sql + every migration), never against a hosted project:
--
--   supabase/tests/stress/pg_up.sh
--   docker exec -i pickle-stress-pg psql -U postgres -v ON_ERROR_STOP=0 \
--     -f - < supabase/tests/stress/db_rank_boundary_malformed_repro.sql
--
-- Every block is self-contained (own users, own permit) and prints an
-- OBSERVED / EXPECTED pair. Nothing here modifies migrations.

\set alice '00000000-0000-4000-8000-0000000000fa'
\set bob   '00000000-0000-4000-8000-0000000000fb'

begin;
insert into auth.users (id, email, raw_user_meta_data)
values (:'alice', 'stress-alice@example.com', '{"name":"Stress Alice"}'::jsonb),
       (:'bob',   'stress-bob@example.com',   '{"name":"Stress Bob"}'::jsonb)
on conflict (id) do nothing;
insert into public.billing_entitlements (user_id, premium)
values (:'alice', true), (:'bob', true)
on conflict (user_id) do update set premium = true, expires_at = null;
commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. apply_synced_shot raises 22P02 OUT of the function (echoing the input)
--    for a non-UUID id / analysisPermitId / sessionId. The casts on the first
--    lines of the body run before the `begin … exception` block that turns
--    every other malformed field into a stable `shot.write_failed:<SQLSTATE>`.
--    Seeds: #104 ("-1"), #333 (["__proto__"]), #2629 (SQL-looking text), #10.
--    Reachable by any authenticated PostgREST caller (the edge parser gates
--    the app path). Expected: a stable code like the other fields get.
-- ─────────────────────────────────────────────────────────────────────────────
\echo '--- A: non-uuid id raises out of apply_synced_shot (expected: stable code, observed: 22P02 raised)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'alice', true);
select public.apply_synced_shot('{"id":"-1","analysisPermitId":"00000000-0000-4000-8000-000000000001"}'::jsonb);
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'alice', true);
select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-000000000002","analysisPermitId":["__proto__"]}'::jsonb);
rollback;
\echo '--- A (contrast): a malformed non-uuid field is caught and coded'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'alice', true);
select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-000000000002","analysisPermitId":"00000000-0000-4000-8000-000000000001","capturedAt":"-1"}'::jsonb) as coded_not_raised;
rollback;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. An empty-string shotType is ACCEPTED as a scored shot and becomes a rank
--    "technique". public.shots caps length(shot_type) <= 64 but has no lower
--    bound; the edge parser (`!value.shotType.trim()`) and the TS oracle
--    (`shotType.length > 0`) both refuse it, so SQL and TS disagree on
--    technique_count / rating for the same rows. Seeds: #1698 (duplicate key,
--    last wins), #2096 (wrong_type ""), owner path #1747 / #2414.
-- ─────────────────────────────────────────────────────────────────────────────
\echo '--- C: empty shotType accepted and counted as a technique'
begin;
insert into public.sessions (id, user_id, started_at) values ('00000000-0000-4000-8000-0000000000c1', :'alice', now());
insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values ('00000000-0000-4000-8000-0000000000c2', :'alice', 'stress-repro-c', 'reserved', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', :'alice', true);
select public.apply_synced_shot(jsonb_build_object(
  'id', '00000000-0000-4000-8000-0000000000c3', 'analysisPermitId', '00000000-0000-4000-8000-0000000000c2',
  'sessionId', '00000000-0000-4000-8000-0000000000c1',
  'shotType', '', 'cameraView', 'side', 'capturedAt', '2026-01-01T00:00:00Z',
  'startMs', 0, 'contactMs', 1, 'endMs', 2, 'overallScore', 7.5, 'confidence', 0.9,
  'resultKind', 'scored', 'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb,
  'versionVector', jsonb_build_object(
    'appVersion', 'a', 'modelBundleVersion', 'b', 'poseModelVersion', 'c', 'paddleModelVersion', 'd',
    'strokeDetectorVersion', 'e', 'phaseModelVersion', 'f', 'scoringModelVersion', 'g', 'shotConfigVersion', 'h')
)) as result;
reset role;
select id, quote_literal(shot_type) as shot_type, result_kind, overall_score from public.shots where id = '00000000-0000-4000-8000-0000000000c3';
select rating, tier, technique_count, scored_shot_count from public.player_rank_state where user_id = :'alice';
\echo 'EXPECTED: result <> accepted / no row / no technique for "";  OBSERVED above: accepted, row stored, technique_count counts ""'
rollback;

-- ─────────────────────────────────────────────────────────────────────────────
-- F. player_rank_tier('NaN') returns 'diamond' (NaN >= 7.5 is TRUE in Postgres
--    numeric ordering: NaN sorts above every number). The TS oracle returns
--    bronze for NaN. Unreachable from recompute_player_rank today (its inputs
--    are averages of 0..10 scores) — a parity/robustness note. Seeds #1812, #3149.
-- ─────────────────────────────────────────────────────────────────────────────
\echo '--- F: player_rank_tier(NaN)'
select public.player_rank_tier('NaN'::numeric) as observed, 'bronze (TS oracle) — or an error' as expected;

-- ─────────────────────────────────────────────────────────────────────────────
-- D. Lost update on player_rank_state under READ COMMITTED (two sessions).
--    recompute_player_rank() reads the evidence in one statement and upserts
--    the row in the next; a concurrent writer whose path takes no advisory
--    lock (authenticated direct INSERT of a low_confidence row — granted; or
--    any owner/service-role INSERT) computes from a snapshot that excludes the
--    other transaction's shot, blocks on the row lock, then overwrites with the
--    stale numbers after the other commits. Reproduced 10/10 by the harness
--    (`interleave/client_read_committed`, `interleave/owner_read_committed`);
--    0/10 under SERIALIZABLE (B gets 40001). Two psql sessions, in order:
--
--   -- session A (authenticated alice, scored sync via the RPC)
--   begin;
--   set local role authenticated; select set_config('request.jwt.claim.sub', :'alice', true);
--   select public.apply_synced_shot(<valid scored payload with a live reserved permit>);   -- accepted
--   select rating, scored_shot_count from public.player_rank_state where user_id = :'alice'; -- e.g. 7.50, 1
--   -- session B (authenticated alice, direct INSERT — the granted client path with no advisory lock)
--   begin;
--   set local role authenticated; select set_config('request.jwt.claim.sub', :'alice', true);
--   insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
--     overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
--     paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
--   values (gen_random_uuid(), :'alice', 'dink', 'side', now(), 0, 1, 2, null, 0.2, 'low_confidence',
--     'a','b','c','d','e','f','g','h','real');     -- BLOCKS on A's uncommitted player_rank_state row
--   -- session A
--   commit;
--   -- session B unblocks; its trigger already computed the rank WITHOUT A's shot
--   commit;
--   select rating, scored_shot_count from public.player_rank_state where user_id = :'alice';
--     -- OBSERVED: the pre-A numbers (row deleted if A's shot was the only scored one)
--     -- EXPECTED: the numbers including A's shot
--   select public.recompute_player_rank(:'alice');  -- repairs it
--
--    Replay: STRESS_ITER=0 STRESS_CONC_ROUNDS=0 STRESS_INTERLEAVE=10 \
--            supabase/tests/stress/run_db_rank_boundary_malformed.sh
-- ─────────────────────────────────────────────────────────────────────────────

begin;
delete from auth.users where id in (:'alice', :'bob');
commit;
