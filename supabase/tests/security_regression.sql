-- ============================================================================
-- Pickle Sensei — Supabase security regression matrix.
--
-- Runs after every migration in supabase/migrations (see run_rls_tests.sh).
-- Each numbered case asserts one security boundary; any regression aborts the
-- whole script (ON_ERROR_STOP) with the failing case name. The shim installs
-- Supabase-like default privileges first, so every REVOKE the migrations rely
-- on is genuinely load-bearing here.
--
-- Matrix:
--   A. owner paths the app depends on keep working (profile patch, session
--      lifecycle, permit reserve, apply_synced_shot() sync, rank trigger,
--      access_state(), consent appends, complete_onboarding())
--   B. cross-user SELECT/UPDATE/DELETE/RPC are denied by RLS
--   C. anonymous access is denied outright (tables, views, RPCs)
--   D. consent/evaluation/feedback ledgers are append-only (grant AND trigger
--      layers, every role), while account-deletion cascades still pass — and
--      the exit survey (account_deletion_feedback) is anonymized, not removed
--   E. column-level grants: identity/score/bookkeeping columns are not
--      client-writable even in the owner's own rows
--   F. payload size caps reject oversized text/jsonb
--   G. privileged functions are not client-executable
--   H. the lifetime free-rating limit is unforgeable (atomic reserve, sync
--      backstop, and no client path that shrinks the scored-shot count)
--   I. account-deletion cascades, owner reads and the permit sweep are
--      index-backed
--   J. the free-rating limit follows the SIGN-IN IDENTITY across account
--      deletion (delete → sign in again → still no free ratings), with no
--      false positives for new identities and no client path to the ledger
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- Seed two users through the auth trigger path (exactly how Supabase creates
-- them in production: insert into auth.users fires handle_new_user()), each
-- with the provider identity signInWithIdToken records alongside the user.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice","email":"alice@example.com"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-00000000000b',
   '{"sub":"apple-sub-bob","email":"bob@example.com"}');

do $$
begin
  if (select count(*) from public.profiles) <> 2 then
    raise exception 'SETUP: handle_new_user trigger did not provision profiles';
  end if;
end $$;

-- ──────────────────── A: owner paths the app depends on ────────────────────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

-- A1: owner sees exactly their own profile
do $$
begin
  if (select count(*) from public.profiles) <> 1
     or not exists (select 1 from public.profiles where email = 'alice@example.com') then
    raise exception 'A1: owner must see exactly their own profile';
  end if;
end $$;

-- A2: the onboarding patch columns are writable (PUT /v1/me/onboarding)
update public.profiles
   set first_name = 'Alice', skill_level = '3.5', handedness = 'right',
       primary_goal = 'consistency', biggest_problem = 'nets',
       focus_checkpoint = 'contact_position'
 where id = '00000000-0000-4000-8000-00000000000a';
do $$
begin
  if not exists (select 1 from public.profiles where first_name = 'Alice') then
    raise exception 'A2: allowed onboarding columns must be client-writable';
  end if;
end $$;

-- A3: complete_onboarding() works for the owner
do $$ begin perform public.complete_onboarding(); end $$;
do $$
begin
  if not exists (select 1 from public.profiles where onboarding_state = 'complete') then
    raise exception 'A3: complete_onboarding must flip the owner state';
  end if;
end $$;

-- A4: session create (insert-or-ignore) + finalize (ended_at only)
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-00000000000a', now())
on conflict (id) do nothing;
update public.sessions set ended_at = now()
  where id = '00000000-0000-4000-8000-0000000000d1';
do $$
begin
  if not exists (select 1 from public.sessions
                 where id = '00000000-0000-4000-8000-0000000000d1'
                   and ended_at is not null) then
    raise exception 'A4: owner session create+finalize must work';
  end if;
end $$;

-- A5: permit reserve, then the full apply_synced_shot() sync path — shot +
-- phases + checkpoints + permit consumption in one atomic invoker call.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-00000000000a', 'permit-1');
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e1',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a1',
    'sessionId', '00000000-0000-4000-8000-0000000000d1',
    'resultKind', 'scored',
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
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
      'applicable', true))
  ));
  if v <> 'accepted' then
    raise exception 'A5: apply_synced_shot must accept the owner sync (got %)', v;
  end if;
  if not exists (select 1 from public.shot_phases
                 where shot_id = '00000000-0000-4000-8000-0000000000e1') then
    raise exception 'A5: sync must write phase evidence';
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a1'
                   and status = 'finalized' and outcome = 'scored') then
    raise exception 'A5: sync must finalize the permit';
  end if;
end $$;

-- A6: the shots trigger recomputed the saved rank (7.1 → platinum)
do $$
begin
  if not exists (select 1 from public.player_rank_state
                 where user_id = '00000000-0000-4000-8000-00000000000a'
                   and tier = 'platinum') then
    raise exception 'A6: rank trigger must have saved a platinum rating';
  end if;
end $$;

