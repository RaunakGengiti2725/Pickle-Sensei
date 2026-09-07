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
--      false positives for new identities and no client path to the ledger —
--      including identities linked AFTER the ratings were spent
--   K. client-controlled input hygiene (captured_at / captures bounds)
--   L. the permit gate binds direct table writes: a scored row cannot be
--      INSERTed around apply_synced_shot() without a live permit or past the
--      free limit, and an abstention cannot carry a score
--   M. duplicate-sync idempotency and privilege floor: a replay of a shot the
--      server already holds is 'accepted' even though its permit is consumed
--      (never a permanent verdict), and the client roles hold no TRUNCATE /
--      TRIGGER / REFERENCES on any public table
--   N. offline > 24h durability: a shot backed by a permit this user reserved
--      is accepted regardless of the permit's age (still reserved, or already
--      swept to released/expired) and finalized once; the free limit is still
--      capped by the lifetime scored count; every other permit state keeps its
--      verdict; the direct-INSERT gate is not widened
--   O. (adversary, round 6) a released/NULL permit — client-reachable before
--      20260906140000 — is refused by apply_synced_shot() with
--      access.permit_not_reserved and never backs a shot, with or without an
--      unrelated live reservation
--   P. the permit lifecycle is a table invariant (released/NULL cannot be
--      written, settled permits are terminal for every role, every legal
--      product transition still works), backing is NULL-safe/default-deny,
--      and the shots gate never falls back to a permit the sync did not name
--   R. (round 9, 20260907100000) a settled permit is terminal for the OWNER
--      role across DELETE: removing a finalized permit that backs a shot, or
--      a settled legacy-style unlinked one, leaves a tombstone — the id can
--      only be restored as the identical settled row (never reopened as
--      reserved, by anyone), the RPC answers permit_not_reserved for it and
--      writes nothing; the owner cannot reopen a settled row by UPDATE
--      either; a reserved unlinked permit is deleted with no memory; account
--      deletion through auth.users AND through public.profiles still removes
--      every permit, shot and tombstone and frees the ids; the tombstone
--      table is invisible to clients
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

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

do $$
declare changed integer;
begin
  update public.profiles set first_name = 'Direct client tampering'
    where id = (select auth.uid());
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'K1: a user token alone must not update even its own profile';
  end if;
  if exists (select 1 from public.profiles) then
    raise exception 'K2: a user token alone must not read application tables';
  end if;
  begin
    insert into public.analysis_permits (user_id, idempotency_key)
    values ((select auth.uid()), 'direct-client-permit');
    raise exception 'K3: direct clients must not forge analysis permits';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
    ) values (
      gen_random_uuid(), (select auth.uid()), 'drive', now(), 0, 1000,
      10, 1, 'scored', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1'
    );
    raise exception 'K4: direct clients must not insert scored shots without API validation';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reserve_analysis_permit('direct-rpc-permit');
    raise exception 'K5: calling the reservation RPC must not bypass the API gate';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_api_request_key();
    raise exception 'K6: authenticated clients must not read the server request key';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', repeat('0', 64), 'apikey', 'service_role'
  )::text, true);
  if exists (select 1 from public.profiles) then
    raise exception 'K7: a forged server header must not authorize database access';
  end if;
end $$;
reset role;

do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
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
-- Fixed-id permits are seeded by the owner: since 20260907000000 the client
-- role cannot name a permit id (section Q); the RPC path is exercised in H.
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-00000000000a', 'permit-1');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
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

-- B1b: EVERY user-owned relation a client session can read isolates rows —
-- base tables through their RLS policies, the derived views through
-- security_invoker (a definer view would aggregate everyone's shots). Alice
-- first fills the relations A5 left empty, then each relation is asserted
-- populated for its owner (so the zero-row check below is never vacuous) and
-- empty for Bob.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
reset role;
insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
values ('00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-00000000000a', 'paddle_speed', 12.5, 0.9, 'ratio');
set local role authenticated;
insert into public.user_saved_drills (user_id, slug)
values ('00000000-0000-4000-8000-00000000000a', 'dink-ladder');
-- captures is read-only for clients (K4), so Alice's row is seeded as the
-- owner role; the read-isolation assertion below still runs as each client.
reset role;
insert into public.captures
  (id, user_id, session_id, shot_id, captured_at, duration_ms, fps,
   capture_mode, evidence_status)
values ('00000000-0000-4000-8000-0000000000c1',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-0000000000e1',
        '2026-08-31T10:00:00Z', 1200, 30, 'automatic_pose_trigger', 'valid');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare
  t text;
  n int;
begin
  foreach t in array array[
    'profiles','sessions','shots','shot_phases','shot_measurements',
    'shot_checkpoints','captures','analysis_permits','consent_records',
    'evaluation_trials','analysis_feedback','user_saved_drills',
    'player_rank_state','progress_daily','practice_days',
    'player_technique_rating'
  ] loop
    execute format('select count(*) from public.%I', t) into n;
    if n = 0 then
      raise exception 'B1b: owner must see their own rows in public.% (setup gap)', t;
    end if;
  end loop;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare
  t text;
  n int;
begin
  foreach t in array array[
    'sessions','shots','shot_phases','shot_measurements',
    'shot_checkpoints','captures','analysis_permits','consent_records',
    'evaluation_trials','analysis_feedback','user_saved_drills',
    'player_rank_state','progress_daily','practice_days',
    'player_technique_rating'
  ] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'B1b: public.% must show 0 rows to a second user (saw %)', t, n;
    end if;
  end loop;
  -- profiles: Bob's own row is the only one visible.
  if (select count(*) from public.profiles) <> 1
     or exists (select 1 from public.profiles
                where id <> '00000000-0000-4000-8000-00000000000b') then
    raise exception 'B1b: public.profiles must show only the caller''s row to a second user';
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
do $$
begin
  begin
    delete from public.sessions where id = '00000000-0000-4000-8000-0000000000d1';
    raise exception 'B3: deleting sessions must require an administrative cascade';
  exception when insufficient_privilege then null;
  end;
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

do $$
begin
  begin
    insert into public.shot_phases (
      shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence
    ) values (
      '00000000-0000-4000-8000-0000000000e1', (select auth.uid()),
      'cross_user_phase', 0, 50, 100, 0.9
    );
    raise exception 'K21: phase evidence must not attach to another user''s shot';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shot_checkpoints (
      shot_id, user_id, checkpoint_key, confidence, band, direction, severity, applicable
    ) values (
      '00000000-0000-4000-8000-0000000000e1', (select auth.uid()),
      'cross_user_checkpoint', 0.9, 'green', 'ok', 0.1, true
    );
    raise exception 'K22: checkpoint evidence must not attach to another user''s shot';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shots (
      id, user_id, session_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
    ) values (
      gen_random_uuid(), (select auth.uid()), '00000000-0000-4000-8000-0000000000d1',
      'drive', now(), 0, 1000, 7, 0.9, 'scored',
      'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1'
    );
    raise exception 'K23: shots must not attach to another user''s session';
  exception when insufficient_privilege then null;
  end;
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
-- Fixture row written directly (not via the RPC) so E1 exercises the table
-- grants themselves; it still needs a live permit — see L for the gate.
-- (Owner-seeded fixed id: the client cannot name one since 20260907000000.)
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a3',
        '00000000-0000-4000-8000-00000000000a', 'permit-e-fixture');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
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
-- (Owner-seeded fixed id: the client cannot name one since 20260907000000.)
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a2',
        '00000000-0000-4000-8000-00000000000a', 'permit-2');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
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
set local request.jwt.claim.sub = '';

-- F5: the caps bind every role, not just clients (oversized guidance as owner —
-- no JWT claim either, so the client-side permit gate does not apply)
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
declare v text; p uuid; p_id uuid; i int;
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

  -- Simulate the over-issued permit a lost race would leave behind (the
  -- client may still write a reservation row; the id is server-assigned).
  insert into public.analysis_permits (user_id, idempotency_key)
  values ('00000000-0000-4000-8000-00000000000c', 'carol-raced-key')
  returning id into p_id;

  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000c9',
    'analysisPermitId', p_id,
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
                 where id = p_id
                   and status = 'released' and outcome = 'free_limit_exceeded') then
    raise exception 'H3: the refused permit must be released, not left reserved';
  end if;
end $$;

-- H4: an abstention still costs nothing — the backstop must not turn
-- low_confidence into a paywall (unscored attempts are free, by contract).
do $$
declare v text; p_id uuid;
begin
  insert into public.analysis_permits (user_id, idempotency_key)
  values ('00000000-0000-4000-8000-00000000000c', 'carol-abstain-key')
  returning id into p_id;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000ca',
    'analysisPermitId', p_id,
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
                 where id = p_id
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
declare v text; p_id uuid;
begin
  insert into public.analysis_permits (user_id, idempotency_key)
  values ('00000000-0000-4000-8000-00000000000d', 'carol-second-life-forged')
  returning id into p_id;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000d2',
    'analysisPermitId', p_id,
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
                 where id = p_id
                   and status = 'released' and outcome = 'free_limit_exceeded') then
    raise exception 'J3: the refused permit must be released, not left reserved';
  end if;
end $$;

-- J4: an abstention is still free for the re-created account (unscored
-- attempts never cost a rating, before or after deletion) and does not move
-- the ledger.
do $$
declare v text; p_id uuid;
begin
  insert into public.analysis_permits (user_id, idempotency_key)
  values ('00000000-0000-4000-8000-00000000000d', 'carol-second-life-abstain')
  returning id into p_id;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000d4',
    'analysisPermitId', p_id,
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

-- J10: an identity linked AFTER the ratings were spent inherits the count at
-- link time. Gina (google) scores twice, THEN an Apple identity is linked to
-- the same account (GoTrue auto-link / linkIdentity). Before the link-time
-- trigger, the Apple identity carried no ledger row — so after the account
-- was deleted, signing in with Apple alone started over at zero.
reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000012', 'gina@example.com',
        '{"full_name":"Gina"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-gina', '00000000-0000-4000-8000-000000000012',
        '{"sub":"google-sub-gina","email":"gina@example.com"}');
do $$
begin
  if exists (select 1 from public.free_rating_ledger
             where identity_hash = public.free_rating_identity_hash('google', 'google-sub-gina')) then
    raise exception 'J10: a brand-new identity with no history must not get a ledger row at link time';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000012';
do $$
declare v text; p uuid; i int;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('gina-key-' || i);
    v := public.apply_synced_shot(jsonb_build_object(
      'id', ('00000000-0000-4000-8000-0000000000b' || i)::uuid,
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
      raise exception 'J10: gina''s free rating % must be accepted (got %)', i, v;
    end if;
  end loop;
end $$;
reset role;
-- The late link. The ledger must be brought up to 2 for the new identity
-- immediately, without waiting for another scored shot that will never come.
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-gina', '00000000-0000-4000-8000-000000000012',
        '{"sub":"apple-sub-gina","email":"gina@example.com"}');
do $$
begin
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-gina')
                   and scored_count = 2) then
    raise exception 'J10: an identity linked after the ratings were spent must inherit scored_count=2';
  end if;
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('google', 'google-sub-gina')
                   and scored_count = 2) then
    raise exception 'J10: the original identity must still read 2 after the link';
  end if;
end $$;

-- J11: delete the account, sign back in with ONLY the late-linked Apple
-- identity: the free ratings stay spent (the exact bypass the link-time
-- trigger closes), while the reverse direction — a fresh account linking an
-- identity that carries history — inherits that history too.
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-000000000012';
end $$;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000013', 'gina@example.com',
        '{"full_name":"Gina"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-gina', '00000000-0000-4000-8000-000000000013',
        '{"sub":"apple-sub-gina","email":"gina@example.com"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000013';
do $$
declare rec record; r record;
begin
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 2 then
    raise exception
      'J11: an account re-created from the late-linked identity must inherit 2 scored (got %, %)',
      rec.premium, rec.scored_count;
  end if;
  select * into r from public.reserve_analysis_permit('gina-third-life-1');
  if r.result <> 'access.paywall_required' then
    raise exception 'J11: reserve must refuse the re-created account (got %)', r.result;
  end if;
  begin
    perform public.inherit_free_rating_ledger();
    raise exception 'J11: inherit_free_rating_ledger must not be client-executable';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.enforce_scored_shot_permit();
    raise exception 'J11: enforce_scored_shot_permit must not be client-executable';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
-- Reverse direction: a genuinely new identity linked to this account is
-- pulled up to the account's inherited history at link time.
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-gina-2', '00000000-0000-4000-8000-000000000013',
        '{"sub":"google-sub-gina-2","email":"gina@example.com"}');
do $$
begin
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('google', 'google-sub-gina-2')
                   and scored_count = 2) then
    raise exception 'J11: an identity linked to an account with inherited history must inherit it';
  end if;
end $$;

-- ─────────── K: client-controlled input hygiene (XC-SEC-4 / XC-SEC-5) ──────────
-- 20260904000000_apply_synced_shot_error_hygiene.sql: apply_synced_shot's
-- write-failure result is SQLSTATE-only (never sqlerrm, which echoes the
-- client's input into function logs), captured_at is range-checked (no
-- 'infinity', no far-future) on shots AND captures, captures text columns are
-- length-capped, and captures — which no edge route writes — is read-only for
-- clients.

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000010', 'kim@example.com',
        '{"full_name":"Kim"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-kim', '00000000-0000-4000-8000-000000000010',
        '{"sub":"google-sub-kim","email":"kim@example.com"}');

-- K1: a malformed capturedAt reaching the RPC directly yields a stable
-- SQLSTATE-only code; the canary never appears in the result and no row lands.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000010';
do $$
declare v text; p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('kim-k1-key');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000c1',
    'analysisPermitId', p,
    'resultKind', 'low_confidence',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', E'XCSEC_CANARY\n[api] forged log line',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', null, 'confidence', 0.2,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v !~ '^shot\.write_failed:[0-9A-Z]{5}$' then
    raise exception 'K1: write failure must be SQLSTATE-only (got %)', v;
  end if;
  if position('XCSEC_CANARY' in v) > 0 then
    raise exception 'K1: client input must never be echoed in the RPC result';
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000c1') then
    raise exception 'K1: a failed write must not leave a shot row';
  end if;
  if (select status from public.analysis_permits where id = p) <> 'reserved' then
    raise exception 'K1: a failed write must leave the permit reserved for retry';
  end if;
end $$;

-- K2: 'infinity' is not a capture instant — the RPC refuses it (non-accepted,
-- SQLSTATE-only) and writes no shot row.
do $$
declare v text; p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('kim-k2-key');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000c2',
    'analysisPermitId', p,
    'resultKind', 'low_confidence',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', 'infinity',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', null, 'confidence', 0.2,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v = 'accepted' then
    raise exception 'K2: capturedAt = infinity must not be accepted';
  end if;
  if v !~ '^shot\.write_failed:[0-9A-Z]{5}$' then
    raise exception 'K2: infinity must surface as a SQLSTATE-only write failure (got %)', v;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000c2') then
    raise exception 'K2: an infinite captured_at must not be stored';
  end if;
end $$;

-- K3: the far-future bound binds too (year 9999 is not a capture instant).
-- K2's permit stayed reserved (a failed write never consumes it), so the
-- idempotent reserve replays it — a third reservation would exceed the
-- two-slot free allowance.
do $$
declare v text; p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('kim-k2-key');
  if p is null then
    raise exception 'K3: the reserved permit from K2 must be replayable';
  end if;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000c3',
    'analysisPermitId', p,
    'resultKind', 'low_confidence',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '9999-12-31T00:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', null, 'confidence', 0.2,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'shot.write_failed:23514' then
    raise exception 'K3: a far-future captured_at must fail the range check (got %)', v;
  end if;
end $$;

-- K4: captures is read-only for clients — no edge route writes it, so
-- authenticated holds no INSERT/UPDATE/DELETE (grants sized to the writes).
do $$
begin
  begin
    insert into public.captures (
      user_id, captured_at, duration_ms, fps, capture_mode, evidence_status, status
    ) values (
      '00000000-0000-4000-8000-000000000010', now(), 1000, 30, 'automatic_pose_trigger',
      'valid', 'analyzed'
    );
    raise exception 'K4: authenticated must not insert into captures';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.captures set duration_ms = 1
      where user_id = '00000000-0000-4000-8000-000000000010';
    raise exception 'K4: authenticated must not update captures';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.captures
      where user_id = '00000000-0000-4000-8000-000000000010';
    raise exception 'K4: authenticated must not delete from captures';
  exception when insufficient_privilege then null;
  end;
  -- Reads keep working (practice_days / progress cards depend on them).
  perform 1 from public.captures where user_id = auth.uid();
end $$;
reset role;

-- K5: captures text bounds bind every role — a 65-character declared_stroke is
-- a check_violation (23514), while 64 characters store fine.
do $$
begin
  begin
    insert into public.captures (
      id, user_id, captured_at, duration_ms, fps, capture_mode,
      declared_stroke, recognized_shot_type, evidence_status, status
    ) values (
      '00000000-0000-4000-8000-0000000000c5',
      '00000000-0000-4000-8000-000000000010', now(), 1000, 30, 'automatic_pose_trigger',
      repeat('x', 65), 'drive', 'valid', 'analyzed'
    );
    raise exception 'K5: a 65-char declared_stroke must be rejected';
  exception when sqlstate '23514' then null;
  end;
  begin
    insert into public.captures (
      id, user_id, captured_at, duration_ms, fps, capture_mode,
      declared_stroke, recognized_shot_type, evidence_status, status
    ) values (
      '00000000-0000-4000-8000-0000000000c6',
      '00000000-0000-4000-8000-000000000010', now(), 1000, 30, 'automatic_pose_trigger',
      'drive', repeat('y', 65), 'valid', 'analyzed'
    );
    raise exception 'K5: a 65-char recognized_shot_type must be rejected';
  exception when sqlstate '23514' then null;
  end;
  insert into public.captures (
    id, user_id, captured_at, duration_ms, fps, capture_mode,
    declared_stroke, recognized_shot_type, evidence_status, status
  ) values (
    '00000000-0000-4000-8000-0000000000c7',
    '00000000-0000-4000-8000-000000000010', now(), 1000, 30, 'automatic_pose_trigger',
    repeat('x', 64), repeat('y', 64), 'valid', 'analyzed'
  );
