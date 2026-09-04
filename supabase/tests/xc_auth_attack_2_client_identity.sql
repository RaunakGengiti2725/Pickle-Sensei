-- ============================================================================
-- xc-security-auth-attack-2 — DB-plane adversarial matrix: a MODIFIED MOBILE
-- CLIENT talking straight to PostgREST/RPC with its OWN Supabase session.
--
-- The edge function is not in this picture at all: hosted Supabase exposes
-- /rest/v1 directly, so the attacker's session token is the whole story and
-- auth.uid() is the only thing standing between accounts. Every case below
-- asks "can a caller make the database act for SOMEBODY ELSE" — through a
-- forged owner column, an RPC argument, a definer function, a foreign row
-- reference, or an identity-ledger read.
--
-- Companion to the edge harness (supabase/functions/api/__wf__/
-- xc-auth-attack-2-client-identity.test.ts): that one proves the API never
-- BUILDS a foreign-identity query; this one proves the database would refuse
-- it even if the API were removed from the path.
--
-- Run (repo root):  ./supabase/tests/run_xc_auth_attack_2.sh
-- New file: it adds cases, it does not modify security_regression.sql.
--
-- Attacker: Mallory (…00c). Victim: Alice (…00a). Both are provisioned by the
-- real handle_new_user() trigger, exactly as Supabase Auth would.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000c', 'mallory@example.com',
   '{"full_name":"Mallory"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice"}'),
  ('apple', 'apple-sub-mallory', '00000000-0000-4000-8000-00000000000c',
   '{"sub":"apple-sub-mallory"}');

-- ── Alice's real world: a session, a reserved permit, a scored shot ─────────
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-00000000000a', now());
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-00000000000a', 'alice-permit-1');
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e1',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a1',
    'sessionId', '00000000-0000-4000-8000-0000000000d1',
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-01T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 400, 'representativeMs', 500,
      'endMs', 600, 'confidence', 0.9))
  ));
  if v <> 'accepted' then
    raise exception 'SETUP: Alice''s own sync must succeed (got %)', v;
  end if;
end $$;

-- A second scored shot so Alice's lifetime count (2) differs from anything
-- Mallory can earn herself (1) — makes an identity-ledger leak unmistakable.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a3',
        '00000000-0000-4000-8000-00000000000a', 'alice-permit-3');
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e2',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a3',
    'sessionId', '00000000-0000-4000-8000-0000000000d1',
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-01T10:05:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 6.4, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'SETUP: Alice''s second sync must succeed (got %)', v;
  end if;
end $$;

-- A still-reserved permit for Alice: the prize Mallory will try to spend,
-- rename and finalize.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a2',
        '00000000-0000-4000-8000-00000000000a', 'alice-permit-2');

reset role;

-- ═══════════════════ MALLORY: every identity-forgery shape ══════════════════
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';

-- K1: the sync RPC takes its owner from auth.uid(), never from the payload.
-- Every identity-shaped key a modified client could invent is injected at
-- once — including inside the phase/checkpoint entries.
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000f1',
    'user_id', '00000000-0000-4000-8000-00000000000a',
    'userId', '00000000-0000-4000-8000-00000000000a',
    'uid', '00000000-0000-4000-8000-00000000000a',
    'sub', '00000000-0000-4000-8000-00000000000a',
    'canonicalAppUserId', '00000000-0000-4000-8000-00000000000a',
    'appUserId', '00000000-0000-4000-8000-00000000000a',
    'ownerId', '00000000-0000-4000-8000-00000000000a',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a2',
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-02T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 9.9, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'user_id', '00000000-0000-4000-8000-00000000000a',
      'startMs', 400, 'representativeMs', 500, 'endMs', 600, 'confidence', 0.9))
  ));
  -- Alice's permit is invisible under Mallory's RLS, so the call dies at the
  -- permit lookup — the forged owner keys never even get a chance.
  if v <> 'access.permit_not_found' then
    raise exception 'K1: forged owner keys must not let Mallory spend Alice''s permit (got %)', v;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000f1') then
    raise exception 'K1: no shot may be written by the refused call';
  end if;