-- A7: access_state() sees the verified world in one call
do $$
declare rec record;
begin
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 0 then
    raise exception 'A7: access_state must report premium=false, 1 scored, 0 reserved (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
end $$;

-- A8: consent ledger appends (grant + withdraw) and evidence ledgers accept
insert into public.consent_records (user_id, scope, action, consent_version, source)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant', 'v1', 'mobile_settings');
insert into public.consent_records (user_id, scope, action, consent_version, source)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'withdraw', 'v1', 'mobile_settings');
insert into public.evaluation_trials (id, user_id, payload)
values ('00000000-0000-4000-8000-0000000000f0',
        '00000000-0000-4000-8000-00000000000a', '{"kind":"trial"}');
insert into public.analysis_feedback (user_id, analysis_id, rating)
values ('00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000e1', 'accurate');

-- A9: the exit survey (POST /v1/me/delete-request body.survey) is a plain
-- owner INSERT — with context columns — and is write-only from a client
-- session: there is no SELECT grant, so even the owner cannot read it back.
insert into public.account_deletion_feedback
  (user_id, reason, wanted, details, provider, platform, app_version,
   account_age_days, was_premium, scored_count)
values ('00000000-0000-4000-8000-00000000000a', 'too_expensive', 'price',
        'Steep for a rec player.', 'google', 'ios', '1.0', 12, false, 1);
do $$
begin
  begin
    perform 1 from public.account_deletion_feedback limit 1;
    raise exception 'A9: exit survey must not be client-readable, even by its owner';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A10: seed the remaining user-owned relations so B1 can prove EVERY one of
-- them is invisible to a second user (not just the subset the sync path
-- happens to write). Owner inserts for the client-writable tables; billing
-- is service-written, so it is seeded with the table owner's privileges.
insert into public.shot_measurements
  (shot_id, user_id, metric_key, value, confidence, unit)
values ('00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-00000000000a', 'contact_height', 0.42, 0.9,
        'normalized');
insert into public.captures
  (id, user_id, session_id, shot_id, captured_at, duration_ms, fps,
   capture_mode, evidence_status)
values ('00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-0000000000e1',
        '2026-08-31T10:00:00Z', 1200, 30, 'automatic_pose_trigger', 'valid');
insert into public.user_saved_drills (user_id, slug)
values ('00000000-0000-4000-8000-00000000000a', 'dink-wall-reps');
insert into public.account_deletion_requests (user_id)
values ('00000000-0000-4000-8000-00000000000a');
reset role;
insert into public.billing_entitlements (user_id, premium)
values ('00000000-0000-4000-8000-00000000000a', false);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

-- A11: precondition for B1 — the owner sees at least one row on every
-- user-owned relation (tables AND the security_invoker views), so the
-- zero-row assertions below are proving isolation, not emptiness.
do $$
declare t text; n int;
begin
  foreach t in array array[
    'sessions','shots','shot_phases','shot_measurements','shot_checkpoints',
    'captures','analysis_permits','consent_records','evaluation_trials',
    'analysis_feedback','user_saved_drills','player_rank_state',
    'billing_entitlements','account_deletion_requests',
    'progress_daily','practice_days','player_technique_rating'
  ] loop
    execute format('select count(*) from public.%I', t) into n;
    if n < 1 then
      raise exception 'A11: owner must see their own rows in public.% (got 0)', t;
    end if;
  end loop;
end $$;

-- ──────────────────────── B: cross-user is denied ──────────────────────────

-- B1: Bob sees ZERO of Alice's rows on every user-owned relation — every
-- RLS table and every security_invoker view (a definer view would run as
-- the table owner and leak the whole aggregate).
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare t text; n int;
begin
  foreach t in array array[
    'sessions','shots','shot_phases','shot_measurements','shot_checkpoints',
    'captures','analysis_permits','consent_records','evaluation_trials',
    'analysis_feedback','user_saved_drills','player_rank_state',
    'billing_entitlements','account_deletion_requests',
    'progress_daily','practice_days','player_technique_rating'
  ] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'B1: cross-user rows must be invisible in public.% (got %)', t, n;
    end if;
  end loop;
  if (select count(*) from public.profiles) <> 1
     or exists (select 1 from public.profiles
                where id = '00000000-0000-4000-8000-00000000000a') then
    raise exception 'B1: cross-user profile must be invisible';
  end if;
end $$;

-- B2: Bob's UPDATE against Alice's session must hit zero rows
update public.sessions set ended_at = null
  where id = '00000000-0000-4000-8000-0000000000d1';
do $$
begin
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
  if not exists (select 1 from public.sessions
                 where id = '00000000-0000-4000-8000-0000000000d1'
                   and ended_at is not null) then
    raise exception 'B2: cross-user UPDATE must not modify rows';
  end if;
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
end $$;

-- B3: Bob's DELETE against Alice's session must hit zero rows
delete from public.sessions where id = '00000000-0000-4000-8000-0000000000d1';
do $$
begin
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
  if not exists (select 1 from public.sessions
                 where id = '00000000-0000-4000-8000-0000000000d1') then
    raise exception 'B3: cross-user DELETE must not remove rows';
  end if;
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
end $$;