end $$;

-- K6: captured_at range binds every role on both tables (infinity, far future).
do $$
begin
  begin
    insert into public.captures (
      id, user_id, captured_at, duration_ms, fps, capture_mode,
      evidence_status, status
    ) values (
      '00000000-0000-4000-8000-0000000000c8',
      '00000000-0000-4000-8000-000000000010', 'infinity', 1000, 30, 'automatic_pose_trigger',
      'valid', 'analyzed'
    );
    raise exception 'K6: captures.captured_at = infinity must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000c9',
      '00000000-0000-4000-8000-000000000010',
      'drive', '-infinity', 0, 1000, null, 0.2, 'low_confidence',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'K6: shots.captured_at = -infinity must be rejected';
  exception when check_violation then null;
  end;
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000ca',
      '00000000-0000-4000-8000-000000000010',
      'drive', '2200-01-01T00:00:00Z', 0, 1000, null, 0.2, 'low_confidence',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'K6: a far-future shots.captured_at must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- ─────── L: the permit gate binds DIRECT table writes (DB-02) ───────────────
--
-- authenticated holds INSERT on public.shots (RLS forces user_id only). The
-- two-lifetime-free-ratings rule lived solely inside apply_synced_shot(), so a
-- client writing the table straight through PostgREST could record a scored
-- shot with no permit at all, past the free limit. The BEFORE INSERT trigger
-- shots_enforce_scored_permit now requires a live reserved permit AND an
-- unspent allowance for every client-written scored row.

reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000014', 'liam@example.com',
        '{"full_name":"Liam"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-liam', '00000000-0000-4000-8000-000000000014',
        '{"sub":"google-sub-liam","email":"liam@example.com"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000014';

-- L1: no permit → a direct scored INSERT is refused at the table layer.
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
      '00000000-0000-4000-8000-0000000000b5',
      '00000000-0000-4000-8000-000000000014',
      'drive', now(), 0, 1000, 9.9, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'L1: a scored shot with no permit must not be INSERTable directly';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.shots where user_id = (select auth.uid())) then
    raise exception 'L1: the refused row must not persist';
  end if;
end $$;

-- L2: an abstention needs no permit (unscored attempts are free) but must not
-- carry a score — the CHECK the edge parser already enforces on its side.
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
      '00000000-0000-4000-8000-0000000000b6',
      '00000000-0000-4000-8000-000000000014',
      'drive', now(), 0, 1000, 9.9, 0.2, 'low_confidence',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'L2: a low_confidence shot must not carry an overall_score';
  exception when check_violation then null;
  end;
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000b6',
      '00000000-0000-4000-8000-000000000014',
      'drive', now(), 0, 1000, null, 0.2, 'low_confidence',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
  if (select count(*) from public.shots where user_id = (select auth.uid())) <> 1 then
    raise exception 'L2: an unscored abstention must still be writable without a permit';
  end if;
end $$;

-- L3: the canonical path is untouched — reserve, then sync, twice.
do $$
declare v text; p uuid; i int;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('liam-key-' || i);
    v := public.apply_synced_shot(jsonb_build_object(
      'id', ('00000000-0000-4000-8000-0000000000b' || (6 + i))::uuid,
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
      raise exception 'L3: the RPC path must still accept free rating % (got %)', i, v;
    end if;
  end loop;
  if (select count(*) from public.analysis_permits
      where user_id = (select auth.uid()) and status = 'finalized') <> 2 then
    raise exception 'L3: both permits must be finalized by the sync';
  end if;
end $$;

-- L4: at the limit, a direct scored INSERT is refused even when the client
-- manufactures a reserved permit for itself (the grant allows the permit row;
-- the allowance does not).
do $$
begin
  insert into public.analysis_permits (user_id, idempotency_key)
  values ('00000000-0000-4000-8000-000000000014', 'liam-forged-key');
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000ba',
      '00000000-0000-4000-8000-000000000014',
      'drive', now(), 0, 1000, 9.9, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'L4: a third scored shot must be refused even with a reserved permit';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.shots
      where user_id = (select auth.uid()) and result_kind = 'scored') <> 2 then
    raise exception 'L4: a free account must never exceed two scored shots by any write path';
  end if;
end $$;

-- L5: a multi-row INSERT cannot smuggle a scored row past the gate beside an
-- abstention — the whole statement fails.
do $$
begin
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values
    ('00000000-0000-4000-8000-0000000000bb',
     '00000000-0000-4000-8000-000000000014',
     'drive', now(), 0, 1000, null, 0.2, 'low_confidence',
     '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
     'scoring-1', 'config-1'),
    ('00000000-0000-4000-8000-0000000000bc',
     '00000000-0000-4000-8000-000000000014',
     'drive', now(), 0, 1000, 9.9, 0.9, 'scored',
     '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
     'scoring-1', 'config-1');
    raise exception 'L5: a batch carrying a scored row must be refused as a whole';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.shots
             where id in ('00000000-0000-4000-8000-0000000000bb',
                          '00000000-0000-4000-8000-0000000000bc')) then
    raise exception 'L5: no row of the refused batch may persist';
  end if;
end $$;

-- L6: the refused writes changed nothing the app can see.
do $$
declare rec record;
begin
  select * into rec from public.access_state();
  if rec.scored_count <> 2 then
    raise exception 'L6: access_state must report 2 scored (got %)', rec.scored_count;
  end if;
end $$;

-- L7: premium bypasses the ALLOWANCE, never the permit: a member past the
-- free limit may write a scored row only while a live permit exists.
reset role;
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000014', true, null)
on conflict (user_id) do update set premium = true, expires_at = null;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000014';
do $$
begin
  -- the permit from L4 is still reserved → a member may write against it
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000bd',
      '00000000-0000-4000-8000-000000000014',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
  update public.analysis_permits set status = 'finalized', outcome = 'scored'
   where user_id = '00000000-0000-4000-8000-000000000014'
     and idempotency_key = 'liam-forged-key';
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000be',
      '00000000-0000-4000-8000-000000000014',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'L7: even a member needs a live permit for a scored row';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.shots
      where user_id = (select auth.uid()) and result_kind = 'scored') <> 3 then
    raise exception 'L7: exactly the permit-backed member row may persist';
  end if;
end $$;
reset role;

-- ============================================================================
-- M. duplicate-sync idempotency + privilege floor
-- (20260906000000_apply_synced_shot_replay_after_lock.sql)
-- ============================================================================

-- M1: sync a shot, then replay the SAME payload — its permit is by then
-- 'finalized' — and it is still 'accepted' with one row. The concurrent form
-- (N copies queued on the advisory lock, each seeing the consumed permit) is
-- pinned on real Postgres by __wf__/xc_pg_rpc_concurrency.test.ts PG3; this
-- is the deterministic single-session form of the same contract.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000015', 'mara@example.com',
        '{"full_name":"Mara"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-mara', '00000000-0000-4000-8000-000000000015',
        '{"sub":"google-sub-mara","email":"mara@example.com"}');
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000fa',
        '00000000-0000-4000-8000-000000000015', 'permit-m1');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000015';
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000fb',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000fa',
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
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'M1: first sync must be accepted (got %)', v;
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = '00000000-0000-4000-8000-0000000000fa'
                   and status = 'finalized') then
    raise exception 'M1: the first sync must finalize the permit';
  end if;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000fb',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000fa',
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
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'accepted' then
    raise exception 'M1: replaying an owned shot must be accepted even with a consumed permit (got %)', v;
  end if;
  if (select count(*) from public.shots
      where id = '00000000-0000-4000-8000-0000000000fb') <> 1 then
    raise exception 'M1: the replay must not duplicate the row';
  end if;
  if (select count(*) from public.analysis_permits
      where user_id = (select auth.uid()) and status = 'finalized') <> 1 then
    raise exception 'M1: the replay must not touch permit state';
  end if;
end $$;

-- M2: a consumed permit presented with a DIFFERENT (unknown) shot id is still
-- refused — the post-lock replay check keys on ownership of the shot id, not
-- on the permit.
do $$
declare v text;
begin
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000fc',
    'analysisPermitId', '00000000-0000-4000-8000-0000000000fa',
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
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  ));
  if v <> 'access.permit_not_reserved' then
    raise exception 'M2: a new shot on a consumed permit must be refused (got %)', v;
  end if;
  if exists (select 1 from public.shots
             where id = '00000000-0000-4000-8000-0000000000fc') then
    raise exception 'M2: the refused write must leave no row';
  end if;
end $$;
reset role;

-- M3: no client role holds TRUNCATE, TRIGGER or REFERENCES on any public
-- table (hosted default privileges grant ALL; the DML grants are untouched).
do $$
declare
  t record;
  r text;
  p text;
begin
  for t in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['TRUNCATE', 'TRIGGER', 'REFERENCES'] loop
        if has_table_privilege(r, format('public.%I', t.relname), p) then
          raise exception 'M3: % must not hold % on public.%', r, p, t.relname;
        end if;
      end loop;
    end loop;
  end loop;
  -- and the DML floor the app relies on is still there
  if not has_table_privilege('authenticated', 'public.shots', 'INSERT')
     or not has_table_privilege('authenticated', 'public.shots', 'SELECT') then
    raise exception 'M3: authenticated must keep SELECT/INSERT on public.shots';
  end if;
end $$;

-- M4: a table created AFTER the migration inherits the floor too.
create table public.m4_probe (id int primary key);
do $$
begin
  if has_table_privilege('authenticated', 'public.m4_probe', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.m4_probe', 'TRIGGER')
     or has_table_privilege('anon', 'public.m4_probe', 'REFERENCES') then
    raise exception 'M4: default privileges must not hand TRUNCATE/TRIGGER/REFERENCES to client roles';
  end if;
end $$;
drop table public.m4_probe;

-- ============================================================================
-- N. offline > 24h: a durable local rating is never dropped from sync
-- (20260906130000_late_permit_sync_durability.sql, OFF-24H-01)
-- ============================================================================
--
-- A scored rating captured on device holds its reserved permit until the
-- outbox drains. Before this migration apply_synced_shot() refused a permit
-- older than 24h (access.permit_expired) and, once the hourly sweep had
-- flipped it to released/expired, refused it again (permit_not_reserved) —
-- both permanent verdicts, so the outbox exhausted the row and the rating
-- vanished from the account. A permit THIS user reserved must back the shot
-- regardless of age; free ratings stay capped by the lifetime scored count
-- (H3/J3 backstop), not by permit age. Only 'reserved' (any age) and
-- released/expired are acceptable backing; every other state keeps its verdict,
-- and the direct table INSERT gate (section L) stays exactly as strict.

reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000016', 'noor@example.com',
   '{"full_name":"Noor"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000017', 'omar@example.com',
   '{"full_name":"Omar"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-noor', '00000000-0000-4000-8000-000000000016',
   '{"sub":"google-sub-noor","email":"noor@example.com"}'),
  ('apple', 'apple-sub-omar', '00000000-0000-4000-8000-000000000017',
   '{"sub":"apple-sub-omar","email":"omar@example.com"}');
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000017', true, null);

-- Permits as the device left them a day (or more) ago. e1/e3/e5/e7/e8 are
-- still 'reserved' (sweep not yet run); e2/e4/e6/e9 were swept to
-- released/expired; ea is a cancelled abstention.
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000016', 'noor-late-1', 'reserved', null,      now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000016', 'noor-late-2', 'released', 'expired', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-000000000016', 'noor-late-3', 'reserved', null,      now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-000000000016', 'noor-late-4', 'released', 'expired', now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-000000000016', 'noor-late-5', 'reserved', null,      now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-000000000017', 'omar-late-6', 'released', 'expired', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000e7', '00000000-0000-4000-8000-000000000017', 'omar-late-7', 'reserved', null,      now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000e8', '00000000-0000-4000-8000-000000000017', 'omar-late-8', 'reserved', null,      now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-000000000017', 'omar-late-9', 'released', 'expired', now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000ea', '00000000-0000-4000-8000-000000000017', 'omar-cancel', 'released', 'cancelled', now() - interval '25 hours');

create function pg_temp.n_shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.n_shot(uuid, uuid, text) to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000016';

-- N0: reserve/access_state semantics are untouched — late holds do not count
-- as reservations, so the slot is available to reserve again.
do $$
declare rec record;
begin
  select * into rec from public.access_state();
  if rec.scored_count <> 0 or rec.reserved_count <> 0 then
    raise exception 'N0: stale holds must not count as reservations (got %)', rec;
  end if;
end $$;

-- N1: a 25h-old permit that is still 'reserved' backs the late sync, and is
-- finalized exactly as a fresh one (finalized/scored).
do $$
declare v text; p record;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d1',
    '00000000-0000-4000-8000-0000000000e1', 'scored'));
  if v <> 'accepted' then
    raise exception 'N1: a late (25h) reserved permit must back its shot (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000e1';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'N1: the late permit must be finalized like a fresh one (got %/%)', p.status, p.outcome;
  end if;
  if (select count(*) from public.shots where id = '00000000-0000-4000-8000-0000000000d1') <> 1 then
    raise exception 'N1: the late shot must be recorded';
  end if;
end $$;

-- N2: a permit the hourly sweep already flipped to released/expired backs
-- the shot too, and ends finalized/scored as well.
do $$
declare v text; p record;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d2',
    '00000000-0000-4000-8000-0000000000e2', 'scored'));
  if v <> 'accepted' then
    raise exception 'N2: a swept (released/expired) permit must back its shot (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000e2';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'N2: the swept permit must be finalized like a fresh one (got %/%)', p.status, p.outcome;
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'N2: both late ratings must count toward the lifetime limit (got %)',
      public.lifetime_scored_count();
  end if;
end $$;

-- N3: THE SAFETY ARGUMENT. Both free ratings are spent; a further late permit
-- — reserved or swept — cannot become a third free rating. The backstop, not
-- permit age, caps the allowance; the permit is released as free_limit_exceeded.
do $$
declare v text; p record;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d3',
    '00000000-0000-4000-8000-0000000000e3', 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'N3: a late reserved permit past the limit must hit the backstop (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000e3';
  if p.status <> 'released' or p.outcome <> 'free_limit_exceeded' then
    raise exception 'N3: the refused late permit must be released/free_limit_exceeded (got %/%)', p.status, p.outcome;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d4',
    '00000000-0000-4000-8000-0000000000e4', 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'N3: a swept permit past the limit must hit the backstop (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000e4';
  if p.status <> 'released' or p.outcome <> 'free_limit_exceeded' then
    raise exception 'N3: the refused swept permit must be released/free_limit_exceeded (got %/%)', p.status, p.outcome;
  end if;
  if (select count(*) from public.shots
      where user_id = (select auth.uid()) and result_kind = 'scored') <> 2 then
    raise exception 'N3: a free account must never exceed two scored shots';
  end if;
end $$;

-- N4: an abstention on a late permit is still free and releases the permit
-- with its own outcome, exactly as a fresh abstention does.
do $$
declare v text; p record;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d5',
    '00000000-0000-4000-8000-0000000000e5', 'low_confidence'));
  if v <> 'accepted' then
    raise exception 'N4: a late abstention must be accepted (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000e5';
  if p.status <> 'released' or p.outcome <> 'low_confidence' then
    raise exception 'N4: the late abstention permit must be released/low_confidence (got %/%)', p.status, p.outcome;
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'N4: an abstention must not move the lifetime count';
  end if;
end $$;

-- N5: idempotent replay stays first — the late shot replayed against its now
-- finalized permit is still 'accepted' with one row; a DIFFERENT shot on that
-- consumed permit, or on a released/free_limit_exceeded one, is refused.
do $$
declare v text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d1',
    '00000000-0000-4000-8000-0000000000e1', 'scored'));
  if v <> 'accepted' then
    raise exception 'N5: replaying the late shot must be accepted (got %)', v;
  end if;
  if (select count(*) from public.shots where id = '00000000-0000-4000-8000-0000000000d1') <> 1 then
    raise exception 'N5: the replay must not duplicate the row';
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d6',
    '00000000-0000-4000-8000-0000000000e1', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'N5: a consumed (finalized) permit must not back a new shot (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d7',
    '00000000-0000-4000-8000-0000000000e3', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'N5: a released/free_limit_exceeded permit must not back a shot (got %)', v;
  end if;
  if exists (select 1 from public.shots
             where id in ('00000000-0000-4000-8000-0000000000d6',
                          '00000000-0000-4000-8000-0000000000d7')) then
    raise exception 'N5: refused writes must leave no row';
  end if;
end $$;
reset role;

-- N6: a member's late permits are accepted too (premium bypasses the
-- allowance, never the permit), and a released/cancelled permit keeps its
-- verdict — only reserved and released/expired are acceptable backing.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000017';
do $$
declare v text; p record;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d8',
    '00000000-0000-4000-8000-0000000000e6', 'scored'));
  if v <> 'accepted' then
    raise exception 'N6: a member''s swept permit must back its shot (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000e6';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'N6: the member''s swept permit must be finalized (got %/%)', p.status, p.outcome;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000d9',
    '00000000-0000-4000-8000-0000000000ea', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'N6: a released/cancelled permit must not back a shot (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000ea';
  if p.status <> 'released' or p.outcome <> 'cancelled' then
    raise exception 'N6: the refused cancelled permit must be untouched (got %/%)', p.status, p.outcome;
  end if;
end $$;

-- N7: ONE late permit backs ONE shot. Two different shots on the same late
-- permit — reserved or swept — the second is refused and only one row lands.
do $$
declare v text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000da',
    '00000000-0000-4000-8000-0000000000e7', 'scored'));
  if v <> 'accepted' then
    raise exception 'N7: first shot on the late reserved permit must be accepted (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000db',
    '00000000-0000-4000-8000-0000000000e7', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'N7: a second shot on the same late permit must be refused (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000dc',
    '00000000-0000-4000-8000-0000000000e9', 'scored'));
  if v <> 'accepted' then
    raise exception 'N7: first shot on the swept permit must be accepted (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000dd',
    '00000000-0000-4000-8000-0000000000e9', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'N7: a second shot on the same swept permit must be refused (got %)', v;
  end if;
  if (select count(*) from public.shots
      where id in ('00000000-0000-4000-8000-0000000000da',
                   '00000000-0000-4000-8000-0000000000db',
                   '00000000-0000-4000-8000-0000000000dc',
                   '00000000-0000-4000-8000-0000000000dd')) <> 2 then
    raise exception 'N7: exactly one shot per late permit may persist';
  end if;
