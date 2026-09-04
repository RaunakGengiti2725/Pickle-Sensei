-- Adjudication probe: C3 (detail rows attached to another user's shot),
-- C4 (append-only trigger passthrough at pg_trigger_depth() > 1),
-- C5 (player_rank_tier(numeric) still executable through PUBLIC).
-- Runs inside one transaction and rolls back; prints RESULT|<id>|<verdict>|<detail> lines.
\set ON_ERROR_STOP on
\set QUIET on

-- helpers live outside the probe transactions so every section can use them
create or replace function pg_temp.try(q text) returns text language plpgsql as $$
begin
  execute q;
  return 'OK';
exception when others then
  return sqlstate;
end $$;

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

-- ───────── C3: detail rows on ANOTHER user's shot ─────────
-- Alice syncs one scored shot through the product path (shot + phases + checkpoints in one RPC).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';
insert into public.sessions (id, user_id, started_at) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000aa', now());
do $$
declare p uuid; v text;
begin
  select permit_id into p from public.reserve_analysis_permit('alice-k1');
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', p, 'scored', 7.0,
         '00000000-0000-4000-8000-0000000000d1'));
  if v <> 'accepted' then raise exception 'C3 setup: sync must be accepted (got %)', v; end if;
end $$;

set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000bb';
do $$
declare r text; r_pre text; r_cp text; r_ms text; r_cap text; r_sess text;
begin
  -- C3a: squatting BEFORE the victim's shot exists is impossible (FK on shots.id).
  r_pre := pg_temp.try($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-0000000000bb', 'contact', 0, 1, 2, 0.5)$q$);
  raise notice 'RESULT|C3a-squat-before-shot-exists|%|insert=% (FK blocks pre-squatting => product sync path cannot be pre-empted)',
    case when r_pre <> 'OK' then 'HELD' else 'BROKEN' end, r_pre;

  -- C3b: attach a NEW phase key to Alice's existing shot (user_id = bob satisfies WITH CHECK).
  r := pg_temp.try($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000bb', 'recover', 0, 1, 2, 0.5)$q$);
  raise notice 'RESULT|C3b-shot_phases-on-foreign-shot|%|insert=%', case when r = 'OK' then 'REPRODUCED' else 'NOT_REPRODUCED' end, r;
  r_cp := pg_temp.try($q$insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000bb', 'squatted', 1, 0.5, 'red', 'x', 0.5, true)$q$);
  r_ms := pg_temp.try($q$insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000bb', 'm', 1, 0.5, 'ms')$q$);
  r_cap := pg_temp.try($q$insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000bb',
      '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000e1', now(), 1, 1, 'imported_video', 'valid')$q$);
  r_sess := pg_temp.try($q$insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-0000000000d1',
      'dink', now(), 0, 1000, 5, 0.9, 'low_confidence', '1','1','1','1','1','1','1','1')$q$);
  raise notice 'RESULT|C3c-other-detail-tables-on-foreign-parent|%|checkpoints=% measurements=% captures(foreign session+shot)=% shots(foreign session_id)=%',
    case when r_cp = 'OK' and r_ms = 'OK' and r_cap = 'OK' and r_sess = 'OK' then 'REPRODUCED' else 'PARTIAL' end, r_cp, r_ms, r_cap, r_sess;

  -- C3d: existing (shot_id, phase_key) of the victim cannot be overwritten (unique + no UPDATE/DELETE reach).
  r := pg_temp.try($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000bb', 'contact', 0, 1, 2, 0.5)$q$);
  raise notice 'RESULT|C3d-victim-existing-phase-key|%|insert=% (23505 = unique violation, victim row intact)',
    case when r <> 'OK' then 'HELD' else 'BROKEN' end, r;
end $$;

-- C3e: what the VICTIM sees afterwards (RLS hides foreign rows from every owner-scoped read).
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';
select count(*) as alice_phases from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e1' \gset
select count(*) as alice_cps from public.shot_checkpoints where shot_id = '00000000-0000-4000-8000-0000000000e1' \gset
select count(*) as alice_caps from public.captures \gset
select count(*) as alice_session_shots from public.shots where session_id = '00000000-0000-4000-8000-0000000000d1' \gset
\echo RESULT|C3e-victim-view-unchanged|INFO|alice sees phases=:alice_phases checkpoints=:alice_cps captures=:alice_caps shots_in_session=:alice_session_shots (only her own rows)
reset role;
select count(*) as foreign_phase_rows from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e1' and user_id <> '00000000-0000-4000-8000-0000000000aa' \gset
select count(*) as foreign_shots_in_session from public.shots where session_id = '00000000-0000-4000-8000-0000000000d1' and user_id <> '00000000-0000-4000-8000-0000000000aa' \gset
\echo RESULT|C3f-foreign-rows-persisted-admin-view|INFO|foreign phase rows on alice shot=:foreign_phase_rows foreign shots in alice session=:foreign_shots_in_session
-- C3g: cascade coupling — deleting the victim's shot removes the squatter's rows too (data-model coupling, no victim impact).
delete from public.shots where id = '00000000-0000-4000-8000-0000000000e1';
select count(*) as leftover from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e1' \gset
\echo RESULT|C3g-victim-shot-delete-cascades-squatter|INFO|leftover foreign rows after victim shot delete=:leftover
rollback;

-- ───────── C4: reject_deletion_feedback_mutation passthrough at trigger depth > 1 ─────────
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000aa', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}');
insert into public.account_deletion_feedback (id, user_id, reason, details) values
  ('00000000-0000-4000-8000-0000000000fe', '00000000-0000-4000-8000-0000000000aa', 'other', 'original');
do $$
declare r text; d text;
begin
  -- direct (depth 1) mutations are rejected even for the table owner
  r := pg_temp.try($q$update public.account_deletion_feedback set details = 'edited' where id = '00000000-0000-4000-8000-0000000000fe'$q$);
  raise notice 'RESULT|C4a-depth1-update-rejected|%|update=%', case when r = '42501' then 'HELD' else 'BROKEN' end, r;
  r := pg_temp.try($q$delete from public.account_deletion_feedback where id = '00000000-0000-4000-8000-0000000000fe'$q$);
  raise notice 'RESULT|C4b-depth1-delete-rejected|%|delete=%', case when r = '42501' then 'HELD' else 'BROKEN' end, r;

  -- depth 2: any trigger-originated statement passes, not just the profiles FK SET NULL
  create temp table adj_nest (x int) on commit drop;
  create or replace function pg_temp.adj_nested() returns trigger language plpgsql as $f$
  begin
    update public.account_deletion_feedback set details = 'rewritten-from-nested-trigger', reason = 'tampered'
      where id = '00000000-0000-4000-8000-0000000000fe';
    return new;
  end $f$;
  create trigger adj_nest_t after insert on adj_nest for each row execute function pg_temp.adj_nested();
  r := pg_temp.try($q$insert into adj_nest values (1)$q$);
  select details into d from public.account_deletion_feedback where id = '00000000-0000-4000-8000-0000000000fe';
  raise notice 'RESULT|C4c-depth2-arbitrary-update-passes|%|nested insert=% details_now=%',
    case when r = 'OK' and d = 'rewritten-from-nested-trigger' then 'REPRODUCED' else 'NOT_REPRODUCED' end, r, d;
  create or replace function pg_temp.adj_nested_del() returns trigger language plpgsql as $f$
  begin
    delete from public.account_deletion_feedback where id = '00000000-0000-4000-8000-0000000000fe';
    return new;
  end $f$;
  drop trigger adj_nest_t on adj_nest;
  create trigger adj_nest_t after insert on adj_nest for each row execute function pg_temp.adj_nested_del();
  r := pg_temp.try($q$insert into adj_nest values (2)$q$);
  raise notice 'RESULT|C4d-depth2-delete-passes|%|nested insert=% rows_left=%',
    case when r = 'OK' and (select count(*) from public.account_deletion_feedback) = 0 then 'REPRODUCED' else 'NOT_REPRODUCED' end,
    r, (select count(*) from public.account_deletion_feedback);
end $$;
-- reachability: client roles hold no UPDATE/DELETE and cannot create triggers => owner/definer-code-only surface
\echo RESULT|C4e-client-reach|INFO|authenticated update/delete privilege on account_deletion_feedback:
select has_table_privilege('authenticated', 'public.account_deletion_feedback', 'UPDATE') as auth_upd,
       has_table_privilege('authenticated', 'public.account_deletion_feedback', 'DELETE') as auth_del,
       has_table_privilege('anon', 'public.account_deletion_feedback', 'UPDATE') as anon_upd,
       has_schema_privilege('authenticated', 'public', 'CREATE') as auth_can_create_in_public \gset
\echo RESULT|C4e-client-reach|INFO|auth_upd=:auth_upd auth_del=:auth_del anon_upd=:anon_upd auth_create_in_public=:auth_can_create_in_public
rollback;

-- ───────── C5: player_rank_tier(numeric) EXECUTE through PUBLIC ─────────
select has_function_privilege('anon', 'public.player_rank_tier(numeric)', 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', 'public.player_rank_tier(numeric)', 'EXECUTE') as auth_exec,
       (select array_to_string(proacl, ',') from pg_proc where oid = 'public.player_rank_tier(numeric)'::regprocedure) as acl \gset
\echo RESULT|C5a-player_rank_tier-execute|INFO|anon_exec=:anon_exec auth_exec=:auth_exec acl=:'acl'
begin;
set local role anon;
select pg_temp.try('select public.player_rank_tier(5.0)') as anon_call \gset
\echo RESULT|C5b-anon-calls-player_rank_tier|INFO|anon call=:anon_call (pure tier-label function, no data access)
rollback;