-- B4: Bob cannot insert rows owned by Alice (WITH CHECK)
do $$
begin
  begin
    insert into public.consent_records (user_id, scope, action)
    values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant');
    raise exception 'B4: insert-as-other-user must be denied';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    insert into public.account_deletion_feedback (user_id, reason)
    values ('00000000-0000-4000-8000-00000000000a', 'other');
    raise exception 'B4: exit survey insert-as-other-user must be denied';
  exception when insufficient_privilege or check_violation then null;
  end;
  -- Nor an anonymous row: only the FK's SET NULL may ever produce one.
  begin
    insert into public.account_deletion_feedback (user_id, reason)
    values (null, 'other');
    raise exception 'B4: exit survey insert with null owner must be denied';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- B4b: even an owner cannot read or mutate the server-only external credential
-- row. The service role is the only path to Apple ciphertext/checkpoints.
do $$
begin
  begin
    perform 1 from public.account_external_credentials limit 1;
    raise exception 'B4b: authenticated must not read external credentials';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.account_external_credentials (user_id)
    values ('00000000-0000-4000-8000-00000000000b');
    raise exception 'B4b: authenticated must not write external credentials';
  exception when insufficient_privilege then null;
  end;
end $$;

-- B5: Bob cannot spend Alice's permit through the sync RPC
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e9',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a1',
    'resultKind', 'scored', 'shotType', 'drive',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'overallScore', 5.0, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'access.permit_not_found' then
    raise exception 'B5: foreign permit must be invisible to the RPC (got %)', v;
  end if;
end $$;

reset role;

-- ───────────────────────── C: anonymous is denied ──────────────────────────

set local role anon;
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','sessions','shots','shot_phases','shot_measurements',
    'shot_checkpoints','captures','analysis_permits','consent_records',
    'evaluation_trials','analysis_feedback','user_saved_drills',
    'player_rank_state','progress_daily','practice_days',
    'player_technique_rating','billing_entitlements',
    'account_deletion_requests','account_deletion_feedback','webhook_events',
    'account_external_credentials','free_rating_ledger'
  ] loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'C: anon must not read public.%', t;
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- RPC surface: anon may not execute the app's data functions.
  begin
    perform public.access_state();
    raise exception 'C: anon must not execute access_state';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.apply_synced_shot('{}'::jsonb);
    raise exception 'C: anon must not execute apply_synced_shot';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.complete_onboarding();
    raise exception 'C: anon must not execute complete_onboarding';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ───────────────────────── D: append-only ledgers ──────────────────────────

-- D1: owners cannot UPDATE their own ledger history (grant layer)
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare t text;
begin
  foreach t in array array[
    'consent_records', 'evaluation_trials', 'analysis_feedback',
    'account_deletion_feedback'
  ] loop
    begin
      execute format('update public.%I set user_id = user_id', t);
      raise exception 'D1: % UPDATE must be denied', t;
    exception when insufficient_privilege then null;
    end;
    begin
      execute format('delete from public.%I', t);
      raise exception 'D1: % DELETE must be denied', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;

-- D2: even a table-owner session (compromised backend / accidental grant)
-- cannot rewrite ledger history — the trigger fires for every role.
do $$
begin
  begin
    update public.consent_records set action = 'grant' where action = 'withdraw';
    raise exception 'D2a: consent UPDATE must be trigger-blocked for all roles';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.evaluation_trials set payload = '{}'::jsonb;
    raise exception 'D2b: trial UPDATE must be trigger-blocked for all roles';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.analysis_feedback;
    raise exception 'D2c: feedback DELETE must be trigger-blocked for all roles';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.account_deletion_feedback set reason = 'other';
    raise exception 'D2d: exit survey UPDATE must be trigger-blocked for all roles';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.account_deletion_feedback;
    raise exception 'D2e: exit survey DELETE must be trigger-blocked for all roles';
  exception when insufficient_privilege then null;
  end;
end $$;

-- D3: account-deletion cascade still removes ledger rows (GDPR path)
do $$
declare remaining int;
begin
  delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';
  select count(*) into remaining from public.consent_records
    where user_id = '00000000-0000-4000-8000-00000000000a';
  if remaining <> 0 then
    raise exception 'D3: account deletion must cascade through the ledgers';
  end if;
end $$;

-- D4: the exit survey is the ONE row that outlives the account — anonymized
-- (FK ON DELETE SET NULL passes the append-only trigger because it runs at
-- trigger depth > 1), never deleted, answer and context intact.
do $$
begin
  if exists (select 1 from public.account_deletion_feedback
             where user_id = '00000000-0000-4000-8000-00000000000a') then
    raise exception 'D4: deletion must anonymize the exit survey (user_id → null)';
  end if;
  if not exists (select 1 from public.account_deletion_feedback
                 where user_id is null
                   and reason = 'too_expensive' and wanted = 'price'
                   and details = 'Steep for a rec player.'
                   and provider = 'google' and account_age_days = 12) then
    raise exception 'D4: the anonymized exit survey must survive account deletion';
  end if;