end $$;

-- N8: the direct-INSERT gate is NOT widened. A client writing public.shots
-- straight through PostgREST with only a 25h-old reserved permit, or only a
-- swept one, is still refused (member, so the allowance is not the reason);
-- the SAME late permit then backs the shot through the RPC.
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
      '00000000-0000-4000-8000-0000000000de',
      '00000000-0000-4000-8000-000000000017',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'N8: a direct scored INSERT backed only by a 25h-old reserved permit must be refused';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000de') then
    raise exception 'N8: the refused direct row must not persist';
  end if;
end $$;
-- swept-only: drop the reserved hold so the only live-looking permit is the
-- released/expired one (client role may update its own permit lifecycle columns)
update public.analysis_permits set status = 'released', outcome = 'expired'
 where id = '00000000-0000-4000-8000-0000000000e8';
do $$
declare v text; p record;
begin
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000df',
      '00000000-0000-4000-8000-000000000017',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'N8: a direct scored INSERT backed only by a swept permit must be refused';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000df') then
    raise exception 'N8: the refused direct row must not persist';
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000e0',
    '00000000-0000-4000-8000-0000000000e8', 'scored'));
  if v <> 'accepted' then
    raise exception 'N8: the RPC must accept the same swept permit the direct path refused (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000e8';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'N8: the RPC-consumed swept permit must be finalized (got %/%)', p.status, p.outcome;
  end if;
end $$;
reset role;

-- N9: access.permit_expired is retired from apply_synced_shot — no reachable
-- branch returns it, so the outbox can never exhaust a row on it.
do $$
begin
  if position('access.permit_expired' in pg_get_functiondef('public.apply_synced_shot(jsonb)'::regprocedure)) > 0 then
    raise exception 'N9: apply_synced_shot must no longer return access.permit_expired';
  end if;
end $$;

-- ============================================================================
-- O. late-permit acceptance is a CLOSED set: released/<NULL outcome>
-- (adversary round 6, cluster sync-permit-durability, OFF-24H-01)
-- ============================================================================
--
-- The 20260906130000 contract: acceptable backing is EXACTLY reserved (any
-- age) or released/expired; "every other state keeps its verdict" —
-- access.permit_not_reserved, as 1fb0efd7 returned for any non-reserved
-- permit. `released` with a NULL outcome is one of those states and is
-- client-reachable: `authenticated` holds UPDATE(status, outcome) on
-- analysis_permits under analysis_permits_update_own (section N8 relies on
-- the same grant), so `PATCH /rest/v1/analysis_permits?id=eq.<own>` with
-- {"status":"released","outcome":null} produces it. The RPC's check
--   not (status = 'reserved' or (status = 'released' and outcome = 'expired'))
-- is three-valued: outcome IS NULL makes the whole predicate NULL, `if NULL`
-- does not fire, and the permit falls through as if it were acceptable.

reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000018', 'pia@example.com',
        '{"full_name":"Pia"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-pia', '00000000-0000-4000-8000-000000000018',
        '{"sub":"apple-sub-pia","email":"pia@example.com"}');
-- member: the lifetime allowance can never be the reason for a verdict here
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000018', true, null);
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
values
  ('00000000-0000-4000-8000-0000000000f5', '00000000-0000-4000-8000-000000000018', 'pia-late-1', 'reserved', null, now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000f6', '00000000-0000-4000-8000-000000000018', 'pia-late-2', 'reserved', null, now() - interval '25 hours');

-- What a client COULD do through PostgREST with its own bearer before
-- 20260906140000 closed the lifecycle at the table (P1 below pins that the
-- same UPDATE is now refused). Rows in this state may still exist from before
-- the fix, so the fixture writes them the only way left — as the table owner
-- with the lifecycle guard switched off — and the assertions below are the
-- adversary's, unchanged: the RPC must refuse them on its own.
alter table public.analysis_permits disable trigger analysis_permits_guard_lifecycle;
update public.analysis_permits set status = 'released', outcome = null
 where id = '00000000-0000-4000-8000-0000000000f5';
update public.analysis_permits set status = 'released', outcome = null
 where id = '00000000-0000-4000-8000-0000000000f6';
alter table public.analysis_permits enable trigger analysis_permits_guard_lifecycle;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000018';

-- O1: released/NULL, no other permit → must be access.permit_not_reserved
-- (the verdict 1fb0efd7 gave and the migration promises). Anything else is a
-- contract change: shot.write_failed:* is TRANSIENT for the mobile outbox
-- (sync.ts TRANSIENT_SYNC_REJECTION_CODES) and burns attempts to exhausted.
-- O2: released/NULL beside a LIVE reservation. The trigger's fallback ("some
-- reserved permit younger than 24h") lets the RPC's insert through, so the
-- shot is accepted on a permit that is NOT acceptable backing, the finalize
-- UPDATE matches nothing (permit stays released/NULL), and the SAME permit
-- backs a second, different shot — the one-permit-one-shot invariant (N7)
-- no longer holds.
-- Every deviation is collected and raised together so one run shows the
-- whole observed-vs-expected picture.
do $$
declare v text; r record; p record; failures text[] := '{}';
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000f7',
    '00000000-0000-4000-8000-0000000000f5', 'scored'));
  if v <> 'access.permit_not_reserved' then
    failures := failures || format('O1: a released permit with a NULL outcome must keep its old verdict access.permit_not_reserved (got %s)', v);
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000f7') then
    failures := failures || 'O1: no row may land on a released/NULL permit';
  end if;

  select * into r from public.reserve_analysis_permit('pia-live');
  if r.result <> 'accepted' then
    raise exception 'O2 precondition: fresh reserve must succeed (got %)', r.result;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000f8',
    '00000000-0000-4000-8000-0000000000f6', 'scored'));
  if v <> 'access.permit_not_reserved' then
    failures := failures || format('O2: released/NULL must be refused even while a live reservation exists (got %s)', v);
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-0000000000f9',
    '00000000-0000-4000-8000-0000000000f6', 'scored'));
  if v <> 'access.permit_not_reserved' then
    failures := failures || format('O2: a second shot on the same released/NULL permit must be refused (got %s)', v);
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000f6';
  if p.status <> 'released' or p.outcome is not null then
    failures := failures || format('O2: a refused permit must be untouched (got %s/%s)', p.status, p.outcome);
  end if;
  if (select count(*) from public.shots
      where id in ('00000000-0000-4000-8000-0000000000f8',
                   '00000000-0000-4000-8000-0000000000f9')) <> 0 then
    failures := failures || format('O2: no shot may persist on a released/NULL permit (got %s rows)',
      (select count(*) from public.shots
        where id in ('00000000-0000-4000-8000-0000000000f8',
                     '00000000-0000-4000-8000-0000000000f9')));
  end if;
  if cardinality(failures) > 0 then
    raise exception E'section O failed:\n  %', array_to_string(failures, E'\n  ');
  end if;
end $$;
reset role;

-- ============================================================================
-- P. the permit lifecycle is closed at the table, backing is NULL-safe and
-- default-deny, and the sync gate never falls back to an unrelated permit
-- (20260906140000_permit_lifecycle_null_safe.sql, OFF-24H-02)
-- ============================================================================
--
-- P1  a client cannot manufacture released/NULL, finalized/NULL, an unknown
--     outcome, or a reserved row with an outcome — 23514, permit untouched
-- P2  every legal transition still works: edge finalize (reserved →
--     finalized/cancelled), the pg_cron sweep statement (reserved →
--     released/expired), the RPC consuming a fresh permit (→ finalized/scored),
--     an abstention (→ released/low_confidence) and a swept permit (→
--     finalized/scored, round-6 late acceptance preserved)
-- P3  both free slots spent → access.paywall_required and the permit ends
--     released/free_limit_exceeded (legal transition)
-- P4  settled permits are terminal for every role: consumed / free-limit /
--     cancelled permits cannot be revived to reserved or re-labelled to
--     released/expired (23514), and the RPC keeps refusing them
-- P5  a pre-existing released/NULL permit (written before the guard) is
--     refused by the direct-INSERT gate, by the RPC (with and without an
--     unrelated live reservation), and by the gate even when it is the
--     vouched permit beside a live reservation — and cannot be re-labelled
--     into acceptable backing by anyone

reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000019', 'quinn@example.com',
   '{"full_name":"Quinn"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000020', 'rosa@example.com',
   '{"full_name":"Rosa"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-quinn', '00000000-0000-4000-8000-000000000019',
   '{"sub":"google-sub-quinn","email":"quinn@example.com"}'),
  ('apple', 'apple-sub-rosa', '00000000-0000-4000-8000-000000000020',
   '{"sub":"apple-sub-rosa","email":"rosa@example.com"}');
-- Both are free accounts: the allowance is live here on purpose.
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000019', 'quinn-p1', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000019', 'quinn-p2', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000019', 'quinn-p3', 'reserved', null, now() - interval '25 hours'),
  ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000019', 'quinn-p4', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000019', 'quinn-p5', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000019', 'quinn-p6', 'finalized', 'scored', now()),
  ('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000019', 'quinn-p7', 'released', 'free_limit_exceeded', now()),
  ('00000000-0000-4000-8000-000000000108', '00000000-0000-4000-8000-000000000020', 'rosa-p8', 'reserved', null, now() - interval '25 hours');
-- rosa-p8 as a pre-fix client left it: released/NULL (guard bypassed as owner).
alter table public.analysis_permits disable trigger analysis_permits_guard_lifecycle;
update public.analysis_permits set status = 'released', outcome = null
 where id = '00000000-0000-4000-8000-000000000108';
alter table public.analysis_permits enable trigger analysis_permits_guard_lifecycle;

-- Attempts an UPDATE on the caller's own permit and returns the SQLSTATE /
-- hint the table answered with ('' when it was allowed).
create function pg_temp.p_move(p_id uuid, p_status text, p_outcome text)
returns text language plpgsql as $$
declare v_state text; v_hint text;
begin
  update public.analysis_permits set status = p_status, outcome = p_outcome where id = p_id;
  return '';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end $$;
grant execute on function pg_temp.p_move(uuid, text, text) to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000019';

-- P1: the client PostgREST-style forge paths are refused at the table with a
-- 4xx-class SQLSTATE (23514 → PostgREST 400 / edge 409), never a 503.
do $$
declare r text; p record;
begin
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000101', 'released', null);
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'P1: reserved → released/NULL must be refused with 23514 (got %)', r;
  end if;
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000101', 'finalized', null);
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'P1: reserved → finalized/NULL must be refused with 23514 (got %)', r;
  end if;
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000101', 'released', 'bogus');
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'P1: an unknown outcome must be refused with 23514 (got %)', r;
  end if;
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000101', 'reserved', 'scored');
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'P1: a reserved permit cannot carry an outcome (got %)', r;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000101';
  if p.status <> 'reserved' or p.outcome is not null then
    raise exception 'P1: the refused permit must be untouched (got %/%)', p.status, p.outcome;
  end if;
end $$;

-- P2: every legal transition the product performs still goes through.
do $$
declare r text; v text; p record;
begin
  -- edge POST /v1/analysis-permits/:id/finalize {outcome:'cancelled'}
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000102', 'finalized', 'cancelled');
  if r <> '' then
    raise exception 'P2: reserved → finalized/cancelled (edge finalize) must be allowed (got %)', r;
  end if;
  -- idempotent replay of the same finalize is a no-op, not a transition
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000102', 'finalized', 'cancelled');
  if r <> '' then
    raise exception 'P2: a no-op lifecycle UPDATE must be allowed (got %)', r;
  end if;
  -- the sync RPC consuming a fresh permit → finalized/scored
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000111',
    '00000000-0000-4000-8000-000000000104', 'scored'));
  if v <> 'accepted' then
    raise exception 'P2: a fresh reserved permit must back its shot (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000104';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'P2: the consumed permit must be finalized/scored (got %/%)', p.status, p.outcome;
  end if;
  -- an abstention → released/low_confidence
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000112',
    '00000000-0000-4000-8000-000000000105', 'low_confidence'));
  if v <> 'accepted' then
    raise exception 'P2: an abstention must be accepted (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000105';
  if p.status <> 'released' or p.outcome <> 'low_confidence' then
    raise exception 'P2: the abstention permit must be released/low_confidence (got %/%)', p.status, p.outcome;
  end if;
end $$;
reset role;
-- the pg_cron sweep (expire-stale-analysis-permits, 20260831000000) — the
-- exact statement it runs, as the job owner
update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';
do $$
declare p record;
begin
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000103';
  if p.status <> 'released' or p.outcome <> 'expired' then
    raise exception 'P2: the sweep must still move a stale reservation to released/expired (got %/%)', p.status, p.outcome;
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000019';
do $$
declare v text; p record;
begin
  -- the swept permit backs its late shot and ends finalized/scored (round 6)
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000113',
    '00000000-0000-4000-8000-000000000103', 'scored'));
  if v <> 'accepted' then
    raise exception 'P2: a swept (released/expired) permit must still back its late shot (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000103';
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'P2: the swept permit must be finalized/scored (got %/%)', p.status, p.outcome;
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'P2: both ratings must count toward the lifetime limit (got %)', public.lifetime_scored_count();
  end if;
end $$;

-- P3: both free slots are spent — a further fresh permit hits the backstop and
-- the permit ends released/free_limit_exceeded (a legal transition).
do $$
declare v text; p record;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000114',
    '00000000-0000-4000-8000-000000000101', 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'P3: a third free rating must hit the backstop (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000101';
  if p.status <> 'released' or p.outcome <> 'free_limit_exceeded' then
    raise exception 'P3: the refused permit must be released/free_limit_exceeded (got %/%)', p.status, p.outcome;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000114') then
    raise exception 'P3: the refused shot must not persist';
  end if;
end $$;

