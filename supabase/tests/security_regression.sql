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

-- ──────────────────────── B: cross-user is denied ──────────────────────────

-- B1: Bob cannot see Alice's rows
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
begin
  if exists (select 1 from public.sessions) or exists (select 1 from public.shots)
     or exists (select 1 from public.consent_records)
     or exists (select 1 from public.player_rank_state) then
    raise exception 'B1: cross-user rows must be invisible';
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

-- E0: shots are INSERT-only THROUGH apply_synced_shot(). A client session
-- holds no INSERT privilege on shots or the detail tables, so a PostgREST
-- `POST /rest/v1/shots` with the user's own token (no permit, client-chosen
-- score and version columns) is refused at the grant layer…
do $$
declare t text;
begin
  begin
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
      9.9, 0.99, 'scored',
      'forged', 'forged', 'forged', 'forged', 'forged', 'forged',
      'forged', 'forged'
    );
    raise exception 'E0a: direct client INSERT into shots must be denied';
  exception when insufficient_privilege then null;
  end;
  foreach t in array array['shots', 'shot_phases', 'shot_measurements', 'shot_checkpoints'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT') then
      raise exception 'E0b: authenticated must hold no INSERT grant on %', t;
    end if;
  end loop;
end $$;

-- …while the SAME session syncs the same shot through the RPC (the shot the
-- rest of this section works on). Alice's identity already carries the A5
-- rating, so this is her second and last free one.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a0',
        '00000000-0000-4000-8000-00000000000a', 'permit-e2');
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e2',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a0',
    'sessionId', '00000000-0000-4000-8000-0000000000d2',
    'resultKind', 'scored',
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', '2026-08-31T11:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 5.5, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'prepare', 'startMs', 0, 'representativeMs', 100,
      'endMs', 200, 'confidence', 0.9)),
    'checkpoints', '[]'::jsonb
  ));
  if v <> 'accepted' then
    raise exception 'E0c: apply_synced_shot must still accept the owner sync (got %)', v;
  end if;
  if not exists (select 1 from public.shots
                 where id = '00000000-0000-4000-8000-0000000000e2'
                   and user_id = '00000000-0000-4000-8000-00000000000a'
                   and overall_score = 5.5 and result_kind = 'scored') then
    raise exception 'E0c: the RPC must have written the shot under the caller';
  end if;
  if not exists (select 1 from public.shot_phases
                 where shot_id = '00000000-0000-4000-8000-0000000000e2'
                   and phase_key = 'prepare') then
    raise exception 'E0c: the RPC must have written the phase evidence';
  end if;
  -- The refused direct INSERT above left no trace in either quota view.
  if public.lifetime_scored_count() <> 2
     or (select scored_count from public.access_state()) <> 2 then
    raise exception 'E0d: scored count must be exactly the two synced ratings (got % / %)',
      public.lifetime_scored_count(), (select scored_count from public.access_state());
  end if;
end $$;

-- E0e: at the limit, the direct INSERT is still refused and still moves
-- nothing — the free limit cannot be exceeded by any client path.
do $$
begin
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000e4',
      '00000000-0000-4000-8000-00000000000a',
      'drive', now(), 0, 1000, 10.0, 0.99, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'E0e: a third scored shot must not be insertable directly';
  exception when insufficient_privilege then null;
  end;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'E0e: the refused INSERT must not move lifetime_scored_count() (got %)',
      public.lifetime_scored_count();
  end if;
end $$;

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

-- E3: shot detail evidence is write-once and written only by the RPC (no
-- client INSERT/UPDATE/DELETE grant; the E0c sync wrote the 'prepare' phase)
do $$
begin
  begin
    insert into public.shot_phases
      (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e2',
            '00000000-0000-4000-8000-00000000000a', 'forged', 0, 100, 200, 0.9);
    raise exception 'E3c: shot_phases must not be client-insertable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shot_checkpoints
      (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values ('00000000-0000-4000-8000-0000000000e2',
            '00000000-0000-4000-8000-00000000000a', 'forged', 100, 1, 'green', 'ok', 0, true);
    raise exception 'E3d: shot_checkpoints must not be client-insertable';
  exception when insufficient_privilege then null;
  end;
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

-- E6: permits — lifecycle columns only; the idempotency identity is fixed.
-- The client transition is the finalize route's: reserved -> terminal with
-- one of the releasable outcomes it accepts.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a2',
        '00000000-0000-4000-8000-00000000000a', 'permit-2');