end $$;

-- K2: the same forged keys with Mallory's OWN permit write a row owned by
-- Mallory — the payload's identity fields are inert, not authoritative.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-00000000000c', 'mallory-permit-1');
do $$
declare v text; v_owner uuid;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000f2',
    'user_id', '00000000-0000-4000-8000-00000000000a',
    'userId', '00000000-0000-4000-8000-00000000000a',
    'sub', '00000000-0000-4000-8000-00000000000a',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000c1',
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-02T11:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 9.9, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'K2: Mallory''s own sync must still work (got %)', v;
  end if;
  select user_id into v_owner from public.shots
   where id = '00000000-0000-4000-8000-0000000000f2';
  if v_owner <> '00000000-0000-4000-8000-00000000000c' then
    raise exception 'K2: shot owner must be auth.uid(), got %', v_owner;
  end if;
end $$;

-- K3: reserve_analysis_permit's only argument is an idempotency key; nothing
-- in it (uuid-shaped, injection-shaped, or otherwise) can move ownership.
do $$
declare r record;
begin
  for r in
    select * from public.reserve_analysis_permit(
      '00000000-0000-4000-8000-00000000000a'' , user_id => ''00000000-0000-4000-8000-00000000000a')
  loop
    if r.result <> 'accepted' then
      raise exception 'K3: reserve must accept the hostile key literally (got %)', r.result;
    end if;
    if not exists (
      select 1 from public.analysis_permits p
      where p.id = r.permit_id and p.user_id = '00000000-0000-4000-8000-00000000000c'
    ) then
      raise exception 'K3: reserved permit must belong to the caller';
    end if;
  end loop;
end $$;

-- K4: direct PostgREST-shaped writes claiming Alice as owner (RLS WITH CHECK).
do $$
declare
  t text;
  stmts text[] := array[
    'insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source) values (gen_random_uuid(), ''00000000-0000-4000-8000-00000000000a'', ''drive'', ''side'', now(), 0, 1000, 9.9, 0.9, ''scored'', ''1'', ''1'', ''1'', ''1'', ''1'', ''1'', ''1'', ''1'', ''real'')',
    'insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), ''00000000-0000-4000-8000-00000000000a'', now())',
    'insert into public.analysis_permits (id, user_id, idempotency_key) values (gen_random_uuid(), ''00000000-0000-4000-8000-00000000000a'', ''forged'')',
    'insert into public.evaluation_trials (id, user_id, payload) values (gen_random_uuid(), ''00000000-0000-4000-8000-00000000000a'', ''{}''::jsonb)',
    'insert into public.consent_records (user_id, scope, action) values (''00000000-0000-4000-8000-00000000000a'', ''model_training'', ''grant'')',
    'insert into public.analysis_feedback (user_id, analysis_id, rating) values (''00000000-0000-4000-8000-00000000000a'', ''00000000-0000-4000-8000-0000000000e1'', ''accurate'')',
    'insert into public.user_saved_drills (user_id, slug) values (''00000000-0000-4000-8000-00000000000a'', ''cross-court-dinks'')',
    'insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values (''00000000-0000-4000-8000-00000000000a'', gen_random_uuid(), now(), now() + interval ''15 minutes'')'
  ];
begin
  foreach t in array stmts loop
    begin
      execute t;
      raise exception 'K4: insert-as-Alice must be denied — statement succeeded: %', t;
    exception
      when insufficient_privilege or check_violation or foreign_key_violation then null;
    end;
  end loop;
end $$;