-- P4: settled permits are terminal — no revival, no re-labelling into
-- acceptable backing — and the RPC keeps refusing them.
do $$
declare r text; v text;
begin
  foreach r in array array[
    pg_temp.p_move('00000000-0000-4000-8000-000000000106', 'reserved', null),
    pg_temp.p_move('00000000-0000-4000-8000-000000000106', 'released', 'expired'),
    pg_temp.p_move('00000000-0000-4000-8000-000000000107', 'reserved', null),
    pg_temp.p_move('00000000-0000-4000-8000-000000000107', 'released', 'expired'),
    pg_temp.p_move('00000000-0000-4000-8000-000000000102', 'reserved', null),
    pg_temp.p_move('00000000-0000-4000-8000-000000000102', 'released', 'expired'),
    pg_temp.p_move('00000000-0000-4000-8000-000000000104', 'released', 'low_confidence')]
  loop
    if r <> '23514:access.permit_transition_rejected' then
      raise exception 'P4: a settled permit must be terminal (got %)', r;
    end if;
  end loop;
  foreach v in array array[
    public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000115', '00000000-0000-4000-8000-000000000106', 'scored')),
    public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000116', '00000000-0000-4000-8000-000000000107', 'scored')),
    public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000117', '00000000-0000-4000-8000-000000000102', 'scored'))]
  loop
    if v <> 'access.permit_not_reserved' then
      raise exception 'P4: a consumed/free-limit/cancelled permit must keep its verdict (got %)', v;
    end if;
  end loop;
  if exists (select 1 from public.shots where id in (
      '00000000-0000-4000-8000-000000000115',
      '00000000-0000-4000-8000-000000000116',
      '00000000-0000-4000-8000-000000000117')) then
    raise exception 'P4: refused writes must leave no row';
  end if;
end $$;
reset role;
-- ... for every role: the table owner cannot revive a consumed permit either
do $$
declare r text;
begin
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000106', 'reserved', null);
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'P4: the lifecycle guard must bind every role (owner got %)', r;
  end if;
end $$;

-- P5: a released/NULL permit that pre-dates the guard.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000020';
do $$
declare v text; r record; v_state text; v_hint text;
begin
  -- direct scored INSERT: the BEFORE INSERT gate refuses (only permit is
  -- released/NULL), 42501 with the verdict in the hint
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-000000000121',
      '00000000-0000-4000-8000-000000000020',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'P5: a direct scored INSERT backed only by a released/NULL permit must be refused';
  exception when insufficient_privilege then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint <> 'access.permit_not_reserved' then
      raise exception 'P5: the gate refusal must carry the contract verdict (got hint %)', v_hint;
    end if;
  end;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000121') then
    raise exception 'P5: the refused direct row must not persist';
  end if;

  -- RPC, no other permit: the verdict, never shot.write_failed:42501
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000122',
    '00000000-0000-4000-8000-000000000108', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'P5: released/NULL must be refused by the RPC (got %)', v;
  end if;

  -- RPC beside an unrelated LIVE reservation: still the named permit's verdict
  select * into r from public.reserve_analysis_permit('rosa-live');
  if r.result <> 'accepted' then
    raise exception 'P5 precondition: fresh reserve must succeed (got %)', r.result;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000123',
    '00000000-0000-4000-8000-000000000108', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'P5: released/NULL must be refused even beside a live reservation (got %)', v;
  end if;

  -- the gate itself, white-box: vouch for the released/NULL permit while the
  -- live reservation exists — the vouched permit alone decides, no fallback
  perform set_config('pickle.sync_permit_id', '00000000-0000-4000-8000-000000000108', true);
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-000000000124',
      '00000000-0000-4000-8000-000000000020',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'P5: the gate must not fall back to an unrelated live reservation when the vouched permit is unacceptable';
  exception
    when sqlstate 'PKP01' then
      -- the verdict SQLSTATE the RPC maps to access.permit_not_reserved
      get stacked diagnostics v_hint = pg_exception_hint;
      if v_hint <> 'access.permit_not_reserved' then
        raise exception 'P5: the vouched-permit refusal must carry the contract verdict (got hint %)', v_hint;
      end if;
    when insufficient_privilege then
      raise exception 'P5: a vouched-permit refusal must raise the verdict SQLSTATE PKP01, not 42501 (the RPC would return shot.write_failed:42501)';
  end;
  perform set_config('pickle.sync_permit_id', '', true);

  -- the live reservation itself still works exactly as before
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000125', r.permit_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'P5: the unrelated live reservation must still back its own shot (got %)', v;
  end if;

  if (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-000000000020') <> 1 then
    raise exception 'P5: exactly one shot (the live permit''s) may persist (got %)',
      (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-000000000020');
  end if;

  -- and nobody can re-label the released/NULL row into acceptable backing
  v_state := pg_temp.p_move('00000000-0000-4000-8000-000000000108', 'released', 'expired');
  if v_state <> '23514:access.permit_transition_rejected' then
    raise exception 'P5: released/NULL → released/expired must be refused (got %)', v_state;
  end if;
  v_state := pg_temp.p_move('00000000-0000-4000-8000-000000000108', 'reserved', null);
  if v_state <> '23514:access.permit_transition_rejected' then
    raise exception 'P5: released/NULL → reserved must be refused (got %)', v_state;
  end if;
end $$;
reset role;
do $$
declare r text;
begin
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000108', 'released', 'expired');
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'P5: the owner cannot re-label released/NULL into acceptable backing either (got %)', r;
  end if;
end $$;

-- ============================================================================
-- Q. a settled permit is terminal for the CLIENT ROLE too, and one permit
-- backs at most one shot in the DATA, whatever the permit row says
-- (20260907000000_permit_terminal_client_role.sql,
-- ADV7-PERMIT-REUSE-DELETE-REINSERT / OFF-24H-02 follow-up)
-- ============================================================================
--
-- Q1  owner DELETE of an own permit — reserved, finalized, released — is
--     42501; anon too; every row stays
-- Q2  owner INSERT naming `id` (any status) or `created_at`/`updated_at` is
--     42501; the product shape (user_id, idempotency_key[, status, outcome])
--     is still allowed with a server-assigned id, and a client-written
--     finalized/scored row is not a rating anywhere and backs nothing
-- Q3  THE ATTACK, as the owner: reserve → sync accepted → DELETE 42501 →
--     re-INSERT the id 42501 → second sync on the permit is
--     access.permit_not_reserved → exactly one shot, linked to the permit,
--     the permit still finalized/scored
-- Q4  no resurrection by any role: after the owner removes the consumed
--     permit row, re-creating its id is 23514 + access.permit_transition_
--     rejected (definer BEFORE INSERT guard); a second shot on the consumed
--     permit id is 23505 for the owner; the RPC answers permit_not_reserved
--     (the id is consumed, not unknown — 20260907100000 tombstone)
-- Q5  shots.analysis_permit_id is the RPC's column: a client INSERT naming it
--     (live permit, scored or abstention, with or without a mismatched
--     vouch) is 42501 + access.permit_not_reserved and writes nothing
-- Q6  legitimate writers still work: same-shot replay stays accepted with
--     one row and the link intact; an abstention records the link and
--     releases; the sweep + late sync consume a swept permit once and refuse
--     it the second time; edge finalize/release UPDATEs go through; a
--     client-written released/expired row is still capped by the allowance
-- Q7  premium / no-permit rows are untouched: several link-less direct
--     scored rows coexist (partial index), a member's sync records the link
-- Q8  auth.users delete still cascades permits (including the one linked to
--     a shot) and the identity ledger row survives; the freed id may then be
--     re-issued by the owner (no tombstone leak)

reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000021', 'sam@example.com',
   '{"full_name":"Sam"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000022', 'tess@example.com',
   '{"full_name":"Tess"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-sam', '00000000-0000-4000-8000-000000000021',
   '{"sub":"google-sub-sam","email":"sam@example.com"}'),
  ('apple', 'apple-sub-tess', '00000000-0000-4000-8000-000000000022',
   '{"sub":"apple-sub-tess","email":"tess@example.com"}');
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000022', true, null);
-- Sam: one of each settled state plus a live reservation, seeded by the owner
-- (the client cannot name an id — Q2).
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000021', 'sam-p1', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000021', 'sam-p2', 'finalized', 'cancelled', now()),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000021', 'sam-p3', 'released', 'expired', now() - interval '25 hours');

-- Runs one statement as the current role and returns 'allowed <n>' or
-- '<SQLSTATE>:<hint>'.
create function pg_temp.q_try(p_sql text) returns text
language plpgsql as $$
declare n integer; v_state text; v_hint text;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'allowed ' || n;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end $$;

create function pg_temp.q_direct_shot(p_id uuid, p_user uuid, p_kind text, p_permit uuid)
returns text language plpgsql as $$
begin
  return pg_temp.q_try(format(
    $q$insert into public.shots (
         id, user_id, analysis_permit_id, shot_type, captured_at, start_ms, end_ms,
         overall_score, analysis_confidence, result_kind,
         app_version, model_bundle_version, pose_model_version,
         paddle_model_version, stroke_detector_version, phase_model_version,
         scoring_model_version, shot_config_version
       ) values (%L, %L, %L, 'drive', now(), 0, 1000, %s, %s, %L,
         '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
         'scoring-1', 'config-1')$q$,
    p_id, p_user, p_permit,
    case when p_kind = 'scored' then '8.0' else 'null' end,
    case when p_kind = 'scored' then '0.9' else '0.2' end,
    p_kind));
end $$;
grant execute on function pg_temp.q_try(text) to authenticated, anon;
grant execute on function pg_temp.q_direct_shot(uuid, uuid, text, uuid) to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000021';

-- Q1: the owner cannot DELETE any of its permits.
do $$
declare r text; pid text;
begin
  foreach pid in array array[
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202',
    '00000000-0000-4000-8000-000000000203']
  loop
    r := pg_temp.q_try(format('delete from public.analysis_permits where id = %L', pid));
    if r <> '42501:' then
      raise exception 'Q1: owner DELETE of permit % must be 42501 (got %)', pid, r;
    end if;
  end loop;
  r := pg_temp.q_try('delete from public.analysis_permits');
  if r <> '42501:' then
    raise exception 'Q1: an unfiltered owner DELETE must be 42501 (got %)', r;
  end if;
  if (select count(*) from public.analysis_permits
      where user_id = '00000000-0000-4000-8000-000000000021') <> 3 then
    raise exception 'Q1: every permit row must survive the refused DELETEs';
  end if;
end $$;
set local role anon;
do $$
declare r text;
begin
  r := pg_temp.q_try('delete from public.analysis_permits');
  if r <> '42501:' then
    raise exception 'Q1: anon DELETE must be 42501 (got %)', r;
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000021';

-- Q2: the owner cannot name a permit id (reserved or settled) or back-date
-- one; the product shape still works and a client-written settled row
-- confers nothing.
do $$
declare r text; p_id uuid; v text; rec record; n_before integer;
begin
  r := pg_temp.q_try($q$insert into public.analysis_permits (id, user_id, idempotency_key)
    values ('00000000-0000-4000-8000-000000000211', '00000000-0000-4000-8000-000000000021', 'sam-forge-1')$q$);
  if r <> '42501:' then
    raise exception 'Q2: INSERT naming id (reserved) must be 42501 (got %)', r;
  end if;
  r := pg_temp.q_try($q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
    values ('00000000-0000-4000-8000-000000000212', '00000000-0000-4000-8000-000000000021', 'sam-forge-2', 'finalized', 'scored')$q$);
  if r <> '42501:' then
    raise exception 'Q2: INSERT naming id (finalized/scored) must be 42501 (got %)', r;
  end if;
  r := pg_temp.q_try($q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
    values ('00000000-0000-4000-8000-000000000213', '00000000-0000-4000-8000-000000000021', 'sam-forge-3', 'released', 'expired')$q$);
  if r <> '42501:' then
    raise exception 'Q2: INSERT naming id (released/expired) must be 42501 (got %)', r;
  end if;
  r := pg_temp.q_try($q$insert into public.analysis_permits (user_id, idempotency_key, created_at)
    values ('00000000-0000-4000-8000-000000000021', 'sam-forge-4', now() - interval '3 days')$q$);
  if r <> '42501:' then
    raise exception 'Q2: INSERT naming created_at must be 42501 (got %)', r;
  end if;
  r := pg_temp.q_try($q$insert into public.analysis_permits (user_id, idempotency_key, updated_at)
    values ('00000000-0000-4000-8000-000000000021', 'sam-forge-5', now())$q$);
  if r <> '42501:' then
    raise exception 'Q2: INSERT naming updated_at must be 42501 (got %)', r;
  end if;
  if exists (select 1 from public.analysis_permits
             where idempotency_key like 'sam-forge-%') then
    raise exception 'Q2: no forged permit row may exist';
  end if;

  -- the product shape (what reserve_analysis_permit() writes as the caller)
  insert into public.analysis_permits (user_id, idempotency_key)
  values ('00000000-0000-4000-8000-000000000021', 'sam-shape-ok')
  returning id into p_id;
  if p_id is null or exists (select 1 from public.analysis_permits
                             where id = p_id and (status <> 'reserved' or outcome is not null)) then
    raise exception 'Q2: the product-shape INSERT must yield a reserved/NULL row with a server id';
  end if;
  -- and the edge finalize UPDATE settles it like any reservation (frees the
  -- live slot for Q3)
  r := pg_temp.q_try(format($q$update public.analysis_permits
    set status = 'finalized', outcome = 'cancelled' where id = %L$q$, p_id));
  if r <> 'allowed 1' then
    raise exception 'Q2: the edge finalize UPDATE must still be allowed (got %)', r;
  end if;

  -- a client-written finalized/scored row is not a rating anywhere
  select public.lifetime_scored_count() into n_before;
  insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
  values ('00000000-0000-4000-8000-000000000021', 'sam-settled-forge', 'finalized', 'scored');
  select * into rec from public.access_state();
  if public.lifetime_scored_count() <> n_before or rec.scored_count <> n_before then
    raise exception 'Q2: a client-written finalized/scored permit must not count as a rating';
  end if;
  -- and it never backs a shot
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000221',
    (select id from public.analysis_permits where idempotency_key = 'sam-settled-forge'), 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'Q2: a client-written finalized/scored permit must not back a shot (got %)', v;
  end if;
end $$;

-- Q3: THE ATTACK (ADV-10), as the owner through the client role.
do $$
declare r record; v text; p_id uuid; d text; i text; n integer;
begin
  select * into r from public.reserve_analysis_permit('sam-attack');
  if r.result <> 'accepted' then
    raise exception 'Q3 precondition: reserve must succeed (got %)', r.result;
  end if;
  p_id := r.permit_id;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000231', p_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'Q3 precondition: first sync must be accepted (got %)', v;
  end if;
  if not exists (select 1 from public.shots
                 where id = '00000000-0000-4000-8000-000000000231'
                   and analysis_permit_id = p_id) then
    raise exception 'Q3: the synced shot must record the permit it consumed';
  end if;

  d := pg_temp.q_try(format('delete from public.analysis_permits where id = %L', p_id));
  i := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key)
       values (%L, '00000000-0000-4000-8000-000000000021', 'sam-attack-again')$q$, p_id));
  if d <> '42501:' or i <> '42501:' then
    raise exception 'Q3: DELETE + re-INSERT of the consumed permit must both be 42501 (got % / %)', d, i;
  end if;

  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000232', p_id, 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'Q3: a second shot on the consumed permit must be access.permit_not_reserved (got %)', v;
  end if;
  select count(*) into n from public.shots where analysis_permit_id = p_id;
  if n <> 1 then
    raise exception 'Q3: exactly one shot may be linked to the permit (got %)', n;
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = p_id and status = 'finalized' and outcome = 'scored') then
    raise exception 'Q3: the consumed permit must still be finalized/scored';
  end if;
end $$;

-- Q4: no resurrection for ANY role. The owner (cascade/maintenance path, no
-- JWT claim) removes the consumed permit row; its id can never be created
-- again as a reservation, a second shot on the id is refused by the index,
-- and the RPC reports the id consumed (the settled row left a tombstone —
-- 20260907100000; section R covers the exact restore).
reset role;
set local request.jwt.claim.sub = '';
do $$
declare p_id uuid; r text;
begin
  select analysis_permit_id into p_id from public.shots
   where id = '00000000-0000-4000-8000-000000000231';
  delete from public.analysis_permits where id = p_id;
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key)
       values (%L, '00000000-0000-4000-8000-000000000021', 'sam-resurrect')$q$, p_id));
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'Q4: re-creating a consumed permit id must be 23514 + access.permit_transition_rejected even for the owner (got %)', r;
  end if;
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
       values (%L, '00000000-0000-4000-8000-000000000021', 'sam-resurrect-2', 'released', 'expired')$q$, p_id));
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'Q4: re-creating a consumed permit id as released/expired must be refused too (got %)', r;
  end if;
  r := pg_temp.q_direct_shot('00000000-0000-4000-8000-000000000233',
    '00000000-0000-4000-8000-000000000021', 'scored', p_id);
  if r <> '23505:' then
    raise exception 'Q4: a second shot on a consumed permit id must be 23505 for the owner (got %)', r;
  end if;
  if (select count(*) from public.shots where analysis_permit_id = p_id) <> 1 then
    raise exception 'Q4: still exactly one shot on the permit id';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000021';
do $$
declare p_id uuid; v text;
begin
  select analysis_permit_id into p_id from public.shots
   where id = '00000000-0000-4000-8000-000000000231';
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000234', p_id, 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'Q4: the RPC must report the removed settled permit as consumed (got %)', v;
  end if;
  -- replay of the shot that consumed it is still an idempotent accept
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000231', p_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'Q4: replaying the held shot must stay accepted (got %)', v;
  end if;
end $$;

-- Q5: shots.analysis_permit_id is written only under the RPC's vouch.
do $$
declare r text;
begin
  -- live reserved permit (201), scored, client names it directly
  r := pg_temp.q_direct_shot('00000000-0000-4000-8000-000000000241',
    '00000000-0000-4000-8000-000000000021', 'scored', '00000000-0000-4000-8000-000000000201');
  if r <> '42501:access.permit_not_reserved' then
    raise exception 'Q5: a client INSERT naming analysis_permit_id must be 42501 + access.permit_not_reserved (got %)', r;
  end if;
  -- abstention rows too — the link is never the client's to write
  r := pg_temp.q_direct_shot('00000000-0000-4000-8000-000000000242',
    '00000000-0000-4000-8000-000000000021', 'low_confidence', '00000000-0000-4000-8000-000000000201');
  if r <> '42501:access.permit_not_reserved' then
    raise exception 'Q5: an abstention naming analysis_permit_id must be refused too (got %)', r;
  end if;
  -- white-box: a vouch for one permit cannot be used to link another
  perform set_config('pickle.sync_permit_id', '00000000-0000-4000-8000-000000000201', true);
  r := pg_temp.q_direct_shot('00000000-0000-4000-8000-000000000243',
    '00000000-0000-4000-8000-000000000021', 'scored', '00000000-0000-4000-8000-000000000203');
  perform set_config('pickle.sync_permit_id', '', true);
  if r <> '42501:access.permit_not_reserved' then
    raise exception 'Q5: a mismatched vouch/link pair must be refused (got %)', r;
  end if;
  if exists (select 1 from public.shots where id in (
      '00000000-0000-4000-8000-000000000241',
      '00000000-0000-4000-8000-000000000242',
      '00000000-0000-4000-8000-000000000243')) then
    raise exception 'Q5: no refused row may persist';
  end if;
  -- the pre-fix direct path (no link, live permit) is unchanged and records
  -- no link
  r := pg_temp.q_direct_shot('00000000-0000-4000-8000-000000000244',
    '00000000-0000-4000-8000-000000000021', 'scored', null);
  if r <> 'allowed 1' then
    raise exception 'Q5: the link-less direct INSERT under a live permit must still be allowed (got %)', r;
  end if;
  if (select analysis_permit_id from public.shots
      where id = '00000000-0000-4000-8000-000000000244') is not null then
    raise exception 'Q5: a direct INSERT must not acquire a permit link';
  end if;
end $$;

-- Q6: legitimate writers. Sam has spent both free ratings by now (Q3 + Q5),
-- so the remaining flows are proven on Tess (member) and on Sam's abstention.
do $$
declare v text; p record;
begin
  -- abstention on the live reservation: link recorded, permit released
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000251', '00000000-0000-4000-8000-000000000201', 'low_confidence'));
  if v <> 'accepted' then
    raise exception 'Q6: an abstention sync must be accepted (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000201';
  if p.status <> 'released' or p.outcome <> 'low_confidence' then
    raise exception 'Q6: the abstention must release its permit (got %/%)', p.status, p.outcome;
  end if;
  if not exists (select 1 from public.shots
                 where id = '00000000-0000-4000-8000-000000000251'
                   and analysis_permit_id = '00000000-0000-4000-8000-000000000201') then
    raise exception 'Q6: the abstention row must record its permit';
  end if;
  -- a second abstention on the same permit is refused (index + state)
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000252', '00000000-0000-4000-8000-000000000201', 'low_confidence'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'Q6: a second shot on a released permit must be refused (got %)', v;
  end if;
  -- same-shot replay: accepted, one row, link intact
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000251', '00000000-0000-4000-8000-000000000201', 'low_confidence'));
  if v <> 'accepted' then
    raise exception 'Q6: same-shot replay must stay accepted (got %)', v;
  end if;
  if (select count(*) from public.shots
      where analysis_permit_id = '00000000-0000-4000-8000-000000000201') <> 1 then
    raise exception 'Q6: the replay must not duplicate the linked row';
  end if;
  -- the edge finalize replay (no-op on a settled row) still works
  if pg_temp.q_try($q$update public.analysis_permits set status = 'finalized', outcome = 'cancelled'
      where id = '00000000-0000-4000-8000-000000000202'$q$) <> 'allowed 1' then
    raise exception 'Q6: the edge finalize no-op replay must be allowed';
  end if;
  -- a client-written released/expired row is acceptable backing in shape
  -- (round 6) but buys nothing past the allowance: Sam is at the limit
  insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
  values ('00000000-0000-4000-8000-000000000021', 'sam-expired-forge', 'released', 'expired');
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000253',
    (select id from public.analysis_permits where idempotency_key = 'sam-expired-forge'), 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'Q6: a client-written released/expired permit past the limit must hit the backstop (got %)', v;
  end if;
  select * into p from public.analysis_permits where idempotency_key = 'sam-expired-forge';
  if p.status <> 'released' or p.outcome <> 'free_limit_exceeded' then
    raise exception 'Q6: the refused forged permit must end released/free_limit_exceeded (got %/%)', p.status, p.outcome;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000253') then
    raise exception 'Q6: no third scored row for a free account';
  end if;