update public.analysis_permits set status = 'finalized', outcome = 'cancelled'
  where id = '00000000-0000-4000-8000-0000000000a2' and status = 'reserved';
do $$
begin
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a2'
                   and status = 'finalized' and outcome = 'cancelled') then
    raise exception 'E6a: permit finalize (status/outcome) must stay client-writable';
  end if;
  begin
    update public.analysis_permits set idempotency_key = 'forged'
      where id = '00000000-0000-4000-8000-0000000000a2';
    raise exception 'E6b: permit idempotency_key must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E6c: the lifecycle is ONE-WAY. A terminal permit (a2 above) can never go
-- back to reserved — which is what would let one permit be consumed twice —
-- and the attempt leaves access_state().reserved_count exactly where it was.
do $$
declare before_reserved int; after_reserved int; st text; v text;
begin
  select reserved_count into before_reserved from public.access_state();
  begin
    update public.analysis_permits set status = 'reserved', outcome = null
      where id = '00000000-0000-4000-8000-0000000000a2';
    raise exception 'E6c: finalized -> reserved must be rejected';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    update public.analysis_permits set status = 'released', outcome = 'cancelled'
      where id = '00000000-0000-4000-8000-0000000000a2';
    raise exception 'E6c: finalized -> released must be rejected (terminal is terminal)';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    update public.analysis_permits set outcome = 'failed'
      where id = '00000000-0000-4000-8000-0000000000a2';
    raise exception 'E6c: a terminal outcome must not be rewritable';
  exception when insufficient_privilege or check_violation then null;
  end;
  select status into st from public.analysis_permits
    where id = '00000000-0000-4000-8000-0000000000a2';
  if st <> 'finalized' then
    raise exception 'E6c: the permit must still be finalized (got %)', st;
  end if;
  select reserved_count into after_reserved from public.access_state();
  if after_reserved <> before_reserved then
    raise exception 'E6c: reserved_count must be unchanged by the attempt (% -> %)',
      before_reserved, after_reserved;
  end if;
  -- And the sync RPC keeps refusing the consumed permit.
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e7',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a2',
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
  if v <> 'access.permit_not_reserved' then
    raise exception 'E6c: a consumed permit must not be reusable by the RPC (got %)', v;
  end if;
end $$;

-- E6d: outcomes are the documented vocabulary, and a client session records
-- only the ones the finalize route accepts — 'scored' / 'expired' /
-- 'free_limit_exceeded' are written by the sync RPC and the sweep. A permit
-- also cannot pick up an outcome while it is still reserved.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a3',
        '00000000-0000-4000-8000-00000000000a', 'permit-3');
do $$
declare bad text;
begin
  foreach bad in array array[
    'status = ''finalized'', outcome = ''totally_made_up''',
    'status = ''finalized'', outcome = ''scored''',
    'status = ''released'', outcome = ''free_limit_exceeded''',
    'status = ''released'', outcome = null',
    'outcome = ''cancelled'''
  ] loop
    begin
      execute format(
        'update public.analysis_permits set %s where id = ''00000000-0000-4000-8000-0000000000a3''',
        bad);
      raise exception 'E6d: permit update "%" must be rejected', bad;
    exception when insufficient_privilege or check_violation then null;
    end;
  end loop;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a3'
                   and status = 'reserved' and outcome is null) then
    raise exception 'E6d: the rejected updates must leave the permit reserved';
  end if;
  -- The finalize route's release shape still works on a reserved permit.
  update public.analysis_permits set status = 'released', outcome = 'low_confidence'
    where id = '00000000-0000-4000-8000-0000000000a3' and status = 'reserved';
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a3'
                   and status = 'released' and outcome = 'low_confidence') then
    raise exception 'E6d: reserved -> released with low_confidence must succeed';
  end if;
  begin
    update public.analysis_permits set status = 'reserved', outcome = null
      where id = '00000000-0000-4000-8000-0000000000a3';
    raise exception 'E6d: released -> reserved must be rejected';
  exception when insufficient_privilege or check_violation then null;
  end;