-- K5: taking over Alice's existing rows — by UPDATE (owner reassignment) or
-- DELETE — must be impossible: either revoked outright, or zero rows because
-- her rows are invisible.
do $$
begin
  begin
    update public.analysis_permits
       set user_id = '00000000-0000-4000-8000-00000000000c'
     where id = '00000000-0000-4000-8000-0000000000a2';
    if found then
      raise exception 'K5: permit owner reassignment must never affect a row';
    end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set status = 'finalized', outcome = 'scored'
     where id = '00000000-0000-4000-8000-0000000000a2';
    if found then
      raise exception 'K5: Mallory must not finalize Alice''s permit';
    end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.shots set user_id = '00000000-0000-4000-8000-00000000000c'
     where id = '00000000-0000-4000-8000-0000000000e1';
    raise exception 'K5: shots must have no client UPDATE grant at all';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.shots where id = '00000000-0000-4000-8000-0000000000e1';
    raise exception 'K5: shots must have no client DELETE grant at all';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles set id = '00000000-0000-4000-8000-00000000000a'
     where id = '00000000-0000-4000-8000-00000000000c';
    raise exception 'K5: a client must not rewrite its own profile id';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sessions set ended_at = now()
     where id = '00000000-0000-4000-8000-0000000000d1';
    if found then
      raise exception 'K5: Mallory must not finalize Alice''s session';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;

-- K6: writing evidence rows onto ALICE'S shot while owning them yourself.
-- Either the write is refused, or it is inert: Alice's own reads (which are
-- user_id-scoped, exactly like the edge function's) must not change.
do $$
declare v_before int; v_after int;
begin
  reset role;
  set local role authenticated;
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
  select count(*) into v_before from public.shot_phases
   where shot_id = '00000000-0000-4000-8000-0000000000e1';
  if v_before <> 1 then
    raise exception 'K6: precondition — Alice should see her one phase (got %)', v_before;
  end if;
  reset role;
  set local role authenticated;
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e1',
            '00000000-0000-4000-8000-00000000000c', 'poisoned', 0, 1, 2, 0.1);
  exception when insufficient_privilege or check_violation or foreign_key_violation then null;
  end;
  begin
    insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values ('00000000-0000-4000-8000-0000000000e1',
            '00000000-0000-4000-8000-00000000000c', 'poisoned', 0, 0.1, 'red', 'ok', 0.9, true);
  exception when insufficient_privilege or check_violation or foreign_key_violation then null;
  end;
  reset role;
  set local role authenticated;
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
  select count(*) into v_after from public.shot_phases
   where shot_id = '00000000-0000-4000-8000-0000000000e1';
  if v_after <> v_before then
    raise exception 'K6: Alice''s visible phase evidence changed (% → %)', v_before, v_after;
  end if;
  if exists (select 1 from public.shot_checkpoints
             where shot_id = '00000000-0000-4000-8000-0000000000e1'
               and checkpoint_key = 'poisoned') then
    raise exception 'K6: a foreign checkpoint became visible on Alice''s shot';
  end if;
  reset role;
  set local role authenticated;
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
end $$;

-- K7: the free-rating identity ledger is unreachable and unforgeable from a
-- client session — no read, no write, and no way to ask about ANOTHER
-- identity (the definer reader takes no arguments).
do $$
declare v_count int;
begin
  begin
    perform 1 from public.free_rating_ledger limit 1;
    raise exception 'K7: the identity ledger must not be readable by a client';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.free_rating_ledger (identity_hash, scored_count)
    values (repeat('a', 64), 0);
    raise exception 'K7: the identity ledger must not be writable by a client';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.free_rating_ledger set scored_count = 0;
    raise exception 'K7: the identity ledger must not be updatable by a client';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.free_rating_identity_hash('google', 'google-sub-alice');
    raise exception 'K7: the identity hash helper must not be callable by a client';
  exception when insufficient_privilege then null;
  end;
  -- The one reader a client may call is caller-scoped and parameterless.
  select public.identity_scored_count() into v_count;
  if v_count is null then
    raise exception 'K7: identity_scored_count() must answer for the caller';
  end if;
  -- Mallory scored exactly one shot herself (K2); Alice's ledger says 2.
  if v_count <> 1 then
    raise exception 'K7: identity_scored_count() must be the caller''s own 1, not Alice''s (got %)', v_count;
  end if;
  if public.lifetime_scored_count() <> 1 then
    raise exception 'K7: lifetime_scored_count() must be the caller''s own 1 (got %)', public.lifetime_scored_count();
  end if;