end $$;

set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000022';
do $$
declare r record; v text; p record; p_live uuid; p_stale uuid;
begin
  select * into r from public.reserve_analysis_permit('tess-live');
  if r.result <> 'accepted' then
    raise exception 'Q6 precondition: member reserve must succeed (got %)', r.result;
  end if;
  p_live := r.permit_id;
  select * into r from public.reserve_analysis_permit('tess-stale');
  if r.result <> 'accepted' then
    raise exception 'Q6 precondition: second member reserve must succeed (got %)', r.result;
  end if;
  p_stale := r.permit_id;
  -- edge release: reserved → released/cancelled
  if pg_temp.q_try(format($q$update public.analysis_permits set status = 'released', outcome = 'cancelled'
      where id = %L$q$, p_live)) <> 'allowed 1' then
    raise exception 'Q6: the edge release UPDATE must be allowed';
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000261', p_live, 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'Q6: a released/cancelled permit must not back a shot (got %)', v;
  end if;
  perform set_config('pickle.q_stale', p_stale::text, true);
end $$;
-- the pg_cron sweep, as the job owner, on a reservation aged past 24h
reset role;
with stale as (
  delete from public.analysis_permits
  where id = current_setting('pickle.q_stale', true)::uuid
  returning id, user_id, idempotency_key, status, outcome
)
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
select id, user_id, idempotency_key, status, outcome, now() - interval '25 hours' from stale;
update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000022';
do $$
declare v text; p record; p_stale uuid := current_setting('pickle.q_stale', true)::uuid;
begin
  select * into p from public.analysis_permits where id = p_stale;
  if p.status <> 'released' or p.outcome <> 'expired' then
    raise exception 'Q6: the sweep must still expire a stale reservation (got %/%)', p.status, p.outcome;
  end if;
  -- late sync on the swept permit: accepted once, linked, finalized/scored
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000262', p_stale, 'scored'));
  if v <> 'accepted' then
    raise exception 'Q6: a swept permit must still back its late shot (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = p_stale;
  if p.status <> 'finalized' or p.outcome <> 'scored' then
    raise exception 'Q6: the late-synced permit must end finalized/scored (got %/%)', p.status, p.outcome;
  end if;
  if not exists (select 1 from public.shots
                 where id = '00000000-0000-4000-8000-000000000262' and analysis_permit_id = p_stale) then
    raise exception 'Q6: the late shot must record its permit';
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000263', p_stale, 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'Q6: the swept-then-consumed permit must refuse a second shot (got %)', v;
  end if;
end $$;

-- Q7: premium / no-permit rows: several link-less direct scored rows coexist
-- under one live permit (the partial index ignores NULL), and a member's
-- sync records the link like anyone else's.
do $$
declare r record; v text; a text; b text;
begin
  select * into r from public.reserve_analysis_permit('tess-direct');
  if r.result <> 'accepted' then
    raise exception 'Q7 precondition: member reserve must succeed (got %)', r.result;
  end if;
  a := pg_temp.q_direct_shot('00000000-0000-4000-8000-000000000271',
    '00000000-0000-4000-8000-000000000022', 'scored', null);
  b := pg_temp.q_direct_shot('00000000-0000-4000-8000-000000000272',
    '00000000-0000-4000-8000-000000000022', 'scored', null);
  if a <> 'allowed 1' or b <> 'allowed 1' then
    raise exception 'Q7: link-less member rows must not collide (got % / %)', a, b;
  end if;
  if (select count(*) from public.shots
      where user_id = '00000000-0000-4000-8000-000000000022' and analysis_permit_id is null) <> 2 then
    raise exception 'Q7: both link-less rows must persist';
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000273', r.permit_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'Q7: a member sync past the free count must be accepted (got %)', v;
  end if;
  if not exists (select 1 from public.shots
                 where id = '00000000-0000-4000-8000-000000000273'
                   and analysis_permit_id = r.permit_id) then
    raise exception 'Q7: the member sync must record its permit';
  end if;
end $$;

-- Q8: account deletion (Auth admin deleteUser → auth.users cascade) still
-- removes every permit, including the one linked to a shot, and the identity
-- ledger row survives; the freed id is then re-creatable by the owner.
reset role;
set local request.jwt.claim.sub = '';
do $$
declare p_id uuid;
begin
  select analysis_permit_id into p_id from public.shots
   where id = '00000000-0000-4000-8000-000000000262';
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-tess')) then
    raise exception 'Q8 precondition: the member''s identity must have a ledger row';
  end if;
  delete from auth.users where id = '00000000-0000-4000-8000-000000000022';
  if exists (select 1 from public.analysis_permits where user_id = '00000000-0000-4000-8000-000000000022')
     or exists (select 1 from public.shots where user_id = '00000000-0000-4000-8000-000000000022') then
    raise exception 'Q8: deleting the auth user must cascade permits and shots';
  end if;
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-tess')) then
    raise exception 'Q8: the identity ledger row must survive account deletion';
  end if;
  -- with the shot gone, nothing tombstones the id: the owner may re-issue it
  insert into public.analysis_permits (id, user_id, idempotency_key)
  values (p_id, '00000000-0000-4000-8000-000000000021', 'sam-reissued');
end $$;

-- ============================================================================
-- R. Round 9 (ADV-11-PREFIX-RESURRECTION + ADV-17-SETTLED-UNRESTORABLE):
--    settled permits are terminal for the OWNER / service role across DELETE
--    (20260907100000_permit_settled_no_delete). Two fresh users: Rae (free,
--    Google identity) and Vic (member).
-- R1  owner DELETE of Rae's finalized/scored permit that backs a shot is
--     allowed and tombstoned; the shot keeps its link; reopening the id as
--     reserved (Rae or Vic), or as any other settled shape, is 23514 +
--     access.permit_transition_rejected; the byte-identical restore is
--     allowed, the tombstone is consumed, and a second sync on the id is
--     access.permit_not_reserved with exactly one shot
-- R2  a settled legacy-style permit (no shot names it) deleted by the owner
--     is tombstoned: reopening is 23514; Rae's RPC naming it is
--     access.permit_not_reserved and writes nothing; Vic's RPC naming it is
--     access.permit_not_found
-- R3  a reserved, unlinked permit is deleted with no memory and the id is
--     re-issuable
-- R4  the lifecycle guard holds for the owner: settled → reserved UPDATE is
--     23514 (no DELETE-free reopening path exists)
-- R5  the tombstone table is service-only: SELECT / DELETE as a client are
--     42501; permit_tombstoned() is caller-scoped (false for another user's
--     tombstoned id, true for the owner's)
-- R6  account deletion: `delete from auth.users` (Rae) and `delete from
--     public.profiles` (Vic) each remove every permit, shot and tombstone of
--     the user (settled, linked, reserved, pre-existing tombstone) and the
--     freed ids are re-issuable as reservations
-- ============================================================================

reset role;
set local request.jwt.claim.sub = '';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000031', 'rae@example.com',
   '{"full_name":"Rae"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000032', 'vic@example.com',
   '{"full_name":"Vic"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-rae', '00000000-0000-4000-8000-000000000031',
   '{"sub":"google-sub-rae","email":"rae@example.com"}');
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000032', true, null);

create function pg_temp.r_permit(p_id uuid) returns text
language sql as $$
  select coalesce((select status || '/' || coalesce(outcome, 'NULL')
                   from public.analysis_permits where id = p_id), 'MISSING');
$$;
create function pg_temp.r_tomb(p_id uuid) returns text
language sql as $$
  select coalesce((select user_id::text || ':' || status || '/' || coalesce(outcome, 'NULL')
                   from public.analysis_permit_tombstones where permit_id = p_id), 'NONE');
$$;
grant execute on function pg_temp.r_permit(uuid) to authenticated;

-- R1 setup, as Rae: reserve + sync one scored shot (the permit is now
-- finalized/scored and linked).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000031';
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('rae-p1');
  if r.result <> 'accepted' then
    raise exception 'R1 precondition: reserve must succeed (got %)', r.result;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000331', r.permit_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'R1 precondition: the first sync must be accepted (got %)', v;
  end if;
  if pg_temp.r_permit(r.permit_id) <> 'finalized/scored' then
    raise exception 'R1 precondition: the permit must be finalized/scored (got %)', pg_temp.r_permit(r.permit_id);
  end if;
end $$;

-- R1: as the owner role.
reset role;
set local request.jwt.claim.sub = '';
do $$
declare p_id uuid; saved record; r text;
begin
  select analysis_permit_id into p_id from public.shots
   where id = '00000000-0000-4000-8000-000000000331';
  select * into saved from public.analysis_permits where id = p_id;
  if pg_temp.r_tomb(p_id) <> 'NONE' then
    raise exception 'R1 precondition: a live permit has no tombstone';
  end if;

  r := pg_temp.q_try(format('delete from public.analysis_permits where id = %L', p_id));
  if r <> 'allowed 1' then
    raise exception 'R1: the owner may remove the row (ops path), got %', r;
  end if;
  if pg_temp.r_permit(p_id) <> 'MISSING' then
    raise exception 'R1: the row must be gone';
  end if;
  if pg_temp.r_tomb(p_id) <> '00000000-0000-4000-8000-000000000031:finalized/scored' then
    raise exception 'R1: the settled row must leave a tombstone (got %)', pg_temp.r_tomb(p_id);
  end if;
  if (select analysis_permit_id from public.shots
      where id = '00000000-0000-4000-8000-000000000331') is distinct from p_id then
    raise exception 'R1: the shot keeps its link (the row is restorable)';
  end if;

  -- Reopening the id: as Rae reserved, as Vic reserved, as Rae in another
  -- settled shape, as Vic in the right shape — every one is 23514.
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key)
       values (%L, '00000000-0000-4000-8000-000000000031', 'rae-reopen')$q$, p_id));
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'R1: reopening a tombstoned id as reserved must be 23514 + access.permit_transition_rejected (got %)', r;
  end if;
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key)
       values (%L, '00000000-0000-4000-8000-000000000032', 'vic-steal')$q$, p_id));
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'R1: another user cannot take a tombstoned id (got %)', r;
  end if;
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
       values (%L, '00000000-0000-4000-8000-000000000031', %L, 'released', 'expired')$q$,
    p_id, saved.idempotency_key));
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'R1: a different settled shape is not the restore (got %)', r;
  end if;
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
       values (%L, '00000000-0000-4000-8000-000000000032', %L, 'finalized', 'scored')$q$,
    p_id, saved.idempotency_key));
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'R1: the right shape under another user is not the restore (got %)', r;
  end if;
  if pg_temp.r_permit(p_id) <> 'MISSING' or pg_temp.r_tomb(p_id) = 'NONE' then
    raise exception 'R1: refused inserts must leave the id gone and remembered';
  end if;

  -- The byte-identical restore (pg_dump --data-only / support repair).
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at, updated_at)
       values (%L, %L, %L, %L, %L, %L, %L)$q$,
    saved.id, saved.user_id, saved.idempotency_key, saved.status, saved.outcome,
    saved.created_at, saved.updated_at));
  if r <> 'allowed 1' then
    raise exception 'R1: the identical settled row must be restorable (got %)', r;
  end if;
  if pg_temp.r_permit(p_id) <> 'finalized/scored' then
    raise exception 'R1: the restored row is finalized/scored (got %)', pg_temp.r_permit(p_id);
  end if;
  if pg_temp.r_tomb(p_id) <> 'NONE' then
    raise exception 'R1: the restore consumes the tombstone (got %)', pg_temp.r_tomb(p_id);
  end if;
end $$;

-- R1: the restored permit is still consumed for Rae.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000031';
do $$
declare p_id uuid; v text;
begin
  select analysis_permit_id into p_id from public.shots
   where id = '00000000-0000-4000-8000-000000000331';
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000332', p_id, 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'R1: a second sync on the restored permit must be access.permit_not_reserved (got %)', v;
  end if;
  if (select count(*) from public.shots
      where user_id = '00000000-0000-4000-8000-000000000031') <> 1 then
    raise exception 'R1: exactly one shot for Rae';
  end if;
  -- replay of the shot that consumed it is still an idempotent accept
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000331', p_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'R1: replaying the held shot must stay accepted (got %)', v;
  end if;
end $$;

-- R2 + R3 + R4, as the owner: a settled legacy-style permit (no shot), a
-- reserved one, and the UPDATE path.
reset role;
set local request.jwt.claim.sub = '';
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
values
  ('00000000-0000-4000-8000-000000000341', '00000000-0000-4000-8000-000000000031', 'rae-legacy', 'finalized', 'scored'),
  ('00000000-0000-4000-8000-000000000342', '00000000-0000-4000-8000-000000000031', 'rae-hygiene', 'reserved', null),
  ('00000000-0000-4000-8000-000000000343', '00000000-0000-4000-8000-000000000031', 'rae-settled', 'released', 'cancelled');
do $$
declare r text;
begin
  -- R2
  r := pg_temp.q_try('delete from public.analysis_permits where id = ''00000000-0000-4000-8000-000000000341''');
  if r <> 'allowed 1' then
    raise exception 'R2: the owner may remove a settled legacy-style row (got %)', r;
  end if;
  if pg_temp.r_tomb('00000000-0000-4000-8000-000000000341') <> '00000000-0000-4000-8000-000000000031:finalized/scored' then
    raise exception 'R2: a settled unlinked permit leaves a tombstone (got %)', pg_temp.r_tomb('00000000-0000-4000-8000-000000000341');
  end if;
  r := pg_temp.q_try(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key)
       values ('00000000-0000-4000-8000-000000000341', '00000000-0000-4000-8000-000000000031', 'rae-legacy-again')$q$);
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'R2: reopening a settled legacy-style id must be 23514 (got %)', r;
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000341') <> 'MISSING' then
    raise exception 'R2: the refused reopen writes nothing';
  end if;

  -- R3
  r := pg_temp.q_try('delete from public.analysis_permits where id = ''00000000-0000-4000-8000-000000000342''');
  if r <> 'allowed 1' then
    raise exception 'R3: a reserved unlinked permit is deletable by the owner (got %)', r;
  end if;
  if pg_temp.r_tomb('00000000-0000-4000-8000-000000000342') <> 'NONE' then
    raise exception 'R3: a reserved unlinked permit leaves no tombstone (got %)', pg_temp.r_tomb('00000000-0000-4000-8000-000000000342');
  end if;
  r := pg_temp.q_try(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key)
       values ('00000000-0000-4000-8000-000000000342', '00000000-0000-4000-8000-000000000031', 'rae-hygiene-again')$q$);
  if r <> 'allowed 1' then
    raise exception 'R3: the freed id is re-issuable (got %)', r;
  end if;

  -- R4
  r := pg_temp.q_try(
    $q$update public.analysis_permits set status = 'reserved', outcome = null
       where id = '00000000-0000-4000-8000-000000000343'$q$);
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'R4: the owner cannot reopen a settled row by UPDATE (got %)', r;
  end if;
  r := pg_temp.q_try(
    $q$update public.analysis_permits set status = 'finalized', outcome = 'scored'
       where id = '00000000-0000-4000-8000-000000000343'$q$);
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'R4: the owner cannot move a settled row to another outcome (got %)', r;
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000343') <> 'released/cancelled' then
    raise exception 'R4: the settled row is unchanged';
  end if;
end $$;

-- R2 (client view) + R5, as Rae then Vic.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000031';
do $$
declare v text; r text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000344', '00000000-0000-4000-8000-000000000341', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'R2: the RPC must report a tombstoned own permit as consumed (got %)', v;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000344') then
    raise exception 'R2: nothing is written for a tombstoned permit';
  end if;
  -- R5
  r := pg_temp.q_try('select * from public.analysis_permit_tombstones');
  if r <> '42501:' then
    raise exception 'R5: the tombstone table must be unreadable by clients (got %)', r;
  end if;
  r := pg_temp.q_try('delete from public.analysis_permit_tombstones');
  if r <> '42501:' then
    raise exception 'R5: the tombstone table must be unwritable by clients (got %)', r;
  end if;
  if not public.permit_tombstoned('00000000-0000-4000-8000-000000000341') then
    raise exception 'R5: permit_tombstoned() is true for the owner of the id';
  end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000032';
do $$
declare v text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000345', '00000000-0000-4000-8000-000000000341', 'scored'));
  if v <> 'access.permit_not_found' then
    raise exception 'R2: another user''s tombstoned id is simply unknown (got %)', v;
  end if;
  if public.permit_tombstoned('00000000-0000-4000-8000-000000000341') then
    raise exception 'R5: permit_tombstoned() must not leak another user''s id';
  end if;
end $$;

-- R6 setup: Vic gets a linked finalized permit, a settled unlinked one, a
-- live one and a pre-existing tombstone (Rae already has all four shapes).
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('vic-p1');
  if r.result <> 'accepted' then
    raise exception 'R6 precondition: member reserve must succeed (got %)', r.result;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000351', r.permit_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'R6 precondition: member sync must be accepted (got %)', v;
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
values
  ('00000000-0000-4000-8000-000000000352', '00000000-0000-4000-8000-000000000032', 'vic-settled', 'finalized', 'cancelled'),
  ('00000000-0000-4000-8000-000000000353', '00000000-0000-4000-8000-000000000032', 'vic-live', 'reserved', null),
  ('00000000-0000-4000-8000-000000000354', '00000000-0000-4000-8000-000000000032', 'vic-gone', 'finalized', 'scored');
delete from public.analysis_permits where id = '00000000-0000-4000-8000-000000000354';