end $$;

-- E6e: a client cannot mint a permit that is already terminal, back-dated,
-- or carries an outcome (INSERT is sized to the reserve RPC's columns), and
-- cannot delete permits either — the ledger of attempts is append-once.
do $$
begin
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
    values ('00000000-0000-4000-8000-0000000000a4',
            '00000000-0000-4000-8000-00000000000a', 'permit-4', 'finalized', 'scored');
    raise exception 'E6e: inserting a pre-finalized permit must be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
    values ('00000000-0000-4000-8000-0000000000a4',
            '00000000-0000-4000-8000-00000000000a', 'permit-4', now() - interval '2 days');
    raise exception 'E6e: inserting a back-dated permit must be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.analysis_permits
      where id = '00000000-0000-4000-8000-0000000000a3';
    raise exception 'E6e: permits must not be client-deletable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E6f: the reversal is also refused through the write shapes that are not a
-- plain UPDATE — the PostgREST upsert (`POST ... resolution=merge-duplicates`
-- = INSERT ... ON CONFLICT DO UPDATE, on either unique key) and MERGE both
-- route through the BEFORE UPDATE guard; a3 (released/low_confidence) stays put.
do $$
begin
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values ('00000000-0000-4000-8000-0000000000a3',
            '00000000-0000-4000-8000-00000000000a', 'permit-3')
    on conflict (id) do update set status = 'reserved', outcome = null;
    raise exception 'E6f: upsert-on-id reversal must be rejected';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values ('00000000-0000-4000-8000-0000000000a5',
            '00000000-0000-4000-8000-00000000000a', 'permit-3')
    on conflict (user_id, idempotency_key) do update set status = 'reserved', outcome = null;
    raise exception 'E6f: upsert-on-idempotency-key reversal must be rejected';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    merge into public.analysis_permits p
    using (select '00000000-0000-4000-8000-0000000000a3'::uuid as id) s on p.id = s.id
    when matched then update set status = 'reserved', outcome = null;
    raise exception 'E6f: MERGE reversal must be rejected';
  exception when insufficient_privilege or check_violation then null;
  end;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a3'
                   and status = 'released' and outcome = 'low_confidence') then
    raise exception 'E6f: the permit must still be released/low_confidence';
  end if;
  if exists (select 1 from public.analysis_permits
             where id = '00000000-0000-4000-8000-0000000000a5') then
    raise exception 'E6f: the refused upsert must not have minted a permit';
  end if;
end $$;

-- E6g: the DEFINER sync RPC cannot be used to launder an outcome either — a
-- resultKind outside shots' vocabulary fails the shot INSERT first, and the
-- single transaction leaves the permit reserved (no partial permit write),
-- so the same permit is still consumable by the well-formed retry.
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a6',
        '00000000-0000-4000-8000-00000000000a', 'permit-6');