end $$;

-- Re-provision Alice for the remaining cases.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
        '{"full_name":"Alice"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
        '{"sub":"google-sub-alice","email":"alice@example.com"}');

-- ───────────────────────── E: column-level grants ──────────────────────────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d2',
        '00000000-0000-4000-8000-00000000000a', now());
insert into public.shots (
  id, user_id, session_id, shot_type, captured_at, start_ms, end_ms,
  overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version,
  scoring_model_version, shot_config_version
) values (
  '00000000-0000-4000-8000-0000000000e2',
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-0000000000d2',
  'drive', now(), 0, 1000,
  5.5, 0.9, 'scored',
  '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
  'scoring-1', 'config-1'
);

-- E1: synced shots are fully immutable from a client session
do $$
declare col text;
begin
  foreach col in array array[
    'favorite = true', 'overall_score = 9.9',
    'user_id = ''00000000-0000-4000-8000-00000000000b''',
    'scoring_model_version = ''forged'''
  ] loop
    begin
      execute format(
        'update public.shots set %s where id = ''00000000-0000-4000-8000-0000000000e2''',
        col);
      raise exception 'E1: shots.% must not be client-writable', col;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

-- E2: profiles identity/bookkeeping columns are locked (email is
-- trigger-synced; display fields are signup-provisioned)
do $$
declare col text;
begin
  foreach col in array array[
    'email = ''spoof@example.com''', 'display_name = ''Spoof''',
    'created_at = now()'
  ] loop
    begin
      execute format(
        'update public.profiles set %s where id = ''00000000-0000-4000-8000-00000000000a''',
        col);
      raise exception 'E2: profiles.% must not be client-writable', col;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

-- E3: shot detail evidence is write-once (no UPDATE/DELETE grant)
insert into public.shot_phases
  (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
values ('00000000-0000-4000-8000-0000000000e2',
        '00000000-0000-4000-8000-00000000000a', 'prepare', 0, 100, 200, 0.9);
do $$
begin
  begin
    update public.shot_phases set confidence = 1
      where shot_id = '00000000-0000-4000-8000-0000000000e2';
    raise exception 'E3a: shot_phases must not be client-updatable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.shot_phases
      where shot_id = '00000000-0000-4000-8000-0000000000e2';
    raise exception 'E3b: shot_phases must not be client-deletable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E4: rank state is trigger-maintained; clients cannot write it
do $$
begin
  begin
    update public.player_rank_state set rating = 10
      where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'E4: player_rank_state must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E5: sessions — only the finalize stamp is client-writable
do $$
declare col text;
begin
  foreach col in array array[
    'notes = ''x''', 'event_count = 99', 'kind = ''game''',
    'started_at = now()',
    'user_id = ''00000000-0000-4000-8000-00000000000b'''
  ] loop
    begin
      execute format(
        'update public.sessions set %s where id = ''00000000-0000-4000-8000-0000000000d2''',
        col);
      raise exception 'E5: sessions.% must not be client-writable', col;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

-- E6: permits — lifecycle columns only; the idempotency identity is fixed
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a2',
        '00000000-0000-4000-8000-00000000000a', 'permit-2');
update public.analysis_permits set status = 'finalized', outcome = 'scored'
  where id = '00000000-0000-4000-8000-0000000000a2';
do $$
begin
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a2'
                   and status = 'finalized') then
    raise exception 'E6a: permit finalize (status/outcome) must stay client-writable';
  end if;
  begin
    update public.analysis_permits set idempotency_key = 'forged'
      where id = '00000000-0000-4000-8000-0000000000a2';
    raise exception 'E6b: permit idempotency_key must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E7: deletion challenges re-arm through the PostgREST upsert shape (DO
-- UPDATE sets every payload column, user_id included) but can never change
-- owners — RLS WITH CHECK pins user_id to the caller.
insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
values ('00000000-0000-4000-8000-00000000000a', gen_random_uuid(), now(),
        now() + interval '15 minutes')
on conflict (user_id) do update
  set user_id = excluded.user_id, challenge = excluded.challenge,
      created_at = excluded.created_at, expires_at = excluded.expires_at;
insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
values ('00000000-0000-4000-8000-00000000000a', gen_random_uuid(), now(),
        now() + interval '15 minutes')
on conflict (user_id) do update
  set user_id = excluded.user_id, challenge = excluded.challenge,
      created_at = excluded.created_at, expires_at = excluded.expires_at;
do $$
begin
  begin
    update public.account_deletion_requests
       set user_id = '00000000-0000-4000-8000-00000000000b'
     where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'E7: deletion-request owner reassignment must be denied';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E8: billing state is service-verified; clients can neither mint nor edit it
do $$
begin
  begin
    insert into public.billing_entitlements (user_id, premium)
    values ('00000000-0000-4000-8000-00000000000a', true);
    raise exception 'E8a: billing_entitlements INSERT must be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.billing_entitlements set premium = true
      where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'E8b: billing_entitlements UPDATE must be denied';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E9: the webhook audit log is invisible and unwritable to clients