-- R6: both deletion paths.
do $$
declare rae_ids uuid[]; vic_ids uuid[]; u uuid; p uuid; r text; n int := 0;
begin
  select array_agg(id) into rae_ids from public.analysis_permits
   where user_id = '00000000-0000-4000-8000-000000000031';
  select array_agg(id) into vic_ids from public.analysis_permits
   where user_id = '00000000-0000-4000-8000-000000000032';
  if coalesce(array_length(rae_ids, 1), 0) < 3 or coalesce(array_length(vic_ids, 1), 0) < 3 then
    raise exception 'R6 precondition: each user holds linked + settled + reserved permits (% / %)',
      array_length(rae_ids, 1), array_length(vic_ids, 1);
  end if;
  if (select count(*) from public.analysis_permit_tombstones
      where user_id in ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000032')) <> 2 then
    raise exception 'R6 precondition: each user has one pre-existing tombstone';
  end if;
  if (select count(*) from public.shots
      where user_id in ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000032')) <> 2 then
    raise exception 'R6 precondition: each user has one linked shot';
  end if;

  delete from auth.users where id = '00000000-0000-4000-8000-000000000031';
  delete from public.profiles where id = '00000000-0000-4000-8000-000000000032';

  foreach u in array array['00000000-0000-4000-8000-000000000031'::uuid,
                          '00000000-0000-4000-8000-000000000032'::uuid] loop
    if exists (select 1 from public.profiles where id = u)
       or exists (select 1 from public.analysis_permits where user_id = u)
       or exists (select 1 from public.shots where user_id = u)
       or exists (select 1 from public.analysis_permit_tombstones where user_id = u) then
      raise exception 'R6: account deletion must leave no profile, permit, shot or tombstone for %', u;
    end if;
  end loop;
  if not exists (select 1 from public.free_rating_ledger
                 where identity_hash = public.free_rating_identity_hash('google', 'google-sub-rae')) then
    raise exception 'R6: the identity ledger row must survive account deletion';
  end if;

  -- The freed ids (linked and settled alike) are plain ids again.
  foreach p in array rae_ids || vic_ids
                     || array['00000000-0000-4000-8000-000000000354'::uuid] loop
    n := n + 1;
    r := pg_temp.q_try(format(
      $q$insert into public.analysis_permits (id, user_id, idempotency_key)
         values (%L, '00000000-0000-4000-8000-000000000021', %L)$q$, p, 'sam-r6-' || n));
    if r <> 'allowed 1' then
      raise exception 'R6: freed id % must be re-issuable (got %)', p, r;
    end if;
  end loop;
end $$;

do $$
declare t record; f record;
begin
  for t in
    select c.oid, c.relname, c.relrowsecurity, c.relkind, c.reloptions
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  loop
    if has_table_privilege('authenticated', t.oid, 'TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'K8: authenticated retains unsafe structural privileges on %', t.relname;
    end if;
    if current_setting('server_version_num')::integer >= 170000
       and has_table_privilege('authenticated', t.oid, 'MAINTAIN') then
      raise exception 'K8: authenticated retains MAINTAIN on %', t.relname;
    end if;
    if has_table_privilege('anon', t.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'K9: anon retains application table privileges on %', t.relname;
    end if;
    if t.relkind in ('v', 'm') and has_table_privilege('authenticated', t.oid, 'SELECT')
       and (t.relkind = 'm' or not coalesce('security_invoker=true' = any(t.reloptions), false)) then
      raise exception 'K10: readable view % must preserve caller RLS', t.relname;
    end if;
    if t.relkind in ('r', 'p') and not t.relrowsecurity then
      raise exception 'K10: application table % must have RLS enabled', t.relname;
    end if;
    if t.relrowsecurity and (
      has_table_privilege('authenticated', t.oid, 'SELECT,INSERT,UPDATE,DELETE')
      or has_any_column_privilege('authenticated', t.oid, 'INSERT,UPDATE')
    ) and not exists (
      select 1 from pg_policy p
      where p.polrelid = t.oid and p.polname = 'api_requests_only'
        and not p.polpermissive and p.polcmd = '*'
    ) then
      raise exception 'K10: % is missing its restrictive API request policy', t.relname;
    end if;
  end loop;
  for f in
    select p.oid, p.proname, p.proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    if has_function_privilege('anon', f.oid, 'EXECUTE') then
      raise exception 'K11: anon must not execute public.%', f.proname;
    end if;
    if not exists (select 1 from unnest(f.proconfig) config where config like 'search_path=%') then
      raise exception 'K12: public.% must pin its search_path', f.proname;
    end if;
  end loop;
  if has_schema_privilege('authenticated', 'public', 'CREATE')
     or has_schema_privilege('anon', 'public', 'CREATE') then
    raise exception 'K13: clients must not create objects in public';
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000f';
set local request.headers = '{}';
do $$
declare changed integer;
begin
  if public.identity_scored_count() <> 0 then
    raise exception 'K14: the definer identity reader must not bypass the API gate';
  end if;
  update public.analysis_permits set status = 'reserved', outcome = null
    where user_id = (select auth.uid());
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'K15: direct clients must not re-arm consumed permits';
  end if;
  begin
    perform secret from api_private.request_key;
    raise exception 'K16: the backend credential table must not be client-readable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
    values ((select auth.uid()), gen_random_uuid(), now() - interval '1 hour', now() + interval '1 hour');
    raise exception 'K17: direct clients must not forge or backdate deletion challenges';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare r record; relation regclass; actual_updates text[]; expected_updates text[]; functions text[];
begin
  for r in select * from (values
    ('profiles', true, false, false, array['provider','onboarding_state','skill_level','focus_checkpoint','handedness','primary_goal','biggest_problem','first_name','gender']),
    ('sessions', true, true, false, array['ended_at']),
    ('shots', true, true, false, array[]::text[]),
    ('shot_phases', true, true, false, array[]::text[]),
    ('shot_measurements', true, false, false, array[]::text[]),
    ('shot_checkpoints', true, true, false, array[]::text[]),
    ('captures', true, false, false, array[]::text[]),
    ('analysis_permits', true, true, false, array['status','outcome']),
    ('consent_records', true, true, false, array[]::text[]),
    ('evaluation_trials', true, true, false, array[]::text[]),
    ('analysis_feedback', true, true, false, array[]::text[]),
    ('user_saved_drills', true, true, true, array[]::text[]),
    ('player_rank_state', true, false, false, array[]::text[]),
    ('billing_entitlements', true, false, false, array[]::text[]),
    ('account_deletion_requests', true, true, false, array['user_id','challenge','created_at','expires_at']),
    ('account_deletion_feedback', false, true, false, array[]::text[]),
    ('webhook_events', false, false, false, array[]::text[]),
    ('account_external_credentials', false, false, false, array[]::text[]),
    ('free_rating_ledger', false, false, false, array[]::text[]),
    ('progress_daily', true, false, false, array[]::text[]),
    ('practice_days', true, false, false, array[]::text[]),
    ('player_technique_rating', true, false, false, array[]::text[])
  ) as expected(name, can_select, can_insert, can_delete, updatable)
  loop
    relation := format('public.%I', r.name)::regclass;
    if has_any_column_privilege('authenticated', relation, 'SELECT') <> r.can_select
       or has_any_column_privilege('authenticated', relation, 'INSERT') <> r.can_insert
       or has_table_privilege('authenticated', relation, 'DELETE') <> r.can_delete
       or has_table_privilege('authenticated', relation, 'UPDATE') then
      raise exception 'K24: table privileges exceed the API contract on % (select %, insert %, update %, delete %)',
        r.name,
        has_any_column_privilege('authenticated', relation, 'SELECT'),
        has_any_column_privilege('authenticated', relation, 'INSERT'),
        has_table_privilege('authenticated', relation, 'UPDATE'),
        has_table_privilege('authenticated', relation, 'DELETE');
    end if;
    select coalesce(array_agg(a.attname::text order by a.attname), '{}'::text[])
      into actual_updates
    from pg_attribute a
    where a.attrelid = relation and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', relation, a.attnum, 'UPDATE');
    select coalesce(array_agg(c order by c), '{}'::text[]) into expected_updates
      from unnest(r.updatable) c;
    if actual_updates <> expected_updates then
      raise exception 'K25: UPDATE columns drifted on % (got %)', r.name, actual_updates;
    end if;
    if has_any_column_privilege('anon', relation, 'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'K26: anon must hold no column privileges on %', r.name;
    end if;
  end loop;
  select array_agg(p.proname::text order by p.proname) into functions
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if functions <> array[
    'access_lock_key','access_state','apply_synced_shot','complete_onboarding',
    'identity_scored_count','is_api_session_active','lifetime_scored_count',
    'permit_backs_sync','permit_tombstoned','reserve_analysis_permit'
  ] then
    raise exception 'K27: authenticated RPC allowlist drifted (got %)', functions;
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'access_lock_key','access_state','apply_synced_shot','complete_onboarding',
      'is_api_session_active','lifetime_scored_count','reserve_analysis_permit'
    ) and p.prosecdef
  ) then
    raise exception 'K28: user RPCs must stay SECURITY INVOKER so RLS cannot be bypassed';
  end if;
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;

set local role service_role;
do $$
begin
  if length(public.get_api_request_key()) <> 64 then
    raise exception 'K29: only the service role must be able to provision the API request key';
  end if;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000f';
do $$
declare p uuid; v text; header text := current_setting('request.headers'); shot_id uuid := gen_random_uuid();
begin
  begin
    update public.analysis_permits set status = 'reserved', outcome = null
      where user_id = (select auth.uid()) and status = 'finalized';
    raise exception 'K30: even trusted requests cannot re-arm finalized permits';
  exception when check_violation then null;
  end;
  select permit_id into p from public.reserve_analysis_permit('api-boundary-probe');
  if p is null then
    raise exception 'K31: the authenticated API reservation must still work';
  end if;
  perform set_config('request.headers', '{}', true);
  v := public.apply_synced_shot(jsonb_build_object(
    'id', shot_id, 'analysisPermitId', p, 'resultKind', 'scored'
  ));
  if v <> 'access.permit_not_found' then
    raise exception 'K31: direct sync RPC must not see the real reserved permit (got %)', v;
  end if;
  perform set_config('request.headers', header, true);
  if exists (select 1 from public.shots s where s.id = shot_id)
     or not exists (select 1 from public.analysis_permits where id = p and status = 'reserved') then
    raise exception 'K31: rejected direct sync must not mutate shots or permits';
  end if;
  update public.analysis_permits set status = 'released', outcome = 'failed' where id = p;
  begin
    update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = p;
    raise exception 'K32: released permits are terminal too';
  exception when check_violation then null;
  end;
end $$;
reset role;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000091', 'session-owner@example.com', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000092', 'other-session-owner@example.com', '{"provider":"apple"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000009101', '00000000-0000-4000-8000-000000000091'),
  ('00000000-0000-4000-8000-000000009102', '00000000-0000-4000-8000-000000000091'),
  ('00000000-0000-4000-8000-000000009201', '00000000-0000-4000-8000-000000000092');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000091';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000009101"}';
do $$
declare claims text := current_setting('request.jwt.claims'); header text := current_setting('request.headers');
begin
  if not public.is_api_session_active() then
    raise exception 'L1: the live owner session must be accepted';
  end if;
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-000000009201"}', true);
  if public.is_api_session_active() then
    raise exception 'L2: another user''s session must not authenticate the caller';
  end if;
  perform set_config('request.jwt.claims', '{}', true);
  if public.is_api_session_active() then
    raise exception 'L3: a missing session id must fail closed';
  end if;
  perform set_config('request.jwt.claims', '{"session_id":"not-a-uuid"}', true);
  if public.is_api_session_active() then
    raise exception 'L4: a malformed session id must fail closed';
  end if;
  perform set_config('request.jwt.claims', claims, true);
  perform set_config('request.headers', '{}', true);
  begin
    perform public.is_api_session_active();
    raise exception 'L5: session checks must require the server request key';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.headers', header, true);
end $$;
reset role;

update auth.sessions set not_after = now() - interval '1 second'
  where id = '00000000-0000-4000-8000-000000009101';
set local role authenticated;
do $$
begin
  if public.is_api_session_active() then
    raise exception 'L6: a time-boxed expired session must not remain active';
  end if;
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-000000009102"}', true);
  if not public.is_api_session_active() then
    raise exception 'L7: expiring one device must not expire another';
  end if;
end $$;
reset role;

update auth.users set banned_until = now() + interval '1 hour'
  where id = '00000000-0000-4000-8000-000000000091';
set local role authenticated;
do $$
begin
  if public.is_api_session_active() then
    raise exception 'L8: a banned user must not retain cached API access';
  end if;
end $$;
reset role;
update auth.users set banned_until = now() - interval '1 second'
  where id = '00000000-0000-4000-8000-000000000091';
update auth.sessions set not_after = null
  where id = '00000000-0000-4000-8000-000000009101';
delete from auth.sessions where id = '00000000-0000-4000-8000-000000009102';
set local role authenticated;
do $$
begin
  if public.is_api_session_active() then
    raise exception 'L9: a revoked session must fail immediately';
  end if;
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-000000009101"}', true);
  if not public.is_api_session_active() then
    raise exception 'L10: logout must preserve another device''s live session';
  end if;
end $$;
reset role;
delete from auth.users where id = '00000000-0000-4000-8000-000000000091';
set local role authenticated;
do $$
begin
  if public.is_api_session_active() then
    raise exception 'L11: deleting an account must invalidate every session';
  end if;
end $$;
reset role;

set local role service_role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-000000000092';
  t uuid;
  lease uuid;
  payload jsonb := '{"event":{"id":"service-role-boundary-test","type":"TEST","app_user_id":"00000000-0000-4000-8000-000000000092"}}';
begin
  t := (public.begin_billing_verification(array[u])->0->>'ticket_id')::uuid;
  perform public.persist_billing_verdict(u, t,
    '{"premium":true,"productKey":"verified-product","expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}');
  lease := (public.claim_billing_webhook_delivery('service-role-boundary-test', payload)->>'lease_token')::uuid;
  t := (public.begin_billing_verification(array[u], 'service-role-boundary-test', payload, lease)->0->>'ticket_id')::uuid;
  perform public.persist_billing_verdict(u, t,
    '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}');
  perform public.complete_billing_webhook('service-role-boundary-test', payload, jsonb_build_object(u::text, t), lease);
  perform public.complete_billing_webhook('service-role-boundary-test', payload, jsonb_build_object(u::text, t), lease);
end $$;
-- External credential DML was intentionally retired by W08. Exercise the
-- same fenced service helpers as Edge, including the real minimum-age gate.
do $$
declare
  u uuid := '00000000-0000-4000-8000-000000000092';
  operation_id uuid := gen_random_uuid();
  challenge_hash bytea := sha256(convert_to('M2 synthetic deletion challenge', 'UTF8'));
  claimed jsonb;
  lease_token uuid;
begin
  perform public.store_account_apple_credential(u, 'v1.abcdefghijklmnop.fixtureEncryptedToken');
  perform public.begin_account_deletion_operation(u, operation_id, challenge_hash,
    sha256(convert_to('M2 synthetic status capability', 'UTF8')));
  perform pg_sleep(3.01);
  claimed := public.confirm_account_deletion_operation(u, challenge_hash, operation_id);
  if claimed->>'outcome' <> 'claimed' then
    raise exception 'M2: the service helper must claim confirmed cleanup';
  end if;
  lease_token := (claimed->>'leaseToken')::uuid;
  perform public.checkpoint_account_deletion_operation(u, operation_id, lease_token, 'apple', 'revoked');
  perform public.checkpoint_account_deletion_operation(u, operation_id, lease_token, 'revenuecat');
  if has_table_privilege('service_role', 'public.account_external_credentials', 'INSERT,UPDATE,DELETE')
    or has_any_column_privilege('service_role', 'public.account_external_credentials', 'INSERT,UPDATE') then
    raise exception 'M2: direct credential writes must stay revoked';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.billing_entitlements
                 where user_id = '00000000-0000-4000-8000-000000000092' and not premium) then
    raise exception 'M1: verified server billing writes must work without default service grants';
  end if;
  if not exists (select 1 from public.account_external_credentials
                 where user_id = '00000000-0000-4000-8000-000000000092'
                   and revenuecat_deleted_at is not null) then
    raise exception 'M2: server external-cleanup checkpoints must be writable and readable';
  end if;
  if (select count(*) from public.webhook_events where id = 'service-role-boundary-test') <> 1 then
    raise exception 'M3: server webhook audit inserts must remain idempotent';
  end if;
  begin
    update public.webhook_events set event_type = 'REWRITTEN' where id = 'service-role-boundary-test';
    raise exception 'M4: the webhook writer must not rewrite audit history';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.webhook_events set claimed_at = now() + interval '1 second'
      where id = 'service-role-boundary-test';
    raise exception 'M5: a live webhook lease must not be stolen';
  exception when insufficient_privilege then null;
  end;
  if not exists (select 1 from public.webhook_events
                 where id = 'service-role-boundary-test' and processed_at is not null) then
    raise exception 'M6: the service role must complete a pending webhook through its helper';
  end if;
  begin
    update public.webhook_events set processed_at = null
      where id = 'service-role-boundary-test';
    raise exception 'M7: completed webhook history must not be reopened';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.webhook_events where id = 'service-role-boundary-test';
    raise exception 'M8: the service role must not delete completed audit history';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

insert into public.webhook_events (id, event_type, payload, claimed_at)
  values ('service-role-pending-retry', 'TEST', '{"event":{"id":"service-role-pending-retry","type":"TEST"}}', now() - interval '6 minutes');
set local role service_role;
do $$
declare
  v_payload jsonb := '{"event":{"id":"service-role-pending-retry","type":"TEST"}}';
  claimed jsonb;
  lease uuid;
begin
  claimed := public.claim_billing_webhook_delivery('service-role-pending-retry', v_payload);
  lease := (claimed->>'lease_token')::uuid;
  if claimed->>'outcome' <> 'claimed' or lease is null or not exists (
    select 1 from public.webhook_events where id = 'service-role-pending-retry'
      and processed_at is null and claimed_at > now() - interval '1 second'
  ) then
    raise exception 'M9: an expired webhook lease must be reclaimable';
  end if;
  if public.claim_billing_webhook_delivery('service-role-pending-retry', v_payload)->>'outcome' <> 'in_progress' then
    raise exception 'M5: a live webhook lease must not be stolen through the helper';
  end if;
  perform public.release_billing_webhook_delivery('service-role-pending-retry', v_payload, lease);
  claimed := public.claim_billing_webhook_delivery('service-role-pending-retry', v_payload);
  if claimed->>'outcome' <> 'claimed' or (claimed->>'lease_token')::uuid = lease or not exists (
    select 1 from public.webhook_events where id = 'service-role-pending-retry'
      and processed_at is null and public.webhook_events.payload = v_payload
  ) then
    raise exception 'M10: a failed pending webhook must be releasable without erasing its audit history';
  end if;
  if public.release_billing_webhook_delivery('service-role-pending-retry', v_payload, lease)->>'outcome' <> 'stale_lease' then
    raise exception 'M10: a stale worker must not release the replacement delivery';
  end if;
end $$;
reset role;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 'billing-a@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000a2', 'billing-b@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000a3', 'billing-deleted@example.test', '{"provider":"google"}');
insert into public.billing_entitlements (user_id, premium, verified_at)
values ('00000000-0000-4000-8000-0000000000a1', true, '2026-01-01T00:00:00Z');

