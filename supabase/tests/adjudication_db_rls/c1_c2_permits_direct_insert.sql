-- Adjudication probe: candidates C1 (permit reversal) and C2 (direct shots INSERT bypass)
-- Runs inside one transaction and rolls back; prints RESULT|<id>|<verdict>|<detail> lines.
\set ON_ERROR_STOP on
\set QUIET on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000aa', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000bb', 'bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'g-alice', '00000000-0000-4000-8000-0000000000aa', '{"sub":"g-alice"}'),
  ('apple',  'a-bob',   '00000000-0000-4000-8000-0000000000bb', '{"sub":"a-bob"}');

create or replace function pg_temp.shot_payload(p_id uuid, p_permit uuid, p_kind text, p_score numeric, p_session uuid default null)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'sessionId', p_session,
    'resultKind', p_kind, 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z', 'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', p_score, 'confidence', 0.9,
    'phases', jsonb_build_array(jsonb_build_object('key','contact','startMs',400,'representativeMs',500,'endMs',600,'confidence',0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object('key','contact_position','score',80,'confidence',0.9,'band','green','direction','ok','severity',0.1,'applicable',true)),
    'versionVector', jsonb_build_object(
      'appVersion','1.0.0','modelBundleVersion','b1','poseModelVersion','p1','paddleModelVersion','pd1',
      'strokeDetectorVersion','s1','phaseModelVersion','ph1','scoringModelVersion','sc1','shotConfigVersion','c1'))
$$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';

-- ───────── C1: analysis_permits status reversal by the owner ─────────
do $$
declare p uuid; v text; r record; n int; st text;
begin
  select permit_id into p from public.reserve_analysis_permit('alice-k1');
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', p, 'scored', 7.0));
  if v <> 'accepted' then raise exception 'C1 setup: first sync must be accepted (got %)', v; end if;
  select status into st from public.analysis_permits where id = p;
  raise notice 'RESULT|C1-setup|INFO|permit % after scored sync status=%', p, st;

  -- owner flips the finalized permit back to reserved (grant update(status,outcome) + owner RLS)
  update public.analysis_permits set status = 'reserved', outcome = null where id = p;
  get diagnostics n = row_count;
  select status into st from public.analysis_permits where id = p;
  raise notice 'RESULT|C1a-owner-reverts-finalized-permit|%|rows_updated=% status_now=%',
    case when n = 1 and st = 'reserved' then 'REPRODUCED' else 'NOT_REPRODUCED' end, n, st;

  -- over-count: reserved_count=1 though no live reservation; reserve refuses with 1 free rating left
  select * into r from public.access_state();
  raise notice 'RESULT|C1b-access_state-after-revert|INFO|scored_count=% reserved_count=% premium=%', r.scored_count, r.reserved_count, r.premium;
  select * into r from public.reserve_analysis_permit('alice-k2');
  raise notice 'RESULT|C1c-reserve-self-lockout|%|reserve(alice-k2)=% with scored_count=1',
    case when r.result = 'access.paywall_required' then 'REPRODUCED' else 'NOT_REPRODUCED' end, r.result;

  -- re-consume the SAME permit for a second scored shot (skips reserve's paywall check)
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', p, 'scored', 7.5));
  select count(*) into n from public.shots where result_kind = 'scored';
  raise notice 'RESULT|C1d-same-permit-consumed-twice|%|second sync on resurrected permit=% scored_shots=% lifetime=%',
    case when v = 'accepted' and n = 2 then 'REPRODUCED' else 'NOT_REPRODUCED' end, v, n, public.lifetime_scored_count();

  -- backstop: third scored shot via the same trick must still be refused
  update public.analysis_permits set status = 'reserved', outcome = null where id = p;
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e3', p, 'scored', 8.0));
  select count(*) into n from public.shots where result_kind = 'scored';
  raise notice 'RESULT|C1e-backstop-third-shot|%|third sync=% scored_shots=%',
    case when v = 'access.paywall_required' and n = 2 then 'HELD' else 'BROKEN' end, v, n;

  -- released → reserved as well
  select permit_id into p from public.reserve_analysis_permit('alice-k3');
  raise notice 'RESULT|C1f-reserve-after-limit|INFO|reserve(alice-k3)=% (expected paywall: lifetime=2)', (select result from public.reserve_analysis_permit('alice-k3'));
end $$;

-- ───────── C2: direct INSERT into public.shots at the free limit ─────────
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000bb';
do $$
declare p uuid; v text; r record; n int; i int; lc int; led int;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('bob-k' || i);
    v := public.apply_synced_shot(pg_temp.shot_payload(('00000000-0000-4000-8000-0000000000f' || i)::uuid, p, 'scored', 6.0));
    if v <> 'accepted' then raise exception 'C2 setup: sync % must be accepted (got %)', i, v; end if;
  end loop;
  select * into r from public.reserve_analysis_permit('bob-k3');
  raise notice 'RESULT|C2a-reserve-at-limit|%|reserve(bob-k3)=%', case when r.result = 'access.paywall_required' then 'HELD' else 'BROKEN' end, r.result;

  -- has table-level INSERT grant on shots?
  raise notice 'RESULT|C2b-authenticated-INSERT-grant-on-shots|INFO|has_table_privilege=%',
    has_table_privilege('authenticated', 'public.shots', 'INSERT');

  begin
    insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
    values ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000bb', 'drive', 'side', now(), 0, 500, 1000,
      9.0, 0.9, 'scored', '1.0.0', 'b1', 'p1', 'pd1', 's1', 'ph1', 'sc1', 'c1', 'real');
    v := 'INSERT_OK';
  exception when others then
    v := 'INSERT_FAILED:' || sqlstate;
  end;
  select count(*) into n from public.shots where result_kind = 'scored';
  lc := public.lifetime_scored_count();
  select * into r from public.access_state();
  raise notice 'RESULT|C2c-direct-insert-third-scored-shot-no-permit|%|insert=% scored_shots=% lifetime_scored_count=% access_state.scored_count=%',
    case when v = 'INSERT_OK' and n = 3 then 'REPRODUCED' else 'NOT_REPRODUCED' end, v, n, lc, r.scored_count;
end $$;
reset role;
select scored_count as bob_ledger from public.free_rating_ledger l
  join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = '00000000-0000-4000-8000-0000000000bb' \gset
\echo RESULT|C2d-ledger-after-direct-insert|INFO|free_rating_ledger.scored_count=:bob_ledger
select scored_shot_count as bob_rank_count, rating as bob_rating from public.player_rank_state where user_id = '00000000-0000-4000-8000-0000000000bb' \gset
\echo RESULT|C2e-rank-after-direct-insert|INFO|player_rank_state.scored_shot_count=:bob_rank_count rating=:bob_rating

rollback;