do $$
begin
  begin
    perform 1 from public.webhook_events limit 1;
    raise exception 'E9a: webhook_events must not be client-readable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.webhook_events (id, payload) values ('evt', '{}'::jsonb);
    raise exception 'E9b: webhook_events must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ───────────────────────── F: payload size caps ────────────────────────────

-- F1: oversized onboarding text rejected on a client-writable column
do $$
begin
  begin
    update public.profiles set biggest_problem = repeat('x', 600)
      where id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'F1: oversized biggest_problem must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- F2: oversized consent source rejected at insert
do $$
begin
  begin
    insert into public.consent_records (user_id, scope, action, source)
    values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant',
            repeat('x', 200));
    raise exception 'F2: oversized consent source must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- F3: oversized evaluation payload rejected (256 KiB cap from 20260831000000)
do $$
begin
  begin
    insert into public.evaluation_trials (id, user_id, payload)
    values ('00000000-0000-4000-8000-0000000000f1',
            '00000000-0000-4000-8000-00000000000a',
            jsonb_build_object('blob', repeat('x', 300000)));
    raise exception 'F3: oversized trial payload must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- F4: hostile saved-drill slug rejected
do $$
begin
  begin
    insert into public.user_saved_drills (user_id, slug)
    values ('00000000-0000-4000-8000-00000000000a', '../../../etc/passwd');
    raise exception 'F4: hostile slug must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- F4b: oversized exit-survey comment rejected (API caps at 500; DB at 1000)
do $$
begin
  begin
    insert into public.account_deletion_feedback (user_id, reason, details)
    values ('00000000-0000-4000-8000-00000000000a', 'other', repeat('x', 1500));
    raise exception 'F4b: oversized exit-survey details must be rejected';
  exception when check_violation then null;
  end;
end $$;

reset role;

-- F5: the caps bind every role, not just clients (oversized guidance as owner)
do $$
begin
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind, guidance,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000e3',
      '00000000-0000-4000-8000-00000000000a',
      'drive', now(), 0, 1000, 5.0, 0.9, 'scored', repeat('x', 3000),
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'F5: oversized guidance must be rejected for every role';
  exception when check_violation then null;
  end;
end $$;

-- ───────────────────────── G: privileged functions ─────────────────────────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
begin
  begin
    perform public.recompute_player_rank('00000000-0000-4000-8000-00000000000b');
    raise exception 'G1: recompute_player_rank must not be client-executable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reject_ledger_mutation();
    raise exception 'G2: reject_ledger_mutation must not be client-executable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reject_deletion_feedback_mutation();
    raise exception 'G2b: reject_deletion_feedback_mutation must not be client-executable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.handle_new_user();
    raise exception 'G3: handle_new_user must not be client-executable';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ──────────────── H: lifetime free-rating limit is unforgeable ─────────────
--
-- The product promises exactly two lifetime free ratings. Before migration
-- 20260901000000 the Edge Function decided this with an unserialized
-- read-then-insert, so concurrent reserves carrying DIFFERENT idempotency keys
-- could each observe availableToReserve >= 1 and both insert.
--
-- A single psql session cannot exercise true concurrency, so these cases pin
-- the two properties that make the invariant hold regardless of interleaving:
-- reserve_analysis_permit() refuses to over-issue, and apply_synced_shot()
-- refuses to record a third scored shot EVEN when handed a valid reserved
-- permit — which is precisely the state a lost race would leave behind.

reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000c', 'carol@example.com',
        '{"full_name":"Carol"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-carol', '00000000-0000-4000-8000-00000000000c',
        '{"sub":"google-sub-carol","email":"carol@example.com"}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';

-- H1: distinct idempotency keys may reserve up to the limit, then must be
-- refused. A fresh account has remaining=2, reserved=0.
do $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit('carol-key-1');
  if r.result <> 'accepted' then
    raise exception 'H1: first free reserve must succeed (got %)', r.result;
  end if;
  select * into r from public.reserve_analysis_permit('carol-key-2');
  if r.result <> 'accepted' then
    raise exception 'H1: second free reserve must succeed (got %)', r.result;
  end if;
  select * into r from public.reserve_analysis_permit('carol-key-3');
  if r.result <> 'access.paywall_required' then
    raise exception
      'H1: a THIRD distinct key must be refused, not silently over-issued (got %)', r.result;
  end if;
  if (select count(*) from public.analysis_permits
      where user_id = '00000000-0000-4000-8000-00000000000c') <> 2 then
    raise exception 'H1: exactly two permits may exist for a free account';
  end if;
end $$;