set local role service_role;
do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000a2';
  older uuid;
  newer uuid;
  r jsonb;
  active jsonb := '{"premium":true,"productKey":"pickle_sensei_pro_monthly","expiresAt":"2099-01-01T00:00:00.000Z","activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  before_time timestamptz;
  after_time timestamptz;
  before_order bigint;
begin
  older := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  newer := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  before_time := clock_timestamp();
  r := public.persist_billing_verdict(a, newer, inactive);
  after_time := clock_timestamp();
  if r->>'outcome' <> 'persisted' or r->'billing'->>'premium' <> 'false' then
    raise exception 'W07-1: newer inactive verification must revoke the legacy premium row';
  end if;
  if (r->'billing'->>'verifiedAt')::timestamptz not between before_time and after_time then
    raise exception 'W07-2: verifiedAt must come from the database, not provider/client clocks';
  end if;
  select verification_order into before_order from public.billing_entitlements where user_id = a;
  r := public.persist_billing_verdict(a, older, active);
  if r->>'outcome' <> 'persisted' or r->>'applied' <> 'false'
     or r->'billing'->>'premium' <> 'false'
     or (select premium from public.billing_entitlements where user_id = a)
     or (select verification_order from public.billing_entitlements where user_id = a) <> before_order then
    raise exception 'W07-3: delayed old-active verification must return canonical inactive without overwriting';
  end if;
  r := public.persist_billing_verdict(a, older, active);
  if r->>'applied' <> 'false' or r->'billing'->>'premium' <> 'false' then
    raise exception 'W07-4: same ticket and verdict replay must be idempotent';
  end if;
  begin
    perform public.persist_billing_verdict(a, older, inactive);
    raise exception 'W07-5: a consumed ticket must reject a conflicting verdict';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(b, newer, active);
    raise exception 'W07-6: verification tickets must be bound to one user';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.persist_billing_verdict(a, gen_random_uuid(), active);
    raise exception 'W07-7: a caller cannot invent a verification ticket';
  exception when invalid_parameter_value then null;
  end;
  older := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  newer := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  perform public.persist_billing_verdict(a, older, inactive);
  r := public.persist_billing_verdict(a, newer, active);
  if r->>'applied' <> 'true' or r->'billing'->>'premium' <> 'true' then
    raise exception 'W07-8: the opposite completion order must still preserve the newer active state';
  end if;
  older := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  newer := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  perform public.persist_billing_verdict(a, newer, active || '{"expiresAt":"2098-01-01T00:00:00.000Z"}');
  r := public.persist_billing_verdict(a, older, active);
  if (r->'billing'->>'expiresAt')::timestamptz <> '2098-01-01T00:00:00Z'::timestamptz then
    raise exception 'W07-9: an old active snapshot cannot extend the newer verified expiry';
  end if;
  before_order := (select verification_order from public.billing_entitlements where user_id = a);
  perform public.begin_billing_verification(array[a]);
  if not (select premium from public.billing_entitlements where user_id = a)
     or (select verification_order from public.billing_entitlements where user_id = a) <> before_order then
    raise exception 'W07-10: issuing a ticket without a successful verification is not a negative entitlement';
  end if;
  begin
    insert into public.billing_entitlements (user_id, premium, verified_at)
    values (a, true, '2999-01-01T00:00:00Z')
    on conflict (user_id) do update set premium = excluded.premium, verified_at = excluded.verified_at;
    raise exception 'W07-11: rolling old writers must fail closed rather than bypass verification order';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.billing_entitlements set premium = true where user_id = a;
    raise exception 'W07-12: direct service-role updates must not bypass ordered persistence';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.webhook_events (id, payload) values ('old-writer-poison', '{}');
    raise exception 'W07-13: rolling old audit writers must not create unvalidated completion markers';
  exception when insufficient_privilege then null;
  end;
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000a2';
  payload jsonb := '{"event":{"id":"w07-transfer","type":"TRANSFER","transferred_from":["00000000-0000-4000-8000-0000000000a1"],"transferred_to":["00000000-0000-4000-8000-0000000000a2"]}}';
  issued jsonb;
  tickets jsonb;
  a_ticket uuid;
  b_ticket uuid;
  lease uuid;
  active jsonb := '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-transfer', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[a,b], 'w07-transfer', payload, lease);
  select (item->>'ticket_id')::uuid into a_ticket from jsonb_array_elements(issued) item where item->>'user_id' = a::text;
  select (item->>'ticket_id')::uuid into b_ticket from jsonb_array_elements(issued) item where item->>'user_id' = b::text;
  tickets := jsonb_build_object(a::text, a_ticket, b::text, b_ticket);
  perform public.persist_billing_verdict(b, b_ticket, active);
  begin
    perform public.complete_billing_webhook('w07-transfer', payload, tickets, lease);
    raise exception 'W07-14: a partially persisted transfer must not create a completion marker';
  exception when object_not_in_prerequisite_state then null;
  end;
  if exists (select 1 from public.webhook_events where id = 'w07-transfer' and processed_at is not null)
     or not (select premium from public.billing_entitlements where user_id = b) then
    raise exception 'W07-15: a failed transfer must preserve healthy-side repair without poisoning audit';
  end if;
  begin
    perform public.complete_billing_webhook('w07-transfer', payload, jsonb_build_object(b::text, b_ticket), lease);
    raise exception 'W07-16: omitting a failed transfer subject cannot complete the audit';
  exception when invalid_parameter_value or object_not_in_prerequisite_state then null;
  end;
  perform public.persist_billing_verdict(a, a_ticket, inactive);
  begin
    perform public.complete_billing_webhook('w07-transfer', payload, jsonb_build_object(a::text, b_ticket, b::text, a_ticket), lease);
    raise exception 'W07-17: audit proofs must be bound to the matching subjects';
  exception when invalid_parameter_value or object_not_in_prerequisite_state then null;
  end;
  r := public.complete_billing_webhook('w07-transfer', payload, tickets, lease);
  if r->>'verified' <> 'true' then
    raise exception 'W07-18: a repaired transfer must complete';
  end if;
  perform public.complete_billing_webhook('w07-transfer', payload, tickets, lease);
  if (select count(*) from public.webhook_events where id = 'w07-transfer') <> 1 then
    raise exception 'W07-19: duplicate audit completion must leave exactly one immutable marker';
  end if;
  begin
    perform public.complete_billing_webhook('w07-transfer', jsonb_set(payload, '{event,type}', '"REFUND"'), tickets);
    raise exception 'W07-20: a conflicting event payload cannot reuse verification proofs';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.begin_billing_verification(array[a], 'w07-transfer', payload);
    raise exception 'W07-21: issuance must include every transfer subject';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.begin_billing_verification(array[a,b], 'wrong-event', payload);
    raise exception 'W07-22: tickets must be bound to the supplied event identity';
  exception when invalid_parameter_value then null;
  end;
  r := public.begin_billing_verification(array['00000000-0000-4000-8000-0000000000ff'::uuid]);
  if r->0->>'outcome' <> 'user_missing' then
    raise exception 'W07-23: only authoritative Auth absence is terminal';
  end if;
  perform set_config('w07.deleted_ticket', public.begin_billing_verification(array['00000000-0000-4000-8000-0000000000a3'::uuid])->0->>'ticket_id', true);
end $$;
reset role;

delete from auth.users where id = '00000000-0000-4000-8000-0000000000a3';
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.persist_billing_verdict('00000000-0000-4000-8000-0000000000a3', current_setting('w07.deleted_ticket')::uuid,
    '{"premium":true,"productKey":null,"expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}');
  if r->>'outcome' <> 'user_missing' then
    raise exception 'W07-24: deletion between issuance and persistence must not resurrect entitlement state';

  end if;
end $$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform public.begin_billing_verification(array['00000000-0000-4000-8000-0000000000a1'::uuid]);
    raise exception 'W07-31: an authenticated API caller must not issue service billing tickets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.persist_billing_verdict('00000000-0000-4000-8000-0000000000a1', gen_random_uuid(), '{}');
    raise exception 'W07-32: an authenticated API caller must not persist billing claims';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.complete_billing_webhook('client-completion', '{"event":{}}', '{}');
    raise exception 'W07-33: an authenticated API caller must not complete server audit events';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.begin_billing_verification(array['00000000-0000-4000-8000-0000000000a1'::uuid]);
    raise exception 'W07-34: anonymous callers must not issue verification tickets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.persist_billing_verdict('00000000-0000-4000-8000-0000000000a1', gen_random_uuid(), '{}');
    raise exception 'W07-35: anonymous callers must not persist billing claims';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.complete_billing_webhook('anon-completion', '{"event":{}}', '{}');
    raise exception 'W07-36: anonymous callers must not complete server audit events';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare
  u uuid := '00000000-0000-4000-8000-0000000000a4';
  payload jsonb := '{"event":{"id":"subject-appears-before-audit","app_user_id":"00000000-0000-4000-8000-0000000000a4"}}';
  r jsonb;
  lease uuid;
begin
  lease := (public.claim_billing_webhook_delivery('subject-appears-before-audit', payload)->>'lease_token')::uuid;
  r := public.begin_billing_verification(array[u], 'subject-appears-before-audit', payload, lease);
  if r->0->>'outcome' <> 'user_missing' then
    raise exception 'W07-37: the unprovisioned fixture must be missing at issuance';
  end if;
  insert into auth.users (id, email, raw_app_meta_data) values (u, 'billing-appeared@example.test', '{"provider":"google"}');
  begin
    perform public.complete_billing_webhook('subject-appears-before-audit', payload, '{}', lease);
    raise exception 'W07-38: a subject appearing before completion requires fresh verification';
  exception when object_not_in_prerequisite_state then null;
  end;
  if exists (select 1 from public.webhook_events where id = 'subject-appears-before-audit' and processed_at is not null) then
    raise exception 'W07-39: absence at issuance cannot poison audit completion after the subject appears';
  end if;
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000a2';
  payload jsonb := '{"event":{"id":"w07-first-claim","app_user_id":"00000000-0000-4000-8000-0000000000a1"}}';
  issued jsonb;
  ticket uuid;
  before_count bigint;
  lease uuid;
