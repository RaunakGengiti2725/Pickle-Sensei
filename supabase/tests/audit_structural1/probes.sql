-- ============================================================================
-- Structural audit #1 — db-rls-grants-isolation probes (additive; does NOT
-- modify security_regression.sql). Run by run_probes.sh after shim_auth.sql
-- (+ optionally hosted_function_defaults.sql) and every migration.
--
-- Every probe runs in its own transaction and is rolled back, so probes are
-- independent. Each probe emits exactly one line per assertion:
--   RESULT|<id>|PASS|<detail>   the pinned invariant held
--   RESULT|<id>|FAIL|<detail>   the invariant is violated on this commit
--   RESULT|<id>|INFO|<detail>   observed behaviour with no pinned contract
-- run_probes.sh greps these lines; any FAIL makes it exit 1.
-- ============================================================================
\set ON_ERROR_STOP off
\set QUIET on
\pset pager off

-- ────────────────────────────── helpers ─────────────────────────────────────
create or replace function pg_temp.report(p_id text, p_ok boolean, p_detail text)
returns void language plpgsql as $$
begin
  raise notice 'RESULT|%|%|%', p_id, case when p_ok then 'PASS' else 'FAIL' end, p_detail;
end $$;

create or replace function pg_temp.info(p_id text, p_detail text)
returns void language plpgsql as $$
begin
  raise notice 'RESULT|%|INFO|%', p_id, p_detail;
end $$;

-- Execute a statement; return 'OK' or '<sqlstate>: <message>'.
create or replace function pg_temp.try(q text)
returns text language plpgsql as $$
begin
  execute q;
  return 'OK';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- Execute a statement; return the affected row count or '<sqlstate>'.
create or replace function pg_temp.try_rows(q text)
returns text language plpgsql as $$
declare n int;
begin
  execute q;
  get diagnostics n = row_count;
  return n::text;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- apply_synced_shot that never raises: returns the status string, or
-- 'RAISED <sqlstate>: <message>' when the RPC threw instead.
create or replace function pg_temp.rpc(p jsonb)
returns text language plpgsql as $$
begin
  return public.apply_synced_shot(p);
exception when others then
  return 'RAISED ' || sqlstate || ': ' || sqlerrm;
end $$;

create or replace function pg_temp.reserve(k text)
returns text language plpgsql as $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit(k);
  return r.result;
exception when others then
  return 'RAISED ' || sqlstate || ': ' || sqlerrm;
end $$;

create or replace function pg_temp.as_user(u uuid)
returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', u::text, true);
end $$;

create or replace function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  execute 'set local role anon';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

create or replace function pg_temp.as_admin()
returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Payload in the exact shape supabase/functions/api/index.ts hands to the RPC.
create or replace function pg_temp.shot(p_id uuid, p_permit uuid, p_kind text, p_session uuid)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'resultKind', p_kind,
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 400, 'representativeMs', 500,
      'endMs', 600, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object(
      'key', 'contact_position', 'score', 71, 'confidence', 0.9,
      'band', 'green', 'direction', 'ok', 'severity', 0.1,
      'applicable', true)))
$$;

-- ────────────────────────────── fixture (committed) ─────────────────────────
-- alice ...0a (google), bob ...0b (apple); alice owns session d1 and one
-- scored shot e1 written through the RPC with permit a1 (now finalized).
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a', '{"sub":"google-sub-alice","email":"alice@example.com"}'),
  ('apple',  'apple-sub-bob',    '00000000-0000-4000-8000-00000000000b', '{"sub":"apple-sub-bob","email":"bob@example.com"}');
insert into public.sessions (id, user_id, started_at) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now()),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-00000000000b', now());
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'fixture-a1');
do $$
declare v text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := public.apply_synced_shot(pg_temp.shot(
    '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1',
    'scored', '00000000-0000-4000-8000-0000000000d1'));
  if v <> 'accepted' then raise exception 'FIXTURE: sync e1 → %', v; end if;
  perform pg_temp.as_admin();
end $$;
commit;

-- ═══════════════════════ S01–S06: apply_synced_shot input contract ══════════
-- Contract (20260831000000 header + 20260902150000 body): "Returns a status
-- code string the API maps verbatim". The Edge Function validates first, so a
-- raise is not reachable from the app, but the RPC is the documented contract.

begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare v text; st text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot(gen_random_uuid(), '00000000-0000-4000-8000-0000000000a2', 'scored', null)
                   || '{"id":"not-a-uuid"}'::jsonb);
  st := (select status from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a2');
  perform pg_temp.report('S01-malformed-id-returns-status',
    v like 'shot.write_failed:%', 'rpc=' || v || ' permit=' || st);
  perform pg_temp.report('S01-malformed-id-permit-untouched', st = 'reserved', 'permit=' || st);
exception when others then
  perform pg_temp.report('S01', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare v text; st text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot(gen_random_uuid(), '00000000-0000-4000-8000-0000000000a2', 'scored', null)
                   || '{"sessionId":"not-a-uuid"}'::jsonb);
  st := (select status from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a2');
  perform pg_temp.report('S01b-malformed-sessionId-returns-status',
    v like 'shot.write_failed:%', 'rpc=' || v || ' permit=' || st);
exception when others then
  perform pg_temp.report('S01b', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare v text; st text; n int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2', 'scored', null)
                   || '{"capturedAt":"not-a-timestamp"}'::jsonb);
  st := (select status from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a2');
  n := (select count(*) from public.shots where id = '00000000-0000-4000-8000-0000000000e2');
  perform pg_temp.report('S02-bad-capturedAt-status-string', v like 'shot.write_failed:%', 'rpc=' || v);
  perform pg_temp.report('S02-bad-capturedAt-permit-reserved-no-shot', st = 'reserved' and n = 0, 'permit=' || st || ' shots=' || n);
exception when others then
  perform pg_temp.report('S02', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare v text; st text; n int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2', 'bogus', null)
                   || '{"overallScore":5.0}'::jsonb);
  st := (select status from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a2');
  n := (select count(*) from public.shots where id = '00000000-0000-4000-8000-0000000000e2');
  perform pg_temp.report('S03-resultKind-outside-CHECK', v like 'shot.write_failed:%' and st = 'reserved' and n = 0,
    'rpc=' || v || ' permit=' || st || ' shots=' || n);
exception when others then
  perform pg_temp.report('S03', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare v text; st text; n int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2', 'scored', null)
                   || '{"overallScore":null}'::jsonb);
  st := (select status from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a2');
  n := (select count(*) from public.shots where id = '00000000-0000-4000-8000-0000000000e2');
  perform pg_temp.report('S04-scored-null-score', v like 'shot.write_failed:%' and st = 'reserved' and n = 0,
    'rpc=' || v || ' permit=' || st || ' shots=' || n);
exception when others then
  perform pg_temp.report('S04', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
do $$
declare v text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', null, 'scored', null) - 'analysisPermitId');
  perform pg_temp.report('S05-missing-permit-id', v = 'access.permit_not_found', 'rpc=' || v);
exception when others then
  perform pg_temp.report('S05', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare v text; st text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  -- d2 is Bob's session
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2',
    'scored', '00000000-0000-4000-8000-0000000000d2'));
  st := (select status from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a2');
  perform pg_temp.report('S06-foreign-session-in-sync', v = 'shot.session_not_found' and st = 'reserved',
    'rpc=' || v || ' permit=' || st);
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2', 'scored', null)
                   || '{"sessionId":""}'::jsonb);
  perform pg_temp.info('S06b-empty-sessionId-treated-as-null', 'rpc=' || v);
exception when others then
  perform pg_temp.report('S06', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S07: the 24-hour boundary ══════════════════════════
-- count uses created_at > now()-24h; expiry uses created_at <= now()-24h.
-- Those are complements: at exactly 24h a permit is neither counted nor usable.
begin;
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2',
   now() - interval '24 hours');
do $$
declare v text; s record; st text; oc text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  select * into s from public.access_state();
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2', 'scored', null));
  select status, outcome into st, oc from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a2';
  perform pg_temp.report('S07a-exactly-24h-not-counted-and-expired',
    s.reserved_count = 0 and v = 'access.permit_expired' and st = 'released' and oc = 'expired',
    'reserved_count=' || s.reserved_count || ' rpc=' || v || ' permit=' || st || '/' || coalesce(oc, 'null'));
exception when others then
  perform pg_temp.report('S07a', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2',
   now() - interval '24 hours' + interval '1 millisecond');
do $$
declare v text; s record;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  select * into s from public.access_state();
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2', 'scored', null));
  perform pg_temp.report('S07b-just-inside-24h-counted-and-usable',
    s.reserved_count = 1 and v = 'accepted', 'reserved_count=' || s.reserved_count || ' rpc=' || v);
exception when others then
  perform pg_temp.report('S07b', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S08: reserve_analysis_permit edge inputs ═══════════
begin;
do $$
declare v text; n int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.reserve(null);
  perform pg_temp.info('S08a-reserve-NULL-key', 'result=' || v);
  v := pg_temp.reserve('');
  n := (select count(*) from public.analysis_permits where idempotency_key = '');
  perform pg_temp.info('S08b-reserve-empty-key', 'result=' || v || ' permits_with_empty_key=' || n);
  v := pg_temp.reserve('fixture-a1');
  perform pg_temp.info('S08c-reserve-replay-of-finalized-key', 'result=' || v || ' (fast path returns the settled permit)');
exception when others then
  perform pg_temp.report('S08', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S09: direct client INSERT of scored shots ══════════
-- Matrix fixture E1 relies on this being allowed. Pin what it implies.
begin;
do $$
declare r text; c1 int; c2 int; led int; v text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  c1 := public.lifetime_scored_count();
  r := pg_temp.try($q$insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms,
        overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
        paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
      values ('00000000-0000-4000-8000-0000000000e8', '00000000-0000-4000-8000-00000000000a', 'dink', now(), 0, 1000,
        9.9, 0.9, 'scored', '1','1','1','1','1','1','1','1')$q$);
  r := r || ' / ' || pg_temp.try($q$insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms,
        overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
        paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
      values ('00000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-00000000000a', 'dink', now(), 0, 1000,
        9.9, 0.9, 'scored', '1','1','1','1','1','1','1','1')$q$);
  c2 := public.lifetime_scored_count();
  v := pg_temp.reserve('after-direct');
  perform pg_temp.as_admin();
  led := (select scored_count from public.free_rating_ledger
          where identity_hash = public.free_rating_identity_hash('google', 'google-sub-alice'));
  perform pg_temp.info('S09-owner-direct-scored-insert-no-permit',
    'inserts=' || r || ' lifetime_before=' || c1 || ' lifetime_after=' || c2 || ' ledger=' || led
    || ' reserve_after=' || v || ' rank=' || coalesce((select rating::text from public.player_rank_state
        where user_id = '00000000-0000-4000-8000-00000000000a'), 'none'));
exception when others then
  perform pg_temp.report('S09', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S10: ledger max-propagation across identities ══════
begin;
do $$
declare v text; g int; a int; d int;
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
    ('00000000-0000-4000-8000-00000000000c', 'carol@example.com', '{}', '{"provider":"google"}');
  insert into auth.identities (provider, provider_id, user_id, identity_data) values
    ('google', 'google-sub-carol', '00000000-0000-4000-8000-00000000000c', '{"sub":"google-sub-carol"}'),
    ('apple',  'apple-sub-carol',  '00000000-0000-4000-8000-00000000000c', '{"sub":"apple-sub-carol"}');
  -- google identity carries history (5) from an earlier, deleted account; apple never scored.
  insert into public.free_rating_ledger (identity_hash, scored_count)
    values (public.free_rating_identity_hash('google', 'google-sub-carol'), 5);
  insert into public.analysis_permits (id, user_id, idempotency_key) values
    ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000c', 'c1');
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000c');
  -- premium so the backstop lets the scored shot through
  perform pg_temp.as_admin();
  insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-00000000000c', true);
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000c');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000c1', 'scored', null));
  perform pg_temp.as_admin();
  g := (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'google-sub-carol'));
  a := (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-carol'));
  -- carol deletes; a NEW person "dave" signs in with... the same Apple subject
  -- cannot happen (subject is per Apple ID). Instead: carol re-creates with
  -- ONLY the apple identity → inherits the google history.
  delete from auth.users where id = '00000000-0000-4000-8000-00000000000c';
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
    ('00000000-0000-4000-8000-00000000000d', 'carol2@example.com', '{}', '{"provider":"apple"}');
  insert into auth.identities (provider, provider_id, user_id, identity_data) values
    ('apple', 'apple-sub-carol', '00000000-0000-4000-8000-00000000000d', '{"sub":"apple-sub-carol"}');
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000d');
  d := public.lifetime_scored_count();
  perform pg_temp.as_admin();
  perform pg_temp.info('S10-ledger-greatest-propagation',
    'rpc=' || v || ' google_ledger=' || g || ' apple_ledger=' || a
    || ' recreated_apple_only_lifetime=' || d || ' (apple identity itself scored once; inherits google max+1 by design)');
exception when others then
  perform pg_temp.report('S10', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S11: profiles.provider client-writable ═════════════
begin;
do $$
declare r1 text; r2 text; p text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  r1 := pg_temp.try($q$update public.profiles set provider = 'evil-provider' where id = '00000000-0000-4000-8000-00000000000a'$q$);
  p := (select provider from public.profiles where id = '00000000-0000-4000-8000-00000000000a');
  r2 := pg_temp.try($q$update public.profiles set provider = repeat('x', 51) where id = '00000000-0000-4000-8000-00000000000a'$q$);
  perform pg_temp.info('S11a-provider-client-writable', 'update=' || r1 || ' provider_now=' || p);
  perform pg_temp.report('S11b-provider-length-cap-binds', r2 like '23514%', 'oversize=' || r2);
exception when others then
  perform pg_temp.report('S11', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S12: owner DELETE on sessions ══════════════════════
begin;
do $$
declare r text; sid uuid; c int; rk text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  r := pg_temp.try_rows($q$delete from public.sessions where id = '00000000-0000-4000-8000-0000000000d1'$q$);
  sid := (select session_id from public.shots where id = '00000000-0000-4000-8000-0000000000e1');
  c := public.lifetime_scored_count();
  rk := coalesce((select tier from public.player_rank_state where user_id = '00000000-0000-4000-8000-00000000000a'), 'none');
  perform pg_temp.info('S12-owner-session-delete',
    'deleted_rows=' || r || ' shot.session_id_after=' || coalesce(sid::text, 'NULL') || ' lifetime=' || c || ' rank_tier=' || rk);
exception when others then
  perform pg_temp.report('S12', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S13: owner full CRUD on captures ═══════════════════
begin;
do $$
declare r1 text; r2 text; r3 text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  r1 := pg_temp.try($q$insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-00000000000a', now(), 1000, 30, 'automatic_pose_trigger', 'valid')$q$);
  r2 := pg_temp.try_rows($q$update public.captures set status = 'analyzed', evidence_status = 'corrupt' where id = '00000000-0000-4000-8000-0000000000f1'$q$);
  r3 := pg_temp.try_rows($q$delete from public.captures where id = '00000000-0000-4000-8000-0000000000f1'$q$);
  perform pg_temp.info('S13-owner-captures-crud', 'insert=' || r1 || ' update_rows=' || r2 || ' delete_rows=' || r3);
exception when others then
  perform pg_temp.report('S13', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S14: pg_trigger_depth()>1 passthrough breadth ══════
-- Any nested DELETE (not only FK cascades) passes reject_ledger_mutation; any
-- nested UPDATE/DELETE passes reject_deletion_feedback_mutation. There is no
-- client-reachable trigger that does either; pin the breadth as INFO.
begin;
do $$
declare r text; n int; c text;
begin
  insert into public.consent_records (user_id, scope, action) values ('00000000-0000-4000-8000-00000000000a', 'video_analysis', 'grant');
  insert into public.account_deletion_feedback (user_id, reason, details) values ('00000000-0000-4000-8000-00000000000a', 'other', 'orig');
  create table pg_temp.scratch (x int);
  create function pg_temp.nested_mutations() returns trigger language plpgsql as $f$
  begin
    delete from public.consent_records where user_id = '00000000-0000-4000-8000-00000000000a';
    update public.account_deletion_feedback set details = 'rewritten' where user_id = '00000000-0000-4000-8000-00000000000a';
    return new;
  end $f$;
  create trigger scratch_nested after insert on pg_temp.scratch for each row execute function pg_temp.nested_mutations();
  r := pg_temp.try('insert into pg_temp.scratch values (1)');
  n := (select count(*) from public.consent_records where user_id = '00000000-0000-4000-8000-00000000000a');
  c := (select details from public.account_deletion_feedback where user_id = '00000000-0000-4000-8000-00000000000a');
  perform pg_temp.info('S14-depth-gt-1-passthrough', 'nested_trigger_insert=' || r || ' consent_rows_left=' || n || ' feedback_details=' || c);
  -- top-level (depth 1) mutations as table owner are still blocked
  insert into public.consent_records (user_id, scope, action) values ('00000000-0000-4000-8000-00000000000a', 'video_analysis', 'grant');
  r := pg_temp.try($q$delete from public.consent_records where user_id = '00000000-0000-4000-8000-00000000000a'$q$);
  perform pg_temp.report('S14b-top-level-owner-delete-blocked', r like '42501%', r);
exception when others then
  perform pg_temp.report('S14', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S15: function EXECUTE matrix ═══════════════════════
begin;
do $$
declare bad text; f text; ok boolean;
begin
  -- anon: nothing in public is executable
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');
  perform pg_temp.report('S15a-anon-no-EXECUTE-on-any-public-function', bad is null, coalesce('anon can execute: ' || bad, 'none'));

  -- authenticated: privileged helpers are NOT executable
  bad := null;
  foreach f in array array[
    'public.free_rating_identity_hash(text,text)', 'public.record_scored_shot_in_ledger()',
    'public.recompute_player_rank(uuid)', 'public.handle_new_user()', 'public.handle_user_email_updated()',
    'public.set_updated_at()', 'public.handle_shot_rank_refresh()', 'public.reject_ledger_mutation()',
    'public.reject_deletion_feedback_mutation()'] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') then bad := coalesce(bad || ', ', '') || f; end if;
  end loop;
  perform pg_temp.report('S15b-authenticated-no-EXECUTE-on-privileged', bad is null, coalesce('authenticated can execute: ' || bad, 'none'));

  -- authenticated: the client RPC surface IS executable (owner paths keep working)
  bad := null;
  foreach f in array array[
    'public.access_state()', 'public.apply_synced_shot(jsonb)', 'public.reserve_analysis_permit(text)',
    'public.complete_onboarding()', 'public.identity_scored_count()', 'public.lifetime_scored_count()',
    'public.access_lock_key(uuid)'] loop
    if not has_function_privilege('authenticated', f, 'EXECUTE') then bad := coalesce(bad || ', ', '') || f; end if;
  end loop;
  perform pg_temp.report('S15c-authenticated-EXECUTE-on-rpc-surface', bad is null, coalesce('missing: ' || bad, 'all granted'));

  -- full inventory of what authenticated can execute (INFO)
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  perform pg_temp.info('S15d-authenticated-executable-inventory', coalesce(bad, 'none'));

  -- live check of the one revoke that is written as `from anon` only
  -- (20260831160000_defense_in_depth.sql): PUBLIC still holds EXECUTE.
  perform pg_temp.as_anon();
  bad := pg_temp.try('select public.player_rank_tier(7.5)');
  perform pg_temp.as_admin();
  perform pg_temp.report('S15e-anon-live-EXECUTE-player_rank_tier-denied', bad like '42501%', 'anon call=' || bad
    || ' acl=' || coalesce((select array_to_string(proacl, ' ') from pg_proc where oid = 'public.player_rank_tier(numeric)'::regprocedure), 'NULL(default: PUBLIC EXECUTE)'));
exception when others then
  perform pg_temp.report('S15', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S16: NULL auth.uid() paths ═════════════════════════
begin;
do $$
declare i int; l int; s record; v text; w text;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claim.sub', '', true);
  i := public.identity_scored_count();
  l := public.lifetime_scored_count();
  select * into s from public.access_state();
  v := pg_temp.reserve('anon-key');
  w := pg_temp.rpc(pg_temp.shot(gen_random_uuid(), '00000000-0000-4000-8000-0000000000a1', 'scored', null));
  perform pg_temp.report('S16-null-uid-counts-zero-and-rpcs-refuse',
    i = 0 and l = 0 and s.premium = false and s.scored_count = 0 and s.reserved_count = 0
    and v = 'auth.required' and w = 'auth.required',
    'identity=' || i || ' lifetime=' || l || ' access=' || s::text || ' reserve=' || v || ' sync=' || w);
exception when others then
  perform pg_temp.report('S16', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S17: cross-user through security_invoker views ═════
begin;
do $$
declare b1 int; b2 int; b3 int; a3 int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000b');
  b1 := (select count(*) from public.progress_daily);
  b2 := (select count(*) from public.practice_days);
  b3 := (select count(*) from public.player_technique_rating);
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  a3 := (select count(*) from public.player_technique_rating where user_id = '00000000-0000-4000-8000-00000000000a');
  perform pg_temp.report('S17-views-isolate-cross-user', b1 = 0 and b2 = 0 and b3 = 0 and a3 = 1,
    'bob sees progress_daily=' || b1 || ' practice_days=' || b2 || ' technique=' || b3 || '; alice sees own technique rows=' || a3);
exception when others then
  perform pg_temp.report('S17', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S18: permit lifecycle reversal by the client ═══════
-- The status/outcome grant lets a client flip a finalized permit back to
-- 'reserved'. The backstop must still hold the lifetime limit.
begin;
-- alice → 2 scored (limit reached)
insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence,
  result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
  phase_model_version, scoring_model_version, shot_config_version)
values ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000000a', 'dink', now(), 0, 1000, 6.0, 0.9,
  'scored', '1','1','1','1','1','1','1','1');
do $$
declare r text; s record; v text; st text; oc text; c int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  r := pg_temp.try_rows($q$update public.analysis_permits set status = 'reserved', outcome = null
    where id = '00000000-0000-4000-8000-0000000000a1'$q$);
  select * into s from public.access_state();
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000a1', 'scored', null));
  select status, outcome into st, oc from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a1';
  c := public.lifetime_scored_count();
  perform pg_temp.report('S18a-flipped-permit-at-limit-denied',
    r = '1' and v = 'access.paywall_required' and c = 2 and st = 'released' and oc = 'free_limit_exceeded',
    'flip_rows=' || r || ' reserved_count=' || s.reserved_count || ' rpc=' || v || ' lifetime=' || c || ' permit=' || st || '/' || coalesce(oc, 'null'));
exception when others then
  perform pg_temp.report('S18a', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare r text; v1 text; v2 text; c int; s record;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  -- alice has 1 scored + 1 reserved (a2); she flips finalized a1 back → 2 reserved with remaining 1
  r := pg_temp.try_rows($q$update public.analysis_permits set status = 'reserved', outcome = null
    where id = '00000000-0000-4000-8000-0000000000a1'$q$);
  select * into s from public.access_state();
  v1 := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000a1', 'scored', null));
  v2 := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-0000000000a2', 'scored', null));
  c := public.lifetime_scored_count();
  perform pg_temp.report('S18b-two-live-permits-cannot-exceed-limit',
    v1 = 'accepted' and v2 = 'access.paywall_required' and c = 2,
    'reserved_count=' || s.reserved_count || ' first=' || v1 || ' second=' || v2 || ' lifetime=' || c);
exception when others then
  perform pg_temp.report('S18b', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S19: session upsert with a foreign id ══════════════
begin;
do $$
declare r text; owner uuid; n int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000b');
  r := pg_temp.try_rows($q$insert into public.sessions (id, user_id, started_at)
    values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000b', now())
    on conflict (id) do nothing$q$);
  n := (select count(*) from public.sessions where id = '00000000-0000-4000-8000-0000000000d1');
  perform pg_temp.as_admin();
  owner := (select user_id from public.sessions where id = '00000000-0000-4000-8000-0000000000d1');
  perform pg_temp.report('S19-foreign-session-upsert-is-noop',
    r = '0' and n = 0 and owner = '00000000-0000-4000-8000-00000000000a',
    'insert_rows=' || r || ' bob_sees=' || n || ' owner_after=' || owner);
exception when others then
  perform pg_temp.report('S19', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S20: cross-user shot id conflict ═══════════════════
begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000000b', 'probe-b1');
do $$
declare v text; st text; n int; r text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000b');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000b1', 'scored', null));
  st := (select status from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000b1');
  n := (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-00000000000b');
  perform pg_temp.report('S20a-sync-with-foreign-shot-id', v = 'shot.id_conflict' and st = 'reserved' and n = 0,
    'rpc=' || v || ' bob_permit=' || st || ' bob_shots=' || n);
  r := pg_temp.try($q$insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000b', 'dink', now(), 0, 1000, 5, 0.9,
      'scored', '1','1','1','1','1','1','1','1')$q$);
  perform pg_temp.info('S20b-direct-insert-foreign-shot-id', 'result=' || r || ' (existence oracle only; row not writable)');
exception when others then
  perform pg_temp.report('S20', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S21: detail rows attached to ANOTHER user's shot ═══
-- 20260829120000_progress_data.sql:261-263 claims "a CHECK-by-policy
-- guarantees a user can only attach details to their own shot (the FK plus
-- shots RLS closes the loop)". FK checks run as table owner and ignore RLS,
-- so the loop closes only if WITH CHECK validates shot ownership. Pin it.
begin;
do $$
declare r1 text; r2 text; r3 text; r4 text; r5 text; n int;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000b');
  r1 := pg_temp.try($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000b', 'recover', 0, 1, 2, 0.5)$q$);
  r2 := pg_temp.try($q$insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000b', 'squatted_key', 1, 0.5, 'red', 'x', 0.5, true)$q$);
  r3 := pg_temp.try($q$insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000b', 'm', 1, 0.5, 'ms')$q$);
  r4 := pg_temp.try($q$insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-00000000000b',
      '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000e1', now(), 1, 1, 'imported_video', 'valid')$q$);
  r5 := pg_temp.try($q$insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-0000000000d1',
      'dink', now(), 0, 1000, 5, 0.9, 'low_confidence', '1','1','1','1','1','1','1','1')$q$);
  perform pg_temp.as_admin();
  n := (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e1'
        and user_id <> '00000000-0000-4000-8000-00000000000a');
  perform pg_temp.report('S21a-shot_phases-foreign-shot_id-rejected', r1 <> 'OK', 'insert=' || r1 || ' foreign_phase_rows_on_alice_shot=' || n);
  perform pg_temp.report('S21b-shot_checkpoints-foreign-shot_id-rejected', r2 <> 'OK', 'insert=' || r2);
  perform pg_temp.report('S21c-shot_measurements-foreign-shot_id-rejected', r3 <> 'OK', 'insert=' || r3);
  perform pg_temp.report('S21d-captures-foreign-session/shot-rejected', r4 <> 'OK', 'insert=' || r4);
  perform pg_temp.report('S21e-shots-foreign-session_id-rejected', r5 <> 'OK', 'insert=' || r5);
exception when others then
  perform pg_temp.report('S21', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- Consequence of S21 if it FAILs: a squatted (shot_id, key) makes the owner's
-- later detail write a silent no-op (ON CONFLICT DO NOTHING) and the owner
-- can never see, fix or delete the foreign row (RLS hides it; no grant).
begin;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'probe-a2');
do $$
declare r text; v text; own int; foreign_rows int; alice_sees int;
begin
  -- alice syncs a shot WITHOUT phases (payload phases optional) …
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e7', '00000000-0000-4000-8000-0000000000a2', 'low_confidence', null)
                   || '{"phases":[]}'::jsonb);
  -- … bob squats the phase key on alice's shot …
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000b');
  r := pg_temp.try($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e7', '00000000-0000-4000-8000-00000000000b', 'contact', 0, 1, 2, 0.5)$q$);
  -- … alice later writes her real phase row (same path the RPC uses)
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  perform pg_temp.try($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e7', '00000000-0000-4000-8000-00000000000a', 'contact', 400, 500, 600, 0.9)
    on conflict (shot_id, phase_key) do nothing$q$);
  alice_sees := (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e7');
  perform pg_temp.as_admin();
  own := (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e7' and user_id = '00000000-0000-4000-8000-00000000000a');
  foreign_rows := (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e7' and user_id = '00000000-0000-4000-8000-00000000000b');
  perform pg_temp.info('S21f-squat-consequence',
    'sync=' || v || ' bob_squat=' || r || ' alice_phase_rows=' || own || ' bob_rows_on_alice_shot=' || foreign_rows || ' alice_sees=' || alice_sees);
  -- owner has no path to remove the squatter: no DELETE grant on details, and RLS hides the row
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  r := pg_temp.try($q$delete from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e7'$q$);
  perform pg_temp.info('S21g-owner-cannot-evict-squatter', 'owner delete=' || r);
exception when others then
  perform pg_temp.report('S21f', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S23: premium expiry boundary ═══════════════════════
begin;
insert into public.billing_entitlements (user_id, premium, expires_at)
  values ('00000000-0000-4000-8000-00000000000a', true, now());
do $$
declare s record; p2 boolean;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  select * into s from public.access_state();
  perform pg_temp.as_admin();
  update public.billing_entitlements set expires_at = now() + interval '1 second' where user_id = '00000000-0000-4000-8000-00000000000a';
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  p2 := (select premium from public.access_state());
  perform pg_temp.report('S23-premium-expiry-boundary', s.premium = false and p2 = true,
    'expires_at=now → premium=' || s.premium || '; expires_at=now+1s → premium=' || p2);
exception when others then
  perform pg_temp.report('S23', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S24: table-level grant + RLS inventory ═════════════
begin;
do $$
declare bad text; t text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'p')
    and has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE');
  perform pg_temp.report('S24a-anon-no-table-privilege-anywhere', bad is null, coalesce('anon has privilege on: ' || bad, 'none'));

  select string_agg(c.relname, ', ' order by c.relname) into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  perform pg_temp.report('S24b-rls-enabled-on-every-public-table', bad is null, coalesce('RLS off: ' || bad, 'all tables'));

  bad := null;
  foreach t in array array['shots', 'shot_phases', 'shot_measurements', 'shot_checkpoints', 'consent_records',
    'evaluation_trials', 'analysis_feedback', 'account_deletion_feedback', 'profiles'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'UPDATE') or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      bad := coalesce(bad || ', ', '') || t;
    end if;
  end loop;
  perform pg_temp.report('S24c-no-table-level-UPDATE/DELETE-on-immutable-tables', bad is null, coalesce(bad, 'none'));

  bad := null;
  foreach t in array array['billing_entitlements', 'player_rank_state', 'webhook_events', 'account_external_credentials', 'free_rating_ledger'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT, UPDATE, DELETE') then bad := coalesce(bad || ', ', '') || t; end if;
  end loop;
  perform pg_temp.report('S24d-service-only-tables-no-client-write', bad is null, coalesce(bad, 'none'));

  bad := null;
  foreach t in array array['webhook_events', 'account_external_credentials', 'free_rating_ledger', 'account_deletion_feedback'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'SELECT') then bad := coalesce(bad || ', ', '') || t; end if;
  end loop;
  perform pg_temp.report('S24e-hidden-tables-no-client-SELECT', bad is null, coalesce(bad, 'none'));

  -- tables authenticated can write at table level (INFO)
  select string_agg(c.relname || '[' ||
      case when has_table_privilege('authenticated', c.oid, 'INSERT') then 'I' else '' end ||
      case when has_table_privilege('authenticated', c.oid, 'UPDATE') then 'U' else '' end ||
      case when has_table_privilege('authenticated', c.oid, 'DELETE') then 'D' else '' end || ']', ', ' order by c.relname) into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE');
  perform pg_temp.info('S24f-authenticated-table-level-write-inventory', coalesce(bad, 'none'));
exception when others then
  perform pg_temp.report('S24', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S25: column-level UPDATE grant exactness ═══════════
begin;
do $$
declare got text; want text; t text; cols text;
begin
  select string_agg(a.attname, ',' order by a.attname) into got
  from pg_attribute a where a.attrelid = 'public.profiles'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE');
  want := 'biggest_problem,first_name,focus_checkpoint,gender,handedness,onboarding_state,primary_goal,provider,skill_level';
  perform pg_temp.report('S25a-profiles-update-columns-exact', got = want, 'got=' || coalesce(got, '') || ' want=' || want);

  select string_agg(a.attname, ',' order by a.attname) into got
  from pg_attribute a where a.attrelid = 'public.sessions'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE');
  perform pg_temp.report('S25b-sessions-update-columns-exact', got = 'ended_at', 'got=' || coalesce(got, ''));

  select string_agg(a.attname, ',' order by a.attname) into got
  from pg_attribute a where a.attrelid = 'public.analysis_permits'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE');
  perform pg_temp.report('S25c-permits-update-columns-exact', got = 'outcome,status', 'got=' || coalesce(got, ''));

  select string_agg(a.attname, ',' order by a.attname) into got
  from pg_attribute a where a.attrelid = 'public.account_deletion_requests'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE');
  perform pg_temp.report('S25d-deletion-requests-update-columns-exact', got = 'challenge,created_at,expires_at,user_id', 'got=' || coalesce(got, ''));

  -- INFO: every other table's client-updatable column set
  select string_agg(x.rel || '{' || x.cols || '}', '; ' order by x.rel) into got from (
    select c.relname as rel, string_agg(a.attname, ',' order by a.attname) as cols
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname not in ('profiles', 'sessions', 'analysis_permits', 'account_deletion_requests')
      and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE')
    group by c.relname) x;
  perform pg_temp.info('S25e-other-tables-client-updatable-columns', coalesce(got, 'none'));
exception when others then
  perform pg_temp.report('S25', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S26: SECURITY DEFINER inventory ════════════════════
begin;
do $$
declare bad text; inv text;
begin
  -- every definer function pins search_path
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  perform pg_temp.report('S26a-definer-functions-pin-search_path', bad is null, coalesce('unpinned: ' || bad, 'all pinned'));

  -- every definer function is trigger-only, zero-arg, or not client-executable
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and p.prorettype <> 'trigger'::regtype and p.pronargs > 0
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'));
  perform pg_temp.report('S26b-parameterised-definer-not-client-executable', bad is null, coalesce('exposed: ' || bad, 'none'));

  select string_agg(p.oid::regprocedure::text || case when p.prosecdef then '[DEFINER]' else '[INVOKER]' end
      || case when exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') then '' else '[no search_path]' end,
      ', ' order by p.oid::regprocedure::text) into inv
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
  perform pg_temp.info('S26c-function-inventory', inv);
exception when others then
  perform pg_temp.report('S26', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S27–S28: view + ledger shape ═══════════════════════
begin;
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
    and not exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o where o = 'security_invoker=true');
  perform pg_temp.report('S27-all-views-security_invoker', bad is null, coalesce('not invoker: ' || bad, 'progress_daily, practice_days, player_technique_rating'));

  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_attribute a on a.attrelid = c.oid
  where c.relname in ('consent_records', 'evaluation_trials', 'analysis_feedback') and a.attname = 'user_id' and not a.attnotnull;
  perform pg_temp.report('S28-ledger-owner-columns-NOT-NULL', bad is null, coalesce('nullable user_id: ' || bad, 'all NOT NULL'));
exception when others then
  perform pg_temp.report('S27', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S29: user with NO auth.identities row ══════════════
begin;
do $$
declare v text; c int; n0 int; n1 int;
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
    ('00000000-0000-4000-8000-00000000000e', 'eve@example.com', '{}', '{"provider":"email"}');
  insert into public.analysis_permits (id, user_id, idempotency_key) values
    ('00000000-0000-4000-8000-0000000000e0', '00000000-0000-4000-8000-00000000000e', 'e0');
  n0 := (select count(*) from public.free_rating_ledger);
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000e');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000ee', '00000000-0000-4000-8000-0000000000e0', 'scored', null));
  c := public.lifetime_scored_count();
  perform pg_temp.as_admin();
  n1 := (select count(*) from public.free_rating_ledger);
  perform pg_temp.report('S29-no-identity-user-syncs-and-counts-own-shots', v = 'accepted' and c = 1 and n1 = n0,
    'rpc=' || v || ' lifetime=' || c || ' ledger_rows ' || n0 || '→' || n1);
exception when others then
  perform pg_temp.report('S29', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S30: ledger ratchet on result_kind UPDATE ══════════
begin;
do $$
declare l0 int; l1 int; l2 int;
begin
  l0 := (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'google-sub-alice'));
  update public.shots set result_kind = 'low_confidence' where id = '00000000-0000-4000-8000-0000000000e1';
  l1 := (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'google-sub-alice'));
  update public.shots set result_kind = 'scored' where id = '00000000-0000-4000-8000-0000000000e1';
  l2 := (select scored_count from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('google', 'google-sub-alice'));
  perform pg_temp.info('S30-ledger-ratchet-on-service-role-result_kind-flip',
    'ledger ' || l0 || ' → (scored→low_confidence) ' || l1 || ' → (back to scored) ' || l2 || '; true scored shots=1 (service-role-only path)');
exception when others then
  perform pg_temp.report('S30', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S31: idempotent replay ignores a changed payload ═══
begin;
do $$
declare v text; sc numeric;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  v := pg_temp.rpc(pg_temp.shot('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'scored', null)
                   || '{"overallScore":9.9}'::jsonb);
  sc := (select overall_score from public.shots where id = '00000000-0000-4000-8000-0000000000e1');
  perform pg_temp.report('S31-replay-accepted-original-kept', v = 'accepted' and sc = 7.1, 'rpc=' || v || ' score=' || sc);
exception when others then
  perform pg_temp.report('S31', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S32: shots.source CHECK binds client inserts ═══════
begin;
do $$
declare r text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000a');
  r := pg_temp.try($q$insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score,
      analysis_confidence, result_kind, source, app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values (gen_random_uuid(), '00000000-0000-4000-8000-00000000000a', 'dink', now(), 0, 1000, 5, 0.9,
      'scored', 'fixture', '1','1','1','1','1','1','1','1')$q$);
  perform pg_temp.report('S32-fixture-source-rejected', r like '23514%', r);
exception when others then
  perform pg_temp.report('S32', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S33: advisory lock reachable from authenticated SQL ═
begin;
do $$
declare r text;
begin
  perform pg_temp.as_user('00000000-0000-4000-8000-00000000000b');
  r := pg_temp.try($q$select pg_catalog.pg_advisory_xact_lock(public.access_lock_key('00000000-0000-4000-8000-00000000000a'))$q$);
  perform pg_temp.info('S33-authenticated-can-take-another-users-lock-in-raw-SQL',
    'result=' || r || ' (requires direct SQL; PostgREST exposes only schema public, not pg_catalog — see concurrency probe C3)');
exception when others then
  perform pg_temp.report('S33', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

-- ═══════════════════════ S34: anon live-query denial on views + RPCs ════════
begin;
do $$
declare r1 text; r2 text; r3 text; r4 text; r5 text;
begin
  perform pg_temp.as_anon();
  r1 := pg_temp.try('select * from public.progress_daily');
  r2 := pg_temp.try('select * from public.practice_days');
  r3 := pg_temp.try('select * from public.player_technique_rating');
  r4 := pg_temp.try('select public.lifetime_scored_count()');
  r5 := pg_temp.try('select public.identity_scored_count()');
  perform pg_temp.report('S34-anon-live-denied-views-and-count-helpers',
    r1 like '42501%' and r2 like '42501%' and r3 like '42501%' and r4 like '42501%' and r5 like '42501%',
    'progress_daily=' || r1 || ' practice_days=' || r2 || ' technique=' || r3 || ' lifetime=' || r4 || ' identity=' || r5);
exception when others then
  perform pg_temp.report('S34', false, 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm);
end $$;
rollback;

\echo PROBES COMPLETE