-- H2: replaying a key returns the SAME permit and consumes no extra allowance
-- (idempotent by contract — the client retries reserves on flaky networks).
do $$
declare r record; v_first uuid;
begin
  select permit_id into v_first from public.reserve_analysis_permit('carol-key-1');
  select * into r from public.reserve_analysis_permit('carol-key-1');
  if r.result <> 'accepted' or r.permit_id <> v_first then
    raise exception 'H2: replay must return the same permit (got % / %)', r.result, r.permit_id;
  end if;
  if (select count(*) from public.analysis_permits
      where user_id = '00000000-0000-4000-8000-00000000000c') <> 2 then
    raise exception 'H2: replay must not create a permit';
  end if;
end $$;

-- H3: THE BACKSTOP. Consume both free ratings, then hand apply_synced_shot a
-- valid, reserved, unexpired permit — the exact artifact a lost reserve race
-- produces — and require it to refuse the third scored shot and release the
-- permit rather than record a third free rating.
do $$
declare v text; p uuid; i int;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('carol-key-' || i);
    v := public.apply_synced_shot(jsonb_build_object(
      'id', ('00000000-0000-4000-8000-0000000000c' || i)::uuid,
      'analysisPermitId', p,
      'resultKind', 'scored',
      'shotType', 'drive', 'cameraView', 'side',
      'capturedAt', '2026-08-31T10:00:00Z',
      'startMs', 0, 'contactMs', 500, 'endMs', 1000,
      'overallScore', 7.1, 'confidence', 0.9,
      'versionVector', jsonb_build_object(
        'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
        'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
        'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
        'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
    ));
    if v <> 'accepted' then
      raise exception 'H3: free rating % must be accepted (got %)', i, v;
    end if;
  end loop;

  -- Simulate the over-issued permit a lost race would leave behind.
  insert into public.analysis_permits (id, user_id, idempotency_key)
  values ('00000000-0000-4000-8000-0000000000af',
          '00000000-0000-4000-8000-00000000000c', 'carol-raced-key');

  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000c9',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000af',
    'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'access.paywall_required' then
    raise exception
      'H3: a third scored shot must be refused even with a valid permit (got %)', v;
  end if;
  if (select count(*) from public.shots
      where user_id = '00000000-0000-4000-8000-00000000000c'
        and result_kind = 'scored') <> 2 then
    raise exception 'H3: a free account must never exceed two scored shots';
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000af'
                   and status = 'released' and outcome = 'free_limit_exceeded') then
    raise exception 'H3: the refused permit must be released, not left reserved';
  end if;
end $$;

-- H4: an abstention still costs nothing — the backstop must not turn
-- low_confidence into a paywall (unscored attempts are free, by contract).
do $$
declare v text;
begin
  insert into public.analysis_permits (id, user_id, idempotency_key)
  values ('00000000-0000-4000-8000-0000000000ae',
          '00000000-0000-4000-8000-00000000000c', 'carol-abstain-key');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000ca',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000ae',
    'resultKind', 'low_confidence',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', null, 'confidence', 0.2,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'H4: an abstention must sync even at the free limit (got %)', v;
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000ae'
                   and status = 'released' and outcome = 'low_confidence') then
    raise exception 'H4: an abstention must RELEASE its permit, never consume it';
  end if;
end $$;

-- H5: cross-user — reserve runs under the caller's RLS, so it can only ever
-- see and create the CALLER's permits, never another account's.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit('carol-key-1');
  if r.result <> 'accepted' then
    raise exception 'H5: bob must get his own fresh permit (got %)', r.result;
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = r.permit_id
                   and user_id = '00000000-0000-4000-8000-00000000000b') then
    raise exception
      'H5: a colliding idempotency key must never return another user''s permit';
  end if;
end $$;

-- H6: anonymous callers cannot reserve at all.
set local role anon;
do $$
begin
  begin
    perform public.reserve_analysis_permit('anon-key');
    raise exception 'H6: anon must not execute reserve_analysis_permit';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- H7: the counter cannot be reset from a client session. Carol sits at the
-- limit (two scored shots from H3); deleting her own shots must be denied at
-- the grant layer, leave the count untouched, and keep the paywall closed.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare r record;
begin
  if exists (select 1 from information_schema.role_table_grants
             where grantee = 'authenticated' and table_schema = 'public'
               and table_name = 'shots' and privilege_type = 'DELETE') then
    raise exception 'H7: authenticated must hold no DELETE grant on shots';
  end if;
  if exists (select 1 from pg_policies
             where schemaname = 'public' and tablename = 'shots'
               and cmd = 'DELETE') then
    raise exception 'H7: shots must carry no client DELETE policy';
  end if;
  begin
    delete from public.shots where user_id = (select auth.uid());
    raise exception 'H7: owner DELETE on shots must be denied';
  exception when insufficient_privilege then null;
  end;
  select * into r from public.access_state();
  if r.scored_count <> 2 then
    raise exception 'H7: scored_count must still be 2 after the attempt (got %)', r.scored_count;
  end if;
  select * into r from public.reserve_analysis_permit('carol-key-after-delete');
  if r.result <> 'access.paywall_required' then
    raise exception 'H7: the paywall must stay closed after a delete attempt (got %)', r.result;
  end if;
end $$;
reset role;