do $$
declare bad text; v text;
begin
  foreach bad in array array['expired', 'free_limit_exceeded', 'cancelled', 'totally_made_up'] loop
    v := public.apply_synced_shot(jsonb_build_object(
      'id', '00000000-0000-4000-8000-0000000000e8',
      'analysisPermitId', '00000000-0000-4000-8000-0000000000a6',
      'resultKind', bad,
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
    if v not like 'shot.write_failed:%' then
      raise exception 'E6g: resultKind % must be refused by the RPC (got %)', bad, v;
    end if;
    if not exists (select 1 from public.analysis_permits
                   where id = '00000000-0000-4000-8000-0000000000a6'
                     and status = 'reserved' and outcome is null) then
      raise exception 'E6g: a refused sync (%) must leave the permit reserved', bad;
    end if;
    if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000e8') then
      raise exception 'E6g: a refused sync (%) must write no shot row', bad;
    end if;
  end loop;
  -- The well-formed abstention on the same permit still lands.
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e8',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000a6',
    'resultKind', 'low_confidence',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', null, 'confidence', 0.4,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'E6g: the well-formed retry must be accepted (got %)', v;
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000a6'
                   and status = 'released' and outcome = 'low_confidence') then
    raise exception 'E6g: the abstention must release the permit as low_confidence';
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'E6g: an abstention must not move lifetime_scored_count() (got %)',
      public.lifetime_scored_count();
  end if;
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

-- ────────── K: RLS-blind privileges are gone from the client roles ──────────
-- TRUNCATE, TRIGGER and REFERENCES bypass row-level security and the
-- row-level append-only triggers entirely. The hosted default privileges hand
-- them to anon/authenticated on every new table; the chain must have revoked
-- them everywhere AND narrowed the defaults so a table added later is not
-- born with them. Iterates every table so a new one is caught automatically.

reset role;

-- K1: no table in schema public grants any of the three to either client role
do $$
declare rel record; r text; p text;
begin
  for rel in
    select c.oid::regclass as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['TRUNCATE', 'TRIGGER', 'REFERENCES'] loop
        if has_table_privilege(r, rel.name, p) then
          raise exception 'K1: % must not hold % on %', r, p, rel.name;
        end if;
      end loop;
    end loop;
  end loop;
  if (select count(*) from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon', 'authenticated')
        and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')) <> 0 then
    raise exception 'K1: information_schema still lists RLS-blind grants for a client role';
  end if;
end $$;

-- K2: the default privileges for schema public no longer hand them out
do $$
begin
  if exists (
    select 1
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and d.defaclobjtype = 'r'
      and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated'))
      and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')) then
    raise exception 'K2: default privileges in schema public still grant TRUNCATE/TRIGGER/REFERENCES to a client role';
  end if;
end $$;

-- K3: a table created AFTER the chain (as the migration role) is born without
-- them — this is what protects the next migration's tables.
create table public.k3_probe (id int primary key);
do $$
begin
  if has_table_privilege('authenticated', 'public.k3_probe', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.k3_probe', 'TRIGGER')
     or has_table_privilege('authenticated', 'public.k3_probe', 'REFERENCES')
     or has_table_privilege('anon', 'public.k3_probe', 'TRUNCATE')
     or has_table_privilege('anon', 'public.k3_probe', 'TRIGGER')
     or has_table_privilege('anon', 'public.k3_probe', 'REFERENCES') then
    raise exception 'K3: a newly created table must not inherit TRUNCATE/TRIGGER/REFERENCES for client roles';
  end if;
end $$;
drop table public.k3_probe;

-- K4: as authenticated, the DDL/bulk paths those privileges unlock are refused
-- with 42501 (TRUNCATE ignores RLS and does not fire row triggers; a client
-- trigger could rewrite every row it touches).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare t text;
begin
  foreach t in array array[
    'shots', 'consent_records', 'analysis_permits', 'billing_entitlements',
    'evaluation_trials', 'free_rating_ledger'
  ] loop
    begin
      execute format('truncate public.%I cascade', t);
      raise exception 'K4: authenticated TRUNCATE of % must be refused', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    execute 'create function pg_temp.k4_fn() returns trigger language plpgsql as $f$ begin return new; end $f$';
    execute 'create trigger k4_trg before insert on public.shots for each row execute function pg_temp.k4_fn()';
    raise exception 'K4: authenticated CREATE TRIGGER on shots must be refused';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- K5: captures hygiene — no client path updates or deletes captures, so the
-- grants (and the dead policies behind them) are gone; the read/insert side
-- the practice evidence relies on is untouched.
do $$
begin
  if has_table_privilege('authenticated', 'public.captures', 'UPDATE')
     or has_table_privilege('authenticated', 'public.captures', 'DELETE') then
    raise exception 'K5: authenticated must not hold UPDATE/DELETE on captures';
  end if;
  if not has_table_privilege('authenticated', 'public.captures', 'SELECT')
     or not has_table_privilege('authenticated', 'public.captures', 'INSERT') then
    raise exception 'K5: captures SELECT/INSERT must stay client-usable';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'captures'
             and cmd in ('UPDATE', 'DELETE')) then
    raise exception 'K5: captures must carry no UPDATE/DELETE policy';
  end if;
end $$;

rollback;

\echo SECURITY REGRESSION MATRIX: ALL CASES PASSED