end $$;

-- K8: no client-executable function takes an identity as an argument. This is
-- the structural version of the whole role: if such a function existed, a
-- modified client could simply pass a victim id. Enumerated from the live
-- catalogue, so a future migration that adds one fails here.
do $$
declare
  r record;
  offenders text := '';
begin
  for r in
    select p.oid::regprocedure::text as sig,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef as definer
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('anon', p.oid, 'EXECUTE'))
  loop
    -- access_lock_key(uuid) is a pure hash of a value the CALLER already
    -- owns (it grants nothing); everything else must be identity-free.
    if r.sig in ('access_lock_key(uuid)', 'public.access_lock_key(uuid)') then
      continue;
    end if;
    if r.args ~* '(^|[ ,])[a-z_]*(user_id|uid|owner|account|subject|identity|sub)[a-z_]* +uuid'
       or r.args ~* 'uuid' and r.definer then
      offenders := offenders || r.sig || ' [' || r.args || ']; ';
    end if;
  end loop;
  if offenders <> '' then
    raise exception 'K8: client-executable function(s) accept a caller-supplied identity: %', offenders;
  end if;
end $$;

-- K9: privileged maintenance functions stay unreachable, with or without a
-- victim id in hand.
do $$
begin
  begin
    perform public.recompute_player_rank('00000000-0000-4000-8000-00000000000a');
    raise exception 'K9: recompute_player_rank must not be client-executable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- K10: the identity-free session helpers report the CALLER, never a target.
do $$
declare r record;
begin
  select * into r from public.access_state();
  if r.scored_count <> 1 then
    raise exception 'K10: access_state() must count Mallory''s own scored shots (got %)', r.scored_count;
  end if;
  if pg_catalog.pg_get_function_identity_arguments(
       'public.complete_onboarding()'::regprocedure) <> '' then
    raise exception 'K10: complete_onboarding() must take no arguments';
  end if;
  if pg_catalog.pg_get_function_identity_arguments(
       'public.access_state()'::regprocedure) <> '' then
    raise exception 'K10: access_state() must take no arguments';
  end if;
end $$;

-- K11: Alice's data stayed exactly as she left it after the whole campaign.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare r record;
begin
  if (select count(*) from public.shots) <> 2 then
    raise exception 'K11: Alice must still see exactly her two shots';
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a2'
                   and status = 'reserved' and outcome is null) then
    raise exception 'K11: Alice''s reserved permit must be untouched';
  end if;
  if exists (select 1 from public.sessions
             where id = '00000000-0000-4000-8000-0000000000d1'
               and ended_at is not null) then
    raise exception 'K11: Alice''s session must not have been finalized';
  end if;
  select * into r from public.access_state();
  if r.scored_count <> 2 then
    raise exception 'K11: Alice''s scored count must be 2 (got %)', r.scored_count;
  end if;
end $$;

-- K12: an anonymous caller (a client that simply omits the session token but
-- keeps the public anon key) reaches none of the identity surface.
reset role;
set local role anon;
set local request.jwt.claim.sub = '';
do $$
begin
  begin
    perform public.identity_scored_count();
    raise exception 'K12: anon must not call identity_scored_count()';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.lifetime_scored_count();
    raise exception 'K12: anon must not call lifetime_scored_count()';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reserve_analysis_permit('anon-key');
    raise exception 'K12: anon must not reserve permits';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.apply_synced_shot('{}'::jsonb);
    raise exception 'K12: anon must not call apply_synced_shot()';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.profiles limit 1;
    raise exception 'K12: anon must not read profiles';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
rollback;

\echo 'xc-auth-attack-2 DB matrix: K1-K12 held (no client-supplied identity is authoritative)'