-- ──────── I: account-deletion cascades and owner reads are index-backed ────
--
-- Every profiles-cascade child is looked up by user_id both when
-- auth.admin.deleteUser fires the FK cascade and when RLS scopes an owner
-- read. With enable_seqscan off the planner only falls back to a sequential
-- scan when NO usable index exists, and only walks a non-leading index when
-- no leading one exists — so the plan text is a deterministic witness even on
-- the tiny fixture this matrix builds.

-- I1: the expected indexes exist
do $$
declare idx text;
begin
  foreach idx in array array[
    'shot_phases_user_idx', 'shot_measurements_user_idx',
    'analysis_feedback_user_created_idx',
    'analysis_permits_reserved_created_idx'
  ] loop
    if not exists (select 1 from pg_indexes
                   where schemaname = 'public' and indexname = idx) then
      raise exception 'I1: index % must exist', idx;
    end if;
  end loop;
end $$;

-- I2: owner-scoped reads of the cascade children (the same user_id lookup the
-- FK cascade performs) go through the user_id-leading index — not a Seq Scan,
-- and not a full walk of a shot_id-/analysis_id-leading index
set local enable_seqscan = off;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare pair text[]; plan jsonb;
begin
  foreach pair slice 1 in array array[
    ['shot_phases', 'shot_phases_user_idx'],
    ['shot_measurements', 'shot_measurements_user_idx'],
    ['analysis_feedback', 'analysis_feedback_user_created_idx']
  ] loop
    execute format(
      'explain (format json) select 1 from public.%I where user_id = (select auth.uid())',
      pair[1]) into plan;
    if plan::text like '%Seq Scan%' or plan::text not like '%' || pair[2] || '%' then
      raise exception 'I2: owner read of % must use %, got %', pair[1], pair[2], plan;
    end if;
  end loop;
end $$;
reset role;

-- I3: the hourly pg_cron stale-permit sweep predicate is index-backed
do $$
declare plan jsonb;
begin
  execute 'explain (format json) update public.analysis_permits '
       || 'set status = ''released'', outcome = ''expired'' '
       || 'where status = ''reserved'' and created_at < now() - interval ''24 hours'''
    into plan;
  if plan::text like '%Seq Scan%' then
    raise exception 'I3: the stale-permit sweep must be index-backed, got %', plan;
  end if;
end $$;
reset enable_seqscan;

-- ──────── J: the free-rating limit follows the sign-in identity ─────────────
--
-- Account deletion is a right the app must offer, and every row the free
-- limit used to count hangs off auth.users. Before 20260902150000 that made
-- "delete → sign in again with the same Apple ID / Google account → two more
-- free ratings" a repeatable loop. These cases pin the closure: the ledger
-- keyed by the provider identity survives the cascade and every decision
-- point (access_state, reserve, sync backstop) honours it — while a genuinely
-- new identity is untouched and no client session can see or edit the ledger.

reset role;

-- J1: Carol (at the limit since H3: both ratings scored) deletes her account.
-- Every account row cascades away — shots, permits, the auth identity — but
-- the identity ledger row does not, and still says 2.
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-00000000000c';
  if exists (select 1 from public.shots
             where user_id = '00000000-0000-4000-8000-00000000000c')
     or exists (select 1 from public.analysis_permits
                where user_id = '00000000-0000-4000-8000-00000000000c')
     or exists (select 1 from auth.identities
                where user_id = '00000000-0000-4000-8000-00000000000c') then
    raise exception 'J1: account deletion must cascade through shots, permits and identities';
  end if;
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('google', 'google-sub-carol')
                   and scored_count = 2) then
    raise exception 'J1: the identity ledger must survive account deletion at 2 scored';
  end if;
end $$;

-- J2: she signs in again. Supabase mints a NEW auth.users row, but the
-- provider identity (sub) is the same — so her free-rating state is too:
-- access_state reports the inherited 2, and the reserve RPC refuses.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000d', 'carol@example.com',
        '{"full_name":"Carol"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-carol', '00000000-0000-4000-8000-00000000000d',
        '{"sub":"google-sub-carol","email":"carol@example.com"}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000d';
do $$
declare rec record; r record;
begin
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 2 or rec.reserved_count <> 0 then
    raise exception
      'J2: a re-created account must inherit its identity''s 2 scored ratings (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into r from public.reserve_analysis_permit('carol-second-life-1');
  if r.result <> 'access.paywall_required' then
    raise exception 'J2: reserve must refuse the re-created account (got %)', r.result;
  end if;
  if exists (select 1 from public.analysis_permits where user_id = (select auth.uid())) then
    raise exception 'J2: no permit may be issued to the re-created account';
  end if;
end $$;