begin
  lease := (public.claim_billing_webhook_delivery('w07-first-claim', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[a], 'w07-first-claim', payload, lease);
  ticket := (issued->0->>'ticket_id')::uuid;
  select count(*) into before_count from api_private.billing_verification_tickets;
  begin
    perform public.begin_billing_verification(array[b], 'w07-first-claim', jsonb_set(payload, '{event,app_user_id}', to_jsonb(b)));
    raise exception 'W07-41: a conflicting in-flight event must not allocate tickets for another scope';
  exception when invalid_parameter_value then null;
  end;
  if (select count(*) from api_private.billing_verification_tickets) <> before_count then
    raise exception 'W07-42: rejected claims must leave no verification tickets';
  end if;
  perform public.persist_billing_verdict(a, ticket,
    '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}');
  perform public.complete_billing_webhook('w07-first-claim', payload, jsonb_build_object(a::text, ticket), lease);
  issued := public.begin_billing_verification(array[a], 'w07-first-claim', payload);
  if issued <> '{"outcome":"duplicate","event_id":"w07-first-claim"}'::jsonb
     or (select count(*) from api_private.billing_verification_tickets) <> before_count then
    raise exception 'W07-43: completion must fence later issuance even after a stale Edge audit lookup';
  end if;
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  b uuid := '00000000-0000-4000-8000-0000000000a2';
  anonymous jsonb := '{"event":{"id":"w07-anonymous-claim","app_user_id":"$RCAnonymousID:unlinked"}}';
  payload jsonb;
  issued jsonb;
  r jsonb;
  ids uuid[];
  ticket uuid;
  invalid jsonb;
  lease uuid;
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  lease := (public.claim_billing_webhook_delivery('w07-anonymous-claim', anonymous)->>'lease_token')::uuid;
  issued := public.begin_billing_verification('{}', 'w07-anonymous-claim', anonymous, lease);
  if issued <> '[]'::jsonb or not exists (select 1 from api_private.billing_webhook_claims where event_id = 'w07-anonymous-claim') then
    raise exception 'W07-47: anonymous-only events still need a durable non-completion claim';
  end if;
  begin
    perform public.begin_billing_verification(array[a], 'w07-anonymous-claim', jsonb_set(anonymous, '{event,app_user_id}', to_jsonb(a)));
    raise exception 'W07-48: a failed anonymous delivery cannot change to a canonical scope on retry';
  exception when invalid_parameter_value then null;
  end;
  r := public.complete_billing_webhook('w07-anonymous-claim', anonymous, '{}', lease);
  if r->>'verified' <> 'false' then
    raise exception 'W07-49: an anonymous audit completes without inventing verified entitlements';
  end if;
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-scope-normalization', 'app_user_id', '$RCAnonymousID:alias',
    'aliases', jsonb_build_array('not-a-user', upper(a::text), b::text),
    'transferred_from', jsonb_build_array(a, upper(a::text)),
    'transferred_to', jsonb_build_array(b, upper(b::text))));
  lease := (public.claim_billing_webhook_delivery('w07-scope-normalization', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[b,a], 'w07-scope-normalization', payload, lease);
  if jsonb_array_length(issued) <> 2
     or (select count(distinct verification_order) from api_private.billing_verification_tickets where event_id = 'w07-scope-normalization') <> 1 then
    raise exception 'W07-50: alias fallback, case normalization and transfer deduplication must share one order';
  end if;
  foreach ids slice 1 in array array[array[a,a],array[a,b],array[a,null::uuid]] loop
    begin
      perform public.begin_billing_verification(ids);
      raise exception 'W07-51: sync admission must reject duplicate, multiple or null subjects';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  begin
    perform public.begin_billing_verification('{}'::uuid[]);
    raise exception 'W07-52: sync admission cannot omit its canonical user';
  exception when invalid_parameter_value then null;
  end;
  payload := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-no-alias-escalation', 'app_user_id', a, 'aliases', jsonb_build_array(b)));
  begin
    perform public.begin_billing_verification(array[a,b], 'w07-no-alias-escalation', payload);
    raise exception 'W07-53: a valid primary subject must not also authorize unrelated aliases';
  exception when invalid_parameter_value then null;
  end;
  ticket := (public.begin_billing_verification(array[a])->0->>'ticket_id')::uuid;
  foreach invalid in array array[
    'null'::jsonb, '{}'::jsonb,
    inactive || '{"verificationOrder":999999999999,"verifiedAt":"2999-01-01T00:00:00Z"}'::jsonb,
    inactive || '{"premium":true}'::jsonb,
    inactive || '{"activeEntitlements":["client-premium"]}'::jsonb,
    inactive || '{"productKey":"unverified-product"}'::jsonb,
    inactive || '{"premium":true,"activeEntitlements":["premium"],"expiresAt":"infinity"}'::jsonb
  ] loop
    begin
      perform public.persist_billing_verdict(a, ticket, invalid);
      raise exception 'W07-54: malformed/client-metadata verdicts cannot consume a verification ticket';
    exception when invalid_parameter_value then null;
    end;
  end loop;
  if (select verdict from api_private.billing_verification_tickets where id = ticket) is not null then
    raise exception 'W07-55: invalid verdict rejection must be atomic with ticket consumption';
  end if;
  perform public.persist_billing_verdict(a, ticket, inactive);
  lease := (public.claim_billing_webhook_delivery('w07-no-alias-escalation', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[a], 'w07-no-alias-escalation', payload, lease);
  begin
    perform public.complete_billing_webhook('w07-no-alias-escalation', payload, jsonb_build_object(a::text, ticket), lease);
    raise exception 'W07-56: a sync ticket cannot prove a webhook with the same subject';
  exception when invalid_parameter_value then null;
  end;
  ticket := (issued->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(a, ticket,
    '{"premium":true,"productKey":"expired-product","expiresAt":"2000-01-01T00:00:00Z","activeEntitlements":["pickle_sensei_pro"]}');
  if (r->'billing') - 'verifiedAt' is distinct from inactive then
    raise exception 'W07-57: expiry at persistence must yield a canonical inactive response without a stale grant';
  end if;
  select array_agg(format('00000000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid)
    into ids from generate_series(201,217) i;
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-too-many', 'transferred_to', to_jsonb(ids)));
  begin
    perform public.begin_billing_verification(ids, 'w07-too-many', payload);
    raise exception 'W07-58: the database must enforce the 16-subject cap before issuing tickets';
  exception when invalid_parameter_value then null;
  end;
end $$;

do $$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';
  payload jsonb := '{"event":{"id":"w07-historical-poison","app_user_id":"00000000-0000-4000-8000-0000000000a1"}}';
  original jsonb;
  ticket_count bigint;
  r jsonb;
begin
  insert into public.webhook_events (id, payload, received_at, processed_at)
    values ('w07-historical-poison', payload, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  select to_jsonb(e) into original from public.webhook_events e where id = 'w07-historical-poison';
  select count(*) into ticket_count from api_private.billing_verification_tickets;
  r := public.begin_billing_verification(array[a], 'w07-historical-poison', payload);
  perform public.complete_billing_webhook('w07-historical-poison', payload, '{}');
  if r is distinct from '{"outcome":"duplicate","event_id":"w07-historical-poison"}'::jsonb
     or (select to_jsonb(e) from public.webhook_events e where id = 'w07-historical-poison') is distinct from original
     or (select count(*) from api_private.billing_verification_tickets) <> ticket_count then
    raise exception 'W07-59: historical markers are preserved, never automatically deleted or repaired';
  end if;
end $$;

do $$
declare f regprocedure; r text;
begin
  foreach f in array array[
    'public.begin_billing_verification(uuid[],text,jsonb,uuid)'::regprocedure,
    'public.persist_billing_verdict(uuid,uuid,jsonb)'::regprocedure,
    'public.complete_billing_webhook(text,jsonb,jsonb,uuid)'::regprocedure,
    'public.claim_billing_webhook_delivery(text,jsonb,boolean)'::regprocedure,
    'public.release_billing_webhook_delivery(text,jsonb,uuid)'::regprocedure
  ] loop
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception 'W07-25: verification helpers require explicit service-role execution grants';
    end if;
    foreach r in array array['anon','authenticated'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        raise exception 'W07-26: clients cannot execute billing helper %', f;
      end if;
    end loop;
    if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'W07-27: PUBLIC must not execute billing helper %', f;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = f and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'W07-28: service-only helpers must use a fixed empty search_path';
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'api_private.billing_verification_tickets'::regclass) then
    raise exception 'W07-29: private verification tickets must have RLS enabled';
  end if;
  if (select count(distinct verification_order) from api_private.billing_verification_tickets
      where event_id = 'w07-transfer') <> 1 then
    raise exception 'W07-40: all transfer subjects must share one database-issued verification order';
  end if;
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(r, 'api_private.begin_billing_verification(uuid[],text,jsonb)', 'EXECUTE')
       or has_function_privilege(r, 'api_private.complete_billing_webhook(text,jsonb,jsonb)', 'EXECUTE') then
      raise exception 'W07-30: unfenced internal billing entrypoints must not be callable (%)', r;
    end if;
    if has_table_privilege(r, 'api_private.billing_verification_tickets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege(r, 'api_private.billing_webhook_claims', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_sequence_privilege(r, 'api_private.billing_verification_order_seq', 'USAGE,SELECT,UPDATE') then
      raise exception 'W07-30: even the service role must use helpers rather than forge tickets or claims (%)', r;
    end if;
    if has_any_column_privilege(r, 'public.billing_entitlements', 'INSERT,UPDATE,REFERENCES')
       or has_any_column_privilege(r, 'public.webhook_events', 'INSERT,UPDATE,REFERENCES') then
      raise exception 'W07-44: neither column grants nor table grants may bypass billing helpers (%)', r;
    end if;
    foreach f in array array[
      'api_private.billing_webhook_subjects(jsonb)'::regprocedure,
      'api_private.claim_billing_webhook(text,jsonb)'::regprocedure
    ] loop
      if has_function_privilege(r, f, 'EXECUTE')
         or not exists (select 1 from pg_proc p where p.oid = f and not p.prosecdef and p.proconfig @> array['search_path=""']) then
        raise exception 'W07-45: internal claim/scope helpers must be inaccessible and use a fixed search_path';
      end if;
    end loop;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'api_private.billing_webhook_claims'::regclass) then
    raise exception 'W07-46: private event claims must have RLS enabled';
  end if;
end $$;
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
values ('00000000-0000-4000-8000-000000009299', '00000000-0000-4000-8000-000000000092',
        'api-tombstone-proof', 'finalized', 'scored');
delete from public.analysis_permits where id = '00000000-0000-4000-8000-000000009299';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000092';
do $$
declare header text := current_setting('request.headers');
begin
  if not public.permit_tombstoned('00000000-0000-4000-8000-000000009299') then
    raise exception 'M11: an API-authorized owner must retain the terminal permit verdict';
  end if;
  perform set_config('request.headers', '{}', true);
  if public.permit_tombstoned('00000000-0000-4000-8000-000000009299') then
    raise exception 'M12: the definer tombstone reader must require the API proof';
  end if;
  perform set_config('request.headers', header, true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000f', true);
  if public.permit_tombstoned('00000000-0000-4000-8000-000000009299') then
    raise exception 'M13: API proof must not expose another user''s tombstone';
  end if;
end $$;
reset role;

create table public.security_default_privilege_probe (id integer);
create sequence public.security_default_sequence_probe;
create function public.security_default_function_probe() returns integer
  language sql set search_path = '' as $$ select 1 $$;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.security_default_privilege_probe',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'K18: new tables must not inherit % privileges', r;
    end if;
    if has_sequence_privilege(r, 'public.security_default_sequence_probe', 'SELECT,UPDATE,USAGE') then
      raise exception 'K19: new sequences must not inherit % privileges', r;
    end if;
    if has_function_privilege(r, 'public.security_default_function_probe()', 'EXECUTE') then
      raise exception 'K20: new functions must not inherit % execution', r;
    end if;
  end loop;
end $$;

rollback;

create schema w07_probe;
create extension dblink with schema w07_probe;

create function w07_probe.await_lock(p_application text)
returns void language plpgsql set search_path = '' as $$
declare deadline timestamptz := clock_timestamp() + interval '3 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity where application_name = p_application and wait_event_type = 'Lock') then
      return;
    end if;
    if clock_timestamp() > deadline then
      raise exception 'W07 concurrency: the second connection never encountered the expected database lock';
    end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

create function w07_probe.collect(p_connection text, p_error text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare r jsonb;
begin
  select value into r from w07_probe.dblink_get_result(p_connection, p_error is null) as result(value jsonb);
  if p_error is not null and position(p_error in w07_probe.dblink_error_message(p_connection)) = 0 then
    raise exception 'W07 concurrency: expected rejection % was not observed', p_error;
  end if;
  perform 1 from w07_probe.dblink_get_result(p_connection, false) as result(value jsonb);
  return r;
end $$;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000e1', 'billing-race@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000e2', 'billing-delete-race@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000e3', 'billing-profile-race@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000e4', 'billing-admission-race@example.test', '{"provider":"google"}');

do $$
<<billing_matrix>>
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  c text;
  a uuid := '00000000-0000-4000-8000-0000000000e1';
  deleted_user uuid := '00000000-0000-4000-8000-0000000000e2';
  profile_user uuid := '00000000-0000-4000-8000-0000000000e3';
  older uuid;
  newer uuid;
  first_ticket uuid;
  second_ticket uuid;
  first_verdict jsonb;
  second_verdict jsonb;
  active jsonb := '{"premium":true,"productKey":"verified-store-product","expiresAt":null,"activeEntitlements":["pickle_sensei_pro"]}';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  newest_active boolean;
  newest_first boolean;
  conflicting boolean;
  issued jsonb;
  r jsonb;
  first_result jsonb;
  payload jsonb;
  conflicting_payload jsonb;
  proofs jsonb;
  query text;
  event_id text;
  scenario_count integer := 0;
  ticket_count bigint;
begin
  foreach c in array array['w07_setup','w07_first','w07_second'] loop
    perform w07_probe.dblink_connect(c, connection || ' application_name=' || c);
    perform w07_probe.dblink_exec(c, 'set statement_timeout = ''5s''');
  end loop;
  perform w07_probe.dblink_exec('w07_setup', 'set role service_role');
  foreach newest_active in array array[false,true] loop
    foreach newest_first in array array[false,true] loop
      select value into issued from w07_probe.dblink('w07_setup', format(
        'select public.begin_billing_verification(%L::uuid[])', array[a]::text
      )) as result(value jsonb);
      older := (issued->0->>'ticket_id')::uuid;
      select value into issued from w07_probe.dblink('w07_setup', format(
        'select public.begin_billing_verification(%L::uuid[])', array[a]::text
      )) as result(value jsonb);
      newer := (issued->0->>'ticket_id')::uuid;
      first_ticket := case when newest_first then newer else older end;
      second_ticket := case when newest_first then older else newer end;
      first_verdict := case when newest_first = newest_active then active else inactive end;
      second_verdict := case when newest_first = newest_active then inactive else active end;
      perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
      select value into first_result from w07_probe.dblink('w07_first', format(
        'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, first_ticket, first_verdict
      )) as result(value jsonb);
      perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
      perform w07_probe.dblink_send_query('w07_second', format(
        'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, second_ticket, second_verdict
      ));
      perform w07_probe.await_lock('w07_second');
      perform w07_probe.dblink_exec('w07_first', 'commit');
      r := w07_probe.collect('w07_second');
      perform w07_probe.dblink_exec('w07_second', 'commit');
      if r->>'outcome' <> 'persisted' or (r->'billing'->>'premium')::boolean <> newest_active
         or (r->>'applied')::boolean = newest_first
         or (select premium from public.billing_entitlements where user_id = a) <> newest_active then
        raise exception 'W07 concurrency: atomic persistence failed (newest active %, newest first %)', newest_active, newest_first;
      end if;
      scenario_count := scenario_count + 1;
    end loop;
  end loop;

  foreach conflicting in array array[false,true] loop
    select value into issued from w07_probe.dblink('w07_setup', format(
      'select public.begin_billing_verification(%L::uuid[])', array[a]::text
    )) as result(value jsonb);
    older := (issued->0->>'ticket_id')::uuid;
    perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
    select value into first_result from w07_probe.dblink('w07_first', format(
      'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older, active
    )) as result(value jsonb);
    perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
    perform w07_probe.dblink_send_query('w07_second', format(
      'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older,
      case when conflicting then inactive else active end
    ));
    perform w07_probe.await_lock('w07_second');
    perform w07_probe.dblink_exec('w07_first', 'commit');
    r := w07_probe.collect('w07_second', case when conflicting then 'Conflicting verification ticket verdict' else null end);
    perform w07_probe.dblink_exec('w07_second', case when conflicting then 'rollback' else 'commit' end);
    if not (select premium from public.billing_entitlements where user_id = a)
       or (not conflicting and (r->>'applied' <> 'false' or r->'billing' <> first_result->'billing')) then
      raise exception 'W07 concurrency: repeated ticket persistence must be identical or reject a conflicting verdict';
    end if;
    scenario_count := scenario_count + 1;
  end loop;

  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-concurrent-audit', 'app_user_id', a));
  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb)', array[a]::text, 'w07-concurrent-audit', payload
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform value from w07_probe.dblink('w07_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older, inactive
  )) as result(value jsonb);
  proofs := jsonb_build_object(a::text, older);
  query := format('select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb)', 'w07-concurrent-audit', payload, proofs);
  perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
  perform value from w07_probe.dblink('w07_first', query) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
  perform w07_probe.dblink_send_query('w07_second', query);
  perform w07_probe.await_lock('w07_second');
  perform w07_probe.dblink_exec('w07_first', 'commit');
  r := w07_probe.collect('w07_second');
  perform w07_probe.dblink_exec('w07_second', 'commit');
  if r->>'received' <> 'true' or (select count(*) from public.webhook_events where id = 'w07-concurrent-audit') <> 1 then
    raise exception 'W07 concurrency: simultaneous audit completions must retain one immutable event';
  end if;
  scenario_count := scenario_count + 1;

  foreach conflicting in array array[false,true] loop
    event_id := 'w07-concurrent-claim-' || conflicting::text;
    payload := jsonb_build_object('event', jsonb_build_object('id', event_id, 'app_user_id', a));
    conflicting_payload := case when conflicting then jsonb_set(payload, '{event,app_user_id}', to_jsonb(profile_user)) else payload end;
    perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
    select value into issued from w07_probe.dblink('w07_first', format(
      'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb)', array[a]::text, event_id, payload
    )) as result(value jsonb);
    older := (issued->0->>'ticket_id')::uuid;
    perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
    perform w07_probe.dblink_send_query('w07_second', format(
      'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb)',
      array[case when conflicting then profile_user else a end]::text, event_id, conflicting_payload
    ));
    perform w07_probe.await_lock('w07_second');
    perform w07_probe.dblink_exec('w07_first', 'commit');
    r := w07_probe.collect('w07_second', case when conflicting then 'Conflicting webhook verification payload' else null end);
    perform w07_probe.dblink_exec('w07_second', case when conflicting then 'rollback' else 'commit' end);
    if (select count(*) from api_private.billing_webhook_claims c where c.event_id = billing_matrix.event_id) <> 1
       or (select count(*) from api_private.billing_verification_tickets t where t.event_id = billing_matrix.event_id) <> (case when conflicting then 1 else 2 end)
       or (not conflicting and (r->0->>'outcome' <> 'issued' or r->0->>'ticket_id' = older::text)) then
      raise exception 'W07 concurrency: identical claims must get fresh ordered tickets, conflicting scopes must get none';
    end if;
    if not conflicting and (select verification_order from api_private.billing_verification_tickets where id = (r->0->>'ticket_id')::uuid)
       <= (select verification_order from api_private.billing_verification_tickets where id = older) then
      raise exception 'W07 concurrency: serialized admissions must assign strictly increasing database orders';
    end if;
    scenario_count := scenario_count + 1;
  end loop;

  event_id := 'w07-complete-before-admission';
  payload := jsonb_build_object('event', jsonb_build_object('id', event_id, 'app_user_id', a));
  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb)', array[a]::text, event_id, payload
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform value from w07_probe.dblink('w07_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older, inactive
  )) as result(value jsonb);
  select count(*) into ticket_count from api_private.billing_verification_tickets;
  perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
  perform value from w07_probe.dblink('w07_first', format(
    'select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb)', event_id, payload, jsonb_build_object(a::text, older)
  )) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
  perform w07_probe.dblink_send_query('w07_second', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb)', array[a]::text, event_id, payload
  ));
  perform w07_probe.await_lock('w07_second');
  perform w07_probe.dblink_exec('w07_first', 'commit');
  r := w07_probe.collect('w07_second');
  perform w07_probe.dblink_exec('w07_second', 'commit');
  if r is distinct from jsonb_build_object('outcome', 'duplicate', 'event_id', event_id)
     or (select count(*) from api_private.billing_verification_tickets) <> ticket_count then
    raise exception 'W07 concurrency: admission must observe a concurrently committed completion without allocating tickets';
  end if;
  scenario_count := scenario_count + 1;

  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-conflicting-audit', 'app_user_id', a, 'type', 'RENEWAL'));
  conflicting_payload := jsonb_set(payload, '{event,type}', '"REFUND"');
  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb)', array[a]::text, 'w07-conflicting-audit', payload
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform value from w07_probe.dblink('w07_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older, inactive
  )) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
  perform value from w07_probe.dblink('w07_first', format(
    'select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb)', 'w07-conflicting-audit', payload, jsonb_build_object(a::text, older)
  )) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
  perform w07_probe.dblink_send_query('w07_second', format(
    'select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb)', 'w07-conflicting-audit', conflicting_payload, jsonb_build_object(a::text, older)
  ));
  perform w07_probe.await_lock('w07_second');
  perform w07_probe.dblink_exec('w07_first', 'commit');
  perform w07_probe.collect('w07_second', 'Conflicting webhook verification payload');
  perform w07_probe.dblink_exec('w07_second', 'rollback');
  if (select e.payload from public.webhook_events e where id = 'w07-conflicting-audit') <> payload then
    raise exception 'W07 concurrency: conflicting audit completion must not rewrite or silently acknowledge another payload';
  end if;
  scenario_count := scenario_count + 1;

  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[])', array[deleted_user]::text
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
  perform value from w07_probe.dblink('w07_first', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', deleted_user, older, active
  )) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_second', 'begin');
  perform w07_probe.dblink_send_query('w07_second', format(
    'with removed as (delete from auth.users where id = %L::uuid returning id) select jsonb_build_object(''deleted'', count(*)) from removed', deleted_user
  ));
  perform w07_probe.await_lock('w07_second');
  perform w07_probe.dblink_exec('w07_first', 'commit');
  r := w07_probe.collect('w07_second');
  perform w07_probe.dblink_exec('w07_second', 'commit');
  if r->>'deleted' <> '1' or exists (select 1 from public.billing_entitlements where user_id = deleted_user)
     or exists (select 1 from api_private.billing_verification_tickets where user_id = deleted_user) then
    raise exception 'W07 concurrency: account deletion must serialize and cascade all verification state';
  end if;
  select value into r from w07_probe.dblink('w07_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', deleted_user, older, active
  )) as result(value jsonb);
  if r->>'outcome' <> 'user_missing' then
    raise exception 'W07 concurrency: a delayed completion must not resurrect a deleted subject';
  end if;
  scenario_count := scenario_count + 1;

  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[])', array[profile_user]::text
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform w07_probe.dblink_exec('w07_first', 'begin');
  perform w07_probe.dblink_exec('w07_first', format('delete from public.profiles where id = %L::uuid', profile_user));
  perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
  perform w07_probe.dblink_send_query('w07_second', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', profile_user, older, active
  ));
  perform w07_probe.await_lock('w07_second');
  perform w07_probe.dblink_exec('w07_first', 'commit');
  perform w07_probe.collect('w07_second', 'Billing profile is unavailable');
  perform w07_probe.dblink_exec('w07_second', 'rollback');
  if not exists (select 1 from auth.users where id = profile_user)
     or (select verdict from api_private.billing_verification_tickets where id = older) is not null then
    raise exception 'W07 concurrency: a missing profile is retryable and must not seal a verification ticket';
  end if;
  scenario_count := scenario_count + 1;
  perform w07_probe.dblink_exec('w07_first', 'begin');
  perform w07_probe.dblink_exec('w07_first', 'delete from auth.users where id = ''00000000-0000-4000-8000-0000000000e4''');
  perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
  perform w07_probe.dblink_send_query('w07_second',
    'select public.begin_billing_verification(array[''00000000-0000-4000-8000-0000000000e4''::uuid])');
  perform w07_probe.await_lock('w07_second');
  perform w07_probe.dblink_exec('w07_first', 'commit');
  r := w07_probe.collect('w07_second');
  perform w07_probe.dblink_exec('w07_second', 'commit');
  if r->0->>'outcome' <> 'user_missing'
     or exists (select 1 from api_private.billing_verification_tickets where user_id = '00000000-0000-4000-8000-0000000000e4') then
    raise exception 'W07 concurrency: admission must serialize against deletion and never issue a ticket for a deleted subject';
  end if;
  scenario_count := scenario_count + 1;
  if scenario_count <> 14 then
    raise exception 'W07 concurrency: expected all 14 scenarios to execute, got %', scenario_count;
  end if;
  raise notice 'W07 concurrent billing scenarios passed: %', scenario_count;
  foreach c in array array['w07_setup','w07_first','w07_second'] loop
    perform w07_probe.dblink_disconnect(c);
  end loop;
end $$;

\echo W07 CONCURRENT BILLING MATRIX: ALL CASES PASSED
\echo SECURITY REGRESSION MATRIX: ALL CASES PASSED
