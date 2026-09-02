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
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- Seed two users through the auth trigger path (exactly how Supabase creates
-- them in production: insert into auth.users fires handle_new_user()).
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}');

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
  (user_id, reason, details, provider, platform, app_version,
   account_age_days, was_premium, scored_count)
values ('00000000-0000-4000-8000-00000000000a', 'too_expensive',
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
    'account_deletion_requests','account_deletion_feedback','webhook_events'
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
                   and reason = 'too_expensive'
                   and details = 'Steep for a rec player.'
                   and provider = 'google' and account_age_days = 12) then
    raise exception 'D4: the anonymized exit survey must survive account deletion';
  end if;
end $$;

-- Re-provision Alice for the remaining cases.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
        '{"full_name":"Alice"}', '{"provider":"google"}');

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

rollback;

\echo SECURITY REGRESSION MATRIX: ALL CASES PASSED