-- J3: the sync backstop holds too — a permit that got around the reserve RPC
-- (the over-issue artifact H3 simulates) still cannot become a free rating
-- for the re-created account.
do $$
declare v text;
begin
  insert into public.analysis_permits (id, user_id, idempotency_key)
  values ('00000000-0000-4000-8000-0000000000d1',
          '00000000-0000-4000-8000-00000000000d', 'carol-second-life-forged');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000d2',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000d1',
    'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'access.paywall_required' then
    raise exception
      'J3: the sync backstop must refuse a scored shot for the re-created account (got %)', v;
  end if;
  if exists (select 1 from public.shots where user_id = (select auth.uid())) then
    raise exception 'J3: no scored shot may be recorded for the re-created account';
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000d1'
                   and status = 'released' and outcome = 'free_limit_exceeded') then
    raise exception 'J3: the refused permit must be released, not left reserved';
  end if;
end $$;

-- J4: an abstention is still free for the re-created account (unscored
-- attempts never cost a rating, before or after deletion) and does not move
-- the ledger.
do $$
declare v text;
begin
  insert into public.analysis_permits (id, user_id, idempotency_key)
  values ('00000000-0000-4000-8000-0000000000d3',
          '00000000-0000-4000-8000-00000000000d', 'carol-second-life-abstain');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000d4',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000d3',
    'resultKind', 'low_confidence',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', null, 'confidence', 0.2,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'J4: an abstention must sync for the re-created account (got %)', v;
  end if;
  if public.identity_scored_count() <> 2 then
    raise exception 'J4: an abstention must not move the identity ledger (got %)',
      public.identity_scored_count();
  end if;
end $$;

-- J5: paying still wins — membership bypasses the inherited history exactly
-- as it bypasses an account's own count.
reset role;
insert into public.billing_entitlements (user_id, premium)
values ('00000000-0000-4000-8000-00000000000d', true);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000d';
do $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit('carol-second-life-pro');
  if r.result <> 'accepted' then
    raise exception 'J5: a member must reserve despite the identity ledger (got %)', r.result;
  end if;
end $$;
reset role;

-- J6: no false positives — a genuinely new identity starts at zero and gets
-- its first free rating.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000e', 'erin@example.com',
        '{"full_name":"Erin"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-erin', '00000000-0000-4000-8000-00000000000e',
        '{"sub":"apple-sub-erin","email":"erin@example.com"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000e';
do $$
declare rec record; r record;
begin
  select * into rec from public.access_state();
  if rec.scored_count <> 0 then
    raise exception 'J6: a new identity must start at 0 scored (got %)', rec.scored_count;
  end if;
  select * into r from public.reserve_analysis_permit('erin-key-1');
  if r.result <> 'accepted' then
    raise exception 'J6: a new identity must get its first free rating (got %)', r.result;
  end if;
end $$;

-- J7: the ledger is written by the sync itself (trigger on the scored shot
-- insert), so it is complete the moment a rating is spent — no deletion-path
-- bookkeeping involved.
do $$
declare v text; p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('erin-key-1');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e5',
    'analysisPermitId', p,
    'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'J7: a first-life scored sync must be accepted (got %)', v;
  end if;
  if public.identity_scored_count() <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'J7: the ledger must record the scored sync (identity %, lifetime %)',
      public.identity_scored_count(), public.lifetime_scored_count();
  end if;
end $$;

-- J8: the ledger is invisible and unwritable from a client session, and its
-- writer/hash helpers are not client-executable. (identity_scored_count and
-- lifetime_scored_count ARE callable — they only ever report the caller.)
do $$
begin
  begin
    perform 1 from public.free_rating_ledger limit 1;
    raise exception 'J8a: free_rating_ledger must not be client-readable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.free_rating_ledger (identity_hash, scored_count)
    values (repeat('0', 64), 0);
    raise exception 'J8b: free_rating_ledger must not be client-insertable';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.free_rating_ledger set scored_count = 0;
    raise exception 'J8c: free_rating_ledger must not be client-updatable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.free_rating_ledger;
    raise exception 'J8d: free_rating_ledger must not be client-deletable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.free_rating_identity_hash('google', 'google-sub-carol');
    raise exception 'J8e: free_rating_identity_hash must not be client-executable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_scored_shot_in_ledger();
    raise exception 'J8f: record_scored_shot_in_ledger must not be client-executable';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- J9: an account with two linked identities keeps both ledger rows in step,
-- so whichever provider the player returns with carries the same history.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000f', 'finn@example.com',
        '{"full_name":"Finn"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-finn', '00000000-0000-4000-8000-00000000000f',
   '{"sub":"google-sub-finn","email":"finn@example.com"}'),
  ('apple', 'apple-sub-finn', '00000000-0000-4000-8000-00000000000f',
   '{"sub":"apple-sub-finn","email":"finn@example.com"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000f';
do $$
declare v text; p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('finn-key-1');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000f5',
    'analysisPermitId', p,
    'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'J9: the linked-identity sync must be accepted (got %)', v;
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.free_rating_ledger
      where identity_hash in (
        public.free_rating_identity_hash('google', 'google-sub-finn'),
        public.free_rating_identity_hash('apple', 'apple-sub-finn'))
        and scored_count = 1) <> 2 then
    raise exception 'J9: every identity of the account must carry the scored count';
  end if;
end $$;

rollback;

\echo SECURITY REGRESSION MATRIX: ALL CASES PASSED
