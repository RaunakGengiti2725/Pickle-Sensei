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
--   T. (W01-03, 20260908110000) settlement receipts bind the scored
--      settlement to owner/device/grant/ticket/operation/payload digest/
--      policy lineage: an identical replay is accepted and moves nothing, a
--      mismatched replay is refused before any permit or count is touched,
--      an invalid receipt persists nothing, and the receipt table is owner-
--      readable through the API gate only, client-unwritable, append-only
--      for every role and removed only by the shot/account cascade
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

-- N0b (W04-01): the one reservation reader every budget decision shares
-- — reserve_analysis_permit(), access_state(), issue_offline_grant() and the
-- shots gate — reports the same 0 for these five late holds: a stale or
-- swept permit is displaceable by a fresh reservation (its late sync then
-- answers to apply_synced_shot()'s backstop, N3), never a firm slot that
-- one path honours and another ignores.
do $$
begin
  if public.online_reservation_count() <> 0 then
    raise exception 'N0b: online_reservation_count() must agree with access_state (got %)', public.online_reservation_count();
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

-- ============================================================================
-- S. W01-01 (20260908100000_permit_partial_terminal_outcome): an honest
--    PARTIAL terminal outcome — mechanics-only output without a validated
--    benchmark — releases the permit, is never a charge, and is never
--    re-labelled as low_confidence or upgraded into a scored rating. Two fresh
--    users: Uma (free, Google identity) and Yun (member).
-- S1  the sync RPC accepts resultKind='partial': the shot persists with
--     result_kind='partial' (not low_confidence) and no score, the permit ends
--     released/partial, lifetime_scored_count() / access_state().scored_count
--     stay 0 and the identity ledger is untouched; the replay is idempotent;
--     a second shot on the partial permit is access.permit_not_reserved;
--     permit_backs_sync(released, partial) is false
-- S2  a partial result may not carry a score: the write is refused at the
--     table, no shot persists and the permit stays reserved (clean retry)
-- S3  with both free ratings spent, a partial is still accepted and free —
--     the count and the ledger stay at 2 — and the scored backstop still
--     refuses a third rating (access.paywall_required)
-- S4  a permit swept to released/expired while offline settles a late partial
--     into released/partial (both permit guards allow the late transition)
-- S5  the client role cannot forge a scored result out of a partial: the
--     released/partial permit is terminal (→ finalized/scored, → reserved,
--     → released/expired, → released/low_confidence are all 23514), partial
--     is never finalized (reserved → finalized/partial is 23514), a partial
--     shot row cannot be re-labelled scored (no UPDATE grant), a direct scored
--     INSERT backed only by a released/partial permit is 42501, and the RPC
--     naming a released/partial permit for a scored shot is
--     access.permit_not_reserved — for a free account and for a member
-- S6  tombstone: an owner DELETE of a released/partial permit (linked or
--     unlinked) leaves a released/partial tombstone; the id cannot be reopened
--     as reserved or in any other shape (23514); only the byte-identical
--     restore is allowed; the RPC answers access.permit_not_reserved for the
--     tombstoned id and writes nothing
-- S7  anti-reset: after Uma deletes her account the identity ledger still
--     reads exactly 2 (partials neither inflate nor reset it) and a re-created
--     account under the same identity inherits 2 and is refused a reservation
-- ============================================================================

reset role;
set local request.jwt.claim.sub = '';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000041', 'uma@example.com',
   '{"full_name":"Uma"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000042', 'yun@example.com',
   '{"full_name":"Yun"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-uma', '00000000-0000-4000-8000-000000000041',
   '{"sub":"google-sub-uma","email":"uma@example.com"}'),
  ('apple', 'apple-sub-yun', '00000000-0000-4000-8000-000000000042',
   '{"sub":"apple-sub-yun","email":"yun@example.com"}');
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000042', true, null);
-- Permits seeded by the owner (the client cannot name an id — Q2).
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000041', 'uma-partial-1', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000041', 'uma-scored-1', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000041', 'uma-scored-2', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-000000000041', 'uma-partial-at-limit', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000405', '00000000-0000-4000-8000-000000000041', 'uma-late-partial', 'reserved', null, now() - interval '25 hours'),
  ('00000000-0000-4000-8000-000000000406', '00000000-0000-4000-8000-000000000041', 'uma-partial-scored', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000407', '00000000-0000-4000-8000-000000000041', 'uma-client-release', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000408', '00000000-0000-4000-8000-000000000041', 'uma-third-rating', 'reserved', null, now()),
  ('00000000-0000-4000-8000-000000000411', '00000000-0000-4000-8000-000000000042', 'yun-partial-1', 'reserved', null, now());
-- the pg_cron sweep (expire-stale-analysis-permits) — the exact statement
update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';

create function pg_temp.s_ledger(p_provider text, p_sub text) returns integer
language sql as $$
  select coalesce((select scored_count from public.free_rating_ledger
                   where identity_hash = public.free_rating_identity_hash(p_provider, p_sub)), -1);
$$;
create function pg_temp.s_shot(p_id uuid) returns text
language sql as $$
  select coalesce((select result_kind || '/' || coalesce(overall_score::text, 'NULL')
                          || '/' || coalesce(analysis_permit_id::text, 'NULL')
                   from public.shots where id = p_id), 'MISSING');
$$;
grant execute on function pg_temp.s_shot(uuid) to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000041';

-- S1: the partial result is an explicit, honest terminal state — and free.
do $$
declare v text; rec record;
begin
  if public.lifetime_scored_count() <> 0 then
    raise exception 'S1 precondition: Uma starts at zero (got %)', public.lifetime_scored_count();
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000431',
    '00000000-0000-4000-8000-000000000401', 'partial'));
  if v <> 'accepted' then
    raise exception 'S1: a partial (mechanics-only) result must be accepted by the sync RPC (got %)', v;
  end if;
  if pg_temp.s_shot('00000000-0000-4000-8000-000000000431')
     <> 'partial/NULL/00000000-0000-4000-8000-000000000401' then
    raise exception 'S1: the shot must persist as result_kind=partial, unscored, linked to its permit (got %)',
      pg_temp.s_shot('00000000-0000-4000-8000-000000000431');
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000401') <> 'released/partial' then
    raise exception 'S1: the permit must end released/partial — never low_confidence, never finalized (got %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000401');
  end if;
  if public.lifetime_scored_count() <> 0 then
    raise exception 'S1: a partial must not count toward lifetime_scored_count() (got %)', public.lifetime_scored_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 6 then
    raise exception 'S1: access_state must report 0 scored and the 6 live reservations (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  if public.permit_backs_sync('released', 'partial') then
    raise exception 'S1: a released/partial permit is never acceptable backing';
  end if;
  -- idempotent replay: accepted, still one row
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000431',
    '00000000-0000-4000-8000-000000000401', 'partial'));
  if v <> 'accepted' then
    raise exception 'S1: replaying the partial sync must stay accepted (got %)', v;
  end if;
  -- one-permit-one-shot: a different shot on the partial permit is refused
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000432',
    '00000000-0000-4000-8000-000000000401', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'S1: a released/partial permit must not back a second shot (got %)', v;
  end if;
  if (select count(*) from public.shots where user_id = (select auth.uid())) <> 1 then
    raise exception 'S1: exactly one shot may exist (got %)',
      (select count(*) from public.shots where user_id = (select auth.uid()));
  end if;
end $$;

-- S2: a partial may not carry a score.
do $$
declare v text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000433',
    '00000000-0000-4000-8000-000000000406', 'partial')
    || jsonb_build_object('overallScore', 6.0));
  if v = 'accepted' then
    raise exception 'S2: a partial result carrying a score must be refused';
  end if;
  if pg_temp.s_shot('00000000-0000-4000-8000-000000000433') <> 'MISSING' then
    raise exception 'S2: the refused shot must not persist';
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000406') <> 'reserved/NULL' then
    raise exception 'S2: the permit must stay reserved for a clean retry (got %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000406');
  end if;
end $$;

-- S3: both free ratings spent; a partial is still free and unlocks nothing.
do $$
declare v text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000434',
    '00000000-0000-4000-8000-000000000402', 'scored'));
  if v <> 'accepted' then
    raise exception 'S3 precondition: first rating (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000435',
    '00000000-0000-4000-8000-000000000403', 'scored'));
  if v <> 'accepted' then
    raise exception 'S3 precondition: second rating (got %)', v;
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S3 precondition: both ratings count (got %)', public.lifetime_scored_count();
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000436',
    '00000000-0000-4000-8000-000000000404', 'partial'));
  if v <> 'accepted' then
    raise exception 'S3: a partial past the free limit is still free (got %)', v;
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000404') <> 'released/partial' then
    raise exception 'S3: the permit must end released/partial (got %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000404');
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S3: the partial must leave the lifetime count at 2 (got %)', public.lifetime_scored_count();
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000437',
    '00000000-0000-4000-8000-000000000408', 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'S3: the scored backstop must still refuse a third rating (got %)', v;
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000408') <> 'released/free_limit_exceeded' then
    raise exception 'S3: the refused permit ends released/free_limit_exceeded (got %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000408');
  end if;
  if pg_temp.s_shot('00000000-0000-4000-8000-000000000437') <> 'MISSING' then
    raise exception 'S3: the refused rating must not persist';
  end if;
end $$;

-- S4: a late partial on a swept permit.
do $$
declare v text;
begin
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000405') <> 'released/expired' then
    raise exception 'S4 precondition: the stale permit was swept (got %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000405');
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000438',
    '00000000-0000-4000-8000-000000000405', 'partial'));
  if v <> 'accepted' then
    raise exception 'S4: a swept permit must settle a late partial (got %)', v;
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000405') <> 'released/partial' then
    raise exception 'S4: the late permit must end released/partial (got %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000405');
  end if;
  if pg_temp.s_shot('00000000-0000-4000-8000-000000000438')
     <> 'partial/NULL/00000000-0000-4000-8000-000000000405' then
    raise exception 'S4: the late partial shot persists unscored and linked (got %)',
      pg_temp.s_shot('00000000-0000-4000-8000-000000000438');
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S4: the late partial must not count (got %)', public.lifetime_scored_count();
  end if;
end $$;

-- S5: the client role cannot forge a scored result out of a partial (Uma).
do $$
declare r text;
begin
  foreach r in array array[
    pg_temp.p_move('00000000-0000-4000-8000-000000000401', 'finalized', 'scored'),
    pg_temp.p_move('00000000-0000-4000-8000-000000000401', 'reserved', null),
    pg_temp.p_move('00000000-0000-4000-8000-000000000401', 'released', 'expired'),
    pg_temp.p_move('00000000-0000-4000-8000-000000000401', 'released', 'low_confidence'),
    pg_temp.p_move('00000000-0000-4000-8000-000000000401', 'finalized', 'partial'),
    pg_temp.p_move('00000000-0000-4000-8000-000000000407', 'finalized', 'partial')]
  loop
    if r <> '23514:access.permit_transition_rejected' then
      raise exception 'S5: a partial permit is terminal and partial is never finalized (got %)', r;
    end if;
  end loop;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000401') <> 'released/partial'
     or pg_temp.r_permit('00000000-0000-4000-8000-000000000407') <> 'reserved/NULL' then
    raise exception 'S5: refused moves must leave both permits untouched (got % / %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000401'),
      pg_temp.r_permit('00000000-0000-4000-8000-000000000407');
  end if;
  -- releasing an own reservation as partial without a shot (edge release
  -- path) is a legal, free settlement
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000407', 'released', 'partial');
  if r <> '' then
    raise exception 'S5: reserved → released/partial must be allowed (got %)', r;
  end if;
  -- the partial shot row cannot be re-labelled scored by the client
  r := pg_temp.q_try($q$update public.shots set result_kind = 'scored', overall_score = 9.5
                        where id = '00000000-0000-4000-8000-000000000431'$q$);
  if r <> '42501:' then
    raise exception 'S5: a partial shot must not be client-upgradable to scored (got %)', r;
  end if;
  if pg_temp.s_shot('00000000-0000-4000-8000-000000000431')
     <> 'partial/NULL/00000000-0000-4000-8000-000000000401' then
    raise exception 'S5: the partial shot must be unchanged (got %)', pg_temp.s_shot('00000000-0000-4000-8000-000000000431');
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S5: the lifetime count must be unchanged (got %)', public.lifetime_scored_count();
  end if;
end $$;

-- S5, member: a released/partial permit is not live backing for a direct
-- scored INSERT (42501 + verdict) nor for the RPC (permit_not_reserved).
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000042';
do $$
declare v text; r text; v_hint text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000441',
    '00000000-0000-4000-8000-000000000411', 'partial'));
  if v <> 'accepted' then
    raise exception 'S5: a member''s partial must be accepted (got %)', v;
  end if;
  if pg_temp.r_permit('00000000-0000-4000-8000-000000000411') <> 'released/partial'
     or pg_temp.s_shot('00000000-0000-4000-8000-000000000441')
        <> 'partial/NULL/00000000-0000-4000-8000-000000000411' then
    raise exception 'S5: the member''s partial settles the same way (got % / %)',
      pg_temp.r_permit('00000000-0000-4000-8000-000000000411'),
      pg_temp.s_shot('00000000-0000-4000-8000-000000000441');
  end if;
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-000000000442',
      '00000000-0000-4000-8000-000000000042',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
      'scoring-1', 'config-1'
    );
    raise exception 'S5: a direct scored INSERT backed only by a released/partial permit must be refused';
  exception when insufficient_privilege then
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint <> 'access.permit_not_reserved' then
      raise exception 'S5: the gate refusal must carry the permit verdict (got hint %)', v_hint;
    end if;
  end;
  if pg_temp.s_shot('00000000-0000-4000-8000-000000000442') <> 'MISSING' then
    raise exception 'S5: the refused direct row must not persist';
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000443',
    '00000000-0000-4000-8000-000000000411', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'S5: the RPC must refuse a scored shot on a released/partial permit (got %)', v;
  end if;
  r := pg_temp.p_move('00000000-0000-4000-8000-000000000411', 'finalized', 'scored');
  if r <> '23514:access.permit_transition_rejected' then
    raise exception 'S5: the member cannot re-label a partial permit as scored (got %)', r;
  end if;
  if (select count(*) from public.shots where user_id = (select auth.uid())) <> 1 then
    raise exception 'S5: the member holds exactly the one partial shot';
  end if;
end $$;

-- S6: tombstone — as the owner role.
reset role;
set local request.jwt.claim.sub = '';
do $$
declare saved record; r text; p_linked uuid := '00000000-0000-4000-8000-000000000401';
        p_unlinked uuid := '00000000-0000-4000-8000-000000000407';
begin
  select * into saved from public.analysis_permits where id = p_linked;
  r := pg_temp.q_try(format('delete from public.analysis_permits where id = %L', p_linked));
  if r <> 'allowed 1' then
    raise exception 'S6: the owner may remove the linked partial row (got %)', r;
  end if;
  if pg_temp.r_tomb(p_linked) <> '00000000-0000-4000-8000-000000000041:released/partial' then
    raise exception 'S6: the released/partial row must leave its tombstone (got %)', pg_temp.r_tomb(p_linked);
  end if;
  if (select analysis_permit_id from public.shots
      where id = '00000000-0000-4000-8000-000000000431') is distinct from p_linked then
    raise exception 'S6: the partial shot keeps its link';
  end if;
  foreach r in array array[
    pg_temp.q_try(format(
      $q$insert into public.analysis_permits (id, user_id, idempotency_key)
         values (%L, '00000000-0000-4000-8000-000000000041', 'uma-reopen')$q$, p_linked)),
    pg_temp.q_try(format(
      $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
         values (%L, '00000000-0000-4000-8000-000000000041', %L, 'finalized', 'scored')$q$,
      p_linked, saved.idempotency_key)),
    pg_temp.q_try(format(
      $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
         values (%L, '00000000-0000-4000-8000-000000000041', %L, 'released', 'low_confidence')$q$,
      p_linked, saved.idempotency_key)),
    pg_temp.q_try(format(
      $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
         values (%L, '00000000-0000-4000-8000-000000000042', %L, 'released', 'partial')$q$,
      p_linked, saved.idempotency_key))]
  loop
    if r <> '23514:access.permit_transition_rejected' then
      raise exception 'S6: a tombstoned partial id can only be restored, never reopened or re-shaped (got %)', r;
    end if;
  end loop;
  if pg_temp.r_permit(p_linked) <> 'MISSING' or pg_temp.r_tomb(p_linked) = 'NONE' then
    raise exception 'S6: refused inserts must leave the id gone and remembered';
  end if;
  r := pg_temp.q_try(format(
    $q$insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at, updated_at)
       values (%L, %L, %L, %L, %L, %L, %L)$q$,
    saved.id, saved.user_id, saved.idempotency_key, saved.status, saved.outcome,
    saved.created_at, saved.updated_at));
  if r <> 'allowed 1' then
    raise exception 'S6: the identical released/partial row must be restorable (got %)', r;
  end if;
  if pg_temp.r_permit(p_linked) <> 'released/partial' or pg_temp.r_tomb(p_linked) <> 'NONE' then
    raise exception 'S6: the restore is released/partial and consumes the tombstone (got % / %)',
      pg_temp.r_permit(p_linked), pg_temp.r_tomb(p_linked);
  end if;
  -- the unlinked released/partial permit (client release, S5) is remembered too
  r := pg_temp.q_try(format('delete from public.analysis_permits where id = %L', p_unlinked));
  if r <> 'allowed 1' then
    raise exception 'S6: the owner may remove the unlinked partial row (got %)', r;
  end if;
  if pg_temp.r_tomb(p_unlinked) <> '00000000-0000-4000-8000-000000000041:released/partial' then
    raise exception 'S6: the unlinked released/partial row must leave its tombstone (got %)', pg_temp.r_tomb(p_unlinked);
  end if;
end $$;

-- S6: as Uma, the tombstoned id is consumed, not unknown, and backs nothing.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000041';
do $$
declare v text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000444',
    '00000000-0000-4000-8000-000000000407', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'S6: a tombstoned partial id must answer access.permit_not_reserved (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000445',
    '00000000-0000-4000-8000-000000000407', 'partial'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'S6: a tombstoned partial id must not back a partial either (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot(
    '00000000-0000-4000-8000-000000000446',
    '00000000-0000-4000-8000-000000000401', 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'S6: the restored released/partial permit stays consumed (got %)', v;
  end if;
  if (select count(*) from public.shots where user_id = (select auth.uid())) <> 5 then
    raise exception 'S6: refused writes must leave no row (got % shots)',
      (select count(*) from public.shots where user_id = (select auth.uid()));
  end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S6: the lifetime count must still be 2 (got %)', public.lifetime_scored_count();
  end if;
end $$;

-- S7: anti-reset — partials neither inflate nor reset the identity ledger.
reset role;
set local request.jwt.claim.sub = '';
do $$
begin
  if pg_temp.s_ledger('google', 'google-sub-uma') <> 2 then
    raise exception 'S7 precondition: the identity ledger reads exactly the 2 scored ratings (got %)',
      pg_temp.s_ledger('google', 'google-sub-uma');
  end if;
  delete from auth.users where id = '00000000-0000-4000-8000-000000000041';
  if exists (select 1 from public.analysis_permits where user_id = '00000000-0000-4000-8000-000000000041')
     or exists (select 1 from public.shots where user_id = '00000000-0000-4000-8000-000000000041')
     or exists (select 1 from public.analysis_permit_tombstones where user_id = '00000000-0000-4000-8000-000000000041') then
    raise exception 'S7: account deletion must cascade permits, shots and tombstones';
  end if;
  if pg_temp.s_ledger('google', 'google-sub-uma') <> 2 then
    raise exception 'S7: the identity ledger must survive deletion at exactly 2 (got %)',
      pg_temp.s_ledger('google', 'google-sub-uma');
  end if;
end $$;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000043', 'uma@example.com',
        '{"full_name":"Uma"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-uma', '00000000-0000-4000-8000-000000000043',
        '{"sub":"google-sub-uma","email":"uma@example.com"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000043';
do $$
declare rec record; r record;
begin
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 2 or rec.reserved_count <> 0 then
    raise exception 'S7: the re-created account inherits exactly 2 (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into r from public.reserve_analysis_permit('uma-second-life-1');
  if r.result <> 'access.paywall_required' then
    raise exception 'S7: reserve must refuse the re-created account (got %)', r.result;
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- ============================================================================
-- T. W04-01 (20260908160000_offline_device_grants): device registry, per-device
--    offline grants with expiry and an append-only allocation ledger where
--    allocation ≠ consumption. Conservation: outstanding + consumed + released
--    offline tickets + live online reservations + lifetime scored ≤ 2 for a
--    free identity; a disconnected device's allocation is never reclaimed by
--    time, sweep, reinstall, key replacement or account deletion. Pro leases
--    are ≤ 7 days and ≤ the verified entitlement expiry. Every mutation goes
--    through API-gated, session-bound RPCs; the client role holds no write.
--    Users: Tara (free, Google), Theo (Pro, expires in 3 days), Tomas (Pro,
--    lifetime), Tess (stale premium=true past expires_at), Tim (free, Apple).
-- T1  registration: attested vs unattested devices, idempotent re-registration
--     never downgrades, environment mismatch is refused, grants need an
--     attested registration
-- T2  free allocation: two tickets, generation 1, 7-day execution window; the
--     online reservation path counts the outstanding tickets (conservation
--     across online + offline), a refresh re-issues the SAME outstanding
--     tickets under a new generation without allocating more
-- T3  allocation ≠ consumption: lifetime_scored_count() and the identity ledger
--     are untouched by allocation; consumption binds one ticket to one durably
--     delivered scored shot of the owner (idempotent replay, no double charge)
-- T4  release: an unused ticket is returned explicitly and stays terminal; a
--     consumed ticket cannot be released and a released one cannot be consumed;
--     allocated + consumed + released ≤ entitlement holds after every step;
--     the client can only say unused_ticket_returned — support_review is an
--     audit reason it can never self-assert
-- T5  no automatic reclaim: an expired grant on a device that never came back,
--     the pg_cron permit sweep, device deletion (reinstall / key replacement)
--     — the allocation stays outstanding and keeps counting
-- T6  account deletion does not reclaim: the ledger survives (no FK), the
--     re-created account under the same identity inherits the hold
-- T7  Pro leases: min(issued + 7d, verified expiry); lifetime → exactly 7 days;
--     a stale premium row is NOT premium (free path); the table refuses > 7d,
--     > entitlement, an unverified Pro lease, and any lease mutation
-- T8  denied client writes: no INSERT/UPDATE/DELETE on any of the three tables
--     for the client role even with the API key; cross-user reads are empty;
--     without the API key nothing is readable and every RPC fails closed;
--     without a live session every mutating RPC fails closed and writes nothing;
--     service_role holds no TRUNCATE/write on any of the three tables (row
--     triggers do not fire on TRUNCATE — the grant itself must be absent)
-- T9  the ledger is append-only for every role and closed at the table:
--     duplicate allocation, consumption after release, release after
--     consumption, consumption without a scored owner shot, and a shot that
--     already backs an online permit are all refused
-- T10 original-installation recovery after account deletion + re-creation:
--     the hold follows the identity (T6) AND the same installation key under
--     the same identity re-obtains and consumes its outstanding ticket; a
--     different installation allocates only what conservation leaves; a
--     different identity on the same key never inherits the ticket; the
--     client cannot close it as support; support closes it through the table
--     only in the identity's name; one delivered rating is charged exactly
--     once (no dead hold, no lost rating)
-- T11 (adversary, round 2: R1/R2; round 5 competing lane: A01/A09)
--     conservation against LATE-SYNCABLE permits: the allocator reads the
--     SAME online_reservation_count() as access_state() and
--     reserve_analysis_permit() — live ('reserved', < 24 h) permits only, as
--     the online path has always counted (N0/S1) — so no permit is a
--     reservation to one decision point and not another. Two live
--     reservations: no ticket. Stale reserved / swept pair: allocatable, and
--     the late sync those permits were kept for then meets
--     apply_synced_shot()'s backstop beside the tickets — refused as
--     access.paywall_required, released/free_limit_exceeded, no shot, no
--     ticket reclaimed — never a third rating; the online path is refused
--     the same way after the allocation. Budget used never exceeds 2.
-- T15 (adversary, round 5: A01/A02/A03; competing lane: A01/A09) the
--     direct-INSERT write gate counts other live reservations and outstanding
--     tickets; a ticket is settled only by the row consume_offline_ticket()
--     writes for it (shots.offline_ticket_id) — never an online-paid row,
--     never a pre-counted row whatever its client-supplied created_at says;
--     stale/swept permits are reservations to no decision point and their
--     late syncs are refused beside the tickets
-- T16 (adversary, round 6: ATK-01/ATK-05/ATK-06) one terminal event per
--     ticket is a TABLE invariant (unique partial index over consumed |
--     released) that holds with the row guard out of the way; the terminal
--     RPCs and the row guard serialize per TICKET through
--     api_private.offline_ticket_lock_key(ticket) — a key no client or
--     service role can compute — taken after the caller lock, so recovered
--     sibling accounts sharing a ticket contend on the same lock (a
--     per-caller lock cannot serialize two uids); register_offline_device()
--     holds the caller lock across its check-then-insert. The overlapping
--     transactions themselves run in
--     supabase/functions/api/__wf__/w04_01_offline_grants_concurrency.test.ts
-- T12 (adversary, round 2: R7b) service_role can never pass as a user through
--     the definer RPCs: with the API header, a user sub and a live session
--     claim, every one of the four RPCs (and the hold reader) is 42501 for
--     the service connection — no result row, no device, no ledger row —
--     and the EXECUTE grant itself is absent
-- T13 (adversary, round 4: A01) a ticket settles only a rating that was NOT
--     already counted before the ticket was allocated: a scored shot that
--     predates the allocation is 'offline.shot_not_chargeable' through the
--     RPC and check_violation at the table; the hold stays, the refresh
--     re-issues the same ticket, the online path stays closed; a rating
--     delivered after the allocation consumes the ticket exactly once and
--     lifetime scored + tickets ever allocated never exceed the budget
-- T14 (adversary, round 4: A02) an identity linked AFTER the allocation
--     inherits the outstanding holds exactly as it inherits the free-rating
--     ledger: delete the account, sign in with ONLY the late-linked identity
--     → hold = 2, paywall online and offline, 0 new tickets; the original
--     installation recovers its tickets and consumes one; a stranger on the
--     same key or a fresh identity never inherits; the link record is
--     append-only, closed to every client role, and refuses a ticket the
--     linking account does not own
-- ============================================================================

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000051', 'tara@example.com',
   '{"full_name":"Tara"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000052', 'theo@example.com',
   '{"full_name":"Theo"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000053', 'tomas@example.com',
   '{"full_name":"Tomas"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000054', 'tess@example.com',
   '{"full_name":"Tess"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000055', 'tim@example.com',
   '{"full_name":"Tim"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-tara', '00000000-0000-4000-8000-000000000051',
   '{"sub":"google-sub-tara","email":"tara@example.com"}'),
  ('apple', 'apple-sub-theo', '00000000-0000-4000-8000-000000000052',
   '{"sub":"apple-sub-theo","email":"theo@example.com"}'),
  ('apple', 'apple-sub-tomas', '00000000-0000-4000-8000-000000000053',
   '{"sub":"apple-sub-tomas","email":"tomas@example.com"}'),
  ('google', 'google-sub-tess', '00000000-0000-4000-8000-000000000054',
   '{"sub":"google-sub-tess","email":"tess@example.com"}'),
  ('apple', 'apple-sub-tim', '00000000-0000-4000-8000-000000000055',
   '{"sub":"apple-sub-tim","email":"tim@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000005101', '00000000-0000-4000-8000-000000000051'),
  ('00000000-0000-4000-8000-000000005201', '00000000-0000-4000-8000-000000000052'),
  ('00000000-0000-4000-8000-000000005301', '00000000-0000-4000-8000-000000000053'),
  ('00000000-0000-4000-8000-000000005401', '00000000-0000-4000-8000-000000000054'),
  ('00000000-0000-4000-8000-000000005501', '00000000-0000-4000-8000-000000000055');
insert into public.billing_entitlements (user_id, premium, expires_at)
values
  ('00000000-0000-4000-8000-000000000052', true, now() + interval '3 days'),
  ('00000000-0000-4000-8000-000000000053', true, null),
  ('00000000-0000-4000-8000-000000000054', true, now() - interval '1 day');

create temporary table t_state (key text primary key, id uuid);
grant select, insert, update on t_state to authenticated;
create function pg_temp.t_ledger(p_provider text, p_sub text) returns integer
language sql as $$
  select coalesce((select scored_count from public.free_rating_ledger
                   where identity_hash = public.free_rating_identity_hash(p_provider, p_sub)), -1);
$$;
create function pg_temp.t_events(p_uid uuid) returns text
language sql security definer as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
grant execute on function pg_temp.t_events(uuid) to authenticated;
-- Conservation as the reviewer reads it: every ticket ever allocated is in
-- exactly one of {outstanding, consumed, released}; tickets not consumed plus
-- the scored ratings plus every LIVE online reservation (a permit still
-- 'reserved' and younger than 24 h — the set access_state().reserved_count
-- has always counted, N0/S1 — not yet linked to a shot) never exceed the 2
-- lifetime free ratings. A stale or swept permit is not a reservation to any
-- decision point; t_syncable_permits() counts those separately so the tests
-- can show that such a permit's late sync is refused, never a third rating.
create function pg_temp.t_live_permits(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.analysis_permits p
  where p.user_id = p_uid
    and p.status = 'reserved'
    and p.created_at > now() - interval '24 hours'
    and not exists (select 1 from public.shots s where s.analysis_permit_id = p.id);
$$;
grant execute on function pg_temp.t_live_permits(uuid) to authenticated;
create function pg_temp.t_syncable_permits(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.analysis_permits p
  where p.user_id = p_uid
    and public.permit_backs_sync(p.status, p.outcome)
    and not exists (select 1 from public.shots s where s.analysis_permit_id = p.id);
$$;
grant execute on function pg_temp.t_syncable_permits(uuid) to authenticated;
create function pg_temp.t_conserved(p_uid uuid) returns boolean
language sql security definer as $$
  select
    (select count(*) from public.offline_allocation_ledger
     where user_id = p_uid and event = 'allocated')
    = (select count(*) from public.offline_allocation_ledger a
       where a.user_id = p_uid and a.event = 'allocated'
         and not exists (select 1 from public.offline_allocation_ledger t
                         where t.ticket_id = a.ticket_id and t.event in ('consumed', 'released')))
      + (select count(*) from public.offline_allocation_ledger
         where user_id = p_uid and event = 'consumed')
      + (select count(*) from public.offline_allocation_ledger
         where user_id = p_uid and event = 'released')
    and
    (select count(*) from public.offline_allocation_ledger a
     where a.user_id = p_uid and a.event = 'allocated'
       and not exists (select 1 from public.offline_allocation_ledger t
                       where t.ticket_id = a.ticket_id and t.event = 'consumed'))
    + (select count(*) from public.shots where user_id = p_uid and result_kind = 'scored')
    + pg_temp.t_live_permits(p_uid)
    <= 2;
$$;
grant execute on function pg_temp.t_conserved(uuid) to authenticated;

-- T1: registration.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000051';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005101"}';
do $$
declare r record; g record; first_seen timestamptz;
begin
  select * into r from public.register_offline_device('tara-key-1', 'production', true);
  if r.result <> 'accepted' or r.device_id is null or r.attestation_state <> 'attested' then
    raise exception 'T1: an attested production registration must be accepted (got %, %, %)',
      r.result, r.device_id, r.attestation_state;
  end if;
  insert into t_state values ('tara-device', r.device_id);
  select last_registered_at into first_seen from public.offline_devices where id = r.device_id;
  select * into g from public.register_offline_device('tara-key-1', 'production', false);
  if g.result <> 'accepted' or g.device_id <> r.device_id or g.attestation_state <> 'attested' then
    raise exception 'T1: re-registration is idempotent and never downgrades an attested device (got %, %, %)',
      g.result, g.device_id, g.attestation_state;
  end if;
  if (select count(*) from public.offline_devices where user_id = (select auth.uid())) <> 1 then
    raise exception 'T1: re-registration must not create a second device row';
  end if;
  select * into g from public.register_offline_device('tara-key-1', 'development', true);
  if g.result <> 'offline.device_environment_mismatch' then
    raise exception 'T1: a registered key cannot change attestation environment (got %)', g.result;
  end if;
  select * into g from public.register_offline_device('tara-sim', 'development', false);
  if g.result <> 'accepted' or g.attestation_state <> 'unattested' then
    raise exception 'T1: an unverified registration is recorded as unattested, never attested (got %, %)',
      g.result, g.attestation_state;
  end if;
  select * into g from public.register_offline_device('tara-sim', 'development', false);
  if g.result <> 'accepted' or g.attestation_state <> 'unattested' then
    raise exception 'T1: repeating an unverified registration keeps it unattested (got %, %)',
      g.result, g.attestation_state;
  end if;
  select * into g from public.register_offline_device('bad key with spaces', 'production', true);
  if g.result <> 'offline.invalid_input' then
    raise exception 'T1: a malformed installation key is refused without a write (got %)', g.result;
  end if;
  select * into g from public.register_offline_device('tara-key-2', 'staging', true);
  if g.result <> 'offline.invalid_input' then
    raise exception 'T1: an unknown attestation environment is refused (got %)', g.result;
  end if;
  if (select count(*) from public.offline_devices where user_id = (select auth.uid())) <> 2 then
    raise exception 'T1: refused registrations must not persist';
  end if;
  select * into g from public.issue_offline_grant('tara-sim', 2);
  if g.result <> 'offline.device_not_attested' then
    raise exception 'T1: an unattested device never receives a grant (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('never-registered', 2);
  if g.result <> 'offline.device_not_registered' then
    raise exception 'T1: an unregistered key never receives a grant (got %)', g.result;
  end if;
  if exists (select 1 from public.offline_grants where user_id = (select auth.uid())) then
    raise exception 'T1: refused grant requests must not persist';
  end if;
end $$;

-- T2: free allocation and conservation across the online path.
do $$
declare g record; g2 record; rec record; p record;
begin
  select * into g from public.issue_offline_grant('tara-key-1', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free'
     or g.generation <> 1 or coalesce(array_length(g.ticket_ids, 1), 0) <> 2
     or g.entitlement_expires_at is not null then
    raise exception 'T2: a free attested device receives two tickets in generation 1 (got %, %, %, %, %)',
      g.result, g.entitlement_source, g.generation, g.ticket_ids, g.entitlement_expires_at;
  end if;
  if g.expires_at <> g.issued_at + interval '7 days' then
    raise exception 'T2: the free execution window is exactly 7 days (got % → %)', g.issued_at, g.expires_at;
  end if;
  insert into t_state values ('tara-grant-1', g.grant_id), ('tara-t1', g.ticket_ids[1]), ('tara-t2', g.ticket_ids[2]);
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2' then
    raise exception 'T2: the ledger records exactly two allocation events (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  if public.offline_hold_count() <> 2 then
    raise exception 'T2: two outstanding tickets are held (got %)', public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 2 then
    raise exception 'T2: access_state reports the offline holds as reservations (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into p from public.reserve_analysis_permit('tara-online-1');
  if p.result <> 'access.paywall_required' then
    raise exception 'T2: an online reservation must count the outstanding offline tickets (got %)', p.result;
  end if;
  -- refresh: same outstanding tickets, next generation, nothing new allocated
  select * into g2 from public.issue_offline_grant('tara-key-1', 2);
  if g2.result <> 'accepted' or g2.generation <> 2 or g2.grant_id = g.grant_id
     or (select array_agg(t order by t) from unnest(g2.ticket_ids) t)
        <> (select array_agg(t order by t) from unnest(g.ticket_ids) t) then
    raise exception 'T2: a refresh re-issues the same outstanding tickets under generation 2 (got %, %, %)',
      g2.result, g2.generation, g2.ticket_ids;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2' or public.offline_hold_count() <> 2 then
    raise exception 'T2: a refresh allocates nothing (got %, hold %)',
      pg_temp.t_events((select auth.uid())), public.offline_hold_count();
  end if;
  if (select count(*) from public.offline_grants where user_id = (select auth.uid())) <> 2 then
    raise exception 'T2: both grants are recorded';
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T2: conservation violated after allocation';
  end if;
end $$;

-- T3: allocation ≠ consumption.
do $$
begin
  if public.lifetime_scored_count() <> 0 then
    raise exception 'T3: allocation must not count as a rating (got %)', public.lifetime_scored_count();
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
do $$
begin
  if pg_temp.t_ledger('google', 'google-sub-tara') <> -1 then
    raise exception 'T3: allocation must not write the identity ledger (got %)', pg_temp.t_ledger('google', 'google-sub-tara');
  end if;
end $$;
-- Another account's rating already on the server (owner write): its id is
-- never chargeable to Tara's ticket.
insert into public.shots (
  id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
) values
  ('00000000-0000-4000-8000-000000000521', '00000000-0000-4000-8000-000000000052', 'drive', now(), 0, 1000, 7, 1, 'scored',
   'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000051';
do $$
declare v text; rec record; t1 uuid := (select id from t_state where key = 'tara-t1'); t2 uuid := (select id from t_state where key = 'tara-t2');
begin
  -- The offline result is delivered THROUGH the settlement RPC: the shot row
  -- is written by the server, bound to the ticket, and the ledger's consumed
  -- event lands in the same transaction. Nothing the client wrote beforehand
  -- is evidence of a rendering.
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000512', null, 'low_confidence'));
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'T3: an unscored result never consumes a ticket (got %)', v;
  end if;
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000521', null, 'scored'));
  if v <> 'shot.id_conflict' then
    raise exception 'T3: another user''s shot never consumes this user''s ticket (got %)', v;
  end if;
  v := public.consume_offline_ticket(t1, '{"resultKind":"scored"}'::jsonb);
  if v <> 'offline.invalid_input' then
    raise exception 'T3: a result without an id is refused (got %)', v;
  end if;
  v := public.consume_offline_ticket(t1, '"not-a-shot"'::jsonb);
  if v <> 'offline.invalid_input' then
    raise exception 'T3: a malformed result is refused (got %)', v;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2'
     or exists (select 1 from public.shots where user_id = (select auth.uid())) then
    raise exception 'T3: refused consumption writes nothing (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000511', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T3: settling a ticket with the delivered scored shot is accepted (got %)', v;
  end if;
  if (select count(*) from public.shots
      where id = '00000000-0000-4000-8000-000000000511' and user_id = (select auth.uid())
        and result_kind = 'scored' and analysis_permit_id is null and offline_ticket_id = t1) <> 1 then
    raise exception 'T3: the settlement writes the rating bound to its ticket';
  end if;
  if public.lifetime_scored_count() <> 1 then
    raise exception 'T3: the settled rating counts once toward the lifetime allowance (got %)', public.lifetime_scored_count();
  end if;
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000511', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T3: the replay is idempotent (got %)', v;
  end if;
  v := public.consume_offline_ticket(t2, pg_temp.n_shot('00000000-0000-4000-8000-000000000511', null, 'scored'));
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'T3: one delivered shot consumes at most one ticket (got %)', v;
  end if;
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000514', null, 'scored'));
  if v <> 'offline.ticket_consumed' then
    raise exception 'T3: a consumed ticket is terminal (got %)', v;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000514') then
    raise exception 'T3: a refused settlement writes no shot';
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2,consumed:1' then
    raise exception 'T3: exactly one consumption event (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  if public.offline_hold_count() <> 1 then
    raise exception 'T3: the consumed ticket is no longer a hold; the other still is (got %)', public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T3: access_state reads 1 scored + 1 outstanding (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T3: conservation violated after consumption';
  end if;
end $$;

-- T4: explicit release — terminal, auditable, never a free re-credit by itself.
do $$
declare v text; rec record; p record; t1 uuid := (select id from t_state where key = 'tara-t1'); t2 uuid := (select id from t_state where key = 'tara-t2');
begin
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'offline.ticket_consumed' then
    raise exception 'T4: a consumed ticket cannot be released (got %)', v;
  end if;
  v := public.release_offline_ticket(t2, 'because');
  if v <> 'offline.invalid_input' then
    raise exception 'T4: a release needs a known reason (got %)', v;
  end if;
  v := public.release_offline_ticket(t2, 'support_review');
  if v <> 'offline.invalid_input' then
    raise exception 'T4: a client never self-asserts a support_review release (got %)', v;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2,consumed:1'
     or exists (select 1 from public.offline_allocation_ledger where user_id = (select auth.uid()) and reason = 'support_review') then
    raise exception 'T4: refused release reasons write nothing (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  v := public.release_offline_ticket(t2, 'unused_ticket_returned');
  if v <> 'accepted' then
    raise exception 'T4: returning an unused ticket is accepted (got %)', v;
  end if;
  v := public.release_offline_ticket(t2, 'unused_ticket_returned');
  if v <> 'accepted' then
    raise exception 'T4: the release replay is idempotent (got %)', v;
  end if;
  v := public.consume_offline_ticket(t2, pg_temp.n_shot('00000000-0000-4000-8000-000000000515', null, 'scored'));
  if v <> 'offline.ticket_released' then
    raise exception 'T4: a released ticket can never be consumed (got %)', v;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2,consumed:1,released:1' then
    raise exception 'T4: the ledger holds exactly one release (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  -- allocated + consumed + released ≤ entitlement: the returned ticket is
  -- terminal and still part of the identity's accounting.
  if public.offline_hold_count() <> 1 then
    raise exception 'T4: a released ticket still counts against the entitlement (got %)', public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T4: access_state reads 1 scored + 1 released (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into p from public.reserve_analysis_permit('tara-online-2');
  if p.result <> 'access.paywall_required' then
    raise exception 'T4: the released ticket is not a free third rating online (got %)', p.result;
  end if;
  select * into p from public.issue_offline_grant('tara-key-1', 2);
  if p.result <> 'access.paywall_required' then
    raise exception 'T4: the released ticket is not a free third rating offline (got %)', p.result;
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T4: conservation violated after release';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- T5: no automatic reclaim. Tim's device took one ticket 40 days ago and never
-- came back; the grant expired 33 days ago.
insert into public.offline_devices (id, user_id, installation_key_id, attestation_environment, attestation_state, attested_at)
values ('00000000-0000-4000-8000-000000000550', '00000000-0000-4000-8000-000000000055', 'tim-key-1', 'production', 'attested', now() - interval '40 days');
insert into public.offline_grants (id, user_id, device_id, entitlement_source, generation, issued_at, expires_at)
values ('00000000-0000-4000-8000-000000000551', '00000000-0000-4000-8000-000000000055', '00000000-0000-4000-8000-000000000550',
        'identity_lifetime_free', 1, now() - interval '40 days', now() - interval '33 days');
insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, created_at)
values ('00000000-0000-4000-8000-000000000055', '00000000-0000-4000-8000-000000000550', '00000000-0000-4000-8000-000000000551', 1,
        '00000000-0000-4000-8000-000000000555', 'allocated',
        array[public.free_rating_identity_hash('apple', 'apple-sub-tim')], now() - interval '40 days');
-- the pg_cron sweep (expire-stale-analysis-permits) — the exact statement
update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000055';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005501"}';
do $$
declare rec record; p record; g record;
begin
  if pg_temp.t_events((select auth.uid())) <> 'allocated:1' or public.offline_hold_count() <> 1 then
    raise exception 'T5: an expired grant does not release its allocation (got %, hold %)',
      pg_temp.t_events((select auth.uid())), public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 1 then
    raise exception 'T5: the stale allocation still counts (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into p from public.reserve_analysis_permit('tim-online-1');
  if p.result <> 'accepted' then
    raise exception 'T5: one rating remains for the online path (got %)', p.result;
  end if;
  select * into p from public.reserve_analysis_permit('tim-online-2');
  if p.result <> 'access.paywall_required' then
    raise exception 'T5: hold + reservation exhaust the entitlement (got %)', p.result;
  end if;
  -- the same device comes back: the grant is refreshed with the same ticket
  select * into g from public.issue_offline_grant('tim-key-1', 2);
  if g.result <> 'accepted' or g.generation <> 2 or g.ticket_ids <> array['00000000-0000-4000-8000-000000000555']::uuid[] then
    raise exception 'T5: the returning device gets its outstanding ticket back, nothing more (got %, %, %)',
      g.result, g.generation, g.ticket_ids;
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T5: conservation violated with a stale allocation';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
-- reinstall / key replacement: the device row goes away, the allocation does not
delete from public.offline_devices where id = '00000000-0000-4000-8000-000000000550';
do $$
begin
  if exists (select 1 from public.offline_grants where device_id = '00000000-0000-4000-8000-000000000550') then
    raise exception 'T5: grants follow their device';
  end if;
  if (select count(*) from public.offline_allocation_ledger where user_id = '00000000-0000-4000-8000-000000000055' and event = 'allocated') <> 1
     or exists (select 1 from public.offline_allocation_ledger where user_id = '00000000-0000-4000-8000-000000000055' and event <> 'allocated') then
    raise exception 'T5: deleting the device must not touch the ledger';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000055';
do $$
declare g record;
begin
  if public.offline_hold_count() <> 1 then
    raise exception 'T5: key replacement never reclaims the allocation (got %)', public.offline_hold_count();
  end if;
  select * into g from public.register_offline_device('tim-key-2', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T5: the new key registers (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('tim-key-2', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'T5: the new installation cannot re-take the ticket the old one holds (got %)', g.result;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:1' then
    raise exception 'T5: nothing was allocated or released (got %)', pg_temp.t_events((select auth.uid()));
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- T6: account deletion does not reclaim.
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-000000000051';
  if exists (select 1 from public.offline_devices where user_id = '00000000-0000-4000-8000-000000000051')
     or exists (select 1 from public.offline_grants where user_id = '00000000-0000-4000-8000-000000000051') then
    raise exception 'T6: devices and grants cascade with the account';
  end if;
  if pg_temp.t_events('00000000-0000-4000-8000-000000000051') <> 'allocated:2,consumed:1,released:1' then
    raise exception 'T6: the allocation ledger survives account deletion (got %)',
      pg_temp.t_events('00000000-0000-4000-8000-000000000051');
  end if;
  if pg_temp.t_ledger('google', 'google-sub-tara') <> 1 then
    raise exception 'T6: the identity ledger keeps the consumed rating (got %)', pg_temp.t_ledger('google', 'google-sub-tara');
  end if;
end $$;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000056', 'tara@example.com',
        '{"full_name":"Tara"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-tara', '00000000-0000-4000-8000-000000000056',
        '{"sub":"google-sub-tara","email":"tara@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000005601', '00000000-0000-4000-8000-000000000056');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000056';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005601"}';
do $$
declare rec record; p record; g record;
begin
  if public.offline_hold_count() <> 1 then
    raise exception 'T6: the re-created account inherits the identity''s outstanding hold (got %)', public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T6: 1 scored + 1 held survive deletion (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into p from public.reserve_analysis_permit('tara-second-life-1');
  if p.result <> 'access.paywall_required' then
    raise exception 'T6: delete-and-recreate is not a third rating online (got %)', p.result;
  end if;
  select * into g from public.register_offline_device('tara-key-3', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T6: the re-created account registers (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('tara-key-3', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'T6: delete-and-recreate is not a third rating offline (got %)', g.result;
  end if;
  if pg_temp.t_events((select auth.uid())) <> '' then
    raise exception 'T6: nothing was allocated to the new account (got %)', pg_temp.t_events((select auth.uid()));
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- T7: Pro leases.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000052';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005201"}';
do $$
declare g record; verified timestamptz;
begin
  perform public.register_offline_device('theo-key-1', 'production', true);
  select * into g from public.issue_offline_grant('theo-key-1', 2);
  select expires_at into verified from public.billing_entitlements where user_id = (select auth.uid());
  if g.result <> 'accepted' or g.entitlement_source <> 'verified_store'
     or coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then
    raise exception 'T7: a verified subscriber receives a lease, never tickets (got %, %, %)',
      g.result, g.entitlement_source, g.ticket_ids;
  end if;
  if g.expires_at <> verified or g.entitlement_expires_at <> verified then
    raise exception 'T7: the lease ends at the verified entitlement expiry when that is sooner than 7 days (got % vs %)',
      g.expires_at, verified;
  end if;
  if g.expires_at > g.issued_at + interval '7 days' then
    raise exception 'T7: a Pro lease is never longer than 7 days';
  end if;
  if pg_temp.t_events((select auth.uid())) <> '' then
    raise exception 'T7: a lease allocates no tickets (got %)', pg_temp.t_events((select auth.uid()));
  end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000053';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005301"}';
do $$
declare g record;
begin
  perform public.register_offline_device('tomas-key-1', 'production', true);
  select * into g from public.issue_offline_grant('tomas-key-1', 0);
  if g.result <> 'accepted' or g.entitlement_source <> 'verified_store'
     or g.expires_at <> g.issued_at + interval '7 days' or g.entitlement_expires_at is not null then
    raise exception 'T7: a lifetime purchase leases exactly 7 days (got %, %, % → %, %)',
      g.result, g.entitlement_source, g.issued_at, g.expires_at, g.entitlement_expires_at;
  end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000054';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005401"}';
do $$
declare g record;
begin
  perform public.register_offline_device('tess-key-1', 'production', true);
  select * into g from public.issue_offline_grant('tess-key-1', 1);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free'
     or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'T7: a stale premium row past expires_at is NOT premium — the free path applies (got %, %, %)',
      g.result, g.entitlement_source, g.ticket_ids;
  end if;
  if exists (select 1 from public.offline_grants where user_id = (select auth.uid()) and entitlement_source = 'verified_store') then
    raise exception 'T7: no Pro lease exists for a stale entitlement';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
do $$
declare theo_device uuid := (select id from public.offline_devices where installation_key_id = 'theo-key-1');
        tomas_device uuid := (select id from public.offline_devices where installation_key_id = 'tomas-key-1');
        tess_device uuid := (select id from public.offline_devices where installation_key_id = 'tess-key-1');
        theo_expiry timestamptz := (select expires_at from public.billing_entitlements where user_id = '00000000-0000-4000-8000-000000000052');
begin
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values ('00000000-0000-4000-8000-000000000053', tomas_device, 'verified_store', 9, now(), now() + interval '7 days 1 second', null);
    raise exception 'T7: a lease longer than 7 days must be refused at the table';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values ('00000000-0000-4000-8000-000000000052', theo_device, 'verified_store', 9, now(), theo_expiry + interval '1 second', theo_expiry);
    raise exception 'T7: a lease past the verified entitlement expiry must be refused at the table';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values ('00000000-0000-4000-8000-000000000052', theo_device, 'verified_store', 9, now(), now() + interval '5 days', now() + interval '30 days');
    raise exception 'T7: a lease must record the verified entitlement expiry, not a longer one';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values ('00000000-0000-4000-8000-000000000054', tess_device, 'verified_store', 9, now(), now() + interval '1 day', null);
    raise exception 'T7: a Pro lease without a verified, unexpired entitlement must be refused at the table';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values ('00000000-0000-4000-8000-000000000054', tess_device, 'identity_lifetime_free', 9, now(), now() + interval '1 day', now() + interval '1 day');
    raise exception 'T7: a free grant carries no entitlement expiry';
  exception when check_violation then null;
  end;
  begin
    update public.offline_grants set expires_at = expires_at + interval '1 day' where device_id = theo_device;
    raise exception 'T7: an issued lease is immutable for every role';
  exception when check_violation then null;
  end;
  if (select count(*) from public.offline_grants where generation = 9) <> 0 then
    raise exception 'T7: refused leases must not persist';
  end if;
end $$;

-- T8: denied client writes.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000052';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005201"}';
do $$
declare changed integer; header text := current_setting('request.headers'); claims text := current_setting('request.jwt.claims');
        theo_device uuid := (select id from public.offline_devices where user_id = (select auth.uid()));
        theo_grant uuid := (select id from public.offline_grants where user_id = (select auth.uid()));
        r record;
begin
  if theo_device is null or theo_grant is null then
    raise exception 'T8 precondition: the owner reads its own device and grant through the API';
  end if;
  if exists (select 1 from public.offline_devices where user_id <> (select auth.uid()))
     or exists (select 1 from public.offline_grants where user_id <> (select auth.uid()))
     or exists (select 1 from public.offline_allocation_ledger where user_id <> (select auth.uid())) then
    raise exception 'T8: cross-user rows are invisible';
  end if;
  begin
    insert into public.offline_devices (user_id, installation_key_id, attestation_environment, attestation_state, attested_at)
    values ((select auth.uid()), 'forged-key', 'production', 'attested', now());
    raise exception 'T8: direct clients must not register devices';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_devices set attestation_state = 'attested', attested_at = now() where id = theo_device;
    raise exception 'T8: direct clients must not attest devices';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.offline_devices where id = theo_device;
    raise exception 'T8: direct clients must not delete devices';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values ((select auth.uid()), theo_device, 'verified_store', 7, now(), now() + interval '1 day', now() + interval '3 days');
    raise exception 'T8: direct clients must not mint leases';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_grants set expires_at = now() + interval '1 hour' where id = theo_grant;
    raise exception 'T8: direct clients must not alter leases';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.offline_grants where id = theo_grant;
    raise exception 'T8: direct clients must not delete leases';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event)
    values ((select auth.uid()), theo_device, theo_grant, 1, gen_random_uuid(), 'allocated');
    raise exception 'T8: direct clients must not allocate tickets';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_allocation_ledger set event = 'consumed' where user_id = (select auth.uid());
    raise exception 'T8: direct clients must not rewrite the ledger';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.offline_allocation_ledger where user_id = (select auth.uid());
    raise exception 'T8: direct clients must not erase the ledger';
  exception when insufficient_privilege then null;
  end;
  -- another user's ticket is not addressable
  if public.consume_offline_ticket('00000000-0000-4000-8000-000000000555', pg_temp.n_shot('00000000-0000-4000-8000-000000000522', null, 'scored')) <> 'offline.ticket_not_found'
     or public.release_offline_ticket('00000000-0000-4000-8000-000000000555', 'unused_ticket_returned') <> 'offline.ticket_not_found' then
    raise exception 'T8: another user''s ticket is not addressable';
  end if;
  if exists (select 1 from public.offline_allocation_ledger where ticket_id = '00000000-0000-4000-8000-000000000555') then
    raise exception 'T8: another user''s ledger rows stay invisible';
  end if;
  -- no live session: every mutating RPC fails closed and writes nothing
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-000000005301"}', true);
  begin
    perform public.register_offline_device('theo-key-9', 'production', true);
    raise exception 'T8: registration binds to a live session of the caller';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.issue_offline_grant('theo-key-1', 0);
    raise exception 'T8: a grant binds to a live session of the caller';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.consume_offline_ticket(gen_random_uuid(), pg_temp.n_shot(gen_random_uuid(), null, 'scored'));
    raise exception 'T8: consumption binds to a live session of the caller';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.release_offline_ticket(gen_random_uuid(), 'unused_ticket_returned');
    raise exception 'T8: release binds to a live session of the caller';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.issue_offline_grant('theo-key-1', 0);
    raise exception 'T8: a missing session fails closed';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', claims, true);
  if (select count(*) from public.offline_devices where user_id = (select auth.uid())) <> 1
     or (select count(*) from public.offline_grants where user_id = (select auth.uid())) <> 1 then
    raise exception 'T8: refused calls must not persist anything';
  end if;
  -- no API key: nothing is readable, every RPC fails closed
  perform set_config('request.headers', '{}', true);
  if exists (select 1 from public.offline_devices) or exists (select 1 from public.offline_grants)
     or exists (select 1 from public.offline_allocation_ledger) then
    raise exception 'T8: a user token alone must not read offline tables';
  end if;
  if public.offline_hold_count() <> 0 then
    raise exception 'T8: the definer hold reader must not bypass the API gate';
  end if;
  begin
    perform public.register_offline_device('theo-key-9', 'production', true);
    raise exception 'T8: registration requires the API gate';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.issue_offline_grant('theo-key-1', 0);
    raise exception 'T8: grants require the API gate';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.consume_offline_ticket(gen_random_uuid(), pg_temp.n_shot(gen_random_uuid(), null, 'scored'));
    raise exception 'T8: consumption requires the API gate';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.release_offline_ticket(gen_random_uuid(), 'unused_ticket_returned');
    raise exception 'T8: release requires the API gate';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.headers', header, true);
  if (select count(*) from public.offline_devices where user_id = (select auth.uid())) <> 1
     or (select count(*) from public.offline_grants where user_id = (select auth.uid())) <> 1 then
    raise exception 'T8: gated refusals must not persist anything';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local role anon;
do $$
begin
  begin
    perform public.offline_hold_count();
    raise exception 'T8: anon must not execute the hold reader';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.issue_offline_grant('x', 0);
    raise exception 'T8: anon must not execute the grant RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.offline_allocation_ledger;
    raise exception 'T8: anon must not read the ledger';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
-- service_role: no TRUNCATE (row triggers never see it), no write at all.
do $$
declare t text;
begin
  foreach t in array array['offline_devices', 'offline_grants', 'offline_allocation_ledger'] loop
    if has_table_privilege('service_role', format('public.%I', t), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'T8: service_role must hold no write or TRUNCATE on public.%', t;
    end if;
    if has_table_privilege('anon', format('public.%I', t), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('authenticated', format('public.%I', t), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'T8: client roles must hold no write on public.%', t;
    end if;
  end loop;
end $$;
create function pg_temp.t_ledger_rows() returns integer
language sql security definer as $$
  select count(*)::int from public.offline_allocation_ledger;
$$;
grant execute on function pg_temp.t_ledger_rows() to service_role;
set local role service_role;
do $$
declare n integer := pg_temp.t_ledger_rows();
begin
  begin
    truncate public.offline_allocation_ledger;
    raise exception 'T8: service_role must not TRUNCATE the allocation ledger';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate public.offline_grants;
    raise exception 'T8: service_role must not TRUNCATE the grants';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate public.offline_devices cascade;
    raise exception 'T8: service_role must not TRUNCATE the device registry';
  exception when insufficient_privilege then null;
  end;
  if pg_temp.t_ledger_rows() <> n then
    raise exception 'T8: a refused TRUNCATE must leave every allocation in place';
  end if;
end $$;
reset role;

-- T9: the ledger is append-only and closed at the table for every role.
do $$
declare tess_device uuid := (select id from public.offline_devices where installation_key_id = 'tess-key-1');
        tess_grant uuid := (select id from public.offline_grants where device_id = (select id from public.offline_devices where installation_key_id = 'tess-key-1'));
        tess_ticket uuid := (select ticket_id from public.offline_allocation_ledger where user_id = '00000000-0000-4000-8000-000000000054' and event = 'allocated');
        tara_t1 uuid := (select id from t_state where key = 'tara-t1');
        tara_t2 uuid := (select id from t_state where key = 'tara-t2');
        n integer;
begin
  select count(*) into n from public.offline_allocation_ledger;
  begin
    update public.offline_allocation_ledger set event = 'released', reason = 'support_review' where ticket_id = tess_ticket;
    raise exception 'T9: the ledger must refuse UPDATE for the owner role';
  exception when check_violation then null;
  end;
  begin
    delete from public.offline_allocation_ledger where ticket_id = tess_ticket;
    raise exception 'T9: the ledger must refuse DELETE for the owner role';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event)
    values ('00000000-0000-4000-8000-000000000054', tess_device, tess_grant, 1, tess_ticket, 'allocated');
    raise exception 'T9: a ticket is allocated once';
  exception when unique_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
    values ('00000000-0000-4000-8000-000000000051', tess_device, tess_grant, 1, tara_t2, 'consumed', '00000000-0000-4000-8000-000000000511');
    raise exception 'T9: a released ticket cannot be consumed by any role';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason)
    values ('00000000-0000-4000-8000-000000000051', tess_device, tess_grant, 1, tara_t1, 'released', 'support_review');
    raise exception 'T9: a consumed ticket cannot be released by any role';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason)
    values ('00000000-0000-4000-8000-000000000054', tess_device, tess_grant, 1, gen_random_uuid(), 'released', 'support_review');
    raise exception 'T9: a ticket that was never allocated cannot be released';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
    values ('00000000-0000-4000-8000-000000000054', tess_device, tess_grant, 1, tess_ticket, 'consumed', '00000000-0000-4000-8000-000000000521');
    raise exception 'T9: consumption requires a scored shot of the same owner';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id)
    values ('00000000-0000-4000-8000-000000000054', tess_device, tess_grant, 1, tess_ticket, 'consumed', null);
    raise exception 'T9: a consumption names its shot';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason)
    values ('00000000-0000-4000-8000-000000000054', tess_device, tess_grant, 1, tess_ticket, 'allocated', 'support_review');
    raise exception 'T9: an allocation carries no release reason';
  exception when check_violation or unique_violation then null;
  end;
  if (select count(*) from public.offline_allocation_ledger) <> n then
    raise exception 'T9: refused writes must not persist';
  end if;
end $$;
-- a shot that already backs an online permit is never charged twice
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000054';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005401"}';
do $$
declare p record; v text; tess_ticket uuid := (select ticket_id from public.offline_allocation_ledger where user_id = (select auth.uid()) and event = 'allocated');
begin
  select * into p from public.reserve_analysis_permit('tess-online-1');
  if p.result <> 'accepted' then
    raise exception 'T9 precondition: one online rating remains beside the offline ticket (got %)', p.result;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000541', p.permit_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'T9 precondition: the online rating syncs (got %)', v;
  end if;
  v := public.consume_offline_ticket(tess_ticket, pg_temp.n_shot('00000000-0000-4000-8000-000000000541', null, 'scored'));
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'T9: a shot charged to an online permit never also consumes a ticket (got %)', v;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:1' then
    raise exception 'T9: nothing was consumed (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T9: conservation violated across online + offline';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';

-- T10: original-installation recovery after account deletion + re-creation.
-- Tim (T5) still holds ticket ...555 on installation key tim-key-1; his
-- account is deleted and the same Apple identity signs in again as a new
-- account. The identity keeps the hold; the original installation must be
-- able to re-obtain and consume the ticket, and nothing else may.
create function pg_temp.t_identity_conserved(p_uid uuid, p_provider text, p_sub text) returns boolean
language sql security definer as $$
  select
    (select count(*) from public.offline_allocation_ledger a
     where a.event = 'allocated'
       and a.identity_hashes && array[public.free_rating_identity_hash(p_provider, p_sub)]
       and not exists (select 1 from public.offline_allocation_ledger t
                       where t.ticket_id = a.ticket_id and t.event = 'consumed'))
    + (select count(*) from public.shots where user_id = p_uid and result_kind = 'scored')
    + pg_temp.t_live_permits(p_uid)
    <= 2;
$$;
grant execute on function pg_temp.t_identity_conserved(uuid, text, text) to authenticated;
create function pg_temp.t_identity_hash(p_provider text, p_sub text) returns text
language sql security definer as $$
  select public.free_rating_identity_hash(p_provider, p_sub);
$$;
grant execute on function pg_temp.t_identity_hash(text, text) to authenticated;
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-000000000055';
  if (select count(*) from public.offline_allocation_ledger where ticket_id = '00000000-0000-4000-8000-000000000555') <> 1
     or exists (select 1 from public.offline_devices where user_id = '00000000-0000-4000-8000-000000000055')
     or exists (select 1 from public.analysis_permits where user_id = '00000000-0000-4000-8000-000000000055') then
    raise exception 'T10 precondition: the deleted account leaves exactly its outstanding allocation behind';
  end if;
end $$;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000058', 'tim@example.com',
        '{"full_name":"Tim"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-tim', '00000000-0000-4000-8000-000000000058',
        '{"sub":"apple-sub-tim","email":"tim@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000005801', '00000000-0000-4000-8000-000000000058');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000058';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005801"}';
do $$
declare rec record; p record; g record; t_new uuid;
        t_old uuid := '00000000-0000-4000-8000-000000000555';
begin
  if public.offline_hold_count() <> 1 then
    raise exception 'T10: the re-created account inherits the identity''s outstanding hold (got %)', public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 1 then
    raise exception 'T10: 0 scored + 1 held survive deletion (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  -- a DIFFERENT installation of the re-created account: nothing to recover;
  -- it allocates exactly what conservation leaves (one), never the old ticket
  select * into g from public.register_offline_device('tim-key-2', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T10: the re-created account registers a new installation (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('tim-key-2', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 or g.ticket_ids[1] = t_old then
    raise exception 'T10: a new installation allocates only the one remaining rating and never inherits the old ticket (got %, %)',
      g.result, g.ticket_ids;
  end if;
  t_new := g.ticket_ids[1];
  insert into t_state values ('tim-t-new', t_new);
  if public.offline_hold_count() <> 2 then
    raise exception 'T10: old + new tickets are both held (got %)', public.offline_hold_count();
  end if;
  select * into p from public.reserve_analysis_permit('tim-second-life-1');
  if p.result <> 'access.paywall_required' then
    raise exception 'T10: two holds exhaust the entitlement online (got %)', p.result;
  end if;
  -- the ORIGINAL installation (same key, same identity) re-obtains its ticket
  -- even though conservation leaves nothing new to allocate
  select * into g from public.register_offline_device('tim-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T10: the original installation re-registers (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('tim-key-1', 2);
  if g.result <> 'accepted' or g.generation <> 1 or g.entitlement_source <> 'identity_lifetime_free'
     or g.ticket_ids <> array[t_old] then
    raise exception 'T10: the original installation recovers exactly its outstanding ticket (got %, %, %)',
      g.result, g.generation, g.ticket_ids;
  end if;
  select * into g from public.issue_offline_grant('tim-key-1', 2);
  if g.result <> 'accepted' or g.generation <> 2 or g.ticket_ids <> array[t_old] then
    raise exception 'T10: the refresh re-issues the same recovered ticket (got %, %, %)', g.result, g.generation, g.ticket_ids;
  end if;
  if public.offline_hold_count() <> 2
     or (select count(*) from public.offline_allocation_ledger where user_id = (select auth.uid()) and event = 'allocated') <> 1 then
    raise exception 'T10: recovery allocates nothing (hold %, own allocations %)', public.offline_hold_count(),
      (select count(*) from public.offline_allocation_ledger where user_id = (select auth.uid()) and event = 'allocated');
  end if;
  -- the client cannot close the recovered ticket in support's name
  if public.release_offline_ticket(t_old, 'support_review') <> 'offline.invalid_input' then
    raise exception 'T10: a client never self-asserts a support_review release';
  end if;
  if not pg_temp.t_identity_conserved((select auth.uid()), 'apple', 'apple-sub-tim') then
    raise exception 'T10: conservation violated after recovery';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
-- a DIFFERENT identity on the same installation key never inherits the ticket
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000054';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005401"}';
do $$
declare g record; t_old uuid := '00000000-0000-4000-8000-000000000555';
        t_new uuid := (select id from t_state where key = 'tim-t-new');
begin
  if public.consume_offline_ticket(t_old, pg_temp.n_shot('00000000-0000-4000-8000-000000000582', null, 'scored')) <> 'offline.ticket_not_found'
     or public.release_offline_ticket(t_old, 'unused_ticket_returned') <> 'offline.ticket_not_found'
     or public.consume_offline_ticket(t_new, pg_temp.n_shot('00000000-0000-4000-8000-000000000582', null, 'scored')) <> 'offline.ticket_not_found'
     or public.release_offline_ticket(t_new, 'unused_ticket_returned') <> 'offline.ticket_not_found' then
    raise exception 'T10: another identity cannot address the recovered or the new ticket';
  end if;
  select * into g from public.register_offline_device('tim-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T10: another identity registers the same key as its own device (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('tim-key-1', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'T10: another identity on the original key never inherits the ticket (got %, %)', g.result, g.ticket_ids;
  end if;
  if public.offline_hold_count() <> 1 then
    raise exception 'T10: the other identity''s own hold is unchanged (got %)', public.offline_hold_count();
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
-- the delivered offline result of the re-created account (the settlement
-- RPC writes it, no online permit) consumes the recovered ticket exactly once
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000058';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005801"}';
do $$
declare rec record; p record; v text; t_old uuid := '00000000-0000-4000-8000-000000000555';
        t_new uuid := (select id from t_state where key = 'tim-t-new');
begin
  v := public.consume_offline_ticket(t_old, pg_temp.n_shot('00000000-0000-4000-8000-000000000581', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T10: the original installation consumes its recovered ticket for the delivered rating (got %)', v;
  end if;
  if public.consume_offline_ticket(t_old, pg_temp.n_shot('00000000-0000-4000-8000-000000000581', null, 'scored')) <> 'accepted' then
    raise exception 'T10: the consume replay is idempotent';
  end if;
  v := public.consume_offline_ticket(t_new, pg_temp.n_shot('00000000-0000-4000-8000-000000000581', null, 'scored'));
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'T10: one delivered rating consumes exactly one ticket (got %)', v;
  end if;
  if public.offline_hold_count() <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'T10: consumption closes the recovered hold and the rating counts once (hold %, scored %)',
      public.offline_hold_count(), public.lifetime_scored_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T10: access_state reads 1 scored + 1 held, never 1 + 2 (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  if (select count(*) from public.offline_allocation_ledger
      where ticket_id = t_old and event = 'consumed' and user_id = (select auth.uid())
        and shot_id = '00000000-0000-4000-8000-000000000581'
        and installation_key_id = 'tim-key-1'
        and identity_hashes && array[pg_temp.t_identity_hash('apple', 'apple-sub-tim')]) <> 1 then
    raise exception 'T10: the consumption is recorded in the re-created account''s name on the original installation';
  end if;
  if not pg_temp.t_identity_conserved((select auth.uid()), 'apple', 'apple-sub-tim') then
    raise exception 'T10: conservation violated after the recovered consumption';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
-- support closes the remaining ticket through the table only in the
-- identity's name; a foreign owner is refused; the closed ticket still counts
do $$
declare a record; t_new uuid := (select id from t_state where key = 'tim-t-new');
begin
  select * into a from public.offline_allocation_ledger where ticket_id = t_new and event = 'allocated';
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes)
    values ('00000000-0000-4000-8000-000000000052', a.device_id, a.grant_id, a.generation, t_new, 'released', 'support_review', a.identity_hashes);
    raise exception 'T10: support cannot close a ticket in a foreign owner''s name';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
    values ('00000000-0000-4000-8000-000000000058', a.device_id, a.grant_id, a.generation, t_new, 'released', 'support_review', a.identity_hashes, 'tim-key-1');
    raise exception 'T10: a terminal event names the installation that holds the ticket';
  exception when check_violation then null;
  end;
  insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes)
  values ('00000000-0000-4000-8000-000000000058', a.device_id, a.grant_id, a.generation, t_new, 'released', 'support_review', a.identity_hashes);
  if (select installation_key_id from public.offline_allocation_ledger where ticket_id = t_new and event = 'released') <> 'tim-key-2' then
    raise exception 'T10: the support release inherits the allocation''s installation key';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000058';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005801"}';
do $$
declare rec record; p record; g record;
begin
  if public.offline_hold_count() <> 1 then
    raise exception 'T10: a support-released ticket still counts (got %)', public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T10: 1 scored + 1 released after support review (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into p from public.reserve_analysis_permit('tim-second-life-2');
  if p.result <> 'access.paywall_required' then
    raise exception 'T10: no third rating online after recovery (got %)', p.result;
  end if;
  select * into g from public.issue_offline_grant('tim-key-1', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'T10: no third rating offline after recovery (got %, %)', g.result, g.ticket_ids;
  end if;
  select * into g from public.issue_offline_grant('tim-key-2', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'T10: a released ticket is never re-issued (got %, %)', g.result, g.ticket_ids;
  end if;
  if not pg_temp.t_identity_conserved((select auth.uid()), 'apple', 'apple-sub-tim') then
    raise exception 'T10: conservation violated after support review';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';

-- T11: conservation against late-syncable permits (adversary round 2, R1/R2;
-- round 5 competing lane, A01/A09). Tobias (free, Google) holds a permit
-- still 'reserved' 25 h after it was issued — the hourly sweep is
-- best-effort — and a permit his client settled as cancelled. Tina (free,
-- Apple) reserved both ratings online and let them age past the sweep.
-- A stale or swept permit is NOT a reservation to any decision point —
-- access_state().reserved_count has never counted one (N0), and the
-- allocator reads the SAME online_reservation_count() the online path does,
-- so the two can never disagree about a permit (A01/A09). Its late sync is
-- honoured only while the budget is still there (section N): beside the
-- tickets the device took, apply_synced_shot()'s backstop refuses it as
-- access.paywall_required and releases the permit as free_limit_exceeded —
-- it never becomes a third rating, and no ticket is reclaimed for it.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000059', 'tobias@example.com',
   '{"full_name":"Tobias"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000005a', 'tina@example.com',
   '{"full_name":"Tina"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-tobias', '00000000-0000-4000-8000-000000000059',
   '{"sub":"google-sub-tobias","email":"tobias@example.com"}'),
  ('apple', 'apple-sub-tina', '00000000-0000-4000-8000-00000000005a',
   '{"sub":"apple-sub-tina","email":"tina@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000005901', '00000000-0000-4000-8000-000000000059'),
  ('00000000-0000-4000-8000-000000005a01', '00000000-0000-4000-8000-00000000005a');
-- the clock: a reservation Tobias made 25 h ago that nothing has settled
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-000000000591', '00000000-0000-4000-8000-000000000059', 'tobias-stale', now() - interval '25 hours');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000059';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005901"}';
do $$
declare g record; g2 record; p record; rec record; v text;
begin
  -- a permit the client settled as cancelled can never back a sync: not a reservation
  select * into p from public.reserve_analysis_permit('tobias-cancelled');
  if p.result <> 'accepted' then
    raise exception 'T11 precondition: one live reservation beside the stale one (got %)', p.result;
  end if;
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = p.permit_id;
  if pg_temp.t_syncable_permits((select auth.uid())) <> 1 or pg_temp.t_live_permits((select auth.uid())) <> 0 then
    raise exception 'T11 precondition: exactly the stale reserved permit can still back a sync, and it is not live (got %, %)',
      pg_temp.t_syncable_permits((select auth.uid())), pg_temp.t_live_permits((select auth.uid()));
  end if;
  select * into g from public.register_offline_device('tobias-key', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T11 precondition: registration (got %)', g.result;
  end if;
  -- every decision point reads the same reservation count: 0 (N0)
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 0 or public.online_reservation_count() <> 0 then
    raise exception 'T11: a stale permit is a reservation to no decision point (got %, %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count, public.online_reservation_count();
  end if;
  -- R2/A01: the allocator sees exactly what the online path sees — both
  -- ratings are free to allocate; the stale permit blocks neither
  select * into g from public.issue_offline_grant('tobias-key', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'T11: the allocator counts the same live reservations as reserve_analysis_permit() — 2 tickets beside a stale permit (got %, %)',
      g.result, g.ticket_ids;
  end if;
  insert into t_state values ('tobias-t', g.ticket_ids[1]);
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2' then
    raise exception 'T11: exactly two allocations are recorded (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T11: conservation violated by the allocation beside a stale permit';
  end if;
  -- A01: an online reservation AFTER the offline allocation is refused —
  -- the two paths agree that the budget is spent
  select * into p from public.reserve_analysis_permit('tobias-third');
  if p.result <> 'access.paywall_required' then
    raise exception 'T11: no online reservation beside two outstanding tickets (got %)', p.result;
  end if;
  if exists (select 1 from public.analysis_permits where idempotency_key = 'tobias-third') then
    raise exception 'T11: the refused reservation persisted nothing';
  end if;
  -- the stale permit's late sync meets the backstop: the tickets hold both
  -- ratings, so it is refused (section N3) and released — never a third rating
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000592', '00000000-0000-4000-8000-000000000591', 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'T11: a stale permit''s late sync beside two outstanding tickets is refused (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-000000000591';
  if p.status <> 'released' or p.outcome <> 'free_limit_exceeded' then
    raise exception 'T11: the refused late permit ends released/free_limit_exceeded (got %/%)', p.status, p.outcome;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000592') then
    raise exception 'T11: the refused late sync wrote no shot';
  end if;
  if pg_temp.t_syncable_permits((select auth.uid())) <> 0 then
    raise exception 'T11: nothing is left that could still back a sync (got %)', pg_temp.t_syncable_permits((select auth.uid()));
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 2 then
    raise exception 'T11: 0 scored + 2 outstanding tickets after the refused late sync (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T11: conservation violated after the late sync';
  end if;
  -- no ticket was reclaimed for the refused sync: the refresh re-issues both
  select * into g2 from public.issue_offline_grant('tobias-key', 2);
  if g2.result <> 'accepted' or g2.generation <> 2 or g2.ticket_ids <> g.ticket_ids then
    raise exception 'T11: a refresh re-issues the two outstanding tickets and allocates nothing (got %, %, %)',
      g2.result, g2.generation, g2.ticket_ids;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2' or not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T11: budget used stays at 2 (got %)', pg_temp.t_events((select auth.uid()));
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';

-- R1: Tina reserves both ratings online, then goes offline.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000005a';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005a01"}';
do $$
declare p1 record; p2 record; g record;
begin
  select * into p1 from public.reserve_analysis_permit('tina-online-1');
  select * into p2 from public.reserve_analysis_permit('tina-online-2');
  if p1.result <> 'accepted' or p2.result <> 'accepted' then
    raise exception 'T11 precondition: two online reservations (got %, %)', p1.result, p2.result;
  end if;
  insert into t_state values ('tina-p1', p1.permit_id), ('tina-p2', p2.permit_id);
  select * into g from public.register_offline_device('tina-key', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T11 precondition: registration (got %)', g.result;
  end if;
  -- R1: two live reservations leave no offline capacity
  select * into g from public.issue_offline_grant('tina-key', 2);
  if g.result <> 'access.paywall_required' or coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then
    raise exception 'T11: two live reservations leave no offline capacity (got %, %)', g.result, g.ticket_ids;
  end if;
  if pg_temp.t_events((select auth.uid())) <> '' then
    raise exception 'T11: a refused allocation writes nothing (got %)', pg_temp.t_events((select auth.uid()));
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
-- 24 h pass; the hourly sweep (expire-stale-analysis-permits) ages both
-- permits out — created_at cannot be moved after the fact, so the owner row
-- applies the sweep's transition to Tina's reservations.
update public.analysis_permits set status = 'released', outcome = 'expired'
where status = 'reserved' and user_id = '00000000-0000-4000-8000-00000000005a';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000005a';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005a01"}';
do $$
declare g record; g2 record; p record; rec record; v text;
        p1 uuid := (select id from t_state where key = 'tina-p1');
        p2 uuid := (select id from t_state where key = 'tina-p2');
begin
  if pg_temp.t_syncable_permits((select auth.uid())) <> 2 or pg_temp.t_live_permits((select auth.uid())) <> 0 then
    raise exception 'T11 precondition: both swept permits can still back a sync and neither is live (got %, %)',
      pg_temp.t_syncable_permits((select auth.uid())), pg_temp.t_live_permits((select auth.uid()));
  end if;
  -- A09: after the production sweep every decision point reports 0
  -- reservations — access_state, the online path and the allocator alike
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 0 or public.online_reservation_count() <> 0 then
    raise exception 'T11: swept permits are reservations to no decision point (got %, %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count, public.online_reservation_count();
  end if;
  select * into g from public.issue_offline_grant('tina-key', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'T11: the allocator sees what the online path sees — 2 tickets after the sweep (got %, %)',
      g.result, g.ticket_ids;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2' or not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T11: two allocations, conserved (got %)', pg_temp.t_events((select auth.uid()));
  end if;
  select * into p from public.reserve_analysis_permit('tina-online-3');
  if p.result <> 'access.paywall_required' then
    raise exception 'T11: no online reservation beside two outstanding tickets (got %)', p.result;
  end if;
  -- the late syncs the sweep kept acceptable meet the backstop: the device
  -- holds both ratings, so neither lands, neither is a third rating, and no
  -- ticket is reclaimed for them
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-0000000005a2', p1, 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'T11: the first swept permit''s late sync is refused beside two tickets (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-0000000005a3', p2, 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'T11: the second swept permit''s late sync is refused beside two tickets (got %)', v;
  end if;
  if (select count(*) from public.analysis_permits where id in (p1, p2) and status = 'released' and outcome = 'free_limit_exceeded') <> 2 then
    raise exception 'T11: both refused late permits end released/free_limit_exceeded';
  end if;
  if exists (select 1 from public.shots where id in ('00000000-0000-4000-8000-0000000005a2', '00000000-0000-4000-8000-0000000005a3')) then
    raise exception 'T11: the refused late syncs wrote no shot';
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 2 then
    raise exception 'T11: nothing scored, both tickets outstanding (got %, %, %)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T11: conservation violated after the late syncs';
  end if;
  select * into g2 from public.issue_offline_grant('tina-key', 2);
  if g2.result <> 'accepted' or g2.generation <> 2 or g2.ticket_ids <> g.ticket_ids then
    raise exception 'T11: the refresh re-issues the two outstanding tickets and allocates nothing (got %, %, %)',
      g2.result, g2.generation, g2.ticket_ids;
  end if;
  if pg_temp.t_events((select auth.uid())) <> 'allocated:2' then
    raise exception 'T11: budget used stays at 2 (got %)', pg_temp.t_events((select auth.uid()));
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';

-- T12: service_role can never pass as a user through the definer RPCs
-- (adversary round 2, R7b). The service connection carries everything the
-- Edge Function's per-user connection carries — API header, user sub, live
-- session claim — and is still refused before any read or write.
do $$
declare f regprocedure;
begin
  foreach f in array array[
    'public.register_offline_device(text,text,boolean)'::regprocedure,
    'public.issue_offline_grant(text,integer)'::regprocedure,
    'public.consume_offline_ticket(uuid,jsonb)'::regprocedure,
    'public.release_offline_ticket(uuid,text)'::regprocedure,
    'public.offline_hold_count()'::regprocedure
  ] loop
    if has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception 'T12: service_role must hold no EXECUTE on %', f;
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception 'T12: anon must hold no EXECUTE on %', f;
    end if;
    if not has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception 'T12: authenticated keeps EXECUTE on %', f;
    end if;
    if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception 'T12: PUBLIC must not execute %', f;
    end if;
  end loop;
end $$;
create function pg_temp.t_service_probe(p_uid uuid) returns text
language sql security definer as $$
  select format('devices:%s ledger:%s grants:%s',
    (select count(*) from public.offline_devices where user_id = p_uid),
    (select count(*) from public.offline_allocation_ledger where user_id = p_uid),
    (select count(*) from public.offline_grants where user_id = p_uid));
$$;
grant execute on function pg_temp.t_service_probe(uuid) to service_role;
grant select on t_state to service_role;
set local role service_role;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000059';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000005901"}';
do $$
declare before text := pg_temp.t_service_probe('00000000-0000-4000-8000-000000000059');
        tobias_ticket uuid := (select id from t_state where key = 'tobias-t');
begin
  if before <> 'devices:1 ledger:2 grants:2' then
    raise exception 'T12 precondition: Tobias holds one device, two allocations, two grants (got %)', before;
  end if;
  begin
    perform public.register_offline_device('service-key', 'production', true);
    raise exception 'T12: service_role must not register a device as the user';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.issue_offline_grant('tobias-key', 2);
    raise exception 'T12: service_role must not issue a grant as the user';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.consume_offline_ticket(tobias_ticket, pg_temp.n_shot('00000000-0000-4000-8000-000000000592', null, 'scored'));
    raise exception 'T12: service_role must not consume a ticket as the user';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.release_offline_ticket(tobias_ticket, 'unused_ticket_returned');
    raise exception 'T12: service_role must not release a ticket as the user';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.offline_hold_count();
    raise exception 'T12: service_role must not read holds as the user';
  exception when insufficient_privilege then null;
  end;
  if pg_temp.t_service_probe('00000000-0000-4000-8000-000000000059') <> before then
    raise exception 'T12: refused service calls must write nothing (got %)',
      pg_temp.t_service_probe('00000000-0000-4000-8000-000000000059');
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';

-- T13: a ticket settles only a rating that was not already counted before the
-- ticket was allocated (adversary round 4, A01). Una (free, Google) has one
-- scored rating from a month ago — already in lifetime_scored_count() when
-- her device asks for tickets, so she receives exactly one. Attaching that
-- old rating to the ticket would turn the hold into free capacity: the
-- consume must be refused, the hold must stay, and the next refresh must
-- re-issue the same ticket rather than a new one.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000061', 'una@example.com',
        '{"full_name":"Una"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-una', '00000000-0000-4000-8000-000000000061',
        '{"sub":"google-sub-una","email":"una@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000006101', '00000000-0000-4000-8000-000000000061');
-- the pre-counted rating: a rating the server already holds, no online
-- permit, captured a month ago — and carrying a FORGED created_at a year in
-- the future (adversary round 5, A03: created_at is a client-writable column
-- on a direct INSERT, so a timestamp comparison against the allocation is no
-- evidence of when the rating was rendered)
insert into public.shots (
  id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, created_at
) values
  ('00000000-0000-4000-8000-000000000611', '00000000-0000-4000-8000-000000000061', 'drive',
   now() - interval '30 days', 0, 1000, 7, 1, 'scored',
   'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', now() + interval '1 year');
create function pg_temp.t_tickets_ever(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.offline_allocation_ledger
  where user_id = p_uid and event = 'allocated';
$$;
grant execute on function pg_temp.t_tickets_ever(uuid) to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000061';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000006101"}';
do $$
declare g record; g2 record; rec record; p record; v text; t1 uuid;
        old_shot uuid := '00000000-0000-4000-8000-000000000611';
begin
  if public.lifetime_scored_count() <> 1 then
    raise exception 'T13 precondition: the old rating is already counted (got %)', public.lifetime_scored_count();
  end if;
  select * into g from public.register_offline_device('una-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T13: registration (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('una-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'T13: one counted rating leaves exactly one ticket to allocate (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1];
  insert into t_state values ('una-t1', t1);
  if public.offline_hold_count() <> 1 then
    raise exception 'T13: the ticket is held (got %)', public.offline_hold_count();
  end if;
  -- the attack: settle the ticket with the rating that was counted before it
  -- (its created_at says it is a year younger than the allocation)
  v := public.consume_offline_ticket(t1, pg_temp.n_shot(old_shot, null, 'scored'));
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'T13: a rating counted before the allocation never settles the ticket, whatever its created_at (got %)', v;
  end if;
  if public.offline_hold_count() <> 1 or pg_temp.t_events((select auth.uid())) <> 'allocated:1' then
    raise exception 'T13: the refused consume leaves the hold in place (hold %, events %)',
      public.offline_hold_count(), pg_temp.t_events((select auth.uid()));
  end if;
  select * into g2 from public.issue_offline_grant('una-key-1', 2);
  if g2.result <> 'accepted' or g2.generation <> 2 or g2.ticket_ids <> array[t1] then
    raise exception 'T13: the refresh re-issues the same held ticket, never a new one (got %, %, %)',
      g2.result, g2.generation, g2.ticket_ids;
  end if;
  if pg_temp.t_tickets_ever((select auth.uid())) <> 1 then
    raise exception 'T13: tickets ever allocated stays 1 (got %)', pg_temp.t_tickets_ever((select auth.uid()));
  end if;
  select * into p from public.reserve_analysis_permit('una-online-1');
  if p.result <> 'access.paywall_required' then
    raise exception 'T13: 1 counted + 1 held exhaust the entitlement online (got %)', p.result;
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T13: access_state reads 1 scored + 1 held (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T13: conservation violated after the refused consume';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
-- the table refuses the same settlement from any writer (support / owner)
do $$
declare a record; t1 uuid := (select id from t_state where key = 'una-t1');
begin
  select * into a from public.offline_allocation_ledger where ticket_id = t1 and event = 'allocated';
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
    values (a.user_id, a.device_id, a.grant_id, a.generation, t1, 'consumed', '00000000-0000-4000-8000-000000000611', a.identity_hashes);
    raise exception 'T13: the table never records a consumption for a rating counted before the allocation';
  exception when check_violation then null;
  end;
  if exists (select 1 from public.offline_allocation_ledger where ticket_id = t1 and event <> 'allocated') then
    raise exception 'T13: the refused table write persisted';
  end if;
end $$;
-- the rating rendered under the ticket, delivered through the settlement RPC,
-- settles it exactly once
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000061';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000006101"}';
do $$
declare g record; rec record; p record; v text; t1 uuid := (select id from t_state where key = 'una-t1');
begin
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000612', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T13: the rating delivered after the allocation settles the ticket (got %)', v;
  end if;
  if public.offline_hold_count() <> 0 or public.lifetime_scored_count() <> 2 then
    raise exception 'T13: consumption closes the hold and the rating counts once (hold %, scored %)',
      public.offline_hold_count(), public.lifetime_scored_count();
  end if;
  select * into g from public.issue_offline_grant('una-key-1', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'T13: two counted ratings leave nothing to allocate (got %, %)', g.result, g.ticket_ids;
  end if;
  select * into p from public.reserve_analysis_permit('una-online-2');
  if p.result <> 'access.paywall_required' then
    raise exception 'T13: two counted ratings leave nothing to reserve (got %)', p.result;
  end if;
  if pg_temp.t_tickets_ever((select auth.uid())) <> 1 or pg_temp.t_events((select auth.uid())) <> 'allocated:1,consumed:1' then
    raise exception 'T13: one ticket ever, one consumption (got %, %)',
      pg_temp.t_tickets_ever((select auth.uid())), pg_temp.t_events((select auth.uid()));
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T13: conservation violated after settlement';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';

-- T14: an identity linked AFTER the allocation inherits the outstanding holds
-- (adversary round 4, A02). Ulla (free, Google) holds two tickets on
-- ulla-key-1; an Apple identity is linked afterwards (GoTrue auto-link or
-- linkIdentity()); the account is deleted and re-created with ONLY the Apple
-- identity. The holds must follow that identity exactly as the free-rating
-- ledger does (20260905000100): hold = 2, paywall everywhere, 0 new tickets.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000062', 'ulla@example.com',
   '{"full_name":"Ulla"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000064', 'ursula@example.com',
   '{"full_name":"Ursula"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-ulla', '00000000-0000-4000-8000-000000000062',
   '{"sub":"google-sub-ulla","email":"ulla@example.com"}'),
  ('google', 'google-sub-ursula', '00000000-0000-4000-8000-000000000064',
   '{"sub":"google-sub-ursula","email":"ursula@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000006201', '00000000-0000-4000-8000-000000000062'),
  ('00000000-0000-4000-8000-000000006401', '00000000-0000-4000-8000-000000000064');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000062';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000006201"}';
do $$
declare g record;
begin
  select * into g from public.register_offline_device('ulla-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T14: registration (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('ulla-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'T14: two tickets are allocated to the first life (got %, %)', g.result, g.ticket_ids;
  end if;
  insert into t_state values ('ulla-t1', g.ticket_ids[1]), ('ulla-t2', g.ticket_ids[2]);
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
-- the late link, then deletion, then re-creation with ONLY the late identity
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-ulla', '00000000-0000-4000-8000-000000000062',
        '{"sub":"apple-sub-ulla","email":"ulla@example.com"}');
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-000000000062';
  if (select count(*) from public.offline_allocation_ledger where user_id = '00000000-0000-4000-8000-000000000062' and event = 'allocated') <> 2
     or exists (select 1 from public.offline_devices where user_id = '00000000-0000-4000-8000-000000000062') then
    raise exception 'T14 precondition: the deleted account leaves exactly its two outstanding allocations behind';
  end if;
end $$;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000063', 'ulla@example.com',
        '{"full_name":"Ulla"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-ulla', '00000000-0000-4000-8000-000000000063',
        '{"sub":"apple-sub-ulla","email":"ulla@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000006301', '00000000-0000-4000-8000-000000000063');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000063';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000006301"}';
do $$
declare g record; rec record; p record;
        t1 uuid := (select id from t_state where key = 'ulla-t1');
        t2 uuid := (select id from t_state where key = 'ulla-t2');
begin
  if public.offline_hold_count() <> 2 then
    raise exception 'T14: the late-linked identity inherits both outstanding holds (got %)', public.offline_hold_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 2 then
    raise exception 'T14: access_state reads 0 scored + 2 held (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into p from public.reserve_analysis_permit('ulla-second-life-1');
  if p.result <> 'access.paywall_required' then
    raise exception 'T14: the inherited holds exhaust the entitlement online (got %)', p.result;
  end if;
  -- a new installation of the re-created account allocates nothing
  select * into g from public.register_offline_device('ulla-key-2', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T14: the re-created account registers a new installation (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('ulla-key-2', 2);
  if g.result <> 'access.paywall_required' or coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then
    raise exception 'T14: a new installation receives no ticket while two are held (got %, %)', g.result, g.ticket_ids;
  end if;
  if pg_temp.t_tickets_ever((select auth.uid())) <> 0 or public.offline_hold_count() <> 2 then
    raise exception 'T14: nothing was allocated to the second life (ever %, hold %)',
      pg_temp.t_tickets_ever((select auth.uid())), public.offline_hold_count();
  end if;
  -- the ORIGINAL installation recovers exactly its two tickets
  select * into g from public.register_offline_device('ulla-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T14: the original installation re-registers (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('ulla-key-1', 2);
  if g.result <> 'accepted' or g.generation <> 1
     or (select array_agg(t order by t) from unnest(g.ticket_ids) t)
        <> (select array_agg(t order by t) from unnest(array[t1, t2]) t) then
    raise exception 'T14: the original installation recovers exactly its outstanding tickets (got %, %, %)',
      g.result, g.generation, g.ticket_ids;
  end if;
  if pg_temp.t_tickets_ever((select auth.uid())) <> 0 or public.offline_hold_count() <> 2 then
    raise exception 'T14: recovery allocates nothing (ever %, hold %)',
      pg_temp.t_tickets_ever((select auth.uid())), public.offline_hold_count();
  end if;
  if not pg_temp.t_identity_conserved((select auth.uid()), 'google', 'google-sub-ulla') then
    raise exception 'T14: conservation violated after recovery';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
-- a stranger on the original key, and a fresh identity, inherit nothing
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000064';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000006401"}';
do $$
declare g record; t1 uuid := (select id from t_state where key = 'ulla-t1');
begin
  if public.offline_hold_count() <> 0 then
    raise exception 'T14: a fresh identity holds nothing (got %)', public.offline_hold_count();
  end if;
  if public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000641', null, 'scored')) <> 'offline.ticket_not_found'
     or public.release_offline_ticket(t1, 'unused_ticket_returned') <> 'offline.ticket_not_found' then
    raise exception 'T14: a stranger cannot address the inherited tickets';
  end if;
  select * into g from public.register_offline_device('ulla-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T14: a stranger registers the same key as its own device (got %)', g.result;
  end if;
  select * into g from public.issue_offline_grant('ulla-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2
     or t1 = any(g.ticket_ids) then
    raise exception 'T14: a stranger on the original key allocates its own tickets, never the inherited ones (got %, %)',
      g.result, g.ticket_ids;
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
-- the delivered rating of the second life settles one recovered ticket
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000063';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000006301"}';
do $$
declare rec record; g record; v text;
        t1 uuid := (select id from t_state where key = 'ulla-t1');
begin
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000631', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T14: the late-linked identity settles its recovered ticket (got %)', v;
  end if;
  if public.offline_hold_count() <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'T14: 1 held + 1 scored after settlement (hold %, scored %)',
      public.offline_hold_count(), public.lifetime_scored_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T14: access_state reads 1 scored + 1 held (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into g from public.issue_offline_grant('ulla-key-2', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'T14: no third rating after settlement (got %, %)', g.result, g.ticket_ids;
  end if;
  if not pg_temp.t_identity_conserved((select auth.uid()), 'google', 'google-sub-ulla') then
    raise exception 'T14: conservation violated after settlement';
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
-- the link record is closed to every client role, append-only, and refuses a
-- ticket the linking account does not own
do $$
declare t1 uuid := (select id from t_state where key = 'ulla-t1');
        r regclass := to_regclass('public.offline_allocation_identity_links');
begin
  if r is null then
    raise exception 'T14: the late-link record public.offline_allocation_identity_links must exist';
  end if;
  if has_table_privilege('authenticated', r, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     or has_table_privilege('anon', r, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     or has_table_privilege('service_role', r, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'T14: no client or service role may touch the link record';
  end if;
  if (select count(*) from public.offline_allocation_identity_links
      where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-ulla')) <> 2 then
    raise exception 'T14: the late link recorded both outstanding tickets for the linked identity (got %)',
      (select count(*) from public.offline_allocation_identity_links
       where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-ulla'));
  end if;
  begin
    update public.offline_allocation_identity_links set identity_hash = 'x' where ticket_id = t1;
    raise exception 'T14: the link record is append-only (update)';
  exception when check_violation then null;
  end;
  begin
    delete from public.offline_allocation_identity_links where ticket_id = t1;
    raise exception 'T14: the link record is append-only (delete)';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_identity_links (ticket_id, identity_hash, user_id)
    values (t1, public.free_rating_identity_hash('google', 'google-sub-ursula'), '00000000-0000-4000-8000-000000000064');
    raise exception 'T14: a link is never recorded for an account that does not own the ticket';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_allocation_identity_links (ticket_id, identity_hash, user_id)
    values (gen_random_uuid(), public.free_rating_identity_hash('apple', 'apple-sub-ulla'), '00000000-0000-4000-8000-000000000063');
    raise exception 'T14: a link is never recorded for a ticket that was never allocated';
  exception when check_violation then null;
  end;
  if (select count(*) from public.offline_allocation_identity_links where ticket_id = t1) <> 1 then
    raise exception 'T14: refused link writes persisted nothing';
  end if;
end $$;

-- T15: conservation across the direct-INSERT write path and the settlement
-- path (adversary round 5: A01, A02, A03; competing lane A01, A09).
--
-- Every free-rating decision point — access_state(), reserve_analysis_
-- permit(), issue_offline_grant(), the shots write gate for a direct client
-- INSERT — adds the SAME three terms: lifetime scored ratings + live online
-- reservations (online_reservation_count(): 'reserved', < 24 h, not yet
-- settled by a shot — the set access_state() has always counted) +
-- outstanding offline tickets; every row-creating path (apply_synced_shot()'s
-- backstop, consume_offline_ticket(), the gate) keeps lifetime scored +
-- outstanding tickets ≤ 2. A stale or swept permit is a reservation to none
-- of them; its late sync is refused beside the tickets. A rating is settled
-- offline ONLY by the row consume_offline_ticket() writes for it, bound to
-- the ticket on the row (shots.offline_ticket_id) — never by a pre-existing
-- row, whatever its client-supplied created_at says.
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000071', 'vera@example.com',
   '{"full_name":"Vera"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000072', 'vito@example.com',
   '{"full_name":"Vito"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000073', 'wanda@example.com',
   '{"full_name":"Wanda"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000074', 'wes@example.com',
   '{"full_name":"Wes"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-vera', '00000000-0000-4000-8000-000000000071',
   '{"sub":"google-sub-vera","email":"vera@example.com"}'),
  ('apple', 'apple-sub-vito', '00000000-0000-4000-8000-000000000072',
   '{"sub":"apple-sub-vito","email":"vito@example.com"}'),
  ('google', 'google-sub-wanda', '00000000-0000-4000-8000-000000000073',
   '{"sub":"google-sub-wanda","email":"wanda@example.com"}'),
  ('apple', 'apple-sub-wes', '00000000-0000-4000-8000-000000000074',
   '{"sub":"apple-sub-wes","email":"wes@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000007101', '00000000-0000-4000-8000-000000000071'),
  ('00000000-0000-4000-8000-000000007201', '00000000-0000-4000-8000-000000000072'),
  ('00000000-0000-4000-8000-000000007301', '00000000-0000-4000-8000-000000000073'),
  ('00000000-0000-4000-8000-000000007401', '00000000-0000-4000-8000-000000000074');
-- Wanda: a permit still 'reserved' 25 h later (the sweep has not run).
-- Wes: a permit the hourly sweep flipped to released/expired — still
-- acceptable backing to apply_synced_shot().
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at)
values
  ('00000000-0000-4000-8000-0000000007e1', '00000000-0000-4000-8000-000000000073', 'wanda-stale', 'reserved', null, now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000007e2', '00000000-0000-4000-8000-000000000074', 'wes-swept', 'reserved', null, now() - interval '25 hours');
update public.analysis_permits set status = 'released', outcome = 'expired'
 where id = '00000000-0000-4000-8000-0000000007e2' and status = 'reserved' and created_at < now() - interval '24 hours';
create function pg_temp.t_direct_scored(p_id uuid, p_uid uuid, p_created_at timestamptz) returns void
language sql as $$
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, created_at
  ) values (
    p_id, p_uid, 'drive', now(), 0, 1000, 7, 1, 'scored',
    'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', p_created_at
  );
$$;
grant execute on function pg_temp.t_direct_scored(uuid, uuid, timestamptz) to authenticated;

-- A01: a direct client INSERT beside an outstanding ticket. Vera reserves P1
-- (1 reservation), takes one ticket T1 (1 hold): the identity's two ratings
-- are both spoken for. The live permit is the slot a direct row spends
-- (section E relies on that), so ONE direct row may land under P1 — after
-- which P1 backs nothing more: a second direct row is refused at the table
-- and the sync under P1 is refused by the backstop, which releases P1.
-- Before this migration the gate saw only "scored < 2 and a live permit":
-- the direct row AND the sync both landed beside the hold (3 units for 2).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000071';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007101"}';
do $$
declare g record; p record; rec record; v text; t1 uuid;
begin
  select * into g from public.register_offline_device('vera-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T15/A01: registration (got %)', g.result;
  end if;
  select * into p from public.reserve_analysis_permit('vera-online-1');
  if p.result <> 'accepted' then
    raise exception 'T15/A01 precondition: the first online reservation is accepted (got %)', p.result;
  end if;
  insert into t_state values ('vera-p1', p.permit_id);
  select * into g from public.issue_offline_grant('vera-key-1', 1);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'T15/A01 precondition: one ticket beside one reservation (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1];
  insert into t_state values ('vera-t1', t1);
  select * into rec from public.access_state();
  if rec.scored_count <> 0 or rec.reserved_count <> 2 then
    raise exception 'T15/A01: access_state reads 1 reservation + 1 hold (got %)', rec;
  end if;
  -- the direct row under P1: the one rating the live permit holds
  perform pg_temp.t_direct_scored('00000000-0000-4000-8000-000000000711', (select auth.uid()), now());
  if public.lifetime_scored_count() <> 1 then
    raise exception 'T15/A01: the direct row under the live permit is the identity''s first rating (got %)',
      public.lifetime_scored_count();
  end if;
  -- the attack: a second permit-less row while P1 is still live — the only
  -- unit left is T1's hold
  begin
    perform pg_temp.t_direct_scored('00000000-0000-4000-8000-000000000713', (select auth.uid()), now());
    raise exception 'T15/A01: a second direct scored INSERT under the same live permit beside an outstanding ticket must be refused';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000713') then
    raise exception 'T15/A01: the refused row must not persist';
  end if;
  -- the attack, other order: syncing under P1 after the direct row it admitted
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000712', (select id from t_state where key = 'vera-p1'), 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'T15/A01: the sync under P1 is refused beside 1 scored + 1 held (got %)', v;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000712') then
    raise exception 'T15/A01: the refused sync must not persist';
  end if;
  if not exists (select 1 from public.analysis_permits
                 where id = (select id from t_state where key = 'vera-p1')
                   and status = 'released' and outcome = 'free_limit_exceeded') then
    raise exception 'T15/A01: the refused permit is released (free_limit_exceeded), not left occupying a slot';
  end if;
  if public.lifetime_scored_count() <> 1 or public.offline_hold_count() <> 1 or public.online_reservation_count() <> 0 then
    raise exception 'T15/A01: 1 scored + 1 held + 0 reserved (got %, %, %)',
      public.lifetime_scored_count(), public.offline_hold_count(), public.online_reservation_count();
  end if;
  -- no second live permit beside the hold, so no further direct row either
  select * into p from public.reserve_analysis_permit('vera-online-2');
  if p.result <> 'access.paywall_required' then
    raise exception 'T15/A01: nothing is left to reserve beside 1 scored + 1 held (got %)', p.result;
  end if;
  begin
    perform pg_temp.t_direct_scored('00000000-0000-4000-8000-000000000714', (select auth.uid()), now());
    raise exception 'T15/A01: no live permit — a direct scored INSERT is refused';
  exception when insufficient_privilege then null;
  end;
  select * into rec from public.access_state();
  if rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'T15/A01: access_state reads 1 scored + 1 hold (got %)', rec;
  end if;
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T15/A01: conservation violated';
  end if;
end $$;

-- A01 (member): premium bypasses the allowance, never the vouch. A direct
-- scored row from a member still needs a live permit, still may not name a
-- ticket, and never settles one.
reset role;
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000072', true, null);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000072';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007201"}';
do $$
declare p record;
begin
  select * into p from public.reserve_analysis_permit('vito-online-1');
  if p.result <> 'accepted' then
    raise exception 'T15: a member reserves (got %)', p.result;
  end if;
  perform pg_temp.t_direct_scored('00000000-0000-4000-8000-000000000721', (select auth.uid()), now());
  perform pg_temp.t_direct_scored('00000000-0000-4000-8000-000000000722', (select auth.uid()), now());
  if (select count(*) from public.shots where user_id = (select auth.uid()) and result_kind = 'scored'
      and analysis_permit_id is null and offline_ticket_id is null) <> 2 then
    raise exception 'T15: a member''s direct rows carry neither settlement link';
  end if;
end $$;

-- A02 + denied client write: the direct row an online permit admitted can
-- never settle a ticket — the settlement path writes its own row, and the
-- shots gate refuses any client row that names a ticket.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000071';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007101"}';
do $$
declare v text; g record; p record; t1 uuid := (select id from t_state where key = 'vera-t1');
begin
  -- the online-paid rating (711, the direct row P1 admitted) is not this
  -- ticket's — whatever its client-written created_at says
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000711', null, 'scored'));
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'T15/A02: a rating an online permit paid for never settles a ticket (got %)', v;
  end if;
  -- a client row naming the ticket is refused outright
  begin
    insert into public.shots (
      id, user_id, offline_ticket_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-000000000716', (select auth.uid()), t1, 'drive', now(), 0, 1000, 7, 1, 'scored',
      'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1'
    );
    raise exception 'T15: a client INSERT naming offline_ticket_id must be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.shots (
      id, user_id, offline_ticket_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-000000000717', (select auth.uid()), t1, 'drive', now(), 0, 1000, null, 0.2, 'low_confidence',
      'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1'
    );
    raise exception 'T15: an abstention naming offline_ticket_id must be refused too';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from public.shots where id in ('00000000-0000-4000-8000-000000000716', '00000000-0000-4000-8000-000000000717')) then
    raise exception 'T15: refused rows must not persist';
  end if;
  if public.offline_hold_count() <> 1 or pg_temp.t_events((select auth.uid())) <> 'allocated:1' then
    raise exception 'T15/A02: the ticket stays outstanding (hold %, events %)', public.offline_hold_count(), pg_temp.t_events((select auth.uid()));
  end if;
  -- a refresh re-issues T1, never a second ticket; the online slot is spent
  select * into g from public.issue_offline_grant('vera-key-1', 1);
  if g.result <> 'accepted' or g.ticket_ids <> array[t1] then
    raise exception 'T15/A02: the refresh re-issues the held ticket only (got %, %)', g.result, g.ticket_ids;
  end if;
  -- the rendered offline rating settles T1 through the settlement path
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000715', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T15/A02: the rating rendered under the ticket settles it (got %)', v;
  end if;
  if public.lifetime_scored_count() <> 2 or public.offline_hold_count() <> 0 then
    raise exception 'T15/A02: 2 scored + 0 held after settlement (got %, %)', public.lifetime_scored_count(), public.offline_hold_count();
  end if;
  select * into g from public.issue_offline_grant('vera-key-1', 1);
  select * into p from public.reserve_analysis_permit('vera-online-3');
  if g.result <> 'access.paywall_required' or p.result <> 'access.paywall_required' then
    raise exception 'T15/A02: two ratings spent leave nothing to allocate or reserve (got %, %)', g.result, p.result;
  end if;
  if (select count(*) from public.offline_allocation_ledger where user_id = (select auth.uid()) and event = 'allocated') <> 1
     or not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T15/A02: one ticket ever allocated; conservation holds';
  end if;
end $$;

-- A03 / c2-A01 on Wanda: the stale (25 h, still 'reserved') permit is a
-- reservation to NO decision point — access_state() never counted it (N0),
-- and the allocator reads the same online_reservation_count() the online
-- path does, so the two agree at every step (competing lane A01: the
-- allocator counting it while reserve_analysis_permit() did not was the
-- break). Its late sync then answers to the backstop beside the tickets.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000073';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007301"}';
do $$
declare p record; g record; g2 record; v text; t1 uuid; t2 uuid; rec record;
begin
  select * into rec from public.access_state();
  if rec.scored_count <> 0 or rec.reserved_count <> 0 or public.online_reservation_count() <> 0 then
    raise exception 'T15/c2-A01: a stale reserved permit is a reservation to no decision point (got %, online %)',
      rec, public.online_reservation_count();
  end if;
  select * into g from public.register_offline_device('wanda-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T15/c2-A01: registration (got %)', g.result;
  end if;
  -- the allocator agrees with the online path: both ratings are allocatable
  select * into g from public.issue_offline_grant('wanda-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'T15/c2-A01: the allocator counts the same reservations reserve_analysis_permit() counts — 2 tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1];
  t2 := g.ticket_ids[2];
  if not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T15/c2-A01: conservation violated by the allocation';
  end if;
  -- the attack: an online reservation AFTER the offline allocation
  select * into p from public.reserve_analysis_permit('wanda-online-2');
  if p.result <> 'access.paywall_required' then
    raise exception 'T15/c2-A01: an online reservation beside two outstanding tickets is refused (got %)', p.result;
  end if;
  -- the stale permit's late sync meets the backstop: the tickets hold both
  -- ratings, so it is refused and released — never a third rating
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000731', '00000000-0000-4000-8000-0000000007e1', 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'T15/c2-A01: the stale permit''s late sync is refused beside two tickets (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000007e1';
  if p.status <> 'released' or p.outcome <> 'free_limit_exceeded'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000731') then
    raise exception 'T15/c2-A01: the refused late permit is released/free_limit_exceeded and wrote nothing (got %/%)', p.status, p.outcome;
  end if;
  if public.lifetime_scored_count() <> 0 or public.offline_hold_count() <> 2 or public.online_reservation_count() <> 0 then
    raise exception 'T15/c2-A01: 0 scored + 2 held + 0 reserved (got %, %, %)',
      public.lifetime_scored_count(), public.offline_hold_count(), public.online_reservation_count();
  end if;
  -- the rendered offline ratings settle the tickets: exactly 2 ratings, and
  -- the online path stays closed throughout
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000732', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T15/c2-A01: the first ticket settles (got %)', v;
  end if;
  select * into p from public.reserve_analysis_permit('wanda-online-3');
  if p.result <> 'access.paywall_required' then
    raise exception 'T15/c2-A01: 1 scored + 1 outstanding ticket leave nothing to reserve (got %)', p.result;
  end if;
  v := public.consume_offline_ticket(t2, pg_temp.n_shot('00000000-0000-4000-8000-000000000733', null, 'scored'));
  if v <> 'accepted' then
    raise exception 'T15/c2-A01: the second ticket settles (got %)', v;
  end if;
  if public.lifetime_scored_count() <> 2 or public.offline_hold_count() <> 0
     or pg_temp.t_events((select auth.uid())) <> 'allocated:2,consumed:2'
     or not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T15/c2-A01: conservation violated (scored %, held %, events %)',
      public.lifetime_scored_count(), public.offline_hold_count(), pg_temp.t_events((select auth.uid()));
  end if;
  select * into g2 from public.issue_offline_grant('wanda-key-1', 2);
  if g2.result <> 'access.paywall_required' or coalesce(array_length(g2.ticket_ids, 1), 0) <> 0 then
    raise exception 'T15/c2-A01: nothing is left to allocate after both settlements (got %, %)', g2.result, g2.ticket_ids;
  end if;
end $$;

-- c2/A09 + A03 on Wes: the permit the production sweep flipped to
-- released/expired is a reservation to no decision point either; and a
-- rating counted BEFORE the ticket existed — written directly under a live
-- permit with created_at forged a year into the future — never settles the
-- later ticket (T13 covers the owner-written shape; this is the client shape
-- end to end).
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000074';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007401"}';
do $$
declare p record; g record; v text; t1 uuid; rec record; live uuid;
begin
  select * into rec from public.access_state();
  if rec.scored_count <> 0 or rec.reserved_count <> 0 or public.online_reservation_count() <> 0 then
    raise exception 'T15/c2-A09: a swept permit is a reservation to no decision point (got %, online %)',
      rec, public.online_reservation_count();
  end if;
  select * into g from public.register_offline_device('wes-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T15/c2-A09: registration (got %)', g.result;
  end if;
  -- a swept permit is not a live permit for a direct INSERT (N8), whatever
  -- created_at the client writes
  begin
    perform pg_temp.t_direct_scored('00000000-0000-4000-8000-000000000741', (select auth.uid()), now() + interval '1 year');
    raise exception 'T15/A03: a swept permit is not a live permit for a direct INSERT';
  exception when insufficient_privilege then null;
  end;
  -- A03: a live permit admits a direct row whose created_at lies a year in
  -- the future; the row counts (lifetime 1) the moment it lands
  select * into p from public.reserve_analysis_permit('wes-online-1');
  if p.result <> 'accepted' then
    raise exception 'T15/A03 precondition: a live permit (got %)', p.result;
  end if;
  live := p.permit_id;
  perform pg_temp.t_direct_scored('00000000-0000-4000-8000-000000000741', (select auth.uid()), now() + interval '1 year');
  if public.lifetime_scored_count() <> 1 then
    raise exception 'T15/A03 precondition: the forged-future row is counted (got %)', public.lifetime_scored_count();
  end if;
  -- the client cancels the permit it never synced (its allowed UPDATE)
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = live;
  -- the ticket is allocated AFTER the row exists: 1 scored + 0 live → 1 ticket
  select * into g from public.issue_offline_grant('wes-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'T15/c2-A09: 1 scored beside a swept permit leaves exactly 1 ticket (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1];
  insert into t_state values ('wes-t1', t1);
  select * into p from public.reserve_analysis_permit('wes-online-2');
  if p.result <> 'access.paywall_required' then
    raise exception 'T15/c2-A09: an online reservation beside 1 scored + 1 outstanding ticket is refused (got %)', p.result;
  end if;
  -- the swept permit's late sync meets the backstop beside the ticket
  v := public.apply_synced_shot(pg_temp.n_shot('00000000-0000-4000-8000-000000000742', '00000000-0000-4000-8000-0000000007e2', 'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'T15/c2-A09: the swept permit''s late sync is refused beside 1 scored + 1 ticket (got %)', v;
  end if;
  select * into p from public.analysis_permits where id = '00000000-0000-4000-8000-0000000007e2';
  if p.status <> 'released' or p.outcome <> 'free_limit_exceeded'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000742') then
    raise exception 'T15/c2-A09: the refused late permit is released/free_limit_exceeded and wrote nothing (got %/%)', p.status, p.outcome;
  end if;
  -- A03: the pre-counted row, whatever created_at the client wrote for it,
  -- is not the ticket's rating
  v := public.consume_offline_ticket(t1, pg_temp.n_shot('00000000-0000-4000-8000-000000000741', null, 'scored'));
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'T15/A03: a rating counted before the ticket existed never settles the ticket (got %)', v;
  end if;
  if public.offline_hold_count() <> 1 or pg_temp.t_events((select auth.uid())) <> 'allocated:1' then
    raise exception 'T15/A03: the refused settlement leaves the hold in place';
  end if;
  select * into g from public.issue_offline_grant('wes-key-1', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[t1] then
    raise exception 'T15/A03: the refresh re-issues the held ticket, never a new one (got %, %)', g.result, g.ticket_ids;
  end if;
  if public.lifetime_scored_count() <> 1 or not pg_temp.t_conserved((select auth.uid())) then
    raise exception 'T15/c2-A09: conservation violated (scored %)', public.lifetime_scored_count();
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
-- the table layer refuses the same settlements from any writer: a consumed
-- event needs a shot row that names the ticket; a shot row never names both
-- a permit and a ticket; one ticket settles at most one row.
do $$
declare t1 uuid := (select id from t_state where key = 'wes-t1'); a record;
begin
  select * into a from public.offline_allocation_ledger where ticket_id = t1 and event = 'allocated';
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes)
    values (a.user_id, a.device_id, a.grant_id, a.generation, t1, 'consumed', '00000000-0000-4000-8000-000000000741', a.identity_hashes);
    raise exception 'T15: the table never records a consumption for a rating that does not name the ticket';
  exception when check_violation then null;
  end;
  begin
    insert into public.shots (
      id, user_id, analysis_permit_id, offline_ticket_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-000000000743', a.user_id, gen_random_uuid(), t1, 'drive', now(), 0, 1000, 7, 1, 'scored',
      'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1'
    );
    raise exception 'T15: a shot row never names both a permit and a ticket';
  exception when check_violation then null;
  end;
  if exists (select 1 from public.offline_allocation_ledger where ticket_id = t1 and event <> 'allocated')
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000000743') then
    raise exception 'T15: refused table writes persisted';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'shots' and indexname = 'shots_offline_ticket_unique'
      and indexdef ilike '%unique%' and indexdef ilike '%offline_ticket_id is not null%'
  ) then
    raise exception 'T15: shots.offline_ticket_id must be unique when set';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shots_one_settlement' and conrelid = 'public.shots'::regclass) then
    raise exception 'T15: shots_one_settlement must exist';
  end if;
end $$;

-- T16: one terminal event per ticket at the table, and per-ticket
-- serialization of the terminal RPCs (adversary round 6: ATK-01/05/06).
do $$
declare idx text; f record;
begin
  select indexdef into idx from pg_indexes
  where schemaname = 'public' and tablename = 'offline_allocation_ledger'
    and indexname = 'offline_allocation_ledger_one_terminal_idx';
  if idx is null or idx not ilike 'create unique index%' or idx not ilike '%(ticket_id)%'
     or idx not ilike '%where%' or idx not ilike '%''consumed''%' or idx not ilike '%''released''%' then
    raise exception 'T16: the ledger must hold at most one terminal event per ticket (unique partial index over consumed | released; got %)', idx;
  end if;
  select p.oid, p.provolatile, p.prosecdef into f
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_private' and p.proname = 'offline_ticket_lock_key'
    and pg_get_function_identity_arguments(p.oid) = 'p_ticket_id uuid';
  if f.oid is null or f.provolatile <> 'i' then
    raise exception 'T16: api_private.offline_ticket_lock_key(uuid) must exist and be immutable';
  end if;
  if has_function_privilege('anon', f.oid, 'EXECUTE')
     or has_function_privilege('authenticated', f.oid, 'EXECUTE')
     or has_function_privilege('service_role', f.oid, 'EXECUTE') then
    raise exception 'T16: no client or service role may execute api_private.offline_ticket_lock_key';
  end if;
  if api_private.offline_ticket_lock_key('00000000-0000-4000-8000-000000000555')
     = public.access_lock_key('00000000-0000-4000-8000-000000000555') then
    raise exception 'T16: the ticket lock key must not collide with the caller lock key for the same uuid';
  end if;
end $$;
-- The index holds with the row guard out of the way: a released row beside
-- Tara's consumed ticket t1 is refused by the index itself (23505), so the
-- guard's read-committed check is the first line and the table the last.
do $$
declare tara_t1 uuid := (select id from t_state where key = 'tara-t1'); a record; n integer;
begin
  select * into a from public.offline_allocation_ledger where ticket_id = tara_t1 and event = 'allocated';
  if not exists (select 1 from public.offline_allocation_ledger where ticket_id = tara_t1 and event = 'consumed') then
    raise exception 'T16 precondition: Tara''s first ticket is consumed';
  end if;
  select count(*) into n from public.offline_allocation_ledger;
  begin
    alter table public.offline_allocation_ledger disable trigger offline_allocation_ledger_guard_event;
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id)
    values (a.user_id, a.device_id, a.grant_id, a.generation, tara_t1, 'released', 'support_review', a.identity_hashes, a.installation_key_id);
    raise exception 'T16: a second terminal word for one ticket must be refused by the table even without the row guard';
  exception when unique_violation then null;
  end;
  if (select tgenabled from pg_trigger where tgrelid = 'public.offline_allocation_ledger'::regclass and tgname = 'offline_allocation_ledger_guard_event') <> 'O' then
    raise exception 'T16: the row guard must be enabled again (the ALTER rolled back with the refused write)';
  end if;
  if (select count(*) from public.offline_allocation_ledger) <> n then
    raise exception 'T16: the refused write must not persist';
  end if;
end $$;
-- The terminal RPCs hold the per-ticket lock (after the caller lock) for the
-- rest of the transaction; register_offline_device() holds the caller lock
-- across its check-then-insert. A fresh user (Tobi) so neither key is held
-- yet by anything this transaction did before.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-000000000078', 'tobi@example.com', '{"full_name":"Tobi"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-tobi', '00000000-0000-4000-8000-000000000078', '{"sub":"google-sub-tobi","email":"tobi@example.com"}');
insert into auth.sessions (id, user_id) values ('00000000-0000-4000-8000-000000007801', '00000000-0000-4000-8000-000000000078');
create function pg_temp.t_holds_advisory(p_key bigint) returns boolean
language sql stable as $$
  select exists (
    select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted
      and l.objsubid = 1
      and l.classid = ((p_key >> 32) & 4294967295)::oid
      and l.objid = (p_key & 4294967295)::oid
  );
$$;
do $$
declare uid uuid := '00000000-0000-4000-8000-000000000078';
        probe uuid := '00000000-0000-4000-8000-000000007816';
begin
  if pg_temp.t_holds_advisory(public.access_lock_key(uid)) or pg_temp.t_holds_advisory(api_private.offline_ticket_lock_key(probe)) then
    raise exception 'T16 precondition: neither lock is held before the RPCs run';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000078';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007801"}';
do $$
declare g record; v text; probe uuid := '00000000-0000-4000-8000-000000007816';
begin
  select * into g from public.register_offline_device('tobi-key-1', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'T16: registration (got %)', g.result;
  end if;
  insert into t_state values ('tobi-probe', probe);
  v := public.release_offline_ticket(probe, 'unused_ticket_returned');
  if v <> 'offline.ticket_not_found' then
    raise exception 'T16: a ticket nobody allocated is not found (got %)', v;
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
do $$
declare uid uuid := '00000000-0000-4000-8000-000000000078';
        probe uuid := (select id from t_state where key = 'tobi-probe');
begin
  if not pg_temp.t_holds_advisory(public.access_lock_key(uid)) then
    raise exception 'T16: register_offline_device()/release_offline_ticket() must hold access_lock_key(uid) for the transaction';
  end if;
  if not pg_temp.t_holds_advisory(api_private.offline_ticket_lock_key(probe)) then
    raise exception 'T16: release_offline_ticket() must hold offline_ticket_lock_key(ticket) for the transaction, before it reads the ticket';
  end if;
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
    ('player_technique_rating', true, false, false, array[]::text[]),
    ('settlement_receipts', true, false, false, array[]::text[]),
    ('offline_devices', true, false, false, array[]::text[]),
    ('offline_grants', true, false, false, array[]::text[]),
    ('offline_allocation_ledger', true, false, false, array[]::text[]),
    ('offline_receipt_settlements', false, false, false, array[]::text[])
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
    'consume_offline_ticket','identity_scored_count','is_api_session_active',
    'issue_offline_grant','lifetime_scored_count','offline_hold_count',
    'online_reservation_count','permit_backs_sync','permit_tombstoned','register_offline_device',
    'release_offline_ticket','reserve_analysis_permit','settle_offline_receipt'
  ] then
    raise exception 'K27: authenticated RPC allowlist drifted (got %)', functions;
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'access_lock_key','access_state','apply_synced_shot','complete_onboarding',
      'is_api_session_active','lifetime_scored_count','online_reservation_count',
      'reserve_analysis_permit'
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
  -- W08-06: the completion receipt is certified by the sweeping worker, never
  -- forged. While the identity is still present certification is refused, the
  -- durable row is untouched, and no role may reach the row or the lock
  -- helper directly.
  if public.certify_account_deletion_completion(u, operation_id, lease_token)->>'outcome' <> 'stale_lease'
    or public.certify_account_deletion_completion(u, operation_id, gen_random_uuid())->>'outcome' <> 'stale_lease' then
    raise exception 'M2: certification must be refused while the Auth identity is present';
  end if;
  if public.read_account_deletion_receipt(u, operation_id)->'completionReceipt' <> 'null'::jsonb
    or public.read_account_deletion_receipt(u, operation_id)->>'state' <> 'in_progress' then
    raise exception 'M2: a refused certification must not leave a receipt behind';
  end if;
  begin
    perform api_private.lock_account_deletion_certification(u, operation_id, lease_token);
    raise exception 'M2: the service role must not reach the private certification lock helper';
  exception when insufficient_privilege then null;
  end;
  begin
    update api_private.account_deletion_operations set completed_at = clock_timestamp(), phase = 'completed'
      where id = operation_id;
    raise exception 'M2: the service role must not forge a receipt with direct DML';
  exception when insufficient_privilege then null;
  end;
  -- W08-06 round 6: the status capability the app keeps after its session is
  -- gone can only move a post-Auth phase, and the owner residue count is
  -- fenced exactly like certification — never while the identity is present.
  if public.claim_account_deletion_status_work(operation_id, sha256(convert_to('M2 synthetic status capability', 'UTF8')))->>'outcome' <> 'blocked'
    or public.claim_account_deletion_status_work(operation_id, sha256(convert_to('M2 forged status capability', 'UTF8')))->>'outcome' <> 'invalid'
    or public.claim_account_deletion_status_work(gen_random_uuid(), sha256(convert_to('M2 synthetic status capability', 'UTF8')))->>'outcome' <> 'invalid' then
    raise exception 'M2: the status capability must not claim work while the Auth identity is present';
  end if;
  if public.read_account_deletion_owner_residue(u, operation_id, lease_token)->>'outcome' <> 'stale_lease'
    or public.read_account_deletion_owner_residue(u, operation_id, gen_random_uuid())->>'outcome' <> 'stale_lease' then
    raise exception 'M2: the owner residue count must be refused while the Auth identity is present';
  end if;
  if public.read_account_deletion_receipt(u, operation_id)->'completionReceipt' <> 'null'::jsonb
    or public.read_account_deletion_receipt(u, operation_id)->>'state' <> 'in_progress'
    or public.read_account_deletion_status(operation_id, sha256(convert_to('M2 synthetic status capability', 'UTF8')))->>'state' <> 'in_progress' then
    raise exception 'M2: a refused status-capability claim must not move the durable row';
  end if;
  begin
    perform api_private.account_deletion_owner_namespaces();
    raise exception 'M2: the service role must not reach the private owner namespace catalog';
  exception when insufficient_privilege then null;
  end;
end $$;
do $$
declare f oid; r text;
begin
  foreach r in array array['claim_account_deletion_status_work|p_operation_id uuid, p_status_capability_hash bytea',
    'read_account_deletion_owner_residue|p_owner_id uuid, p_operation_id uuid, p_lease_token uuid'] loop
    select p.oid into f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = split_part(r, '|', 1)
        and pg_get_function_identity_arguments(p.oid) = split_part(r, '|', 2);
    if f is null then
      raise exception 'M2: % must exist with its full binding', split_part(r, '|', 1);
    end if;
    if not has_function_privilege('service_role', f, 'EXECUTE')
      or has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception 'M2: % must be executable by service_role only', split_part(r, '|', 1);
    end if;
    if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE')
      or not exists (select 1 from pg_proc p where p.oid = f and p.prosecdef and p.proconfig @> array['search_path=""']) then
      raise exception 'M2: % must be a definer with a fixed empty search_path and no PUBLIC execute', split_part(r, '|', 1);
    end if;
  end loop;
  select p.oid into f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_private' and p.proname = 'account_deletion_owner_namespaces'
      and pg_get_function_identity_arguments(p.oid) = '';
  if f is null then
    raise exception 'M2: the private owner namespace catalog must exist';
  end if;
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(r, f, 'EXECUTE') then
      raise exception 'M2: the private owner namespace catalog must not be executable by %', r;
    end if;
  end loop;
  if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE')
    or not exists (select 1 from pg_proc p where p.oid = f and not p.prosecdef and p.proconfig @> array['search_path=""']) then
    raise exception 'M2: the private owner namespace catalog must be an invoker with a fixed empty search_path and no PUBLIC execute';
  end if;
end $$;
do $$
declare f oid; r text;
begin
  select p.oid into f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'certify_account_deletion_completion'
      and pg_get_function_identity_arguments(p.oid) = 'p_owner_id uuid, p_operation_id uuid, p_lease_token uuid';
  if f is null then
    raise exception 'M2: certification RPC must exist with the owner, operation and lease binding';
  end if;
  if not has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception 'M2: certification requires an explicit service-role execution grant';
  end if;
  foreach r in array array['anon','authenticated'] loop
    if has_function_privilege(r, f, 'EXECUTE') then
      raise exception 'M2: clients cannot certify account deletion (%)', r;
    end if;
  end loop;
  if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'M2: PUBLIC must not certify account deletion';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = f and p.prosecdef and p.proconfig @> array['search_path=""']) then
    raise exception 'M2: certification must be a definer with a fixed empty search_path';
  end if;
  select p.oid into f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_private' and p.proname = 'lock_account_deletion_certification'
      and pg_get_function_identity_arguments(p.oid) = 'p_owner_id uuid, p_operation_id uuid, p_lease_token uuid';
  if f is null then
    raise exception 'M2: the private certification lock helper must exist with the owner, operation and lease binding';
  end if;
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_function_privilege(r, f, 'EXECUTE') then
      raise exception 'M2: the private certification lock helper must not be executable by %', r;
    end if;
  end loop;
  if exists (select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE')
    or not exists (select 1 from pg_proc p where p.oid = f and not p.prosecdef and p.proconfig @> array['search_path=""']) then
    raise exception 'M2: the private certification lock helper must be an invoker with a fixed empty search_path and no PUBLIC execute';
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

begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000092', 'lease-proof@example.test', '{"provider":"google"}');
set local role service_role;
do $$
declare
  u uuid := '00000000-0000-4000-8000-000000000092';
  payload jsonb := jsonb_build_object('event', jsonb_build_object('id', 'lease-fencing-proof', 'app_user_id', u));
  old_lease uuid;
  new_lease uuid;
  old_ticket uuid;
  new_ticket uuid;
  verdict jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
begin
  old_lease := (public.claim_billing_webhook_delivery('lease-fencing-proof', payload)->>'lease_token')::uuid;
  old_ticket := (public.begin_billing_verification(array[u], 'lease-fencing-proof', payload, old_lease)->0->>'ticket_id')::uuid;
  perform public.release_billing_webhook_delivery('lease-fencing-proof', payload, old_lease);
  new_lease := (public.claim_billing_webhook_delivery('lease-fencing-proof', payload)->>'lease_token')::uuid;
  if new_lease is null or new_lease = old_lease then
    raise exception 'M14: replacement delivery must receive a distinct lease';
  end if;
  begin
    perform public.begin_billing_verification(array[u], 'lease-fencing-proof', payload, old_lease);
    raise exception 'M15: replaced delivery must not issue verification tickets';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.persist_billing_verdict(u, old_ticket, verdict);
    raise exception 'M16: stale worker must not persist a verdict';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.complete_billing_webhook('lease-fencing-proof', payload, jsonb_build_object(u::text, old_ticket), old_lease);
    raise exception 'M17: stale worker must not complete the replacement delivery';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.complete_billing_webhook('lease-fencing-proof', payload, jsonb_build_object(u::text, old_ticket), new_lease);
    raise exception 'M18: a fresh lease must not reuse another lease''s ticket';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from public.webhook_events where id = 'lease-fencing-proof' and processed_at is not null) then
    raise exception 'M19: rejected stale work must not write a completion marker';
  end if;
  new_ticket := (public.begin_billing_verification(array[u], 'lease-fencing-proof', payload, new_lease)->0->>'ticket_id')::uuid;
  perform public.persist_billing_verdict(u, new_ticket, verdict);
  perform public.complete_billing_webhook('lease-fencing-proof', payload, jsonb_build_object(u::text, new_ticket), new_lease);
  if not exists (select 1 from public.webhook_events where id = 'lease-fencing-proof' and processed_at is not null) then
    raise exception 'M20: replacement worker must complete with its own verified ticket';
  end if;
end $$;
rollback;
-- ----------------------------------------------------------------------------
-- W07-T. Durable transfer queue + verification barrier
-- (20260908150000_billing_recovery_transfer.sql). A RevenueCat TRANSFER moves
-- purchases from a source account to a destination account. The destination
-- must NOT become premium on the strength of its own provider verdict until
-- every source is provider-confirmed (or authoritatively absent): a source
-- confirmed as no longer entitled releases the destination and the transfer
-- confirms; a source the provider still reports entitled parks the transfer as
-- held, and both accounts then mirror exactly what the provider confirmed for
-- each of them (the provider, never the event, decides who is premium). The
-- source loses as soon as its verdict lands; an applied destination side is
-- never barred again; every step is append-only audited; the queue is
-- reachable only through service-role RPCs.
-- ----------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000b1', 'transfer-src-1@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b2', 'transfer-dst-1@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b3', 'transfer-src-2@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b4', 'transfer-dst-2@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b5', 'transfer-src-3@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b6', 'transfer-dst-3@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b8', 'transfer-dst-4@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b9', 'transfer-src-8@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000ba', 'transfer-dst-8@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c01', 'transfer-src-r2-1@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c02', 'transfer-dst-r2-1@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c03', 'transfer-src-r2-2@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c04', 'transfer-dst-r2-2@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c05', 'transfer-src-r2-3a@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c06', 'transfer-src-r2-3b@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c07', 'transfer-dst-r2-3@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c08', 'transfer-src-r2-4@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c09', 'transfer-dst-r2-4@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c0a', 'transfer-src-r2-5@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000c0b', 'transfer-dst-r2-5@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000d01', 'transfer-src-r3-1@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000d02', 'transfer-dst-r3-1@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000d03', 'transfer-src-r3-2@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000d04', 'transfer-dst-r3-2a@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000d05', 'transfer-dst-r3-2b@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000d06', 'transfer-r3-3a@example.test', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000d07', 'transfer-r3-3b@example.test', '{"provider":"apple"}');
do $$
declare
  r text;
  t regclass;
  f regprocedure;
begin
  foreach t in array array[
    'api_private.billing_transfers'::regclass,
    'api_private.billing_transfer_sides'::regclass,
    'api_private.billing_transfer_audit'::regclass
  ] loop
    if not (select relrowsecurity from pg_class where oid = t) then
      raise exception 'W07-T1: transfer queue table % must enable RLS', t;
    end if;
    if exists (select 1 from pg_policy where polrelid = t) then
      raise exception 'W07-T2: transfer queue table % must have no client policies', t;
    end if;
    foreach r in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
        raise exception 'W07-T3: % must hold no direct privileges on %', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon','authenticated','service_role'] loop
    if has_sequence_privilege(r, 'api_private.billing_transfer_audit_id_seq', 'SELECT,UPDATE,USAGE') then
      raise exception 'W07-T4: % must hold no privileges on the transfer audit sequence', r;
    end if;
  end loop;
  foreach f in array array[
    'public.enqueue_billing_transfer(text,jsonb,uuid)'::regprocedure,
    'public.billing_transfer_recovery(uuid)'::regprocedure,
    'public.persist_billing_verdict(uuid,uuid,jsonb)'::regprocedure
  ] loop
    if not has_function_privilege('service_role', f, 'EXECUTE') then
      raise exception 'W07-T5: transfer helper % requires an explicit service-role execution grant', f;
    end if;
    foreach r in array array['anon','authenticated'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        raise exception 'W07-T6: clients cannot execute transfer helper %', f;
      end if;
    end loop;
    if not exists (select 1 from pg_proc where oid = f and prosecdef and proconfig @> array['search_path=""']) then
      raise exception 'W07-T7: transfer helper % must be a definer with an empty search_path', f;
    end if;
  end loop;
  foreach f in array array[
    'api_private.settle_billing_transfer(uuid)'::regprocedure,
    'api_private.apply_billing_transfer_side(api_private.billing_transfers,api_private.billing_transfer_sides)'::regprocedure,
    'api_private.note_billing_transfer(api_private.billing_transfers,uuid,text,jsonb)'::regprocedure,
    'api_private.billing_transfer_summary(api_private.billing_transfers)'::regprocedure,
    'api_private.billing_transfer_party_ids(jsonb,text)'::regprocedure,
    'api_private.billing_verdict_active(jsonb,timestamptz)'::regprocedure,
    'api_private.guard_billing_transfer_history()'::regprocedure,
    'api_private.lock_billing_transfers(uuid)'::regprocedure,
    'api_private.reconcile_billing_transfer_sources(uuid)'::regprocedure,
    'api_private.billing_destination_blocker(uuid)'::regprocedure,
    'api_private.reconcile_billing_destination(uuid)'::regprocedure
  ] loop
    foreach r in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(r, f, 'EXECUTE') then
        raise exception 'W07-T8: private transfer helper % must not be executable by %', f, r;
      end if;
    end loop;
  end loop;
end $$;

set local role authenticated;
do $$
begin
  begin
    perform public.enqueue_billing_transfer('w07-t-client', '{"event":{"type":"TRANSFER"}}'::jsonb, gen_random_uuid());
    raise exception 'W07-T9: an authenticated API caller must not queue billing transfers';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.billing_transfer_recovery('00000000-0000-4000-8000-0000000000b2');
    raise exception 'W07-T10: an authenticated API caller must not read the transfer recovery queue';
  exception when insufficient_privilege then null;
  end;
end $$;
set local role anon;
do $$
begin
  begin
    perform public.enqueue_billing_transfer('w07-t-client', '{"event":{"type":"TRANSFER"}}'::jsonb, gen_random_uuid());
    raise exception 'W07-T11: an anonymous caller must not queue billing transfers';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-0000000000b1';
  dst uuid := '00000000-0000-4000-8000-0000000000b2';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-transfer-1', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  queued jsonb;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  r jsonb;
  tid uuid;
begin
  lease := (public.claim_billing_webhook_delivery('w07-transfer-1', payload)->>'lease_token')::uuid;
  begin
    perform public.enqueue_billing_transfer('w07-transfer-1', payload, gen_random_uuid());
    raise exception 'W07-T12: a foreign lease must not queue a transfer';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.enqueue_billing_transfer('w07-transfer-1', payload, null);
    raise exception 'W07-T13: a transfer cannot be queued without the delivery lease';
  exception when object_not_in_prerequisite_state then null;
  end;
  queued := public.enqueue_billing_transfer('w07-transfer-1', payload, lease);
  if queued->>'outcome' <> 'queued' or queued->>'state' <> 'pending'
     or queued->'sources'->0->>'user_id' <> src::text or (queued->'sources'->0->>'verified')::boolean
     or queued->'destinations'->0->>'user_id' <> dst::text or (queued->'destinations'->0->>'applied')::boolean then
    raise exception 'W07-T14: queueing a transfer must record both sides as pending (got %)', queued;
  end if;
  tid := (queued->>'transfer_id')::uuid;
  r := public.enqueue_billing_transfer('w07-transfer-1', payload, lease);
  if (r->>'transfer_id')::uuid <> tid or r->>'state' <> 'pending' then
    raise exception 'W07-T15: re-queueing the same delivery must be idempotent (got %)', r;
  end if;
  begin
    perform public.enqueue_billing_transfer('w07-transfer-1', payload || '{"replayed":true}'::jsonb, lease);
    raise exception 'W07-T16: a different payload must not re-scope a queued transfer';
  exception when invalid_parameter_value then null;
  end;
  issued := public.begin_billing_verification(array[src, dst], 'w07-transfer-1', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  -- Destination verified first: the provider already reports it premium, but
  -- the source has not been confirmed yet.
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if r->>'outcome' <> 'persisted' or (r->>'applied')::boolean or not (r->>'withheld')::boolean
     or (r->'billing'->>'premium')::boolean or r->'billing'->>'verifiedAt' is null then
    raise exception 'W07-T17: a destination verdict must be withheld until the source is confirmed (got %)', r;
  end if;
  if exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-T18: the destination must not be premium before provider confirmation of the source';
  end if;
  begin
    perform public.persist_billing_verdict(dst, dst_ticket, inactive);
    raise exception 'W07-T19: a withheld destination verdict must still seal its ticket';
  exception when invalid_parameter_value then null;
  end;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean
     or exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-T20: replaying a withheld destination verdict must stay withheld';
  end if;
  begin
    perform public.complete_billing_webhook('w07-transfer-1', payload,
      jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
    raise exception 'W07-T21: a transfer with an unconfirmed source must not complete its webhook audit';
  exception when object_not_in_prerequisite_state then null;
  end;
  if exists (select 1 from public.webhook_events where id = 'w07-transfer-1' and processed_at is not null) then
    raise exception 'W07-T22: an unconfirmed transfer must not write a completion marker';
  end if;
  r := public.billing_transfer_recovery(dst);
  if jsonb_array_length(r) <> 1 or r->0->>'state' <> 'pending'
     or not (r->0->'destinations'->0->>'verified')::boolean or (r->0->'destinations'->0->>'applied')::boolean then
    raise exception 'W07-T23: the recovery queue must expose the unsettled transfer (got %)', r;
  end if;
  -- Provider confirms the source lost its entitlement: the source loses and
  -- the withheld destination is released in the same step.
  r := public.persist_billing_verdict(src, src_ticket, inactive);
  if r->>'outcome' <> 'persisted' or not (r->>'applied')::boolean or (r->>'withheld')::boolean
     or (r->'billing'->>'premium')::boolean then
    raise exception 'W07-T24: the source verdict must apply immediately (got %)', r;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-T25: the destination must gain premium once the provider confirms the source lost it';
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0
     or jsonb_array_length(public.billing_transfer_recovery(src)) <> 0 then
    raise exception 'W07-T27: a confirmed transfer must leave the recovery queue';
  end if;
  r := public.complete_billing_webhook('w07-transfer-1', payload,
    jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
  if not (r->>'verified')::boolean
     or not exists (select 1 from public.webhook_events where id = 'w07-transfer-1' and processed_at is not null) then
    raise exception 'W07-T28: a confirmed transfer must complete its webhook audit (got %)', r;
  end if;
end $$;
reset role;
do $$
declare
  dst uuid := '00000000-0000-4000-8000-0000000000b2';
  t api_private.billing_transfers%rowtype;
begin
  select * into strict t from api_private.billing_transfers where event_id = 'w07-transfer-1';
  if t.state <> 'confirmed' or t.settled_at is null then
    raise exception 'W07-T26: a fully reconciled transfer must be confirmed';
  end if;
  if not exists (select 1 from public.billing_entitlements e
      join api_private.billing_transfer_sides s on s.user_id = e.user_id and s.transfer_id = t.id
      join api_private.billing_verification_tickets k on k.id = s.ticket_id
      where e.user_id = dst and e.premium and e.verification_order = k.verification_order
        and k.event_id = 'w07-transfer-1' and s.applied_at is not null) then
    raise exception 'W07-T25b: the destination must be applied at its own transfer ticket order';
  end if;
  if (select array_agg(action order by id) from api_private.billing_transfer_audit where transfer_id = t.id)
     <> array['enqueued','destination_verified','destination_withheld','source_verified','destination_applied','confirmed'] then
    raise exception 'W07-T29: the transfer audit must record every reconciliation step (got %)',
      (select array_agg(action order by id) from api_private.billing_transfer_audit where transfer_id = t.id);
  end if;
end $$;
set local role service_role;

-- Source verified first: the destination applies as soon as its own verdict
-- lands because the barrier is already satisfied.
do $$
declare
  src uuid := '00000000-0000-4000-8000-0000000000b3';
  dst uuid := '00000000-0000-4000-8000-0000000000b4';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-transfer-2', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_annual', 'expiresAt', null,
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  issued jsonb;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-transfer-2', payload)->>'lease_token')::uuid;
  perform public.enqueue_billing_transfer('w07-transfer-2', payload, lease);
  issued := public.begin_billing_verification(array[src, dst], 'w07-transfer-2', payload, lease);
  perform public.persist_billing_verdict(src,
    (select (item->>'ticket_id')::uuid from jsonb_array_elements(issued) item where item->>'user_id' = src::text), inactive);
  r := public.persist_billing_verdict(dst,
    (select (item->>'ticket_id')::uuid from jsonb_array_elements(issued) item where item->>'user_id' = dst::text), active);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean
     or not exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-T30: a destination verified after the source is confirmed must gain immediately (got %)', r;
  end if;
  if jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-T31: a source-first transfer must confirm once the destination is applied';
  end if;
end $$;

-- Source still entitled per the provider: the transfer parks as held. Both
-- sides are now provider-confirmed, so the destination's own confirmed verdict
-- applies (the provider says both accounts are entitled; the event does not
-- override it), the delivery completes, and the transfer confirms only once a
-- later provider verdict says the source lost the entitlement.
do $$
declare
  src uuid := '00000000-0000-4000-8000-0000000000b5';
  dst uuid := '00000000-0000-4000-8000-0000000000b6';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-transfer-3', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  sync_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-transfer-3', payload)->>'lease_token')::uuid;
  perform public.enqueue_billing_transfer('w07-transfer-3', payload, lease);
  issued := public.begin_billing_verification(array[src, dst], 'w07-transfer-3', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  perform public.persist_billing_verdict(src, src_ticket, active);
  if public.billing_transfer_recovery(dst)->0->>'state' <> 'held'
     or exists (select 1 from public.billing_entitlements where user_id = dst) then
    raise exception 'W07-T32: a source that still holds the entitlement must park the transfer as held (got %)',
      public.billing_transfer_recovery(dst);
  end if;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean
     or not exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-T33: a destination whose source is provider-confirmed must apply its own confirmed verdict (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-transfer-3', payload,
    jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
  if not (r->>'verified')::boolean
     or not exists (select 1 from public.webhook_events where id = 'w07-transfer-3' and processed_at is not null) then
    raise exception 'W07-T34: a held transfer with both sides provider-confirmed must complete its delivery (got %)', r;
  end if;
  r := public.billing_transfer_recovery(src);
  if jsonb_array_length(r) <> 1 or r->0->>'state' <> 'held' or not (r->0->'sources'->0->>'active')::boolean
     or not (r->0->'destinations'->0->>'applied')::boolean then
    raise exception 'W07-T35: the recovery queue must expose the held transfer with its applied destination (got %)', r;
  end if;
  sync_ticket := (public.begin_billing_verification(array[src])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(src, sync_ticket, inactive);
  if not (r->>'applied')::boolean or (r->'billing'->>'premium')::boolean then
    raise exception 'W07-T36: a later provider verdict for the source must apply (got %)', r;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-T37: a later provider verdict that the source lost entitlement must confirm the held transfer';
  end if;
end $$;
reset role;
do $$
begin
  if (select array_agg(t.state) from api_private.billing_transfers t where t.event_id in ('w07-transfer-2', 'w07-transfer-3'))
     <> array['confirmed', 'confirmed'] then
    raise exception 'W07-T37b: settled transfers must be confirmed in the durable queue';
  end if;
  if (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
      join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-transfer-3')
     <> array['enqueued','source_verified','held','destination_verified','destination_applied','source_verified','confirmed'] then
    raise exception 'W07-T38: the held transfer audit must record the hold and its release (got %)',
      (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
        join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-transfer-3');
  end if;
end $$;
set local role service_role;

-- A source that is authoritatively absent from Auth is terminal (mirrors
-- W07-23): the destination applies on its own verdict.
do $$
declare
  missing uuid := '00000000-0000-4000-8000-0000000000b7';
  dst uuid := '00000000-0000-4000-8000-0000000000b8';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-transfer-4', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(missing::text, '$RCAnonymousID:ab12'),
    'transferred_to', jsonb_build_array(upper(dst::text))));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_lifetime', 'expiresAt', null,
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid;
  queued jsonb;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-transfer-4', payload)->>'lease_token')::uuid;
  queued := public.enqueue_billing_transfer('w07-transfer-4', payload, lease);
  if queued->>'state' <> 'pending' or not (queued->'sources'->0->>'missing')::boolean
     or jsonb_array_length(queued->'sources') <> 1 or queued->'destinations'->0->>'user_id' <> dst::text then
    raise exception 'W07-T39: queueing must normalise subjects and mark an absent source (got %)', queued;
  end if;
  r := public.begin_billing_verification(array[missing, dst], 'w07-transfer-4', payload, lease);
  r := public.persist_billing_verdict(dst,
    (select (item->>'ticket_id')::uuid from jsonb_array_elements(r) item where item->>'user_id' = dst::text), active);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean
     or not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-T40: an absent source must not hold the destination (got %)', r;
  end if;
end $$;

-- Malformed transfer events are rejected before anything is queued.
do $$
declare
  payload jsonb;
  lease uuid;
  r jsonb;
begin
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-transfer-5', 'type', 'RENEWAL',
    'app_user_id', '00000000-0000-4000-8000-0000000000b1'));
  lease := (public.claim_billing_webhook_delivery('w07-transfer-5', payload)->>'lease_token')::uuid;
  begin
    perform public.enqueue_billing_transfer('w07-transfer-5', payload, lease);
    raise exception 'W07-T41: a non-transfer event must not be queued as a transfer';
  exception when invalid_parameter_value then null;
  end;
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-transfer-6', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array('00000000-0000-4000-8000-0000000000b1'),
    'transferred_to', jsonb_build_array('00000000-0000-4000-8000-0000000000B1')));
  lease := (public.claim_billing_webhook_delivery('w07-transfer-6', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-transfer-6', payload, lease);
  if r->>'outcome' <> 'no_subjects' then
    raise exception 'W07-T42: a subject on both sides has nothing to move and must not poison the delivery (got %)', r;
  end if;
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-transfer-6b', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array('00000000-0000-4000-8000-0000000000b1'),
    'transferred_to', jsonb_build_array('00000000-0000-4000-8000-0000000000B1', '00000000-0000-4000-8000-0000000000b8')));
  lease := (public.claim_billing_webhook_delivery('w07-transfer-6b', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-transfer-6b', payload, lease);
  if r->>'outcome' <> 'queued' or jsonb_array_length(r->'sources') <> 0
     or jsonb_array_length(r->'destinations') <> 1
     or r->'destinations'->0->>'user_id' <> '00000000-0000-4000-8000-0000000000b8' then
    raise exception 'W07-T42b: a subject on both sides is dropped from both; the other destination still queues (got %)', r;
  end if;
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-transfer-6c', 'type', 'TRANSFER',
    'app_user_id', '00000000-0000-4000-8000-0000000000b8',
    'transferred_from', '00000000-0000-4000-8000-0000000000b1'));
  lease := (public.claim_billing_webhook_delivery('w07-transfer-6c', payload)->>'lease_token')::uuid;
  r := public.begin_billing_verification(array['00000000-0000-4000-8000-0000000000b8'::uuid], 'w07-transfer-6c', payload, lease);
  if jsonb_array_length(r) <> 1 or r->0->>'outcome' <> 'issued' then
    raise exception 'W07-T42c: a transfer whose parties are not arrays still verifies its subject directly (got %)', r;
  end if;
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-transfer-7', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array('$RCAnonymousID:one'), 'transferred_to', jsonb_build_array('$RCAnonymousID:two')));
  lease := (public.claim_billing_webhook_delivery('w07-transfer-7', payload)->>'lease_token')::uuid;
  r := public.enqueue_billing_transfer('w07-transfer-7', payload, lease);
  if r->>'outcome' <> 'no_subjects' then
    raise exception 'W07-T43: an anonymous-only transfer has nothing to reconcile (got %)', r;
  end if;
end $$;

-- Shipping webhook path: the edge function only calls
-- begin_billing_verification / persist_billing_verdict / complete_billing_webhook,
-- so issuing verification for a TRANSFER event must queue the transfer and
-- the barrier must hold without any explicit enqueue call.
do $$
declare
  src uuid := '00000000-0000-4000-8000-0000000000b9';
  dst uuid := '00000000-0000-4000-8000-0000000000ba';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-transfer-8', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-transfer-8', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-transfer-8', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  r := public.billing_transfer_recovery(dst);
  if jsonb_array_length(r) <> 1 or r->0->>'event_id' <> 'w07-transfer-8' or r->0->>'state' <> 'pending' then
    raise exception 'W07-T52: issuing webhook verification for a transfer must queue it (got %)', r;
  end if;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean or (r->'billing'->>'premium')::boolean
     or exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-T53: the shipping path must withhold the destination until the source is confirmed (got %)', r;
  end if;
  begin
    perform public.complete_billing_webhook('w07-transfer-8', payload,
      jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
    raise exception 'W07-T54: the shipping path must not complete a transfer whose source is unconfirmed';
  exception when object_not_in_prerequisite_state then null;
  end;
  r := public.persist_billing_verdict(src, src_ticket, inactive);
  if not (r->>'applied')::boolean
     or not exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-T55: the shipping path must release the destination once the source is confirmed lost (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-transfer-8', payload,
    jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
  if not (r->>'verified')::boolean then
    raise exception 'W07-T56: the shipping path must complete once the transfer is confirmed (got %)', r;
  end if;
  -- A non-transfer event on the same path queues nothing.
  payload := jsonb_build_object('event', jsonb_build_object('id', 'w07-renewal-8', 'type', 'RENEWAL',
    'app_user_id', dst::text));
  lease := (public.claim_billing_webhook_delivery('w07-renewal-8', payload)->>'lease_token')::uuid;
  perform public.begin_billing_verification(array[dst], 'w07-renewal-8', payload, lease);
  if jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-T57: a non-transfer event must not enter the transfer queue';
  end if;
end $$;
reset role;
do $$
begin
  if (select state from api_private.billing_transfers where event_id = 'w07-transfer-8') <> 'confirmed'
     or exists (select 1 from api_private.billing_transfers where event_id = 'w07-renewal-8') then
    raise exception 'W07-T58: the shipping path must leave exactly the transfer confirmed in the durable queue';
  end if;
  if exists (select 1 from api_private.billing_transfers where event_id in ('w07-transfer-5', 'w07-transfer-6', 'w07-transfer-6c', 'w07-transfer-7')) then
    raise exception 'W07-T44: rejected or subject-less transfer events must not leave queue rows';
  end if;
  if (select source_user_ids || destination_user_ids from api_private.billing_transfers where event_id = 'w07-transfer-6b')
     <> array['00000000-0000-4000-8000-0000000000b8'::uuid] then
    raise exception 'W07-T44c: a subject listed on both sides must not be queued on either';
  end if;
  if (select state from api_private.billing_transfers where event_id = 'w07-transfer-4') <> 'confirmed'
     or not exists (select 1 from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id
       where t.event_id = 'w07-transfer-4' and a.action = 'source_missing') then
    raise exception 'W07-T44b: an absent source must be audited and the transfer confirmed';
  end if;
end $$;
set local role service_role;

-- The barrier is user-wide, not ticket-wide: while the destination is party
-- to a transfer whose source is still UNVERIFIED, its OWN sync verdict (no
-- transfer binding) must not grant premium either.
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000c01';
  dst uuid := '00000000-0000-4000-8000-000000000c02';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-1', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  sync_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-r2-transfer-1', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-r2-transfer-1', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  -- The destination device syncs on its own while the source is unverified.
  sync_ticket := (public.begin_billing_verification(array[dst])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst, sync_ticket, active);
  if r->>'outcome' <> 'persisted' or (r->>'applied')::boolean or not (r->>'withheld')::boolean
     or (r->'billing'->>'premium')::boolean or r->'transfer'->>'event_id' <> 'w07-r2-transfer-1'
     or r->'transfer'->>'state' <> 'pending' then
    raise exception 'W07-R2-1: a destination sync verdict must be withheld while its transfer is pending (got %)', r;
  end if;
  if exists (select 1 from public.billing_entitlements where user_id = dst) then
    raise exception 'W07-R2-2: a withheld sync verdict must not write a destination entitlement row';
  end if;
  r := public.billing_transfer_recovery(dst);
  if jsonb_array_length(r) <> 1 or r->0->>'state' <> 'pending'
     or not (r->0->'destinations'->0->>'verified')::boolean or (r->0->'destinations'->0->>'applied')::boolean then
    raise exception 'W07-R2-3: the withheld sync verdict must be recorded on the queued side (got %)', r;
  end if;
  r := public.persist_billing_verdict(src, src_ticket, inactive);
  if not (r->>'applied')::boolean or (r->'billing'->>'premium')::boolean then
    raise exception 'W07-R2-4: the source verdict must apply immediately (got %)', r;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-R2-5: the recorded sync verdict must be released once the source is confirmed lost';
  end if;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'W07-R2-6: the transfer ticket verdict after release reports the applied entitlement (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-r2-transfer-1', payload,
    jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
  if not (r->>'verified')::boolean then
    raise exception 'W07-R2-7: the transfer webhook completes once the barrier released (got %)', r;
  end if;
end $$;

do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000c03';
  dst uuid := '00000000-0000-4000-8000-000000000c04';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-2', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  sync_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-r2-transfer-2', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-r2-transfer-2', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  -- The destination device syncs on its own while the source is unverified.
  sync_ticket := (public.begin_billing_verification(array[dst])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst, sync_ticket, active);
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean or (r->'billing'->>'premium')::boolean
     or r->'transfer'->>'state' <> 'pending'
     or exists (select 1 from public.billing_entitlements where user_id = dst) then
    raise exception 'W07-R2-8: a destination sync verdict must be withheld while its source is unverified (got %)', r;
  end if;
  perform public.persist_billing_verdict(src, src_ticket, active);
  if public.billing_transfer_recovery(dst)->0->>'state' <> 'held' then
    raise exception 'W07-R2-9: a source that still holds the entitlement must park the transfer as held (got %)',
      public.billing_transfer_recovery(dst);
  end if;
  -- The source is provider-confirmed entitled: the hold is the provider's
  -- answer, so the destination's recorded provider verdict applies too.
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or not exists (select 1 from public.billing_entitlements where user_id = src and premium) then
    raise exception 'W07-R2-10: once the source is provider-confirmed the recorded destination verdict applies (got %)',
      public.billing_transfer_recovery(dst);
  end if;
  sync_ticket := (public.begin_billing_verification(array[dst])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst, sync_ticket, active);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'W07-R2-11: repeated destination syncs apply while the transfer is held (got %)', r;
  end if;
  sync_ticket := (public.begin_billing_verification(array[src])->0->>'ticket_id')::uuid;
  perform public.persist_billing_verdict(src, sync_ticket, inactive);
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or exists (select 1 from public.billing_entitlements where user_id = src and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-R2-12: the held transfer confirms when the source loses';
  end if;
end $$;
reset role;
do $$
begin
  if (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
      join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-r2-transfer-1')
     <> array['enqueued','destination_verified','destination_withheld','source_verified','destination_applied','confirmed'] then
    raise exception 'W07-R2-13: a withheld sync verdict must be audited like any destination verdict (got %)',
      (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
        join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-r2-transfer-1');
  end if;
  if (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
      join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-r2-transfer-2')
     <> array['enqueued','destination_verified','destination_withheld','source_verified','held',
              'destination_applied','source_verified','confirmed'] then
    raise exception 'W07-R2-14: the hold and the release of the recorded destination verdict must be audited (got %)',
      (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
        join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-r2-transfer-2');
  end if;
end $$;
set local role service_role;

-- A destination shared by two unsettled transfers gains only once EVERY
-- source of EVERY transfer is confirmed; the response is coherent (withheld
-- implies non-premium and no entitlement row at that verification order).
do $$
declare
  src1 uuid := '00000000-0000-4000-8000-000000000c05';
  src2 uuid := '00000000-0000-4000-8000-000000000c06';
  dst uuid := '00000000-0000-4000-8000-000000000c07';
  payload1 jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-3a', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src1::text), 'transferred_to', jsonb_build_array(dst::text)));
  payload2 jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-3b', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src2::text), 'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_annual',
    'expiresAt', (clock_timestamp() + interval '300 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease1 uuid;
  lease2 uuid;
  issued1 jsonb;
  issued2 jsonb;
  src1_ticket uuid;
  src2_ticket uuid;
  dst1_ticket uuid;
  dst2_ticket uuid;
  r jsonb;
begin
  lease1 := (public.claim_billing_webhook_delivery('w07-r2-transfer-3a', payload1)->>'lease_token')::uuid;
  issued1 := public.begin_billing_verification(array[src1, dst], 'w07-r2-transfer-3a', payload1, lease1);
  lease2 := (public.claim_billing_webhook_delivery('w07-r2-transfer-3b', payload2)->>'lease_token')::uuid;
  issued2 := public.begin_billing_verification(array[src2, dst], 'w07-r2-transfer-3b', payload2, lease2);
  select (item->>'ticket_id')::uuid into src1_ticket from jsonb_array_elements(issued1) item where item->>'user_id' = src1::text;
  select (item->>'ticket_id')::uuid into dst1_ticket from jsonb_array_elements(issued1) item where item->>'user_id' = dst::text;
  select (item->>'ticket_id')::uuid into src2_ticket from jsonb_array_elements(issued2) item where item->>'user_id' = src2::text;
  select (item->>'ticket_id')::uuid into dst2_ticket from jsonb_array_elements(issued2) item where item->>'user_id' = dst::text;
  if jsonb_array_length(public.billing_transfer_recovery(dst)) <> 2 then
    raise exception 'W07-R2-15: both transfers must be queued for the shared destination';
  end if;
  r := public.persist_billing_verdict(dst, dst2_ticket, active);
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean or (r->'billing'->>'premium')::boolean
     or r->'transfer'->>'event_id' <> 'w07-r2-transfer-3a' then
    raise exception 'W07-R2-16: the second transfer''s ticket must be withheld by the first unsettled transfer (got %)', r;
  end if;
  if exists (select 1 from public.billing_entitlements where user_id = dst) then
    raise exception 'W07-R2-17: a withheld verdict must leave no destination entitlement row';
  end if;
  r := public.billing_transfer_recovery(dst);
  if jsonb_array_length(r) <> 2
     or exists (select 1 from jsonb_array_elements(r) t
          where t->>'state' <> 'pending' or (t->'destinations'->0->>'applied')::boolean
             or not (t->'destinations'->0->>'verified')::boolean) then
    raise exception 'W07-R2-18: one destination verdict is recorded on every queued transfer and applied on none (got %)', r;
  end if;
  r := public.persist_billing_verdict(src1, src1_ticket, inactive);
  if not (r->>'applied')::boolean then
    raise exception 'W07-R2-19: the first source verdict must apply (got %)', r;
  end if;
  if exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 2 then
    raise exception 'W07-R2-20: the destination stays non-premium while the second transfer''s source is unconfirmed';
  end if;
  r := public.persist_billing_verdict(dst, dst1_ticket, active);
  if (r->>'applied')::boolean or not (r->>'withheld')::boolean or (r->'billing'->>'premium')::boolean
     or r->'transfer'->>'event_id' <> 'w07-r2-transfer-3b' then
    raise exception 'W07-R2-21: the first transfer''s ticket is withheld by the second unsettled transfer (got %)', r;
  end if;
  begin
    perform public.complete_billing_webhook('w07-r2-transfer-3a', payload1,
      jsonb_build_object(src1::text, src1_ticket, dst::text, dst1_ticket), lease1);
    raise exception 'W07-R2-22: a transfer whose destination is still barred must not complete';
  exception when object_not_in_prerequisite_state then null;
  end;
  r := public.persist_billing_verdict(src2, src2_ticket, inactive);
  if not (r->>'applied')::boolean then
    raise exception 'W07-R2-23: the second source verdict must apply (got %)', r;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-R2-24: the destination gains once the last source is confirmed and both transfers confirm';
  end if;
  r := public.complete_billing_webhook('w07-r2-transfer-3a', payload1,
    jsonb_build_object(src1::text, src1_ticket, dst::text, dst1_ticket), lease1);
  if not (r->>'verified')::boolean then
    raise exception 'W07-R2-25: the first transfer webhook completes after both settle (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-r2-transfer-3b', payload2,
    jsonb_build_object(src2::text, src2_ticket, dst::text, dst2_ticket), lease2);
  if not (r->>'verified')::boolean then
    raise exception 'W07-R2-26: the second transfer webhook completes after both settle (got %)', r;
  end if;
end $$;
reset role;
do $$
begin
  if (select array_agg(state order by event_id) from api_private.billing_transfers
      where event_id in ('w07-r2-transfer-3a', 'w07-r2-transfer-3b')) <> array['confirmed', 'confirmed'] then
    raise exception 'W07-R2-27: both shared-destination transfers must be confirmed';
  end if;
  if (select count(*) from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id
      where t.event_id in ('w07-r2-transfer-3a', 'w07-r2-transfer-3b') and s.role = 'destination' and s.applied_at is not null) <> 2 then
    raise exception 'W07-R2-28: the destination side of both transfers must be applied';
  end if;
end $$;

-- A held source that is later deleted from Auth is authoritatively absent:
-- redelivery (the worker died before completing) reclassifies it, confirms
-- the transfer and completes.
set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000c08';
  dst uuid := '00000000-0000-4000-8000-000000000c09';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-4', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-r2-transfer-4', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-r2-transfer-4', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  perform public.persist_billing_verdict(src, src_ticket, active);
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if (r->>'withheld')::boolean or not (r->>'applied')::boolean
     or public.billing_transfer_recovery(dst)->0->>'state' <> 'held' then
    raise exception 'W07-R2-29: an entitled source parks the transfer as held while the confirmed destination applies (got %)', r;
  end if;
  if exists (select 1 from public.webhook_events where id = 'w07-r2-transfer-4' and processed_at is not null) then
    raise exception 'W07-R2-30: the delivery is not complete until the worker completes it';
  end if;
  perform public.release_billing_webhook_delivery('w07-r2-transfer-4', payload, lease);
end $$;
reset role;
delete from auth.users where id = '00000000-0000-4000-8000-000000000c08';
set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000c08';
  dst uuid := '00000000-0000-4000-8000-000000000c09';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-4', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid;
  issued jsonb;
  dst_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-r2-transfer-4', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-r2-transfer-4', payload, lease);
  if not exists (select 1 from jsonb_array_elements(issued) item where item->>'user_id' = src::text and item->>'outcome' = 'user_missing') then
    raise exception 'W07-R2-31: redelivery must report the deleted source as missing (got %)', issued;
  end if;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-R2-32: a source absent from Auth releases the held destination on redelivery (got %)',
      public.billing_transfer_recovery(dst);
  end if;
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'W07-R2-33: the destination verdict applies once the source is authoritatively absent (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-r2-transfer-4', payload, jsonb_build_object(dst::text, dst_ticket), lease);
  if not (r->>'received')::boolean or (r->>'verified')::boolean then
    raise exception 'W07-R2-34: the redelivered transfer webhook completes, reporting the absent subject as unverified (got %)', r;
  end if;
end $$;
reset role;
do $$
declare
  t api_private.billing_transfers%rowtype;
begin
  select * into strict t from api_private.billing_transfers where event_id = 'w07-r2-transfer-4';
  if t.state <> 'confirmed'
     or not exists (select 1 from public.webhook_events where id = 'w07-r2-transfer-4' and processed_at is not null)
     or exists (select 1 from api_private.billing_webhook_claims where event_id = 'w07-r2-transfer-4' and lease_token is not null) then
    raise exception 'W07-R2-35: the transfer must confirm and the delivery must be settled once its only source is absent';
  end if;
  if not exists (select 1 from api_private.billing_transfer_sides where transfer_id = t.id and role = 'source' and user_missing_at is not null)
     or not exists (select 1 from api_private.billing_transfer_audit where transfer_id = t.id and action = 'source_missing'
          and (detail->>'verified')::boolean) then
    raise exception 'W07-R2-36: a verified source later deleted from Auth must be marked missing and audited';
  end if;
end $$;

-- "Source loses" is independent of the destination: a destination whose
-- profile row is unavailable must not roll back the source's confirmed loss.
create temp table w07_r2_state (src_ticket uuid, lease uuid);
grant select, insert on w07_r2_state to service_role;
set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000c0a';
  dst uuid := '00000000-0000-4000-8000-000000000c0b';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-5', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  issued jsonb;
  lease uuid;
  r jsonb;
begin
  issued := public.begin_billing_verification(array[src]);
  perform public.persist_billing_verdict(src, (issued->0->>'ticket_id')::uuid, active);
  lease := (public.claim_billing_webhook_delivery('w07-r2-transfer-5', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-r2-transfer-5', payload, lease);
  r := public.persist_billing_verdict(dst,
    (select (item->>'ticket_id')::uuid from jsonb_array_elements(issued) item where item->>'user_id' = dst::text), active);
  if not (r->>'withheld')::boolean then
    raise exception 'W07-R2-37: the destination must be withheld before the source is confirmed (got %)', r;
  end if;
  insert into pg_temp.w07_r2_state
    select (item->>'ticket_id')::uuid, lease
    from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
end $$;
reset role;
delete from public.profiles where id = '00000000-0000-4000-8000-000000000c0b';
set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000c0a';
  dst uuid := '00000000-0000-4000-8000-000000000c0b';
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  r jsonb;
begin
  r := public.persist_billing_verdict(src, (select s.src_ticket from pg_temp.w07_r2_state s), inactive);
  if not (r->>'applied')::boolean or (r->'billing'->>'premium')::boolean then
    raise exception 'W07-R2-38: the source loss must persist even though the destination cannot be applied (got %)', r;
  end if;
  if exists (select 1 from public.billing_entitlements where user_id = src and premium) then
    raise exception 'W07-R2-39: the source must not keep premium after a provider-confirmed loss';
  end if;
  r := public.billing_transfer_recovery(dst);
  if jsonb_array_length(r) <> 1 or r->0->>'state' <> 'pending' or (r->0->'destinations'->0->>'applied')::boolean
     or (r->0->'destinations'->0->>'missing')::boolean then
    raise exception 'W07-R2-40: a destination without a profile row stays recoverable, not missing (got %)', r;
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from api_private.billing_transfer_audit a join api_private.billing_transfers t on t.id = a.transfer_id
      where t.event_id = 'w07-r2-transfer-5' and a.action = 'destination_deferred') then
    raise exception 'W07-R2-41: an unapplied destination must be audited as deferred';
  end if;
end $$;
insert into public.profiles (id, email, provider)
  values ('00000000-0000-4000-8000-000000000c0b', 'transfer-dst-r2-5@example.test', 'apple');
set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000c0a';
  dst uuid := '00000000-0000-4000-8000-000000000c0b';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r2-transfer-5', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  r jsonb;
begin
  perform public.release_billing_webhook_delivery('w07-r2-transfer-5', payload, (select s.lease from pg_temp.w07_r2_state s));
  lease := (public.claim_billing_webhook_delivery('w07-r2-transfer-5', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-r2-transfer-5', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  if not exists (select 1 from public.billing_entitlements where user_id = dst and premium)
     or jsonb_array_length(public.billing_transfer_recovery(dst)) <> 0 then
    raise exception 'W07-R2-42: redelivery applies the recorded destination verdict once its profile is back (got %)',
      public.billing_transfer_recovery(dst);
  end if;
  perform public.persist_billing_verdict(src, src_ticket, '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}'::jsonb);
  r := public.persist_billing_verdict(dst, dst_ticket, active);
  if (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'W07-R2-43: the destination re-verification applies after recovery (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-r2-transfer-5', payload,
    jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
  if not (r->>'verified')::boolean then
    raise exception 'W07-R2-44: the recovered transfer webhook completes (got %)', r;
  end if;
end $$;
reset role;
drop table pg_temp.w07_r2_state;

-- A stale TRANSFER (the device switched back before delivery: the provider
-- says the source is still entitled, the destination is not) parks as held
-- with both sides confirmed. The destination's OWN later purchase is its own
-- provider-confirmed entitlement: it applies, its webhook completes, and its
-- syncs keep applying while the stale transfer stays held (recoverable).
set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000d01';
  dst uuid := '00000000-0000-4000-8000-000000000d02';
  transfer jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r3-stale', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text), 'transferred_to', jsonb_build_array(dst::text)));
  purchase jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r3-purchase', 'type', 'INITIAL_PURCHASE', 'app_user_id', dst::text));
  lifetime jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_lifetime', 'expiresAt', null,
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst_ticket uuid;
  own_ticket uuid;
  r jsonb;
begin
  lease := (public.claim_billing_webhook_delivery('w07-r3-stale', transfer)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst], 'w07-r3-stale', transfer, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst::text;
  perform public.persist_billing_verdict(src, src_ticket, lifetime);
  r := public.persist_billing_verdict(dst, dst_ticket, inactive);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or (r->'billing'->>'premium')::boolean
     or public.billing_transfer_recovery(dst)->0->>'state' <> 'held' then
    raise exception 'W07-R3-1: a stale transfer parks as held and the destination mirrors its confirmed inactive verdict (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-r3-stale', transfer,
    jsonb_build_object(src::text, src_ticket, dst::text, dst_ticket), lease);
  if not (r->>'verified')::boolean then
    raise exception 'W07-R3-2: a held transfer whose sides are both provider-confirmed completes its delivery (got %)', r;
  end if;
  -- The destination buys a subscription of its own.
  lease := (public.claim_billing_webhook_delivery('w07-r3-purchase', purchase)->>'lease_token')::uuid;
  own_ticket := (public.begin_billing_verification(array[dst], 'w07-r3-purchase', purchase, lease)->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst, own_ticket, active);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean
     or not exists (select 1 from public.billing_entitlements where user_id = dst and premium) then
    raise exception 'W07-R3-3: a held stale transfer must not withhold the destination''s own provider-confirmed purchase (got %)', r;
  end if;
  r := public.complete_billing_webhook('w07-r3-purchase', purchase, jsonb_build_object(dst::text, own_ticket), lease);
  if not (r->>'verified')::boolean
     or not exists (select 1 from public.webhook_events where id = 'w07-r3-purchase' and processed_at is not null) then
    raise exception 'W07-R3-4: the destination''s own purchase webhook completes (got %)', r;
  end if;
  own_ticket := (public.begin_billing_verification(array[dst])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst, own_ticket, active);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean then
    raise exception 'W07-R3-5: the destination''s own syncs keep applying while the stale transfer is held (got %)', r;
  end if;
  r := public.billing_transfer_recovery(dst);
  if jsonb_array_length(r) <> 1 or r->0->>'state' <> 'held'
     or not (r->0->'sources'->0->>'active')::boolean or not (r->0->'destinations'->0->>'applied')::boolean then
    raise exception 'W07-R3-6: the stale transfer stays held and recoverable, not silently confirmed (got %)', r;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = src and premium) then
    raise exception 'W07-R3-7: the source keeps the entitlement the provider confirmed for it';
  end if;
end $$;
reset role;
do $$
begin
  if (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
      join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-r3-stale')
     <> array['enqueued','source_verified','held','destination_verified','destination_applied'] then
    raise exception 'W07-R3-8: a held stale transfer audits the hold and the applied destination verdict, nothing more (got %)',
      (select array_agg(a.action order by a.id) from api_private.billing_transfer_audit a
        join api_private.billing_transfers t on t.id = a.transfer_id where t.event_id = 'w07-r3-stale');
  end if;
end $$;

-- An applied destination side is settled for good: when the source later
-- buys a new subscription of its own, the transfer (still open for another
-- destination) re-parks as held, but the applied destination's own renewal
-- applies and advances its expiry.
set local role service_role;
do $$
declare
  src uuid := '00000000-0000-4000-8000-000000000d03';
  dst1 uuid := '00000000-0000-4000-8000-000000000d04';
  dst2 uuid := '00000000-0000-4000-8000-000000000d05';
  payload jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r3-applied', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(src::text),
    'transferred_to', jsonb_build_array(dst1::text, dst2::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '30 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  renewed jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_monthly',
    'expiresAt', (clock_timestamp() + interval '60 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  inactive jsonb := '{"premium":false,"productKey":null,"expiresAt":null,"activeEntitlements":[]}';
  lease uuid;
  issued jsonb;
  src_ticket uuid;
  dst1_ticket uuid;
  own_ticket uuid;
  r jsonb;
  e public.billing_entitlements%rowtype;
begin
  lease := (public.claim_billing_webhook_delivery('w07-r3-applied', payload)->>'lease_token')::uuid;
  issued := public.begin_billing_verification(array[src, dst1, dst2], 'w07-r3-applied', payload, lease);
  select (item->>'ticket_id')::uuid into src_ticket from jsonb_array_elements(issued) item where item->>'user_id' = src::text;
  select (item->>'ticket_id')::uuid into dst1_ticket from jsonb_array_elements(issued) item where item->>'user_id' = dst1::text;
  perform public.persist_billing_verdict(src, src_ticket, inactive);
  r := public.persist_billing_verdict(dst1, dst1_ticket, active);
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean then
    raise exception 'W07-R3-9: the first destination applies once the source is confirmed lost (got %)', r;
  end if;
  r := public.billing_transfer_recovery(dst1);
  if jsonb_array_length(r) <> 1 or r->0->>'state' <> 'pending'
     or not exists (select 1 from jsonb_array_elements(r->0->'destinations') d
          where d->>'user_id' = dst1::text and (d->>'applied')::boolean)
     or not exists (select 1 from jsonb_array_elements(r->0->'destinations') d
          where d->>'user_id' = dst2::text and not (d->>'verified')::boolean) then
    raise exception 'W07-R3-10: the transfer stays open for the unverified second destination (got %)', r;
  end if;
  -- The source buys a new subscription of its own.
  own_ticket := (public.begin_billing_verification(array[src])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(src, own_ticket, active);
  if not (r->>'applied')::boolean or not (r->'billing'->>'premium')::boolean
     or public.billing_transfer_recovery(dst1)->0->>'state' <> 'held' then
    raise exception 'W07-R3-11: the source''s own new purchase applies and re-parks the open transfer as held (got %)', r;
  end if;
  -- The applied destination renews.
  own_ticket := (public.begin_billing_verification(array[dst1])->0->>'ticket_id')::uuid;
  r := public.persist_billing_verdict(dst1, own_ticket, renewed);
  select * into strict e from public.billing_entitlements where user_id = dst1;
  if not (r->>'applied')::boolean or (r->>'withheld')::boolean or not (r->'billing'->>'premium')::boolean
     or not e.premium or e.expires_at < clock_timestamp() + interval '59 days' then
    raise exception 'W07-R3-12: an already-applied destination is never barred again; its renewal advances expiry (got %, expires %)',
      r, e.expires_at;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = src and premium) then
    raise exception 'W07-R3-13: the source keeps its own new purchase';
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id
      where t.event_id = 'w07-r3-applied' and s.user_id = '00000000-0000-4000-8000-000000000d04' and s.applied_at is not null
        and s.ticket_id = (select id from api_private.billing_verification_tickets
          where user_id = '00000000-0000-4000-8000-000000000d04' and event_id = 'w07-r3-applied')) then
    raise exception 'W07-R3-14: the applied destination side keeps the verdict it was applied with';
  end if;
end $$;

-- Mutual transfers (S->D, then D->S; the device switched twice) with both
-- accounts provider-confirmed active on their own tickets: neither is losing
-- anything, so neither may be withheld — two paying accounts are never both
-- locked out.
set local role service_role;
do $$
declare
  s uuid := '00000000-0000-4000-8000-000000000d06';
  d uuid := '00000000-0000-4000-8000-000000000d07';
  t1 jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r3-mutual-1', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(s::text), 'transferred_to', jsonb_build_array(d::text)));
  t2 jsonb := jsonb_build_object('event', jsonb_build_object(
    'id', 'w07-r3-mutual-2', 'type', 'TRANSFER',
    'transferred_from', jsonb_build_array(d::text), 'transferred_to', jsonb_build_array(s::text)));
  active jsonb := jsonb_build_object(
    'premium', true, 'productKey', 'pickle_sensei_pro_annual',
    'expiresAt', (clock_timestamp() + interval '300 days'),
    'activeEntitlements', jsonb_build_array('pickle_sensei_pro'));
  lease1 uuid;
  lease2 uuid;
  issued1 jsonb;
  issued2 jsonb;
  s_ticket1 uuid;
  d_ticket1 uuid;
  s_ticket2 uuid;
  d_ticket2 uuid;
  rs jsonb;
  rd jsonb;
begin
  lease1 := (public.claim_billing_webhook_delivery('w07-r3-mutual-1', t1)->>'lease_token')::uuid;
  issued1 := public.begin_billing_verification(array[s, d], 'w07-r3-mutual-1', t1, lease1);
  lease2 := (public.claim_billing_webhook_delivery('w07-r3-mutual-2', t2)->>'lease_token')::uuid;
  issued2 := public.begin_billing_verification(array[d, s], 'w07-r3-mutual-2', t2, lease2);
  select (item->>'ticket_id')::uuid into s_ticket1 from jsonb_array_elements(issued1) item where item->>'user_id' = s::text;
  select (item->>'ticket_id')::uuid into d_ticket1 from jsonb_array_elements(issued1) item where item->>'user_id' = d::text;
  select (item->>'ticket_id')::uuid into s_ticket2 from jsonb_array_elements(issued2) item where item->>'user_id' = s::text;
  select (item->>'ticket_id')::uuid into d_ticket2 from jsonb_array_elements(issued2) item where item->>'user_id' = d::text;
  rs := public.persist_billing_verdict(s, s_ticket1, active);
  if (rs->>'applied')::boolean or not (rs->>'withheld')::boolean or (rs->'billing'->>'premium')::boolean then
    raise exception 'W07-R3-15: the first account is withheld while its own transfer source is unverified (got %)', rs;
  end if;
  rd := public.persist_billing_verdict(d, d_ticket1, active);
  if not (rd->>'applied')::boolean or (rd->>'withheld')::boolean or not (rd->'billing'->>'premium')::boolean then
    raise exception 'W07-R3-16: the second account applies once the first is provider-confirmed (got %)', rd;
  end if;
  if not exists (select 1 from public.billing_entitlements where user_id = s and premium)
     or not exists (select 1 from public.billing_entitlements where user_id = d and premium) then
    raise exception 'W07-R3-17: both provider-confirmed-active accounts must be premium (s=%, d=%)',
      (select premium from public.billing_entitlements where user_id = s),
      (select premium from public.billing_entitlements where user_id = d);
  end if;
  rs := public.persist_billing_verdict(s, s_ticket2, active);
  rd := public.persist_billing_verdict(d, d_ticket2, active);
  if not (rs->>'applied')::boolean or (rs->>'withheld')::boolean
     or not (rd->>'applied')::boolean or (rd->>'withheld')::boolean then
    raise exception 'W07-R3-18: the second transfer''s tickets apply for both accounts (got % / %)', rs, rd;
  end if;
  rs := public.complete_billing_webhook('w07-r3-mutual-1', t1, jsonb_build_object(s::text, s_ticket1, d::text, d_ticket1), lease1);
  rd := public.complete_billing_webhook('w07-r3-mutual-2', t2, jsonb_build_object(d::text, d_ticket2, s::text, s_ticket2), lease2);
  if not (rs->>'verified')::boolean or not (rd->>'verified')::boolean then
    raise exception 'W07-R3-19: both mutual transfer deliveries complete (got % / %)', rs, rd;
  end if;
  if exists (select 1 from jsonb_array_elements(public.billing_transfer_recovery(s)) t where t->>'state' <> 'held')
     or jsonb_array_length(public.billing_transfer_recovery(s)) <> 2 then
    raise exception 'W07-R3-20: both mutual transfers stay held and recoverable (got %)', public.billing_transfer_recovery(s);
  end if;
end $$;
reset role;
do $$
begin
  if (select array_agg(state order by event_id) from api_private.billing_transfers
      where event_id in ('w07-r3-mutual-1', 'w07-r3-mutual-2')) <> array['held', 'held'] then
    raise exception 'W07-R3-21: mutual transfers with both sources entitled are held, not confirmed';
  end if;
  if (select count(*) from api_private.billing_transfer_sides s join api_private.billing_transfers t on t.id = s.transfer_id
      where t.event_id in ('w07-r3-mutual-1', 'w07-r3-mutual-2') and s.role = 'destination' and s.applied_at is not null) <> 2 then
    raise exception 'W07-R3-22: the destination side of both mutual transfers must be applied';
  end if;
end $$;

-- Append-only audit and immutable settled history, even for the table owner.
do $$
declare
  tid uuid := (select id from api_private.billing_transfers where event_id = 'w07-transfer-1');
begin
  begin
    update api_private.billing_transfer_audit set action = 'confirmed' where transfer_id = tid and action = 'destination_withheld';
    raise exception 'W07-T45: transfer audit rows must be immutable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from api_private.billing_transfer_audit where transfer_id = tid;
    raise exception 'W07-T46: transfer audit rows must not be deletable';
  exception when insufficient_privilege then null;
  end;
  begin
    update api_private.billing_transfers set state = 'pending', settled_at = null where id = tid;
    raise exception 'W07-T47: a confirmed transfer must not reopen';
  exception when check_violation then null;
  end;
  begin
    update api_private.billing_transfers set destination_user_ids = array['00000000-0000-4000-8000-0000000000b8'::uuid] where id = tid;
    raise exception 'W07-T48: transfer scope must be immutable';
  exception when check_violation then null;
  end;
  begin
    delete from api_private.billing_transfers where id = tid;
    raise exception 'W07-T49: transfer rows must not be deletable';
  exception when insufficient_privilege then null;
  end;
  begin
    update api_private.billing_transfer_sides set verdict = null, ticket_id = null, verification_order = null, verified_at = null, applied_at = null
      where transfer_id = tid and role = 'destination';
    raise exception 'W07-T50: an applied destination side must be immutable';
  exception when check_violation then null;
  end;
  begin
    update api_private.billing_transfer_sides set verification_order = verification_order - 1
      where transfer_id = tid and role = 'source';
    raise exception 'W07-T51: a side verdict must never regress to an older verification order';
  exception when check_violation then null;
  end;
  begin
    delete from api_private.billing_transfer_sides where transfer_id = tid;
    raise exception 'W07-T59: transfer sides must not be deletable';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate api_private.billing_transfer_audit;
    raise exception 'W07-T60: the transfer audit must not be truncatable, even by the owner';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate api_private.billing_transfer_sides;
    raise exception 'W07-T61: transfer sides must not be truncatable, even by the owner';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate api_private.billing_transfers cascade;
    raise exception 'W07-T62: transfers must not be truncatable, even by the owner';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;


-- ============================================================================
-- T. (W01-03, 20260908110000) settlement receipts bind the scored settlement
-- to owner / device / grant / ticket / operation / payload digest / policy
-- lineage. An identical replay is accepted (the original receipt stands) and
-- moves nothing; a replay that differs in ANY bound field is refused as
-- shot.receipt_mismatch BEFORE any permit, ledger row or shot is touched; a
-- receipt that does not describe the shot it travels with is refused as
-- shot.receipt_invalid on a fresh settlement; the receipt table is owner-
-- readable through the API gate only, client-unwritable, append-only for
-- every role, and removed only by the shot/account cascade.
-- ============================================================================
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000093', 'tess@example.test',
   '{"full_name":"Tess"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000094', 'theo@example.test',
   '{"full_name":"Theo"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-tess', '00000000-0000-4000-8000-000000000093',
   '{"sub":"google-sub-tess","email":"tess@example.test"}'),
  ('apple', 'apple-sub-theo', '00000000-0000-4000-8000-000000000094',
   '{"sub":"apple-sub-theo","email":"theo@example.test"}');
insert into public.analysis_permits (id, user_id, idempotency_key)
values
  ('00000000-0000-4000-8000-0000000000d1',
   '00000000-0000-4000-8000-000000000093', 'w0103-t-first'),
  ('00000000-0000-4000-8000-0000000000d2',
   '00000000-0000-4000-8000-000000000093', 'w0103-t-spare'),
  ('00000000-0000-4000-8000-0000000000d3',
   '00000000-0000-4000-8000-000000000094', 'w0103-t-theo');

-- Test-only builders (superuser-owned, dropped with the rollback): the shot
-- payload the edge function sends to the RPC, and the receipt transport it
-- attaches — binding + bindingSha256 + policy lineage, canonical bytes and
-- their digest — so the matrix exercises the RPC exactly as the API does.
create schema t_probe;
create function t_probe.shot(p_shot uuid, p_permit uuid, p_score numeric)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_shot,
    'analysisPermitId', p_permit,
    'resultKind', 'scored',
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', '2026-09-08T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', p_score, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
create function t_probe.claims()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'installationKeyId', 'ik_tess_phone',
    'grant', jsonb_build_object('grantId', 'grant_t1', 'grantJwsSha256', repeat('a', 64)),
    'ticket', jsonb_build_object('allocationId', 'alloc_t1', 'generation', 3, 'ticketId', 'ticket_t1'),
    'operationId', 'op_t1')
$$;
create function t_probe.policy(p_version text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('version', p_version, 'sha256', repeat('b', 64))
$$;
create function t_probe.receipt(p_owner uuid, p_shot jsonb, p_claims jsonb, p_policy jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with binding as (
    select jsonb_build_object(
      'ownerId', p_owner,
      'shotId', p_shot ->> 'id',
      'analysisPermitId', p_shot ->> 'analysisPermitId',
      'resultKind', p_shot ->> 'resultKind',
      'installationKeyId', p_claims -> 'installationKeyId',
      'grant', p_claims -> 'grant',
      'ticket', p_claims -> 'ticket',
      'operationId', p_claims -> 'operationId',
      'payloadSha256', encode(pg_catalog.sha256(convert_to(p_shot::text, 'UTF8')), 'hex')
    ) as b
  ), receipt as (
    select jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'settlement_receipt',
      'binding', b,
      'bindingSha256', encode(pg_catalog.sha256(convert_to(b::text, 'UTF8')), 'hex'),
      'policy', p_policy
    ) as r
    from binding
  )
  select jsonb_build_object(
    'canonical', r::text,
    'sha256', encode(pg_catalog.sha256(convert_to(r::text, 'UTF8')), 'hex')
  )
  from receipt
$$;
create function t_probe.settle(p_owner uuid, p_shot jsonb, p_claims jsonb, p_policy jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select p_shot || jsonb_build_object(
    'settlementReceipt', t_probe.receipt(p_owner, p_shot, p_claims, p_policy))
$$;
grant usage on schema t_probe to authenticated;
grant execute on all functions in schema t_probe to authenticated;

do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000093';

-- T1: a fresh scored settlement with its receipt is accepted; the receipt is
-- written in the same transaction with every bound field denormalized, the
-- named permit is consumed exactly once and the lifetime count moves by one.
do $$
declare
  tess uuid := '00000000-0000-4000-8000-000000000093';
  first_permit uuid := '00000000-0000-4000-8000-0000000000d1';
  v_shot uuid := '00000000-0000-4000-8000-0000000000e1';
  settlement jsonb;
  transport jsonb;
  stored record;
  v text;
begin
  settlement := t_probe.settle(tess, t_probe.shot(v_shot, first_permit, 7.1),
                               t_probe.claims(), t_probe.policy('policy-2026-09-08'));
  transport := settlement -> 'settlementReceipt';
  v := public.apply_synced_shot(settlement);
  if v <> 'accepted' then
    raise exception 'T1: a fresh settlement with its receipt must be accepted (got %)', v;
  end if;
  select * into stored from public.settlement_receipts where shot_id = v_shot;
  if not found then
    raise exception 'T1: the receipt must be durable with the shot';
  end if;
  if stored.user_id <> tess
     or stored.analysis_permit_id <> first_permit
     or stored.result_kind <> 'scored'
     or stored.installation_key_id <> 'ik_tess_phone'
     or stored.grant_id <> 'grant_t1'
     or stored.grant_jws_sha256 <> repeat('a', 64)
     or stored.ticket_allocation_id <> 'alloc_t1'
     or stored.ticket_generation <> 3
     or stored.ticket_id <> 'ticket_t1'
     or stored.operation_id <> 'op_t1'
     or stored.payload_sha256 <> (stored.receipt -> 'binding' ->> 'payloadSha256')
     or stored.binding_sha256 <> (stored.receipt ->> 'bindingSha256')
     or stored.policy_version <> 'policy-2026-09-08'
     or stored.policy_sha256 <> repeat('b', 64)
     or stored.receipt_canonical <> (transport ->> 'canonical')
     or stored.receipt_sha256 <> (transport ->> 'sha256')
     or stored.receipt <> (transport ->> 'canonical')::jsonb then
    raise exception 'T1: the stored receipt must be exactly the presented receipt with its binding denormalized';
  end if;
  if (select status || '/' || coalesce(outcome, '') from public.analysis_permits where id = first_permit)
     <> 'finalized/scored' then
    raise exception 'T1: the named permit must be consumed once';
  end if;
  if (select status || '/' || coalesce(outcome, '') from public.analysis_permits
      where id = '00000000-0000-4000-8000-0000000000d2') <> 'reserved/' then
    raise exception 'T1: the spare permit must be untouched';
  end if;
  if public.lifetime_scored_count() <> 1 then
    raise exception 'T1: one scored settlement counts once (got %)', public.lifetime_scored_count();
  end if;
end $$;

-- T2: an IDENTICAL replay is accepted — the original receipt stands, no
-- second receipt, no permit movement, no second count.
do $$
declare
  tess uuid := '00000000-0000-4000-8000-000000000093';
  first_permit uuid := '00000000-0000-4000-8000-0000000000d1';
  v_shot uuid := '00000000-0000-4000-8000-0000000000e1';
  before_sha text;
  v text;
begin
  select receipt_sha256 into before_sha from public.settlement_receipts where shot_id = v_shot;
  v := public.apply_synced_shot(t_probe.settle(tess, t_probe.shot(v_shot, first_permit, 7.1),
                                               t_probe.claims(), t_probe.policy('policy-2026-09-08')));
  if v <> 'accepted' then
    raise exception 'T2: an identical replay must be accepted (got %)', v;
  end if;
  if (select count(*) from public.shots where id = v_shot) <> 1
     or (select count(*) from public.settlement_receipts where shot_id = v_shot) <> 1
     or (select receipt_sha256 from public.settlement_receipts where shot_id = v_shot) <> before_sha then
    raise exception 'T2: the replay must leave the one original receipt';
  end if;
  if (select count(*) from public.analysis_permits
      where user_id = (select auth.uid()) and status = 'finalized') <> 1
     or public.lifetime_scored_count() <> 1 then
    raise exception 'T2: the replay must consume nothing';
  end if;
end $$;

-- T3: a replay that differs in ANY bound field — payload digest, permit,
-- device, grant, ticket, operation id, policy lineage, claims withheld or the
-- receipt withheld — is refused as shot.receipt_mismatch. Each attempt names
-- the still-reserved spare permit where it can; it is never consumed and the
-- lifetime count never moves: the check runs before the permit is touched.
do $$
declare
  tess uuid := '00000000-0000-4000-8000-000000000093';
  first_permit uuid := '00000000-0000-4000-8000-0000000000d1';
  spare uuid := '00000000-0000-4000-8000-0000000000d2';
  v_shot uuid := '00000000-0000-4000-8000-0000000000e1';
  original jsonb := t_probe.shot('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000d1', 7.1);
  claims jsonb := t_probe.claims();
  policy jsonb := t_probe.policy('policy-2026-09-08');
  attempt record;
  v text;
begin
  for attempt in
    select * from (values
      ('payload digest', t_probe.settle(tess, t_probe.shot(v_shot, first_permit, 7.6), claims, policy)),
      ('different permit', t_probe.settle(tess, t_probe.shot(v_shot, spare, 7.1), claims, policy)),
      ('different device', t_probe.settle(tess, original, claims || '{"installationKeyId":"ik_other"}', policy)),
      ('different grant', t_probe.settle(tess, original,
         claims || jsonb_build_object('grant', jsonb_build_object('grantId', 'grant_x', 'grantJwsSha256', repeat('a', 64))), policy)),
      ('different ticket', t_probe.settle(tess, original,
         claims || jsonb_build_object('ticket', jsonb_build_object('allocationId', 'alloc_t1', 'generation', 9, 'ticketId', 'ticket_t1')), policy)),
      ('different operation', t_probe.settle(tess, original, claims || '{"operationId":"op_x"}', policy)),
      ('different policy lineage', t_probe.settle(tess, original, claims, t_probe.policy('policy-other'))),
      ('claims withheld', t_probe.settle(tess, original, null, policy)),
      ('receipt withheld', original)
    ) as cases(label, payload)
  loop
    v := public.apply_synced_shot(attempt.payload);
    if v <> 'shot.receipt_mismatch' then
      raise exception 'T3 (%): a mismatched replay must be refused (got %)', attempt.label, v;
    end if;
    if (select count(*) from public.shots where id = v_shot) <> 1
       or (select count(*) from public.settlement_receipts where shot_id = v_shot) <> 1 then
      raise exception 'T3 (%): the refused replay must write nothing', attempt.label;
    end if;
    if (select status || '/' || coalesce(outcome, '') from public.analysis_permits where id = spare) <> 'reserved/'
       or (select status || '/' || coalesce(outcome, '') from public.analysis_permits where id = first_permit) <> 'finalized/scored' then
      raise exception 'T3 (%): zero credit may be consumed by a refused replay', attempt.label;
    end if;
    if public.lifetime_scored_count() <> 1 then
      raise exception 'T3 (%): zero sequence may be consumed by a refused replay', attempt.label;
    end if;
  end loop;
end $$;

-- T4: on a FRESH settlement a receipt that does not describe this owner, shot
-- or permit, carries no policy lineage for a scored result, or whose bytes do
-- not match their digest is refused as shot.receipt_invalid: nothing persists
-- and the permit stays reserved for a clean retry.
do $$
declare
  tess uuid := '00000000-0000-4000-8000-000000000093';
  theo uuid := '00000000-0000-4000-8000-000000000094';
  first_permit uuid := '00000000-0000-4000-8000-0000000000d1';
  spare uuid := '00000000-0000-4000-8000-0000000000d2';
  fresh_id uuid := '00000000-0000-4000-8000-0000000000e2';
  fresh jsonb := t_probe.shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000d2', 6.4);
  claims jsonb := t_probe.claims();
  policy jsonb := t_probe.policy('policy-2026-09-08');
  attempt record;
  v text;
begin
  for attempt in
    select * from (values
      ('receipt for another shot id', fresh || jsonb_build_object('settlementReceipt',
         t_probe.receipt(tess, t_probe.shot('00000000-0000-4000-8000-0000000000e3', spare, 6.4), claims, policy))),
      ('receipt for another owner', fresh || jsonb_build_object('settlementReceipt',
         t_probe.receipt(theo, fresh, claims, policy))),
      ('receipt for another permit', fresh || jsonb_build_object('settlementReceipt',
         t_probe.receipt(tess, t_probe.shot(fresh_id, first_permit, 6.4), claims, policy))),
      ('scored without policy lineage', t_probe.settle(tess, fresh, claims, null)),
      ('receipt digest mismatch', fresh || jsonb_build_object('settlementReceipt',
         t_probe.receipt(tess, fresh, claims, policy) || jsonb_build_object('sha256', repeat('f', 64)))),
      ('receipt not an object', fresh || '{"settlementReceipt":"receipt"}')
    ) as cases(label, payload)
  loop
    v := public.apply_synced_shot(attempt.payload);
    if v <> 'shot.receipt_invalid' then
      raise exception 'T4 (%): an invalid receipt must be refused (got %)', attempt.label, v;
    end if;
    if exists (select 1 from public.shots where id = fresh_id)
       or exists (select 1 from public.settlement_receipts where shot_id = fresh_id) then
      raise exception 'T4 (%): an invalid receipt must persist nothing', attempt.label;
    end if;
    if (select status || '/' || coalesce(outcome, '') from public.analysis_permits where id = spare) <> 'reserved/'
       or public.lifetime_scored_count() <> 1 then
      raise exception 'T4 (%): an invalid receipt must consume nothing', attempt.label;
    end if;
  end loop;
end $$;

-- T5: the owner reads exactly their own receipt through the API gate and
-- holds no write on the table — a receipt cannot be forged, altered or
-- removed from a client session.
do $$
declare v_shot uuid := '00000000-0000-4000-8000-0000000000e1';
begin
  if (select count(*) from public.settlement_receipts) <> 1 then
    raise exception 'T5: the owner must read exactly their own receipt';
  end if;
  begin
    insert into public.settlement_receipts (
      shot_id, user_id, analysis_permit_id, result_kind, payload_sha256, binding_sha256,
      policy_version, policy_sha256, receipt, receipt_canonical, receipt_sha256
    ) values (
      v_shot, (select auth.uid()), '00000000-0000-4000-8000-0000000000d2', 'scored',
      repeat('0', 64), repeat('0', 64), 'forged', repeat('0', 64), '{}', '{}', repeat('0', 64)
    );
    raise exception 'T5: clients must not insert receipts';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.settlement_receipts set operation_id = 'op_forged' where shot_id = v_shot;
    raise exception 'T5: clients must not alter receipts';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.settlement_receipts where shot_id = v_shot;
    raise exception 'T5: clients must not remove receipts';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.headers', '{}', true);
  if exists (select 1 from public.settlement_receipts) then
    raise exception 'T5: receipts must be invisible without the API gate';
  end if;
end $$;
reset role;

-- T6: another owner sees nothing; anonymous holds no privilege at all.
do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000094';
do $$
begin
  if exists (select 1 from public.settlement_receipts) then
    raise exception 'T6: receipts must be owner-isolated';
  end if;
  if has_table_privilege('anon', 'public.settlement_receipts',
                         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or has_table_privilege('authenticated', 'public.settlement_receipts',
                            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception 'T6: the receipt table must be read-only for the owner and closed to anon';
  end if;
end $$;
reset role;

-- T7: append-only for EVERY role (table owner included); the only removal is
-- the cascade that removes the shot — and then the receipt goes with it.
do $$
declare v_shot uuid := '00000000-0000-4000-8000-0000000000e1';
begin
  begin
    update public.settlement_receipts set operation_id = 'op_forged' where shot_id = v_shot;
    raise exception 'T7: receipts must be append-only even for the table owner';
  exception when check_violation then null;
  end;
  begin
    delete from public.settlement_receipts where shot_id = v_shot;
    raise exception 'T7: a receipt must outlive every path but the shot cascade';
  exception when check_violation then null;
  end;
  if (select count(*) from public.settlement_receipts where shot_id = v_shot) <> 1 then
    raise exception 'T7: the refused writes must leave the receipt intact';
  end if;
  delete from auth.users where id = '00000000-0000-4000-8000-000000000093';
  if exists (select 1 from public.settlement_receipts where shot_id = v_shot)
     or exists (select 1 from public.shots where id = v_shot) then
    raise exception 'T7: account deletion must cascade the receipt with the shot';
  end if;
end $$;

-- T8: account deletion cascades the receipt in WHICHEVER order PostgreSQL
-- fires the two profiles cascades. settlement_receipts has two cascade
-- parents (shot_id → shots, user_id → profiles) and shots cascades from
-- profiles too; the same-event RI triggers on profiles fire in trigger-NAME
-- order (RI_ConstraintTrigger_a_<oid>, compared as text), which depends on the
-- oids the cluster allocated — a fresh install, production and any restore
-- may each differ. T7 exercised the natural order of this database; here BOTH
-- orders are forced by recreating the profiles-side foreign key that must
-- fire later (same name, same definition, a newer oid; schema change rolled
-- back with the section), asserted from pg_trigger before each deletion, and
-- each order must remove the profile, the shot and the receipt without error.
create function t_probe.profile_cascade_order()
returns text[] language sql stable set search_path = '' as $$
  select array_agg(t.tgconstrrelid::regclass::text order by t.tgname)
  from pg_catalog.pg_trigger t
  where t.tgrelid = 'public.profiles'::regclass
    and t.tgfoid = 'pg_catalog."RI_FKey_cascade_del"'::regproc
    and t.tgconstrrelid in ('public.shots'::regclass, 'public.settlement_receipts'::regclass)
$$;
create function t_probe.force_profile_cascade_first(p_first text)
returns text[] language plpgsql set search_path = '' as $$
declare
  ordering text[];
  attempts integer := 0;
begin
  loop
    ordering := t_probe.profile_cascade_order();
    if cardinality(ordering) <> 2 then
      raise exception 'T8: expected exactly two profiles cascades to shots and settlement_receipts (got %)', ordering;
    end if;
    exit when ordering[1] = p_first;
    attempts := attempts + 1;
    if attempts > 6 then
      raise exception 'T8: could not make the % cascade fire first (%)', p_first, ordering;
    end if;
    -- Recreate the OTHER foreign key so its RI trigger takes a newer oid.
    if p_first = 'public.settlement_receipts' then
      alter table public.shots drop constraint shots_user_id_fkey;
      alter table public.shots add constraint shots_user_id_fkey
        foreign key (user_id) references public.profiles (id) on delete cascade;
    else
      alter table public.settlement_receipts drop constraint settlement_receipts_user_id_fkey;
      alter table public.settlement_receipts add constraint settlement_receipts_user_id_fkey
        foreign key (user_id) references public.profiles (id) on delete cascade;
    end if;
  end loop;
  return ordering;
end $$;
create function t_probe.settle_as(p_owner uuid, p_shot uuid, p_permit uuid)
returns void language plpgsql set search_path = '' as $$
declare v text;
begin
  perform pg_catalog.set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', p_owner::text, true);
  set local role authenticated;
  v := public.apply_synced_shot(t_probe.settle(p_owner, t_probe.shot(p_shot, p_permit, 6.8),
                                                t_probe.claims(), t_probe.policy('policy-2026-09-08')));
  reset role;
  if v <> 'accepted' then
    raise exception 'T8: the settlement must be accepted before the cascade is exercised (got %)', v;
  end if;
  if (select count(*) from public.settlement_receipts where shot_id = p_shot) <> 1 then
    raise exception 'T8: the receipt must be durable before the cascade is exercised';
  end if;
end $$;
create function t_probe.delete_account_expect_cascade(p_owner uuid, p_shot uuid, p_order text[])
returns void language plpgsql set search_path = '' as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    delete from auth.users where id = p_owner;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    raise exception 'T8 (% first): account deletion of a user with a settled shot must not raise, got % (%)',
      p_order[1], v_state, v_msg;
  end;
  if exists (select 1 from public.profiles where id = p_owner)
     or exists (select 1 from public.shots where id = p_shot)
     or exists (select 1 from public.settlement_receipts where shot_id = p_shot) then
    raise exception 'T8 (% first): account deletion must remove the profile, the shot and the receipt', p_order[1];
  end if;
end $$;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000095', 'tara@example.test',
   '{"full_name":"Tara"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000096', 'tobias@example.test',
   '{"full_name":"Tobias"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-tara', '00000000-0000-4000-8000-000000000095',
   '{"sub":"google-sub-tara","email":"tara@example.test"}'),
  ('apple', 'apple-sub-tobias', '00000000-0000-4000-8000-000000000096',
   '{"sub":"apple-sub-tobias","email":"tobias@example.test"}');
insert into public.analysis_permits (id, user_id, idempotency_key)
values
  ('00000000-0000-4000-8000-0000000000d4',
   '00000000-0000-4000-8000-000000000095', 'w0103-t8-tara'),
  ('00000000-0000-4000-8000-0000000000d5',
   '00000000-0000-4000-8000-000000000096', 'w0103-t8-tobias');

-- T8a: the settlement_receipts cascade fires BEFORE the shots cascade — the
-- receipt is removed while its shot still exists; only the account cascade
-- explains it, and the guard must recognise that.
do $$
declare
  tara uuid := '00000000-0000-4000-8000-000000000095';
  v_shot uuid := '00000000-0000-4000-8000-0000000000e4';
  ordering text[];
begin
  ordering := t_probe.force_profile_cascade_first('public.settlement_receipts');
  if ordering <> array['public.settlement_receipts', 'public.shots'] then
    raise exception 'T8a: the receipts cascade must be ordered first (got %)', ordering;
  end if;
  perform t_probe.settle_as(tara, v_shot, '00000000-0000-4000-8000-0000000000d4');
  perform t_probe.delete_account_expect_cascade(tara, v_shot, ordering);
end $$;

-- T8b: the shots cascade fires BEFORE the settlement_receipts cascade — the
-- shot cascade removes the receipt, then the receipts cascade finds nothing.
do $$
declare
  tobias uuid := '00000000-0000-4000-8000-000000000096';
  v_shot uuid := '00000000-0000-4000-8000-0000000000e5';
  ordering text[];
begin
  ordering := t_probe.force_profile_cascade_first('public.shots');
  if ordering <> array['public.shots', 'public.settlement_receipts'] then
    raise exception 'T8b: the shots cascade must be ordered first (got %)', ordering;
  end if;
  perform t_probe.settle_as(tobias, v_shot, '00000000-0000-4000-8000-0000000000d5');
  perform t_probe.delete_account_expect_cascade(tobias, v_shot, ordering);
end $$;

-- T8c: outside both cascades the receipt still cannot be removed — the
-- tolerance is for the parent rows being gone, not for a live owner.
do $$
declare
  theo uuid := '00000000-0000-4000-8000-000000000094';
  v_shot uuid := '00000000-0000-4000-8000-0000000000e6';
begin
  perform t_probe.settle_as(theo, v_shot, '00000000-0000-4000-8000-0000000000d3');
  begin
    delete from public.settlement_receipts where shot_id = v_shot;
    raise exception 'T8c: a receipt whose shot and owner both exist must not be removable';
  exception when check_violation then null;
  end;
  begin
    delete from public.settlement_receipts where user_id = theo;
    raise exception 'T8c: a receipt whose shot and owner both exist must not be removable by owner';
  exception when check_violation then null;
  end;
  if (select count(*) from public.settlement_receipts where shot_id = v_shot) <> 1 then
    raise exception 'T8c: the refused deletes must leave the receipt intact';
  end if;
end $$;
rollback;

-- ============================================================================
-- U. (W04-04, 20260909220000) delayed offline consumption receipts settle at
-- most once through settle_offline_receipt(): a redelivered receipt (same id,
-- same canonical digest) replays the stored verdict and moves nothing; the
-- same id with another body is offline.receipt_conflict; a second receipt for
-- an operation or a result that already has one, a receipt whose ticket was
-- already consumed or whose allocation does not match the grant it claims, a
-- receipt without its output or with an output that does not name its result,
-- a receipt the edge could not verify and a receipt naming another owner are
-- all HELD as reconciliation_required with the ticket left exactly as it was
-- (never released, never consumed, never re-executed); a malformed receipt
-- persists nothing; the settlement table is invisible and unwritable for every
-- client role, append-only for every role, service_role cannot execute the
-- RPC, a caller without a live API session is refused, and the account cascade
-- is the only remover.
-- ============================================================================
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000481', 'uri@example.com',
   '{"full_name":"Uri"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000482', 'ula@example.com',
   '{"full_name":"Ula"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000483', 'ulf@example.com',
   '{"full_name":"Ulf"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-uri', '00000000-0000-4000-8000-000000000481',
   '{"sub":"google-sub-uri","email":"uri@example.com"}'),
  ('apple', 'apple-sub-ula', '00000000-0000-4000-8000-000000000482',
   '{"sub":"apple-sub-ula","email":"ula@example.com"}'),
  ('apple', 'apple-sub-ulf', '00000000-0000-4000-8000-000000000483',
   '{"sub":"apple-sub-ulf","email":"ulf@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000004801', '00000000-0000-4000-8000-000000000481'),
  ('00000000-0000-4000-8000-000000004802', '00000000-0000-4000-8000-000000000482'),
  ('00000000-0000-4000-8000-000000004803', '00000000-0000-4000-8000-000000000483');
-- Ulf holds a live verified-store entitlement: issue_offline_grant() answers
-- him a Pro lease (entitlement_source verified_store, no tickets).
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000483', true, now() + interval '30 days');

create temporary table u_state (key text primary key, id uuid);
grant select, insert on u_state to authenticated;
-- Test-only builders: the receipt the device signs (schema
-- offline-result-receipt-v1, attestation omitted — the RPC settles what the
-- edge verified), the canonical digest the edge computes for it, and the shot
-- payload the device delivered beside it.
create schema u_probe;
create function u_probe.shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-09T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
create function u_probe.receipt(
  p_receipt_id text, p_owner uuid, p_key text, p_grant uuid, p_ticket uuid, p_generation integer,
  p_operation text, p_result uuid, p_billing text
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', 'offline-result-receipt-v1',
    'receiptId', p_receipt_id,
    'ownerId', p_owner,
    'installationKeyId', p_key,
    'grantId', p_grant,
    'grantJwsSha256', repeat('a', 64),
    'lifecycleSequence', 1,
    'nativeTime', jsonb_build_object('monotonicMs', 1000, 'wallClockIso', '2026-09-09T10:00:00Z'),
    'ticket', case when p_ticket is null then 'null'::jsonb else jsonb_build_object(
      'allocationId', p_grant, 'generation', p_generation, 'ticketId', p_ticket) end,
    'operationId', p_operation,
    'resultId', p_result,
    'fullOutputSha256', repeat('c', 64),
    'billingDisposition', p_billing)
$$;
create function u_probe.digest(p_receipt jsonb)
returns text language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(convert_to(p_receipt::text, 'UTF8')), 'hex')
$$;
create function u_probe.settle(p_receipt jsonb, p_output jsonb, p_hold text)
returns table (result text, delivery text, status text, reason_code text, financial_disposition text, result_id text)
language sql set search_path = '' as $$
  select * from public.settle_offline_receipt(p_receipt, u_probe.digest(p_receipt), p_output, p_hold)
$$;
create function u_probe.events(p_uid uuid) returns text
language sql security definer set search_path = '' as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
create function u_probe.settlements(p_uid uuid) returns text
language sql security definer set search_path = '' as $$
  select coalesce(
    (select string_agg(s.receipt_id || '=' || s.status || '/' || coalesce(s.reason_code, '-') || '/' || s.financial_disposition,
                       ',' order by s.receipt_id)
     from public.offline_receipt_settlements s where s.user_id = p_uid), '');
$$;
create function u_probe.held_on(p_uid uuid, p_ticket uuid) returns integer
language sql security definer set search_path = '' as $$
  select count(*)::int from public.offline_receipt_settlements s
  where s.user_id = p_uid and s.ticket_id = p_ticket
    and s.status = 'reconciliation_required' and s.financial_disposition = 'reserved';
$$;
create function u_probe.recorded(p_uid uuid) returns integer
language sql security definer set search_path = '' as $$
  select count(*)::int from public.offline_receipt_settlements s where s.user_id = p_uid;
$$;
grant usage on schema u_probe to authenticated;
grant execute on all functions in schema u_probe to authenticated;

do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000481';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004801"}';

-- U1: setup as Uri — an attested device holding a free grant of two tickets.
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('uri-key-1', 'production', true);
  if r.result <> 'accepted' then
    raise exception 'U1 precondition: registration is accepted (got %)', r.result;
  end if;
  select * into g from public.issue_offline_grant('uri-key-1', 2);
  if g.result <> 'accepted' or g.generation <> 1 or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'U1 precondition: two free tickets are allocated (got %, %, %)', g.result, g.generation, g.ticket_ids;
  end if;
  insert into u_state values ('grant', g.grant_id), ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
  if u_probe.events((select auth.uid())) <> 'allocated:2' then
    raise exception 'U1 precondition: the ledger holds exactly the two allocations (got %)', u_probe.events((select auth.uid()));
  end if;
end $$;

-- U2: a chargeable receipt settles its ticket exactly once; the identical
-- redelivery replays the verdict; the same id with another body is a
-- conflict; a second receipt for the same operation, the same result or the
-- same (consumed) ticket is HELD and writes no rating.
do $$
declare
  uri uuid := (select auth.uid());
  g uuid := (select id from u_state where key = 'grant');
  t1 uuid := (select id from u_state where key = 't1');
  r1 jsonb := u_probe.receipt('rcpt-1', uri, 'uri-key-1', g, t1, 1, 'op-1',
    '00000000-0000-4000-8000-000000004811', 'joint_verification_required');
  r1b jsonb := u_probe.receipt('rcpt-1', uri, 'uri-key-1', g, t1, 1, 'op-1',
    '00000000-0000-4000-8000-000000004812', 'joint_verification_required');
  r_same_op jsonb := u_probe.receipt('rcpt-1-again', uri, 'uri-key-1', g, t1, 1, 'op-1',
    '00000000-0000-4000-8000-000000004812', 'joint_verification_required');
  r_same_result jsonb := u_probe.receipt('rcpt-1-result', uri, 'uri-key-1', g, t1, 1, 'op-1-result',
    '00000000-0000-4000-8000-000000004811', 'joint_verification_required');
  r_same_ticket jsonb := u_probe.receipt('rcpt-2', uri, 'uri-key-1', g, t1, 1, 'op-2',
    '00000000-0000-4000-8000-000000004812', 'joint_verification_required');
  o1 jsonb := u_probe.shot('00000000-0000-4000-8000-000000004811', null, 'scored');
  o2 jsonb := u_probe.shot('00000000-0000-4000-8000-000000004812', null, 'scored');
  v record;
begin
  select * into v from u_probe.settle(r1, o1, null);
  if v.result <> 'accepted' or v.delivery <> 'settled' or v.status <> 'result_recorded'
     or v.reason_code is not null or v.financial_disposition <> 'consumed'
     or v.result_id <> '00000000-0000-4000-8000-000000004811' then
    raise exception 'U2: a verified chargeable receipt settles its ticket (got %, %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition, v.result_id;
  end if;
  if (select count(*) from public.shots
      where id = '00000000-0000-4000-8000-000000004811' and user_id = uri
        and result_kind = 'scored' and analysis_permit_id is null and offline_ticket_id = t1) <> 1
     or u_probe.events(uri) <> 'allocated:2,consumed:1'
     or public.lifetime_scored_count() <> 1 then
    raise exception 'U2: the rating, the consumed event and the receipt commit together (got %, %)',
      u_probe.events(uri), public.lifetime_scored_count();
  end if;
  select * into v from u_probe.settle(r1, o1, null);
  if v.result <> 'accepted' or v.delivery <> 'replayed' or v.status <> 'result_recorded'
     or v.financial_disposition <> 'consumed' or v.result_id <> '00000000-0000-4000-8000-000000004811' then
    raise exception 'U2: the identical redelivery replays the stored verdict (got %, %, %, %)',
      v.result, v.delivery, v.status, v.financial_disposition;
  end if;
  select * into v from u_probe.settle(r1, o1, null);
  if v.delivery <> 'replayed' then
    raise exception 'U2: every further redelivery replays (got %)', v.delivery;
  end if;
  select * into v from u_probe.settle(r1b, o2, null);
  if v.result <> 'offline.receipt_conflict' or v.delivery is not null then
    raise exception 'U2: the same receipt id with another body is a conflict (got %, %)', v.result, v.delivery;
  end if;
  select * into v from u_probe.settle(r_same_op, o2, null);
  if v.result <> 'accepted' or v.delivery <> 'held' or v.status <> 'reconciliation_required'
     or v.reason_code <> 'conflicting_receipt' or v.financial_disposition <> 'reserved' or v.result_id is not null then
    raise exception 'U2: a second receipt for the same operation is held (got %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u_probe.settle(r_same_result, o1, null);
  if v.delivery <> 'held' or v.reason_code <> 'conflicting_receipt' then
    raise exception 'U2: a second receipt for the same result is held (got %, %)', v.delivery, v.reason_code;
  end if;
  select * into v from u_probe.settle(r_same_ticket, o2, null);
  if v.delivery <> 'held' or v.reason_code <> 'conflicting_receipt' or v.financial_disposition <> 'reserved' then
    raise exception 'U2: a second rating claimed under a consumed ticket is held (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004812')
     or u_probe.events(uri) <> 'allocated:2,consumed:1'
     or public.lifetime_scored_count() <> 1 then
    raise exception 'U2: held receipts write no rating and move no ticket (got %, %)',
      u_probe.events(uri), public.lifetime_scored_count();
  end if;
  if u_probe.settlements(uri) <> 'rcpt-1=result_recorded/-/consumed,'
       || 'rcpt-1-again=reconciliation_required/conflicting_receipt/reserved,'
       || 'rcpt-1-result=reconciliation_required/conflicting_receipt/reserved,'
       || 'rcpt-2=reconciliation_required/conflicting_receipt/reserved' then
    raise exception 'U2: one durable row per receipt id, the conflict persisted nothing (got %)', u_probe.settlements(uri);
  end if;
end $$;

-- U3: ambiguous evidence is HELD, never refunded and never settled: the
-- ticket stays allocated through every hold and is still settled by the one
-- verified receipt that follows. A malformed receipt persists nothing.
do $$
declare
  uri uuid := (select auth.uid());
  ula uuid := '00000000-0000-4000-8000-000000000482';
  g uuid := (select id from u_state where key = 'grant');
  t1 uuid := (select id from u_state where key = 't1');
  t2 uuid := (select id from u_state where key = 't2');
  o3 jsonb := u_probe.shot('00000000-0000-4000-8000-000000004813', null, 'scored');
  o4 jsonb := u_probe.shot('00000000-0000-4000-8000-000000004814', null, 'scored');
  o6 jsonb := u_probe.shot('00000000-0000-4000-8000-000000004816', null, 'scored');
  o9 jsonb := u_probe.shot('00000000-0000-4000-8000-000000004821', null, 'scored');
  v record;
begin
  -- no output travelled with the receipt
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-3', uri, 'uri-key-1', g, t2, 1, 'op-3', '00000000-0000-4000-8000-000000004813', 'joint_verification_required'),
    null, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_missing' or v.financial_disposition <> 'reserved' then
    raise exception 'U3: a receipt without its output is held as evidence_missing (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- the output names another result
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-4', uri, 'uri-key-1', g, t2, 1, 'op-4', '00000000-0000-4000-8000-000000004814', 'joint_verification_required'),
    o3, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'reserved' then
    raise exception 'U3: an output that does not name the result is held as evidence_ambiguous (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- the output is an abstention yet the receipt claims a charge
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-4b', uri, 'uri-key-1', g, t2, 1, 'op-4b', '00000000-0000-4000-8000-00000000481d', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-00000000481d', null, 'low_confidence'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U3: a charge claimed for an unscored output is held (got %, %)', v.delivery, v.reason_code;
  end if;
  -- the edge could not verify the signature / binding / digest
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-5', uri, 'uri-key-1', g, t2, 1, 'op-5', '00000000-0000-4000-8000-000000004815', 'joint_verification_required'),
    o4, 'evidence_ambiguous');
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'reserved' then
    raise exception 'U3: an edge hold reason is recorded as the hold (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- the ticket does not belong to the grant the receipt claims
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-6', uri, 'uri-key-1', '00000000-0000-4000-8000-00000000f0f0', t2, 1, 'op-6', '00000000-0000-4000-8000-000000004816', 'joint_verification_required'),
    o6, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U3: a ticket outside the claimed grant is held (got %, %)', v.delivery, v.reason_code;
  end if;
  -- the receipt claims another generation of the same grant
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-6b', uri, 'uri-key-1', g, t2, 2, 'op-6b', '00000000-0000-4000-8000-00000000481e', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-00000000481e', null, 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U3: a ticket claimed under another generation is held (got %, %)', v.delivery, v.reason_code;
  end if;
  -- the receipt names another owner
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-7', ula, 'uri-key-1', g, t2, 1, 'op-7', '00000000-0000-4000-8000-00000000481f', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-00000000481f', null, 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'owner_mismatch' or v.financial_disposition <> 'reserved' then
    raise exception 'U3: a receipt naming another owner is held as owner_mismatch (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- an unknown ticket
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-8', uri, 'uri-key-1', g, '00000000-0000-4000-8000-00000000f0f1', 1, 'op-8', '00000000-0000-4000-8000-000000004820', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004820', null, 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U3: an unknown ticket is held (got %, %)', v.delivery, v.reason_code;
  end if;
  -- malformed receipts: nothing recorded
  select * into v from public.settle_offline_receipt('{"receiptId":"rcpt-9"}'::jsonb, repeat('d', 64), o9, null);
  if v.result <> 'offline.invalid_input' or v.delivery is not null then
    raise exception 'U3: a receipt missing its identities is refused (got %)', v.result;
  end if;
  select * into v from public.settle_offline_receipt(
    u_probe.receipt('rcpt-9', uri, 'uri-key-1', g, t2, 1, 'op-9', '00000000-0000-4000-8000-000000004821', 'joint_verification_required'),
    'not-a-digest', o9, null);
  if v.result <> 'offline.invalid_input' then
    raise exception 'U3: a receipt without a canonical digest is refused (got %)', v.result;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-9', uri, 'uri-key-1', g, t2, 1, 'op-9', '00000000-0000-4000-8000-000000004821', 'joint_verification_required'),
    o9, 'refund');
  if v.result <> 'offline.invalid_input' then
    raise exception 'U3: an unknown hold reason is refused (got %)', v.result;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-9', uri, 'uri-key-1', g, t2, 1, 'op-9', '00000000-0000-4000-8000-000000004821', 'not_a_disposition'),
    o9, null);
  if v.result <> 'offline.invalid_input' then
    raise exception 'U3: an unknown billing disposition is refused (got %)', v.result;
  end if;
  -- through every hold: no rating, no release, no consumption, the ticket is
  -- exactly where the allocation left it
  if exists (select 1 from public.shots where user_id = uri and id <> '00000000-0000-4000-8000-000000004811')
     or u_probe.events(uri) <> 'allocated:2,consumed:1'
     or public.lifetime_scored_count() <> 1
     or public.offline_hold_count() <> 1 then
    raise exception 'U3: holds never refund, release or consume (got %, %, %)',
      u_probe.events(uri), public.lifetime_scored_count(), public.offline_hold_count();
  end if;
  if u_probe.settlements(uri) like '%rcpt-9%' or u_probe.held_on(uri, t2) <> 7 or u_probe.held_on(uri, t1) <> 3
     or u_probe.settlements(uri) not like '%rcpt-8=reconciliation_required/evidence_ambiguous/reserved%'
     or u_probe.recorded(uri) <> 12 then
    raise exception 'U3: every hold is durable with its ticket still reserved, a refused receipt is not (got %)',
      u_probe.settlements(uri);
  end if;
  -- an abstention under the outstanding ticket is recorded and consumes nothing
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-10', uri, 'uri-key-1', g, t2, 1, 'op-10', '00000000-0000-4000-8000-000000004817', 'not_chargeable'),
    u_probe.shot('00000000-0000-4000-8000-000000004817', null, 'low_confidence'), null);
  if v.delivery <> 'settled' or v.status <> 'result_recorded' or v.financial_disposition <> 'reserved'
     or v.result_id <> '00000000-0000-4000-8000-000000004817' or u_probe.events(uri) <> 'allocated:2,consumed:1' then
    raise exception 'U3: a not_chargeable receipt records its result and leaves the ticket outstanding (got %, %, %, %)',
      v.delivery, v.status, v.financial_disposition, u_probe.events(uri);
  end if;
  -- a not_chargeable receipt beside an output that claims a scored rating is
  -- contradictory evidence (the mirror of rcpt-4b): held, durable, nothing moves
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-10b', uri, 'uri-key-1', g, t2, 1, 'op-10b', '00000000-0000-4000-8000-000000004822', 'not_chargeable'),
    u_probe.shot('00000000-0000-4000-8000-000000004822', null, 'scored'), null);
  if v.delivery <> 'held' or v.status <> 'reconciliation_required' or v.reason_code <> 'evidence_ambiguous'
     or v.financial_disposition <> 'reserved' or v.result_id is not null
     or u_probe.events(uri) <> 'allocated:2,consumed:1'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004822') then
    raise exception 'U3: a not_chargeable receipt with a scored output is held as evidence_ambiguous (got %, %, %, %, %)',
      v.delivery, v.status, v.reason_code, v.financial_disposition, u_probe.events(uri);
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-10b', uri, 'uri-key-1', g, t2, 1, 'op-10b', '00000000-0000-4000-8000-000000004822', 'not_chargeable'),
    u_probe.shot('00000000-0000-4000-8000-000000004822', null, 'scored'), null);
  if v.delivery <> 'replayed' or v.status <> 'reconciliation_required' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U3: the contradictory receipt replays its hold (got %, %, %)', v.delivery, v.status, v.reason_code;
  end if;
  -- the held ticket is still the device's to settle with verified evidence
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-11', uri, 'uri-key-1', g, t2, 1, 'op-11', '00000000-0000-4000-8000-000000004818', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004818', null, 'scored'), null);
  if v.delivery <> 'settled' or v.financial_disposition <> 'consumed'
     or u_probe.events(uri) <> 'allocated:2,consumed:2' or public.lifetime_scored_count() <> 2 then
    raise exception 'U3: the held ticket was never reclaimed and settles once with verified evidence (got %, %, %)',
      v.delivery, u_probe.events(uri), public.lifetime_scored_count();
  end if;
  -- an abstention claimed under the ticket the ledger just CONSUMED is
  -- contradictory evidence (the mirror of rcpt-2): a conflicting_receipt
  -- HOLD, never a result_recorded verdict asserting a reserved ticket
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-11b', uri, 'uri-key-1', g, t2, 1, 'op-11b', '00000000-0000-4000-8000-00000000482a', 'not_chargeable'),
    null, null);
  if v.delivery <> 'held' or v.status <> 'reconciliation_required' or v.reason_code <> 'conflicting_receipt'
     or v.financial_disposition <> 'reserved' or v.result_id is not null
     or u_probe.events(uri) <> 'allocated:2,consumed:2' then
    raise exception 'U3: a not_chargeable receipt under a consumed ticket is held as conflicting_receipt (got %, %, %, %, %)',
      v.delivery, v.status, v.reason_code, v.financial_disposition, u_probe.events(uri);
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-11b', uri, 'uri-key-1', g, t2, 1, 'op-11b', '00000000-0000-4000-8000-00000000482a', 'not_chargeable'),
    null, null);
  if v.delivery <> 'replayed' or v.status <> 'reconciliation_required' or v.reason_code <> 'conflicting_receipt' then
    raise exception 'U3: the conflicting abstention replays its hold (got %, %, %)', v.delivery, v.status, v.reason_code;
  end if;
  -- a null ticket under a FREE grant is not a Pro lease: the receipt is
  -- evidence about some other authorization and is HELD (nothing recorded,
  -- nothing written, nothing financial), whatever it claims beside it —
  -- a scored output, an abstention, no output, another result — and the
  -- hold replays. (20260910150000: the lease branch binds its lineage first,
  -- as the ticket branch does; a genuine lease is exercised in U3b.)
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12', uri, 'uri-key-1', g, null, null, 'op-12', '00000000-0000-4000-8000-000000004819', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004819', null, 'scored'), null);
  if v.delivery <> 'held' or v.status <> 'reconciliation_required' or v.reason_code <> 'evidence_ambiguous'
     or v.financial_disposition <> 'not_applicable' or v.result_id is not null
     or u_probe.events(uri) <> 'allocated:2,consumed:2'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004819') then
    raise exception 'U3: a no-ticket receipt under a free grant is held, nothing written (got %, %, %, %, %)',
      v.delivery, v.status, v.reason_code, v.financial_disposition, u_probe.events(uri);
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12', uri, 'uri-key-1', g, null, null, 'op-12', '00000000-0000-4000-8000-000000004819', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004819', null, 'scored'), null);
  if v.delivery <> 'replayed' or v.status <> 'reconciliation_required' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U3: the held no-ticket receipt replays its hold (got %, %, %)', v.delivery, v.status, v.reason_code;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12b', uri, 'uri-key-1', g, null, null, 'op-12b', '00000000-0000-4000-8000-000000004823', 'not_chargeable'),
    u_probe.shot('00000000-0000-4000-8000-000000004823', null, 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U3: a no-ticket not_chargeable receipt under a free grant is held (got %, %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition, v.result_id;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12c', uri, 'uri-key-1', g, null, null, 'op-12c', '00000000-0000-4000-8000-000000004824', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004824', null, 'abstained'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U3: a no-ticket chargeable receipt beside an abstention under a free grant is held (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12d', uri, 'uri-key-1', g, null, null, 'op-12d', '00000000-0000-4000-8000-000000004825', 'joint_verification_required'),
    null, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U3: a no-ticket chargeable receipt without its output under a free grant is held (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12e', uri, 'uri-key-1', g, null, null, 'op-12e', '00000000-0000-4000-8000-000000004826', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004827', null, 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U3: a no-ticket receipt whose output names another result under a free grant is held (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12f', uri, 'uri-key-1', g, null, null, 'op-12f', '00000000-0000-4000-8000-000000004828', 'not_chargeable'),
    null, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U3: a no-ticket not_chargeable receipt without an output under a free grant is held (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('rcpt-12g', uri, 'uri-key-1', g, null, null, 'op-12g', '00000000-0000-4000-8000-000000004829', 'not_chargeable'),
    u_probe.shot('00000000-0000-4000-8000-000000004829', null, 'abstained'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U3: a no-ticket not_chargeable receipt beside its abstention under a free grant is held (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  if u_probe.events(uri) <> 'allocated:2,consumed:2'
     or (select count(*) from public.shots where user_id = uri) <> 2 then
    raise exception 'U3: no-ticket receipts never touch the allocation ledger or write a rating (got %, %)',
      u_probe.events(uri), (select count(*) from public.shots where user_id = uri);
  end if;
end $$;

-- U3b (W04-04 round 7, 20260910150000): the Pro lease. As Ulf — a verified-
-- store subscriber whose device holds a lease (no tickets) — a chargeable
-- receipt beside its complete scored output is result_recorded /
-- not_applicable AND the rating is WRITTEN for him (shot + phases, no permit,
-- no ticket, no ledger event) before the verdict is answered; the identical
-- redelivery replays and writes nothing more; the same id with another body
-- is the conflict; a second receipt for the recorded result is a
-- conflicting_receipt HOLD; an abstention is recorded without a rating; a
-- chargeable receipt without its output, beside another result, beside an
-- abstention, or beside an output the shots table refuses is HELD with
-- nothing written; a rating whose session has not synced is pending (nothing
-- durable) and settles once it has; a new chargeable lease receipt under the
-- reversible freeze is pending with nothing written and settles once the
-- freeze lifts. The lease writer is api_private-only (no client role executes
-- it) and the shots gate admits a lease vouch only for THAT verified-store
-- grant of the caller, never stacked with a ticket, never a free grant,
-- never another owner's lease.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000483';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004803"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('ulf-key-1', 'production', true);
  if r.result <> 'accepted' then
    raise exception 'U3b precondition: registration is accepted (got %)', r.result;
  end if;
  select * into g from public.issue_offline_grant('ulf-key-1', 0);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 0
     or not exists (select 1 from public.offline_grants og where og.id = g.grant_id
                    and og.user_id = (select auth.uid()) and og.entitlement_source = 'verified_store') then
    raise exception 'U3b precondition: a verified-store lease without tickets is issued (got %, %)', g.result, g.ticket_ids;
  end if;
  insert into u_state values ('lease', g.grant_id);
end $$;
do $$
declare
  ulf uuid := (select auth.uid());
  uri uuid := '00000000-0000-4000-8000-000000000481';
  l uuid := (select id from u_state where key = 'lease');
  g uuid := (select id from u_state where key = 'grant');
  t2 uuid := (select id from u_state where key = 't2');
  r1 jsonb := u_probe.receipt('lrcpt-1', ulf, 'ulf-key-1', l, null, null, 'lop-1',
    '00000000-0000-4000-8000-000000004831', 'joint_verification_required');
  o1 jsonb := u_probe.shot('00000000-0000-4000-8000-000000004831', null, 'scored')
    || jsonb_build_object('phases', jsonb_build_array(
         jsonb_build_object('key', 'backswing', 'startMs', 0, 'representativeMs', 100, 'endMs', 400, 'confidence', 0.8),
         jsonb_build_object('key', 'contact', 'startMs', 400, 'representativeMs', 500, 'endMs', 600, 'confidence', 0.9)));
  r1_forged jsonb := u_probe.receipt('lrcpt-1', ulf, 'ulf-key-1', l, null, null, 'lop-1',
    '00000000-0000-4000-8000-000000004832', 'joint_verification_required');
  r_pending jsonb := u_probe.receipt('lrcpt-9', ulf, 'ulf-key-1', l, null, null, 'lop-9',
    '00000000-0000-4000-8000-000000004839', 'joint_verification_required');
  o_pending jsonb := u_probe.shot('00000000-0000-4000-8000-000000004839', null, 'scored')
    || jsonb_build_object('sessionId', '00000000-0000-4000-8000-000000004890');
  r_frozen jsonb := u_probe.receipt('lrcpt-10', ulf, 'ulf-key-1', l, null, null, 'lop-10',
    '00000000-0000-4000-8000-00000000483a', 'joint_verification_required');
  o_frozen jsonb := u_probe.shot('00000000-0000-4000-8000-00000000483a', null, 'scored');
  v record; sh record;
begin
  -- the chargeable lease receipt: recorded, and the rating is written for Ulf
  select * into v from u_probe.settle(r1, o1, null);
  if v.result <> 'accepted' or v.delivery <> 'settled' or v.status <> 'result_recorded' or v.reason_code is not null
     or v.financial_disposition <> 'not_applicable' or v.result_id <> '00000000-0000-4000-8000-000000004831' then
    raise exception 'U3b: a lease receipt beside its scored output is result_recorded / not_applicable (got %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  select s.user_id, s.result_kind, s.analysis_permit_id, s.offline_ticket_id, s.start_ms, s.contact_ms, s.end_ms,
         s.overall_score, s.source, s.app_version,
         (select count(*) from public.shot_phases p where p.shot_id = s.id) as phases
    into sh
  from public.shots s where s.id = '00000000-0000-4000-8000-000000004831';
  if not found or sh.user_id <> ulf or sh.result_kind <> 'scored' or sh.analysis_permit_id is not null
     or sh.offline_ticket_id is not null or sh.start_ms <> 0 or sh.contact_ms <> 500 or sh.end_ms <> 1000
     or sh.overall_score <> 7.1 or sh.source <> 'real' or sh.app_version <> '1.0.0' or sh.phases <> 2 then
    raise exception 'U3b: the lease rating is written for the owner with no permit and no ticket (got %)', sh;
  end if;
  if u_probe.events(ulf) <> '' or u_probe.recorded(ulf) <> 1 then
    raise exception 'U3b: a lease allocates nothing and consumes nothing (got %, %)', u_probe.events(ulf), u_probe.recorded(ulf);
  end if;
  -- the identical redelivery replays; nothing more is written
  select * into v from u_probe.settle(r1, o1, null);
  if v.delivery <> 'replayed' or v.status <> 'result_recorded' or v.financial_disposition <> 'not_applicable'
     or v.result_id <> '00000000-0000-4000-8000-000000004831'
     or (select count(*) from public.shots where user_id = ulf) <> 1 then
    raise exception 'U3b: the redelivered lease receipt replays and writes nothing (got %, %, %)',
      v.delivery, v.status, (select count(*) from public.shots where user_id = ulf);
  end if;
  -- the same id with another body
  select * into v from u_probe.settle(r1_forged, u_probe.shot('00000000-0000-4000-8000-000000004832', null, 'scored'), null);
  if v.result <> 'offline.receipt_conflict' or v.delivery is not null
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004832') then
    raise exception 'U3b: a lease receipt id reused for another body is the conflict (got %, %)', v.result, v.delivery;
  end if;
  -- a second receipt for the recorded result
  select * into v from u_probe.settle(
    u_probe.receipt('lrcpt-2', ulf, 'ulf-key-1', l, null, null, 'lop-2', '00000000-0000-4000-8000-000000004831', 'joint_verification_required'),
    o1, null);
  if v.delivery <> 'held' or v.reason_code <> 'conflicting_receipt' or v.financial_disposition <> 'not_applicable' then
    raise exception 'U3b: a second lease receipt for a recorded result is held as conflicting_receipt (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- an abstention: recorded, no rating written
  select * into v from u_probe.settle(
    u_probe.receipt('lrcpt-3', ulf, 'ulf-key-1', l, null, null, 'lop-3', '00000000-0000-4000-8000-000000004833', 'not_chargeable'),
    u_probe.shot('00000000-0000-4000-8000-000000004833', null, 'low_confidence'), null);
  if v.delivery <> 'settled' or v.status <> 'result_recorded' or v.financial_disposition <> 'not_applicable'
     or v.result_id <> '00000000-0000-4000-8000-000000004833'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004833') then
    raise exception 'U3b: a lease abstention is recorded without a rating (got %, %, %)', v.delivery, v.status, v.financial_disposition;
  end if;
  -- chargeable without its output; beside another result; beside an
  -- abstention; a not_chargeable claim beside a scored output
  select * into v from u_probe.settle(
    u_probe.receipt('lrcpt-4', ulf, 'ulf-key-1', l, null, null, 'lop-4', '00000000-0000-4000-8000-000000004834', 'joint_verification_required'),
    null, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_missing' or v.financial_disposition <> 'not_applicable' then
    raise exception 'U3b: a chargeable lease receipt without its output is held as evidence_missing (got %, %)', v.delivery, v.reason_code;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('lrcpt-5', ulf, 'ulf-key-1', l, null, null, 'lop-5', '00000000-0000-4000-8000-000000004835', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004836', null, 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous'
     or exists (select 1 from public.shots where id in ('00000000-0000-4000-8000-000000004835', '00000000-0000-4000-8000-000000004836')) then
    raise exception 'U3b: a lease output naming another result is held, nothing written (got %, %)', v.delivery, v.reason_code;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('lrcpt-6', ulf, 'ulf-key-1', l, null, null, 'lop-6', '00000000-0000-4000-8000-000000004837', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-000000004837', null, 'low_confidence'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U3b: a chargeable lease receipt beside an abstention is held (got %, %)', v.delivery, v.reason_code;
  end if;
  select * into v from u_probe.settle(
    u_probe.receipt('lrcpt-7', ulf, 'ulf-key-1', l, null, null, 'lop-7', '00000000-0000-4000-8000-000000004838', 'not_chargeable'),
    u_probe.shot('00000000-0000-4000-8000-000000004838', null, 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004838') then
    raise exception 'U3b: a not_chargeable lease claim beside a scored output is held, nothing written (got %, %)', v.delivery, v.reason_code;
  end if;
  -- an output the shots table refuses (camera view outside the contract):
  -- held, nothing written
  select * into v from u_probe.settle(
    u_probe.receipt('lrcpt-8', ulf, 'ulf-key-1', l, null, null, 'lop-8', '00000000-0000-4000-8000-00000000483b', 'joint_verification_required'),
    u_probe.shot('00000000-0000-4000-8000-00000000483b', null, 'scored') || '{"cameraView":"overhead-drone"}'::jsonb, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-00000000483b') then
    raise exception 'U3b: an output the shots table refuses is held, nothing written (got %, %)', v.delivery, v.reason_code;
  end if;
  -- the session has not synced: pending, nothing durable; settles once it has
  select * into v from u_probe.settle(r_pending, o_pending, null);
  if v.result <> 'accepted' or v.delivery <> 'pending' or v.status <> 'pending' or v.financial_disposition <> 'not_applicable'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004839') then
    raise exception 'U3b: a lease rating whose session has not synced is pending (got %, %, %)', v.result, v.delivery, v.status;
  end if;
  insert into public.sessions (id, user_id, started_at) values ('00000000-0000-4000-8000-000000004890', ulf, now());
  select * into v from u_probe.settle(r_pending, o_pending, null);
  if v.delivery <> 'settled' or v.status <> 'result_recorded'
     or (select session_id from public.shots where id = '00000000-0000-4000-8000-000000004839') <> '00000000-0000-4000-8000-000000004890' then
    raise exception 'U3b: the pending lease rating settles once its session exists (got %, %)', v.delivery, v.status;
  end if;
  -- the reversible freeze: a new chargeable lease receipt is pending with
  -- nothing written; a settled one replays; it settles once the freeze lifts
  select * into v from public.settle_offline_receipt(r_frozen, u_probe.digest(r_frozen), o_frozen, null, true);
  if v.result <> 'accepted' or v.delivery <> 'pending' or v.status <> 'pending' or v.financial_disposition <> 'not_applicable'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-00000000483a') then
    raise exception 'U3b: a new lease receipt under the freeze is pending, nothing written (got %, %, %)', v.result, v.delivery, v.status;
  end if;
  select * into v from public.settle_offline_receipt(r1, u_probe.digest(r1), o1, null, true);
  if v.delivery <> 'replayed' or v.status <> 'result_recorded' then
    raise exception 'U3b: a settled lease receipt replays under the freeze (got %, %)', v.delivery, v.status;
  end if;
  select * into v from u_probe.settle(r_frozen, o_frozen, null);
  if v.delivery <> 'settled' or v.status <> 'result_recorded'
     or not exists (select 1 from public.shots where id = '00000000-0000-4000-8000-00000000483a' and user_id = ulf) then
    raise exception 'U3b: the frozen lease receipt settles once the freeze lifts (got %, %)', v.delivery, v.status;
  end if;
  if u_probe.recorded(ulf) <> 10 or u_probe.events(ulf) <> ''
     or (select count(*) from public.shots where user_id = ulf) <> 3 then
    raise exception 'U3b: ten durable verdicts, three ratings, no ledger event (got %, %, %)',
      u_probe.recorded(ulf), u_probe.events(ulf), (select count(*) from public.shots where user_id = ulf);
  end if;

  -- the lease writer is closed to every client role
  if has_function_privilege('authenticated', 'api_private.record_offline_lease_shot(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'api_private.record_offline_lease_shot(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'api_private.record_offline_lease_shot(uuid, jsonb)', 'EXECUTE') then
    raise exception 'U3b: no client role executes the lease writer';
  end if;
  begin
    perform api_private.record_offline_lease_shot(l, u_probe.shot('00000000-0000-4000-8000-00000000483c', null, 'scored'));
    raise exception 'U3b: the owner must not call the lease writer directly';
  exception when insufficient_privilege then null;
  end;
  -- the shots gate admits a lease vouch only for THIS caller's verified-store
  -- grant: a free grant, another owner's lease and a stacked ticket vouch are
  -- refused
  begin
    perform set_config('pickle.offline_lease_grant_id', g::text, true);
    insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
    values ('00000000-0000-4000-8000-00000000483d', ulf, 'drive', 'side', now(), 0, 500, 1000, 7.1, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real');
    raise exception 'U3b: a free grant is not a lease vouch';
  exception when check_violation then null;
  end;
  begin
    perform set_config('pickle.offline_lease_grant_id', l::text, true);
    perform set_config('pickle.offline_ticket_id', t2::text, true);
    insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
    values ('00000000-0000-4000-8000-00000000483e', ulf, 'drive', 'side', now(), 0, 500, 1000, 7.1, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real');
    raise exception 'U3b: a lease vouch stacked on a ticket vouch is refused';
  exception when check_violation then null;
  end;
  perform set_config('pickle.offline_lease_grant_id', '', true);
  perform set_config('pickle.offline_ticket_id', '', true);
  if (select count(*) from public.shots where user_id = ulf) <> 3 then
    raise exception 'U3b: the refused vouches wrote nothing (got %)', (select count(*) from public.shots where user_id = ulf);
  end if;
end $$;
-- as Uri again: Ulf's lease is not Uri's vouch
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000481';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004801"}';
do $$
declare uri uuid := (select auth.uid()); l uuid := (select id from u_state where key = 'lease');
begin
  begin
    perform set_config('pickle.offline_lease_grant_id', l::text, true);
    insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
    values ('00000000-0000-4000-8000-00000000483f', uri, 'drive', 'side', now(), 0, 500, 1000, 7.1, 0.9, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real');
    raise exception 'U3b: another owner''s lease is not a vouch';
  exception when check_violation then null;
  end;
  perform set_config('pickle.offline_lease_grant_id', '', true);
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-00000000483f') then
    raise exception 'U3b: the stolen lease vouch wrote nothing';
  end if;
end $$;

-- U4: the settlement table is closed to the owner role — no read, no write —
-- and the RPC is bound to a live session of the caller.
do $$
declare uri uuid := (select auth.uid()); claims text := current_setting('request.jwt.claims');
        g uuid := (select id from u_state where key = 'grant'); t2 uuid := (select id from u_state where key = 't2');
begin
  begin
    perform 1 from public.offline_receipt_settlements;
    raise exception 'U4: the owner must not read settlements directly';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.offline_receipt_settlements (
      user_id, receipt_id, receipt_sha256, owner_id, installation_key_id, grant_id, grant_jws_sha256,
      operation_id, result_id, full_output_sha256, billing_disposition, lifecycle_sequence,
      status, financial_disposition, receipt
    ) values (
      uri, 'forged', repeat('e', 64), uri, 'uri-key-1', g, repeat('a', 64),
      'op-forged', '00000000-0000-4000-8000-00000000481a', repeat('c', 64), 'joint_verification_required', 1,
      'result_recorded', 'not_applicable', '{}'::jsonb);
    raise exception 'U4: the owner must not forge a settlement';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_receipt_settlements set status = 'result_recorded', reason_code = null where user_id = uri;
    raise exception 'U4: the owner must not rewrite a settlement';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.offline_receipt_settlements where user_id = uri;
    raise exception 'U4: the owner must not erase a settlement';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-000000004802"}', true);
  begin
    perform u_probe.settle(
      u_probe.receipt('rcpt-13', uri, 'uri-key-1', g, t2, 1, 'op-13', '00000000-0000-4000-8000-00000000481b', 'joint_verification_required'),
      u_probe.shot('00000000-0000-4000-8000-00000000481b', null, 'scored'), null);
    raise exception 'U4: settlement binds to a live session of the caller';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform u_probe.settle(
      u_probe.receipt('rcpt-13', uri, 'uri-key-1', g, t2, 1, 'op-13', '00000000-0000-4000-8000-00000000481b', 'joint_verification_required'),
      u_probe.shot('00000000-0000-4000-8000-00000000481b', null, 'scored'), null);
    raise exception 'U4: a missing session fails closed';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claims', claims, true);
  if u_probe.recorded(uri) <> 23 or u_probe.settlements(uri) like '%forged%' or u_probe.settlements(uri) like '%rcpt-13%' then
    raise exception 'U4: refused calls persist nothing (got %)', u_probe.settlements(uri);
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';

-- U5: anon and service_role: no read, no execute; superuser: append-only.
set local role anon;
do $$
begin
  begin
    perform 1 from public.offline_receipt_settlements;
    raise exception 'U5: anon must not read settlements';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.settle_offline_receipt('{}'::jsonb, repeat('a', 64), null, null);
    raise exception 'U5: anon must not execute the settlement RPC';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role service_role;
do $$
begin
  begin
    perform 1 from public.offline_receipt_settlements;
    raise exception 'U5: service_role must not read settlements';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.settle_offline_receipt('{}'::jsonb, repeat('a', 64), null, null);
    raise exception 'U5: service_role must not execute the settlement RPC (the route settles as the caller)';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
declare uri uuid := '00000000-0000-4000-8000-000000000481';
begin
  begin
    update public.offline_receipt_settlements set status = 'result_recorded', reason_code = null, financial_disposition = 'consumed'
    where user_id = uri and receipt_id = 'rcpt-3';
    raise exception 'U5: a held settlement is append-only for every role';
  exception when check_violation then null;
  end;
  begin
    delete from public.offline_receipt_settlements where user_id = uri and receipt_id = 'rcpt-1';
    raise exception 'U5: a settlement is not removable by any role';
  exception when check_violation then null;
  end;
  begin
    insert into public.offline_receipt_settlements (
      user_id, receipt_id, receipt_sha256, owner_id, installation_key_id, grant_id, grant_jws_sha256,
      operation_id, result_id, full_output_sha256, billing_disposition, lifecycle_sequence,
      status, reason_code, financial_disposition, receipt
    ) values (
      uri, 'refund', repeat('e', 64), uri, 'uri-key-1', gen_random_uuid(), repeat('a', 64),
      'op-refund', '00000000-0000-4000-8000-00000000481c', repeat('c', 64), 'joint_verification_required', 1,
      'reconciliation_required', 'evidence_ambiguous', 'consumed', '{}'::jsonb);
    raise exception 'U5: a hold can never be recorded as consumed';
  exception when check_violation then null;
  end;
  if (select count(*) from public.offline_receipt_settlements where user_id = uri) <> 23
     or (select status || '/' || financial_disposition from public.offline_receipt_settlements
         where user_id = uri and receipt_id = 'rcpt-3') <> 'reconciliation_required/reserved' then
    raise exception 'U5: the refused writes leave every settlement intact';
  end if;
  -- the account cascade is the one remover
  delete from auth.users where id = uri;
  if exists (select 1 from public.offline_receipt_settlements where user_id = uri) then
    raise exception 'U5: account deletion must remove the settlements';
  end if;
end $$;
rollback;

-- ============================================================================
-- U6–U9. (W04-04 round 2, 20260909220000) a ticket is bound to its allocation
-- LINEAGE, not the literal allocated row: issue_offline_grant() re-issues the
-- installation's outstanding tickets under the next generation (new grant id,
-- no new allocated row), so a receipt bound to the refreshed grant settles the
-- generation-1 ticket exactly once, the stale receipt under the superseded
-- grant then holds (never a second consumption), an out-of-order receipt for
-- the other ticket under the superseded grant still settles, and foreign
-- installations, foreign grants and generations the lineage never had stay
-- HELD; a receipt whose session has not synced is answered pending with
-- nothing recorded and settles on the identical redelivery once the session
-- exists; lifecycleSequence/generation are positive safe integers (2^31 gets a
-- durable verdict, 2^53 is refused); read_analysis_release_policy_lineage()
-- answers an installed policy by digest (superseded or withdrawn included) to
-- the service role alone and the nothing-installed row for an unknown digest.
-- ============================================================================
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000491', 'ugo@example.com',
   '{"full_name":"Ugo"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000492', 'uma@example.com',
   '{"full_name":"Uma"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000493', 'uli@example.com',
   '{"full_name":"Uli"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-ugo', '00000000-0000-4000-8000-000000000491',
   '{"sub":"google-sub-ugo","email":"ugo@example.com"}'),
  ('apple', 'apple-sub-uma', '00000000-0000-4000-8000-000000000492',
   '{"sub":"apple-sub-uma","email":"uma@example.com"}'),
  ('google', 'google-sub-uli', '00000000-0000-4000-8000-000000000493',
   '{"sub":"google-sub-uli","email":"uli@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000004901', '00000000-0000-4000-8000-000000000491'),
  ('00000000-0000-4000-8000-000000004902', '00000000-0000-4000-8000-000000000492'),
  ('00000000-0000-4000-8000-000000004903', '00000000-0000-4000-8000-000000000493');

create temporary table u2_state (key text primary key, id uuid);
grant select, insert on u2_state to authenticated;
create schema u2_probe;
create function u2_probe.shot(p_id uuid, p_kind text, p_session uuid default null) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id,
    'sessionId', p_session,
    'analysisPermitId', null,
    'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-09T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
create function u2_probe.receipt(
  p_receipt_id text, p_owner uuid, p_key text, p_grant uuid, p_ticket uuid, p_generation bigint,
  p_operation text, p_result uuid, p_billing text, p_sequence bigint default 1
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', 'offline-result-receipt-v1',
    'receiptId', p_receipt_id,
    'ownerId', p_owner,
    'installationKeyId', p_key,
    'grantId', p_grant,
    'grantJwsSha256', repeat('a', 64),
    'lifecycleSequence', p_sequence,
    'nativeTime', jsonb_build_object('monotonicMs', 1000, 'wallClockIso', '2026-09-09T10:00:00Z'),
    'ticket', case when p_ticket is null then 'null'::jsonb else jsonb_build_object(
      'allocationId', p_grant, 'generation', p_generation, 'ticketId', p_ticket) end,
    'operationId', p_operation,
    'resultId', p_result,
    'fullOutputSha256', repeat('c', 64),
    'billingDisposition', p_billing)
$$;
create function u2_probe.settle(p_receipt jsonb, p_output jsonb, p_hold text)
returns table (result text, delivery text, status text, reason_code text, financial_disposition text, result_id text)
language sql set search_path = '' as $$
  select * from public.settle_offline_receipt(
    p_receipt, encode(pg_catalog.sha256(convert_to(p_receipt::text, 'UTF8')), 'hex'), p_output, p_hold)
$$;
-- the same call with the reversible deny-new freeze the edge passes through
create function u2_probe.settle_frozen(p_receipt jsonb, p_output jsonb, p_hold text)
returns table (result text, delivery text, status text, reason_code text, financial_disposition text, result_id text)
language sql set search_path = '' as $$
  select * from public.settle_offline_receipt(
    p_receipt, encode(pg_catalog.sha256(convert_to(p_receipt::text, 'UTF8')), 'hex'), p_output, p_hold, true)
$$;
create function u2_probe.events(p_uid uuid) returns text
language sql security definer set search_path = '' as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
create function u2_probe.recorded(p_uid uuid) returns integer
language sql security definer set search_path = '' as $$
  select count(*)::int from public.offline_receipt_settlements s where s.user_id = p_uid;
$$;
create function u2_probe.stored_sequence(p_uid uuid, p_receipt text) returns bigint
language sql security definer set search_path = '' as $$
  select s.lifecycle_sequence from public.offline_receipt_settlements s
  where s.user_id = p_uid and s.receipt_id = p_receipt;
$$;
create function u2_probe.shots_on(p_uid uuid, p_ticket uuid) returns integer
language sql security definer set search_path = '' as $$
  select count(*)::int from public.shots s where s.user_id = p_uid and s.offline_ticket_id = p_ticket;
$$;
-- the app's session outbox landing after the receipt
create function u2_probe.sync_session(p_uid uuid, p_session uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.sessions (id, user_id, started_at) values (p_session, p_uid, now());
$$;
grant usage on schema u2_probe to authenticated;
grant execute on all functions in schema u2_probe to authenticated;

do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;

-- Uma: her own attested device with its own free grant — the foreign grant
-- and the foreign owner of the lineage checks.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000492';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004902"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('uma-key-1', 'production', true);
  select * into g from public.issue_offline_grant('uma-key-1', 2);
  if r.result <> 'accepted' or g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'U6 precondition: Uma holds a free grant of two tickets (got %, %)', r.result, g.result;
  end if;
  insert into u2_state values ('uma-grant', g.grant_id), ('uma-t1', g.ticket_ids[1]), ('uma-t2', g.ticket_ids[2]);
end $$;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000491';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004901"}';

-- U6: generation 1 allocates two tickets; the lease refresh re-issues the
-- SAME tickets under generation 2 (a new grant id) and writes no new
-- allocated row.
do $$
declare r record; g1 record; g2 record;
begin
  select * into r from public.register_offline_device('ugo-key-1', 'production', true);
  if r.result <> 'accepted' then
    raise exception 'U6 precondition: registration is accepted (got %)', r.result;
  end if;
  select * into g1 from public.issue_offline_grant('ugo-key-1', 2);
  if g1.result <> 'accepted' or g1.generation <> 1 or coalesce(array_length(g1.ticket_ids, 1), 0) <> 2 then
    raise exception 'U6 precondition: generation 1 allocates two tickets (got %, %, %)', g1.result, g1.generation, g1.ticket_ids;
  end if;
  select * into g2 from public.issue_offline_grant('ugo-key-1', 2);
  if g2.result <> 'accepted' or g2.generation <> 2 or g2.grant_id = g1.grant_id
     or g2.ticket_ids <> g1.ticket_ids then
    raise exception 'U6 precondition: the refresh re-issues the same tickets under generation 2 (got %, %, %, %)',
      g2.result, g2.generation, g2.grant_id, g2.ticket_ids;
  end if;
  if u2_probe.events((select auth.uid())) <> 'allocated:2' then
    raise exception 'U6 precondition: the refresh writes no new allocated row (got %)', u2_probe.events((select auth.uid()));
  end if;
  insert into u2_state values
    ('g1', g1.grant_id), ('g2', g2.grant_id), ('t1', g1.ticket_ids[1]), ('t2', g1.ticket_ids[2]);
end $$;

-- U7: lineage. Foreign evidence is HELD first (it must not poison the
-- honest receipt that follows); the receipt bound to the refreshed grant
-- settles the generation-1 ticket exactly once; the stale receipt for the
-- same ticket under the superseded grant holds; the out-of-order receipt for
-- the other ticket under the superseded grant still settles.
do $$
declare
  ugo uuid := (select auth.uid());
  uma uuid := '00000000-0000-4000-8000-000000000492';
  g1 uuid := (select id from u2_state where key = 'g1');
  g2 uuid := (select id from u2_state where key = 'g2');
  t1 uuid := (select id from u2_state where key = 't1');
  t2 uuid := (select id from u2_state where key = 't2');
  uma_grant uuid := (select id from u2_state where key = 'uma-grant');
  uma_t1 uuid := (select id from u2_state where key = 'uma-t1');
  r_g2 jsonb := u2_probe.receipt('r2-1', ugo, 'ugo-key-1', g2, t1, 2, 'op2-1',
    '00000000-0000-4000-8000-000000004911', 'joint_verification_required');
  o1 jsonb := u2_probe.shot('00000000-0000-4000-8000-000000004911', 'scored');
  v record;
begin
  -- the refreshed grant claimed under the generation it never had
  select * into v from u2_probe.settle(
    u2_probe.receipt('r2-gen', ugo, 'ugo-key-1', g2, t1, 1, 'op2-gen', '00000000-0000-4000-8000-000000004912', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004912', 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'reserved' then
    raise exception 'U7: a generation the grant never had is held (got %, %, %)', v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- the superseded grant claimed under the refreshed generation
  select * into v from u2_probe.settle(
    u2_probe.receipt('r2-gen1', ugo, 'ugo-key-1', g1, t1, 2, 'op2-gen1', '00000000-0000-4000-8000-000000004913', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004913', 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U7: a grant/generation pair the lineage never issued is held (got %, %)', v.delivery, v.reason_code;
  end if;
  -- another installation of the same account naming this installation's ticket
  select * into v from u2_probe.settle(
    u2_probe.receipt('r2-install', ugo, 'ugo-key-2', g2, t1, 2, 'op2-install', '00000000-0000-4000-8000-000000004914', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004914', 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U7: a foreign installation is held (got %, %)', v.delivery, v.reason_code;
  end if;
  -- another account's grant (a real grant of a real device) naming my ticket
  select * into v from u2_probe.settle(
    u2_probe.receipt('r2-foreign', ugo, 'ugo-key-1', uma_grant, t1, 1, 'op2-foreign', '00000000-0000-4000-8000-000000004915', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004915', 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U7: another account''s grant is held (got %, %)', v.delivery, v.reason_code;
  end if;
  -- my refreshed grant naming another account's ticket
  select * into v from u2_probe.settle(
    u2_probe.receipt('r2-theirs', ugo, 'ugo-key-1', g2, uma_t1, 2, 'op2-theirs', '00000000-0000-4000-8000-000000004916', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004916', 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U7: another account''s ticket is held (got %, %)', v.delivery, v.reason_code;
  end if;
  if u2_probe.events(ugo) <> 'allocated:2' or u2_probe.events(uma) <> 'allocated:2'
     or exists (select 1 from public.shots where user_id in (ugo, uma))
     or public.lifetime_scored_count() <> 0 or u2_probe.recorded(ugo) <> 5 then
    raise exception 'U7: foreign evidence is held durably and moves nothing (got %, %, %)',
      u2_probe.events(ugo), u2_probe.events(uma), u2_probe.recorded(ugo);
  end if;

  -- the honest receipt bound to the refreshed grant settles the g1 ticket once
  select * into v from u2_probe.settle(r_g2, o1, null);
  if v.result <> 'accepted' or v.delivery <> 'settled' or v.status <> 'result_recorded'
     or v.financial_disposition <> 'consumed' or v.result_id <> '00000000-0000-4000-8000-000000004911' then
    raise exception 'U7: a receipt bound to the refreshed grant settles the re-issued ticket (got %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  if u2_probe.shots_on(ugo, t1) <> 1 or u2_probe.events(ugo) <> 'allocated:2,consumed:1'
     or public.lifetime_scored_count() <> 1 then
    raise exception 'U7: one rating, one consumed event (got %, %, %)',
      u2_probe.shots_on(ugo, t1), u2_probe.events(ugo), public.lifetime_scored_count();
  end if;
  select * into v from u2_probe.settle(r_g2, o1, null);
  if v.delivery <> 'replayed' or v.financial_disposition <> 'consumed' then
    raise exception 'U7: the identical redelivery replays (got %, %)', v.delivery, v.financial_disposition;
  end if;
  -- the stale receipt for the same ticket under the superseded grant
  select * into v from u2_probe.settle(
    u2_probe.receipt('r2-stale', ugo, 'ugo-key-1', g1, t1, 1, 'op2-stale', '00000000-0000-4000-8000-000000004917', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004917', 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'conflicting_receipt' or v.financial_disposition <> 'reserved' then
    raise exception 'U7: the same ticket under the superseded generation holds, never double-consumes (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- out of order: the other ticket, executed under the superseded grant
  -- before the refresh, still settles through its own lineage
  select * into v from u2_probe.settle(
    u2_probe.receipt('r2-2', ugo, 'ugo-key-1', g1, t2, 1, 'op2-2', '00000000-0000-4000-8000-000000004918', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004918', 'scored'), null);
  if v.delivery <> 'settled' or v.financial_disposition <> 'consumed' then
    raise exception 'U7: an out-of-order receipt under the superseded grant settles its outstanding ticket (got %, %)',
      v.delivery, v.financial_disposition;
  end if;
  if u2_probe.shots_on(ugo, t1) <> 1 or u2_probe.shots_on(ugo, t2) <> 1
     or u2_probe.events(ugo) <> 'allocated:2,consumed:2' or public.lifetime_scored_count() <> 2
     or public.offline_hold_count() <> 0 or u2_probe.recorded(ugo) <> 8 then
    raise exception 'U7: exactly the two lifetime ratings, nothing held, every receipt durable (got %, %, %, %)',
      u2_probe.events(ugo), public.lifetime_scored_count(), public.offline_hold_count(), u2_probe.recorded(ugo);
  end if;
end $$;
reset role;

-- U8: as Uma — a receipt whose session has not synced is pending with nothing
-- recorded, redelivery stays pending, and the identical receipt settles once
-- the session exists; lifecycleSequence 2^31 gets a durable verdict,
-- generation 2^31 is a durable hold, 2^53 is refused.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000492';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004902"}';
do $$
declare
  uma uuid := (select auth.uid());
  g uuid := (select id from u2_state where key = 'uma-grant');
  t1 uuid := (select id from u2_state where key = 'uma-t1');
  t2 uuid := (select id from u2_state where key = 'uma-t2');
  sess uuid := '00000000-0000-4000-8000-000000004930';
  r_pending jsonb := u2_probe.receipt('r3-1', uma, 'uma-key-1', g, t1, 1, 'op3-1',
    '00000000-0000-4000-8000-000000004921', 'joint_verification_required');
  o_pending jsonb := u2_probe.shot('00000000-0000-4000-8000-000000004921', 'scored', '00000000-0000-4000-8000-000000004930');
  r_wide jsonb := u2_probe.receipt('r3-2', uma, 'uma-key-1', g, t2, 1, 'op3-2',
    '00000000-0000-4000-8000-000000004922', 'not_chargeable', 2147483648);
  v record;
begin
  select * into v from u2_probe.settle(r_pending, o_pending, null);
  if v.result <> 'accepted' or v.delivery <> 'pending' or v.status <> 'pending' or v.reason_code is not null
     or v.financial_disposition <> 'reserved' or v.result_id is not null then
    raise exception 'U8: a receipt whose session has not synced is pending (got %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u2_probe.settle(r_pending, o_pending, null);
  if v.delivery <> 'pending' then
    raise exception 'U8: redelivery before the session syncs stays pending (got %)', v.delivery;
  end if;
  if u2_probe.recorded(uma) <> 0 or u2_probe.events(uma) <> 'allocated:2' or u2_probe.shots_on(uma, t1) <> 0 then
    raise exception 'U8: pending records nothing and moves nothing (got %, %, %)',
      u2_probe.recorded(uma), u2_probe.events(uma), u2_probe.shots_on(uma, t1);
  end if;
  perform u2_probe.sync_session(uma, sess);
  select * into v from u2_probe.settle(r_pending, o_pending, null);
  if v.delivery <> 'settled' or v.status <> 'result_recorded' or v.financial_disposition <> 'consumed'
     or v.result_id <> '00000000-0000-4000-8000-000000004921' then
    raise exception 'U8: the identical receipt settles once the session exists (got %, %, %)',
      v.delivery, v.status, v.financial_disposition;
  end if;
  select * into v from u2_probe.settle(r_pending, o_pending, null);
  if v.delivery <> 'replayed' or u2_probe.shots_on(uma, t1) <> 1 or u2_probe.events(uma) <> 'allocated:2,consumed:1' then
    raise exception 'U8: settled once, then replayed (got %, %, %)', v.delivery, u2_probe.shots_on(uma, t1), u2_probe.events(uma);
  end if;

  -- a generation beyond int4 the lineage never issued: a durable hold
  select * into v from u2_probe.settle(
    u2_probe.receipt('r3-gen', uma, 'uma-key-1', g, t2, 2147483648, 'op3-gen', '00000000-0000-4000-8000-000000004923', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004923', 'scored'), null);
  if v.result <> 'accepted' or v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U8: generation 2^31 is a durable hold, not invalid_input (got %, %, %)', v.result, v.delivery, v.reason_code;
  end if;
  -- lifecycleSequence beyond int4: a durable verdict, stored exactly
  select * into v from u2_probe.settle(r_wide, u2_probe.shot('00000000-0000-4000-8000-000000004922', 'low_confidence'), null);
  if v.result <> 'accepted' or v.delivery <> 'settled' or v.status <> 'result_recorded' or v.financial_disposition <> 'reserved' then
    raise exception 'U8: lifecycleSequence 2^31 receives a durable verdict (got %, %, %, %)', v.result, v.delivery, v.status, v.financial_disposition;
  end if;
  if u2_probe.stored_sequence(uma, 'r3-2') <> 2147483648 then
    raise exception 'U8: the sequence is stored exactly (got %)', u2_probe.stored_sequence(uma, 'r3-2');
  end if;
  -- beyond the shared contract's safe integer: refused, nothing recorded
  select * into v from u2_probe.settle(
    u2_probe.receipt('r3-huge', uma, 'uma-key-1', g, t2, 1, 'op3-huge', '00000000-0000-4000-8000-000000004924', 'joint_verification_required', 9007199254740992),
    u2_probe.shot('00000000-0000-4000-8000-000000004924', 'scored'), null);
  if v.result <> 'offline.invalid_input' or v.delivery is not null then
    raise exception 'U8: lifecycleSequence 2^53 is refused (got %, %)', v.result, v.delivery;
  end if;
  if u2_probe.recorded(uma) <> 3 or u2_probe.events(uma) <> 'allocated:2,consumed:1' or public.lifetime_scored_count() <> 1 then
    raise exception 'U8: three durable verdicts, one rating, the refused receipt persisted nothing (got %, %, %)',
      u2_probe.recorded(uma), u2_probe.events(uma), public.lifetime_scored_count();
  end if;
  -- the device returns t2; an abstention that then arrives claiming the
  -- RELEASED ticket contradicts the ledger: a conflicting_receipt HOLD, not a
  -- result_recorded verdict asserting the ticket is still reserved
  if public.release_offline_ticket(t2, 'unused_ticket_returned') <> 'accepted'
     or u2_probe.events(uma) <> 'allocated:2,consumed:1,released:1' then
    raise exception 'U8 precondition: the outstanding ticket is released (got %)', u2_probe.events(uma);
  end if;
  select * into v from u2_probe.settle(
    u2_probe.receipt('r3-released', uma, 'uma-key-1', g, t2, 1, 'op3-released', '00000000-0000-4000-8000-000000004925', 'not_chargeable'),
    u2_probe.shot('00000000-0000-4000-8000-000000004925', 'low_confidence'), null);
  if v.result <> 'accepted' or v.delivery <> 'held' or v.status <> 'reconciliation_required'
     or v.reason_code <> 'conflicting_receipt' or v.financial_disposition <> 'reserved' or v.result_id is not null then
    raise exception 'U8: a not_chargeable receipt under a released ticket is held as conflicting_receipt (got %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u2_probe.settle(
    u2_probe.receipt('r3-released', uma, 'uma-key-1', g, t2, 1, 'op3-released', '00000000-0000-4000-8000-000000004925', 'not_chargeable'),
    u2_probe.shot('00000000-0000-4000-8000-000000004925', 'low_confidence'), null);
  if v.delivery <> 'replayed' or v.reason_code <> 'conflicting_receipt' then
    raise exception 'U8: the conflicting abstention replays its hold (got %, %)', v.delivery, v.reason_code;
  end if;
  if u2_probe.recorded(uma) <> 4 or u2_probe.events(uma) <> 'allocated:2,consumed:1,released:1'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004925') then
    raise exception 'U8: the hold is durable, writes no rating and moves no ticket (got %, %)',
      u2_probe.recorded(uma), u2_probe.events(uma);
  end if;
end $$;
reset role;

-- U8b (W04-04 round 6, 20260910130000): the reversible deny-new freeze is
-- passed INTO the settlement as p_defer_new and decided AFTER the durable
-- lookup. As Uli — a fresh device holding a free grant of two tickets:
--   * a genuinely new chargeable receipt under the freeze is pending: nothing
--     recorded, nothing consumed, the ticket stays reserved; the identical
--     redelivery settles once the freeze lifts;
--   * a settled receipt redelivered under the freeze REPLAYS consumed (never
--     pending); a different body reusing its id is offline.receipt_conflict;
--   * a durable HOLD replays its hold under the freeze; an edge hold reason,
--     contradictory or missing evidence and a ticket the ledger already
--     closed are held durably regardless of the freeze;
--   * a not_chargeable abstention is recorded regardless of the freeze;
--   * a no-ticket receipt under Uli's FREE grant is not a Pro lease: it is
--     held evidence_ambiguous / not_applicable regardless of the freeze
--     (20260910150000 binds the lease lineage first; the genuine lease is
--     exercised in U3b);
--   * the 4-argument call still resolves (p_defer_new defaults to false) and
--     the function stays a definer executable by authenticated alone.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000493';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004903"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('uli-key-1', 'production', true);
  select * into g from public.issue_offline_grant('uli-key-1', 2);
  if r.result <> 'accepted' or g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'U8b precondition: Uli holds a free grant of two tickets (got %, %)', r.result, g.result;
  end if;
  insert into u2_state values ('uli-grant', g.grant_id), ('uli-t1', g.ticket_ids[1]), ('uli-t2', g.ticket_ids[2]);
end $$;
do $$
declare
  uli uuid := (select auth.uid());
  g uuid := (select id from u2_state where key = 'uli-grant');
  t1 uuid := (select id from u2_state where key = 'uli-t1');
  t2 uuid := (select id from u2_state where key = 'uli-t2');
  r_new jsonb := u2_probe.receipt('r5-1', uli, 'uli-key-1', g, t1, 1, 'op5-1',
    '00000000-0000-4000-8000-000000004951', 'joint_verification_required');
  o_new jsonb := u2_probe.shot('00000000-0000-4000-8000-000000004951', 'scored');
  r_forged jsonb := u2_probe.receipt('r5-1', uli, 'uli-key-1', g, t1, 1, 'op5-1',
    '00000000-0000-4000-8000-000000004952', 'joint_verification_required');
  r_held jsonb := u2_probe.receipt('r5-2', uli, 'uli-key-1', g, t2, 1, 'op5-2',
    '00000000-0000-4000-8000-000000004953', 'joint_verification_required');
  o_held jsonb := u2_probe.shot('00000000-0000-4000-8000-000000004953', 'scored');
  r_pro jsonb := u2_probe.receipt('r5-6', uli, 'uli-key-1', g, null, null, 'op5-6',
    '00000000-0000-4000-8000-000000004956', 'joint_verification_required');
  o_pro jsonb := u2_probe.shot('00000000-0000-4000-8000-000000004956', 'scored');
  v record;
begin
  -- a genuinely new chargeable receipt under the freeze: pending, nothing
  -- durable, the ticket stays reserved — on the redelivery too
  select * into v from u2_probe.settle_frozen(r_new, o_new, null);
  if v.result <> 'accepted' or v.delivery <> 'pending' or v.status <> 'pending' or v.reason_code is not null
     or v.financial_disposition <> 'reserved' or v.result_id is not null then
    raise exception 'U8b: a new chargeable receipt under the freeze is pending (got %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u2_probe.settle_frozen(r_new, o_new, null);
  if v.delivery <> 'pending' or u2_probe.recorded(uli) <> 0 or u2_probe.events(uli) <> 'allocated:2'
     or u2_probe.shots_on(uli, t1) <> 0 or public.offline_hold_count() <> 2 then
    raise exception 'U8b: the frozen receipt records nothing and moves nothing (got %, %, %, %, %)',
      v.delivery, u2_probe.recorded(uli), u2_probe.events(uli), u2_probe.shots_on(uli, t1), public.offline_hold_count();
  end if;
  -- the freeze lifts: the identical receipt settles once
  select * into v from u2_probe.settle(r_new, o_new, null);
  if v.delivery <> 'settled' or v.status <> 'result_recorded' or v.financial_disposition <> 'consumed'
     or v.result_id <> '00000000-0000-4000-8000-000000004951' then
    raise exception 'U8b: the identical receipt settles once the freeze lifts (got %, %, %)',
      v.delivery, v.status, v.financial_disposition;
  end if;
  -- frozen again: the settled receipt REPLAYS its durable verdict, never pending
  select * into v from u2_probe.settle_frozen(r_new, o_new, null);
  if v.result <> 'accepted' or v.delivery <> 'replayed' or v.status <> 'result_recorded'
     or v.financial_disposition <> 'consumed' or v.result_id <> '00000000-0000-4000-8000-000000004951' then
    raise exception 'U8b: a settled receipt redelivered under the freeze replays consumed (got %, %, %, %)',
      v.result, v.delivery, v.status, v.financial_disposition;
  end if;
  -- a different body reusing the settled id under the freeze: the conflict,
  -- never pending
  select * into v from u2_probe.settle_frozen(r_forged, u2_probe.shot('00000000-0000-4000-8000-000000004952', 'scored'), null);
  if v.result <> 'offline.receipt_conflict' or v.delivery is not null then
    raise exception 'U8b: a different receipt reusing a settled id under the freeze is the conflict (got %, %)', v.result, v.delivery;
  end if;
  if u2_probe.shots_on(uli, t1) <> 1 or u2_probe.events(uli) <> 'allocated:2,consumed:1' or u2_probe.recorded(uli) <> 1 then
    raise exception 'U8b: one rating, one consumed event, one settlement (got %, %, %)',
      u2_probe.shots_on(uli, t1), u2_probe.events(uli), u2_probe.recorded(uli);
  end if;
  -- an edge hold reason under the freeze is a durable HOLD, and replays as one
  select * into v from u2_probe.settle_frozen(r_held, o_held, 'evidence_ambiguous');
  if v.result <> 'accepted' or v.delivery <> 'held' or v.status <> 'reconciliation_required'
     or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'reserved' then
    raise exception 'U8b: an edge hold under the freeze is held durably (got %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code;
  end if;
  select * into v from u2_probe.settle_frozen(r_held, o_held, null);
  if v.delivery <> 'replayed' or v.status <> 'reconciliation_required' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U8b: a durable hold redelivered under the freeze replays its hold (got %, %, %)',
      v.delivery, v.status, v.reason_code;
  end if;
  -- contradictory and missing evidence under the freeze: held, not deferred
  select * into v from u2_probe.settle_frozen(
    u2_probe.receipt('r5-3', uli, 'uli-key-1', g, t2, 1, 'op5-3', '00000000-0000-4000-8000-000000004954', 'joint_verification_required'),
    null, null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_missing' or v.financial_disposition <> 'reserved' then
    raise exception 'U8b: a chargeable receipt without its output is held under the freeze (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u2_probe.settle_frozen(
    u2_probe.receipt('r5-4', uli, 'uli-key-1', g, t2, 1, 'op5-4', '00000000-0000-4000-8000-000000004955', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004955', 'low_confidence'), null);
  if v.delivery <> 'held' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U8b: a chargeable receipt beside an abstention is held under the freeze (got %, %)', v.delivery, v.reason_code;
  end if;
  -- a chargeable receipt under the ticket the ledger already CONSUMED: the
  -- ledger decides, frozen or not
  select * into v from u2_probe.settle_frozen(
    u2_probe.receipt('r5-5', uli, 'uli-key-1', g, t1, 1, 'op5-5', '00000000-0000-4000-8000-000000004957', 'joint_verification_required'),
    u2_probe.shot('00000000-0000-4000-8000-000000004957', 'scored'), null);
  if v.delivery <> 'held' or v.reason_code <> 'conflicting_receipt' or v.financial_disposition <> 'reserved' then
    raise exception 'U8b: a receipt under a consumed ticket is held as conflicting_receipt under the freeze (got %, %, %)',
      v.delivery, v.reason_code, v.financial_disposition;
  end if;
  -- a no-ticket receipt under a FREE grant is not a lease: held durably,
  -- nothing financial, nothing written — chargeable or not, frozen or not
  select * into v from u2_probe.settle_frozen(r_pro, o_pro, null);
  if v.result <> 'accepted' or v.delivery <> 'held' or v.status <> 'reconciliation_required'
     or v.reason_code <> 'evidence_ambiguous' or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U8b: a no-ticket receipt under a free grant is held / not_applicable under the freeze (got %, %, %, %, %)',
      v.result, v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  select * into v from u2_probe.settle_frozen(
    u2_probe.receipt('r5-7', uli, 'uli-key-1', g, null, null, 'op5-7', '00000000-0000-4000-8000-000000004958', 'not_chargeable'),
    u2_probe.shot('00000000-0000-4000-8000-000000004958', 'low_confidence'), null);
  if v.delivery <> 'held' or v.status <> 'reconciliation_required' or v.reason_code <> 'evidence_ambiguous'
     or v.financial_disposition <> 'not_applicable' or v.result_id is not null then
    raise exception 'U8b: a no-ticket abstention under a free grant is held under the freeze (got %, %, %, %)',
      v.delivery, v.status, v.reason_code, v.financial_disposition;
  end if;
  -- a ticketed abstention under the freeze is recorded too: nothing to charge
  select * into v from u2_probe.settle_frozen(
    u2_probe.receipt('r5-8', uli, 'uli-key-1', g, t2, 1, 'op5-8', '00000000-0000-4000-8000-000000004959', 'not_chargeable'),
    u2_probe.shot('00000000-0000-4000-8000-000000004959', 'low_confidence'), null);
  if v.delivery <> 'settled' or v.status <> 'result_recorded' or v.financial_disposition <> 'reserved'
     or v.result_id <> '00000000-0000-4000-8000-000000004959' then
    raise exception 'U8b: a ticketed abstention is recorded under the freeze (got %, %, %)',
      v.delivery, v.status, v.financial_disposition;
  end if;
  -- the freeze lifts: the frozen holds stand, the free-grant no-ticket
  -- receipt included
  select * into v from u2_probe.settle(r_pro, o_pro, null);
  if v.delivery <> 'replayed' or v.status <> 'reconciliation_required' or v.reason_code <> 'evidence_ambiguous'
     or exists (select 1 from public.shots where id = '00000000-0000-4000-8000-000000004956') then
    raise exception 'U8b: the no-ticket hold stands once the freeze lifts (got %, %, %)',
      v.delivery, v.status, v.reason_code;
  end if;
  select * into v from u2_probe.settle(r_held, o_held, null);
  if v.delivery <> 'replayed' or v.reason_code <> 'evidence_ambiguous' then
    raise exception 'U8b: the hold taken under the freeze stands after it (got %, %)', v.delivery, v.reason_code;
  end if;
  if u2_probe.recorded(uli) <> 8 or u2_probe.events(uli) <> 'allocated:2,consumed:1'
     or u2_probe.shots_on(uli, t1) <> 1 or u2_probe.shots_on(uli, t2) <> 0 or public.lifetime_scored_count() <> 1 then
    raise exception 'U8b: eight durable verdicts, one rating, t2 still reserved (got %, %, %, %, %)',
      u2_probe.recorded(uli), u2_probe.events(uli), u2_probe.shots_on(uli, t1), u2_probe.shots_on(uli, t2), public.lifetime_scored_count();
  end if;
end $$;
reset role;
do $$
declare fn record;
begin
  select p.prosecdef, pg_get_function_identity_arguments(p.oid) as args, p.pronargdefaults into fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'settle_offline_receipt';
  if not found or not fn.prosecdef
     or fn.args <> 'p_receipt jsonb, p_receipt_sha256 text, p_output jsonb, p_hold_reason text, p_defer_new boolean'
     or fn.pronargdefaults <> 1 then
    raise exception 'U8b: settle_offline_receipt is the one definer with the defaulted p_defer_new (got %, %, %)',
      fn.prosecdef, fn.args, fn.pronargdefaults;
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'settle_offline_receipt') <> 1 then
    raise exception 'U8b: the 4-argument signature is dropped, not left beside the new one';
  end if;
  if has_function_privilege('anon', 'public.settle_offline_receipt(jsonb, text, jsonb, text, boolean)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.settle_offline_receipt(jsonb, text, jsonb, text, boolean)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.settle_offline_receipt(jsonb, text, jsonb, text, boolean)', 'EXECUTE') then
    raise exception 'U8b: the settlement RPC executes for authenticated alone';
  end if;
end $$;
set local request.jwt.claim.sub = '';

-- U9: the release lineage reader — an installed policy by digest, superseded
-- and withdrawn included, for the service role alone.
do $$
declare
  artifact jsonb := jsonb_build_object('version', 'fixture-1', 'sha256', repeat('a', 64));
  lineage jsonb; document jsonb; serialized text;
  hashes text[] := '{}';
  v text;
  state jsonb; lineage_row jsonb;
begin
  select jsonb_object_agg(k, artifact) into lineage from unnest(array[
    'pipeline', 'definition', 'model', 'preprocessing', 'calibration', 'dataset', 'validationReport', 'supportedDomain'
  ]) k;
  foreach v in array array['fixture-policy-u9-1', 'fixture-policy-u9-2'] loop
    document := jsonb_build_object(
      'schemaVersion', 'analysis-release-policy-v1', 'version', v,
      'validFrom', floor(extract(epoch from now()))::bigint - 60,
      'validUntil', floor(extract(epoch from now()))::bigint + 3600,
      'mechanics', jsonb_build_object('lineage', lineage),
      'benchmark', jsonb_build_object('lineage', lineage,
        'uncertainty', jsonb_build_object('kind', 'calibrated_prediction_interval', 'nominalCoverage', 0.9,
          'coverageScope', 'supported_slice', 'calibrationUnit', 'player_session'),
        'maximumIntervalWidth', 1.5, 'boundaryStep', 0.25,
        'supportedIntervals', jsonb_build_array(jsonb_build_object('lower', 3, 'upper', 5))),
      'supportedInputs', jsonb_build_array(jsonb_build_object('shotType', 'forehand_drive', 'cameraView', 'side',
        'handedness', 'right', 'captureMode', 'imported_video')));
    serialized := document::text;
    hashes := hashes || encode(sha256(convert_to(serialized, 'UTF8')), 'hex');
    perform public.install_analysis_release_policy(serialized, hashes[array_length(hashes, 1)]);
    perform public.approve_analysis_release_output(hashes[array_length(hashes, 1)], 'mechanics', 'u9-reviewer', repeat('a', 64));
    perform public.approve_analysis_release_output(hashes[array_length(hashes, 1)], 'benchmark', 'u9-reviewer', repeat('a', 64));
  end loop;
  perform public.activate_analysis_release_policy(hashes[1], 'u9-operator');
  -- while active, the lineage row IS the active reader's row
  if public.read_analysis_release_policy_lineage(hashes[1]) <> public.read_analysis_release_policy() then
    raise exception 'U9: the active policy reads identically by digest';
  end if;
  -- rotation: the superseded policy stays readable, approved and not withdrawn
  perform public.activate_analysis_release_policy(hashes[2], 'u9-operator');
  state := public.read_analysis_release_policy();
  lineage_row := public.read_analysis_release_policy_lineage(hashes[1]);
  if state #>> '{approval,policy,sha256}' <> hashes[2]
     or lineage_row #>> '{approval,policy,sha256}' <> hashes[1]
     or lineage_row ->> 'canonicalDocument' is null
     or (lineage_row ->> 'denyNewAuthorizations')::boolean
     or (lineage_row #>> '{approval,denyNewAuthorizations}')::boolean
     or lineage_row #>> '{approval,withdrawnAt}' is not null
     or lineage_row #>> '{approval,mechanicsApprovedAt}' is null
     or lineage_row #>> '{approval,benchmarkApprovedAt}' is null then
    raise exception 'U9: a superseded, never withdrawn policy is readable by digest with its approvals (got %)', lineage_row;
  end if;
  -- withdrawal of the superseded policy is visible through the lineage
  perform public.withdraw_analysis_release_policy(hashes[1], 'u9-operator');
  lineage_row := public.read_analysis_release_policy_lineage(hashes[1]);
  if not (lineage_row ->> 'denyNewAuthorizations')::boolean
     or not (lineage_row #>> '{approval,denyNewAuthorizations}')::boolean
     or lineage_row #>> '{approval,withdrawnAt}' is null then
    raise exception 'U9: a withdrawn lineage denies (got %)', lineage_row;
  end if;
  if (public.read_analysis_release_policy() ->> 'denyNewAuthorizations')::boolean then
    raise exception 'U9: withdrawing the superseded policy does not gate the active one';
  end if;
  -- unknown or malformed digest: the nothing-installed row
  if public.read_analysis_release_policy_lineage(repeat('f', 64))
       <> '{"document":null,"canonicalDocument":null,"denyNewAuthorizations":true,"approval":null}'::jsonb
     or public.read_analysis_release_policy_lineage('not-a-digest')
       <> '{"document":null,"canonicalDocument":null,"denyNewAuthorizations":true,"approval":null}'::jsonb
     or public.read_analysis_release_policy_lineage(null)
       <> '{"document":null,"canonicalDocument":null,"denyNewAuthorizations":true,"approval":null}'::jsonb then
    raise exception 'U9: an unknown digest is the nothing-installed row';
  end if;
  if not has_function_privilege('service_role', 'public.read_analysis_release_policy_lineage(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.read_analysis_release_policy_lineage(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.read_analysis_release_policy_lineage(text)', 'EXECUTE') then
    raise exception 'U9: the lineage reader is the service role''s alone';
  end if;
end $$;
set local role service_role;
do $$
begin
  if (public.read_analysis_release_policy_lineage(repeat('f', 64)) ->> 'denyNewAuthorizations') <> 'true' then
    raise exception 'U9: the service role reads the lineage';
  end if;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000491';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000004901"}';
do $$
begin
  begin
    perform public.read_analysis_release_policy_lineage(repeat('f', 64));
    raise exception 'U9: clients must not read the release lineage';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local role anon;
do $$
begin
  begin
    perform public.read_analysis_release_policy_lineage(repeat('f', 64));
    raise exception 'U9: anon must not read the release lineage';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;

-- ============================================================================
-- V. (W11-03, 20260910110300_cron_offline_allocation_safe) the hourly pg_cron
-- stale-permit sweep is a named, owner-only function —
-- api_private.sweep_stale_analysis_permits() — and the matrix runs THAT
-- function (not a hand-copied UPDATE) against every offline artefact. The
-- sweep writes exactly one thing: reserved online permits older than 24 h
-- become released/expired. It never touches an offline device, grant, ticket,
-- ledger event or settled receipt, it never waits on (or blocks) a settlement
-- that is in flight, and no client or service role can invoke it.
-- Users: Vera (free, Google: tickets + offline receipts), Vic (Pro, expires
-- in 3 days: an expired Pro lease), Vito (free, Google: online permits and
-- their settlement receipts), Vlad (free, created by a second connection so a
-- committed permit can be row-locked while the sweep runs).
-- V1  the sweep function exists with the pinned shape: SECURITY DEFINER,
--     search_path pinned, EXECUTE absent for anon / authenticated /
--     service_role; when pg_cron is installed the scheduled job runs it
-- V2  precondition snapshot: Vera holds 2 tickets (one consumed through a
--     recorded receipt, one outstanding under a HELD receipt), Vic holds an
--     expired Pro lease, Vito holds a settled permit with its settlement
--     receipt, two stale reserved permits, a fresh reservation and a released
--     abstention — the offline tables are digested
-- V3  the sweep: exactly the two stale reserved permits are released/expired
--     (the returned count says so); every other permit is byte-identical; the
--     offline device / grant / ledger / receipt digests are unchanged, Vera's
--     hold is still 1, the held ticket is still reserved, Vic's expired lease
--     is still there, offline_hold_count() and access_state() agree
-- V4  the swept permit still backs the rating it was reserved for: Vito's
--     late sync WITH its settlement receipt is accepted after the sweep and
--     writes a second receipt; both receipts survive a further sweep
-- V5  concurrency: a stale permit row-locked by another connection (a late
--     sync in flight, as apply_synced_shot() locks it) is SKIPPED, not
--     waited for — the sweep returns within the statement timeout without
--     it; the other connection settles it finalized/scored and a further
--     sweep leaves it alone
-- V6  the sweep is idempotent (a second run returns 0 and moves nothing), a
--     malformed batch bound is refused, and every client role is 42501
-- ============================================================================
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-000000000071', 'vera@example.com',
   '{"full_name":"Vera"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000072', 'vic@example.com',
   '{"full_name":"Vic"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-000000000073', 'vito@example.com',
   '{"full_name":"Vito"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-vera', '00000000-0000-4000-8000-000000000071',
   '{"sub":"google-sub-vera","email":"vera@example.com"}'),
  ('apple', 'apple-sub-vic', '00000000-0000-4000-8000-000000000072',
   '{"sub":"apple-sub-vic","email":"vic@example.com"}'),
  ('google', 'google-sub-vito', '00000000-0000-4000-8000-000000000073',
   '{"sub":"google-sub-vito","email":"vito@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-000000007101', '00000000-0000-4000-8000-000000000071'),
  ('00000000-0000-4000-8000-000000007201', '00000000-0000-4000-8000-000000000072'),
  ('00000000-0000-4000-8000-000000007301', '00000000-0000-4000-8000-000000000073');
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000072', true, now() + interval '3 days');

-- Vito's online permits, as the shipping app leaves them behind:
--   ...0731 settled 3 days ago (finalized/scored with its receipt, below)
--   ...0732 reserved 2 days ago, never finalized — the device went offline
--   ...0733 reserved just now — a live reservation
--   ...0734 released/low_confidence 2 days ago — a settled abstention
--   ...0735 reserved 2 days ago on a second device that never came back
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values
  ('00000000-0000-4000-8000-000000000731', '00000000-0000-4000-8000-000000000073', 'w1103-settled', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000000732', '00000000-0000-4000-8000-000000000073', 'w1103-stale', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000733', '00000000-0000-4000-8000-000000000073', 'w1103-live', now()),
  ('00000000-0000-4000-8000-000000000734', '00000000-0000-4000-8000-000000000073', 'w1103-abstained', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000735', '00000000-0000-4000-8000-000000000073', 'w1103-stale-2', now() - interval '2 days');
update public.analysis_permits set status = 'released', outcome = 'low_confidence'
where id = '00000000-0000-4000-8000-000000000734';

-- Vic's expired Pro lease: issued 10 days ago for 7 days (≤ the verified
-- entitlement expiry), never refreshed. No ticket rides on a Pro lease; the
-- row itself is the artefact the sweep must leave alone.
insert into public.offline_devices (id, user_id, installation_key_id, attestation_environment, attestation_state, attested_at)
values ('00000000-0000-4000-8000-000000000720', '00000000-0000-4000-8000-000000000072', 'vic-key-1', 'production', 'attested', now() - interval '10 days');
insert into public.offline_grants (id, user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
values ('00000000-0000-4000-8000-000000000721', '00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000720',
        'verified_store', 1, now() - interval '10 days', now() - interval '3 days',
        (select expires_at from public.billing_entitlements where user_id = '00000000-0000-4000-8000-000000000072'));

create temporary table v_state (key text primary key, id uuid);
grant select, insert on v_state to authenticated;
create temporary table v_digest (key text primary key, digest text);
create schema v_probe;
create extension dblink with schema v_probe;
-- Test-only builders: the shot payload the edge sends to the RPCs, the
-- settlement receipt transport apply_synced_shot() verifies, and the signed
-- offline receipt settle_offline_receipt() settles (as in sections T and U).
create function v_probe.shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-10T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
create function v_probe.settle(p_owner uuid, p_shot jsonb, p_operation text)
returns jsonb language sql immutable set search_path = '' as $$
  with binding as (
    select jsonb_build_object(
      'ownerId', p_owner,
      'shotId', p_shot ->> 'id',
      'analysisPermitId', p_shot ->> 'analysisPermitId',
      'resultKind', p_shot ->> 'resultKind',
      'installationKeyId', 'ik_vito_phone',
      'grant', null,
      'ticket', null,
      'operationId', p_operation,
      'payloadSha256', encode(pg_catalog.sha256(convert_to(p_shot::text, 'UTF8')), 'hex')
    ) as b
  ), receipt as (
    select jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'settlement_receipt',
      'binding', b,
      'bindingSha256', encode(pg_catalog.sha256(convert_to(b::text, 'UTF8')), 'hex'),
      'policy', jsonb_build_object('version', 'policy-2026-09-08', 'sha256', repeat('b', 64))
    ) as r
    from binding
  )
  select p_shot || jsonb_build_object('settlementReceipt', jsonb_build_object(
    'canonical', r::text,
    'sha256', encode(pg_catalog.sha256(convert_to(r::text, 'UTF8')), 'hex')))
  from receipt
$$;
create function v_probe.receipt(
  p_receipt_id text, p_owner uuid, p_key text, p_grant uuid, p_ticket uuid,
  p_operation text, p_result uuid
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', 'offline-result-receipt-v1',
    'receiptId', p_receipt_id,
    'ownerId', p_owner,
    'installationKeyId', p_key,
    'grantId', p_grant,
    'grantJwsSha256', repeat('a', 64),
    'lifecycleSequence', 1,
    'nativeTime', jsonb_build_object('monotonicMs', 1000, 'wallClockIso', '2026-09-10T10:00:00Z'),
    'ticket', jsonb_build_object('allocationId', p_grant, 'generation', 1, 'ticketId', p_ticket),
    'operationId', p_operation,
    'resultId', p_result,
    'fullOutputSha256', repeat('c', 64),
    'billingDisposition', 'joint_verification_required')
$$;
create function v_probe.settle_receipt(p_receipt jsonb, p_output jsonb, p_hold text)
returns table (result text, delivery text, status text, reason_code text, financial_disposition text, result_id text)
language sql set search_path = '' as $$
  select * from public.settle_offline_receipt(
    p_receipt, encode(pg_catalog.sha256(convert_to(p_receipt::text, 'UTF8')), 'hex'), p_output, p_hold)
$$;
-- The reviewer's ruler: one digest per offline table over EVERY row (all
-- users), so "the sweep touched nothing offline" is a byte comparison.
create function v_probe.digest(p_table text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  execute format(
    'select coalesce(md5(string_agg(t::text, %L order by t::text)), %L) from %s t',
    '|', 'empty', p_table) into v;
  return v;
end $$;
create function v_probe.permits(p_uid uuid) returns text
language sql security definer set search_path = '' as $$
  select coalesce(string_agg(right(p.id::text, 4) || '=' || p.status || '/' || coalesce(p.outcome, '-'), ',' order by p.id), '')
  from public.analysis_permits p where p.user_id = p_uid;
$$;
create function v_probe.events(p_uid uuid) returns text
language sql security definer set search_path = '' as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
create function v_probe.snapshot() returns void
language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  delete from v_digest;
  foreach t in array array[
    'public.offline_devices', 'public.offline_grants', 'public.offline_allocation_ledger',
    'public.settlement_receipts', 'public.offline_receipt_settlements'] loop
    insert into v_digest values (t, v_probe.digest(t));
  end loop;
end $$;
create function v_probe.changed() returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select string_agg(d.key, ',' order by d.key) into v
  from v_digest d where d.digest <> v_probe.digest(d.key);
  return coalesce(v, '');
end $$;
grant usage on schema v_probe to authenticated;
grant execute on all functions in schema v_probe to authenticated;

-- V1: the sweep is a pinned, owner-only definer; when pg_cron is present the
-- scheduled job runs exactly it.
do $$
declare f record; r text;
begin
  select p.prosecdef, p.proconfig, p.provolatile, pg_get_function_result(p.oid) as result
    into f
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_private' and p.proname = 'sweep_stale_analysis_permits';
  if not found then
    raise exception 'V1: the stale-permit sweep must be a named function, api_private.sweep_stale_analysis_permits(), not an anonymous cron statement';
  end if;
  if not f.prosecdef or f.result <> 'integer'
     or not (f.proconfig @> array['search_path=""']::text[]) then
    raise exception 'V1: the sweep is SECURITY DEFINER with a pinned search_path and returns the swept count (got %, %, %)',
      f.prosecdef, f.proconfig, f.result;
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'api_private.sweep_stale_analysis_permits(integer)', 'execute') then
      raise exception 'V1: % must not hold EXECUTE on the sweep', r;
    end if;
  end loop;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if (select count(*) from cron.job where jobname = 'expire-stale-analysis-permits'
          and command = 'select api_private.sweep_stale_analysis_permits()') <> 1
       or exists (select 1 from cron.job
                  where command ilike '%analysis_permits%'
                    and command <> 'select api_private.sweep_stale_analysis_permits()') then
      raise exception 'V1: the scheduled sweep must be exactly select api_private.sweep_stale_analysis_permits()';
    end if;
  else
    raise notice 'V1: pg_cron is not installed here; the schedule itself is proven on a pg_cron-capable image';
  end if;
end $$;

-- V2: preconditions. Vera: two tickets, one consumed through a recorded
-- receipt, one still held under a HELD receipt. Vito: a settled permit with
-- its receipt beside the stale, live and abstained ones.
do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000071';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007101"}';
do $$
declare
  vera uuid := (select auth.uid());
  r record; g record; v record;
begin
  select * into r from public.register_offline_device('vera-key-1', 'production', true);
  if r.result <> 'accepted' then
    raise exception 'V2 precondition: registration (got %)', r.result;
  end if;
  select * into g from public.issue_offline_grant('vera-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'V2 precondition: two free tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  insert into v_state values ('vera-grant', g.grant_id), ('vera-t1', g.ticket_ids[1]), ('vera-t2', g.ticket_ids[2]);
  select * into v from v_probe.settle_receipt(
    v_probe.receipt('w1103-rcpt-1', vera, 'vera-key-1', g.grant_id, g.ticket_ids[1], 'w1103-op-1',
                    '00000000-0000-4000-8000-000000000711'),
    v_probe.shot('00000000-0000-4000-8000-000000000711', null, 'scored'), null);
  if v.result <> 'accepted' or v.delivery <> 'settled' or v.status <> 'result_recorded'
     or v.financial_disposition <> 'consumed' then
    raise exception 'V2 precondition: the first ticket settles through its receipt (got %, %, %, %)',
      v.result, v.delivery, v.status, v.financial_disposition;
  end if;
  -- the second receipt could not be verified by the edge: HELD, ticket kept
  select * into v from v_probe.settle_receipt(
    v_probe.receipt('w1103-rcpt-2', vera, 'vera-key-1', g.grant_id, g.ticket_ids[2], 'w1103-op-2',
                    '00000000-0000-4000-8000-000000000712'),
    v_probe.shot('00000000-0000-4000-8000-000000000712', null, 'scored'), 'evidence_ambiguous');
  if v.result <> 'accepted' or v.delivery <> 'held' or v.status <> 'reconciliation_required'
     or v.financial_disposition <> 'reserved' then
    raise exception 'V2 precondition: the second receipt is held with its ticket reserved (got %, %, %, %)',
      v.result, v.delivery, v.status, v.financial_disposition;
  end if;
  if v_probe.events(vera) <> 'allocated:2,consumed:1' or public.offline_hold_count() <> 1
     or public.lifetime_scored_count() <> 1 then
    raise exception 'V2 precondition: one consumed, one outstanding (got %, hold %, scored %)',
      v_probe.events(vera), public.offline_hold_count(), public.lifetime_scored_count();
  end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000073';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007301"}';
do $$
declare
  vito uuid := (select auth.uid());
  v text;
begin
  v := public.apply_synced_shot(v_probe.settle(vito,
    v_probe.shot('00000000-0000-4000-8000-000000000741', '00000000-0000-4000-8000-000000000731', 'scored'),
    'w1103-op-settled'));
  if v <> 'accepted' then
    raise exception 'V2 precondition: the settled permit''s sync with its receipt is accepted (got %)', v;
  end if;
  if (select count(*) from public.settlement_receipts where user_id = vito) <> 1 then
    raise exception 'V2 precondition: the settlement receipt is durable';
  end if;
  if v_probe.permits(vito) <> '0731=finalized/scored,0732=reserved/-,0733=reserved/-,0734=released/low_confidence,0735=reserved/-' then
    raise exception 'V2 precondition: permit shapes (got %)', v_probe.permits(vito);
  end if;
  if public.online_reservation_count() <> 1 then
    raise exception 'V2 precondition: only the fresh permit is a live reservation (got %)', public.online_reservation_count();
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
select v_probe.snapshot();

-- V3: the sweep. Exactly the two stale reserved permits move; nothing offline
-- moves by a single byte.
set local statement_timeout = '5s';
do $$
declare n integer; rec record;
begin
  n := api_private.sweep_stale_analysis_permits();
  if n <> 2 then
    raise exception 'V3: exactly the two stale reserved permits are swept (got %)', n;
  end if;
  if v_probe.permits('00000000-0000-4000-8000-000000000073')
     <> '0731=finalized/scored,0732=released/expired,0733=reserved/-,0734=released/low_confidence,0735=released/expired' then
    raise exception 'V3: the settled, live and abstained permits are untouched (got %)',
      v_probe.permits('00000000-0000-4000-8000-000000000073');
  end if;
  if v_probe.changed() <> '' then
    raise exception 'V3: the sweep must not touch an offline device, grant, ledger event or receipt (changed: %)', v_probe.changed();
  end if;
  if not exists (select 1 from public.offline_grants where id = '00000000-0000-4000-8000-000000000721'
                 and expires_at < now()) then
    raise exception 'V3: an expired Pro lease is retained, never reclaimed by the sweep';
  end if;
  if (select count(*) from public.offline_receipt_settlements where user_id = '00000000-0000-4000-8000-000000000071'
        and status = 'reconciliation_required' and financial_disposition = 'reserved'
        and ticket_id = (select id from v_state where key = 'vera-t2')) <> 1
     or exists (select 1 from public.offline_allocation_ledger
                where ticket_id = (select id from v_state where key = 'vera-t2') and event <> 'allocated') then
    raise exception 'V3: the held receipt keeps its ticket reserved through the sweep';
  end if;
end $$;
reset statement_timeout;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000071';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007101"}';
do $$
declare rec record; g record;
begin
  if public.offline_hold_count() <> 1 or v_probe.events((select auth.uid())) <> 'allocated:2,consumed:1' then
    raise exception 'V3: Vera''s outstanding ticket is still held after the sweep (got %, %)',
      public.offline_hold_count(), v_probe.events((select auth.uid()));
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'V3: access_state still counts the hold (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into g from public.issue_offline_grant('vera-key-1', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[(select id from v_state where key = 'vera-t2')] then
    raise exception 'V3: the device re-obtains exactly its outstanding ticket after the sweep (got %, %)', g.result, g.ticket_ids;
  end if;
end $$;

-- V4: the swept permit still backs the late rating it was reserved for, with
-- its receipt; both of Vito's receipts survive a further sweep.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000073';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007301"}';
do $$
declare vito uuid := (select auth.uid()); v text;
begin
  v := public.apply_synced_shot(v_probe.settle(vito,
    v_probe.shot('00000000-0000-4000-8000-000000000742', '00000000-0000-4000-8000-000000000732', 'scored'),
    'w1103-op-late'));
  if v <> 'accepted' then
    raise exception 'V4: the swept permit''s late sync with its receipt is accepted (got %)', v;
  end if;
  if (select count(*) from public.settlement_receipts where user_id = vito) <> 2
     or public.lifetime_scored_count() <> 2 then
    raise exception 'V4: the late settlement writes its receipt and counts once (got %, %)',
      (select count(*) from public.settlement_receipts where user_id = vito), public.lifetime_scored_count();
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
select v_probe.snapshot();
set local statement_timeout = '5s';
do $$
declare n integer;
begin
  n := api_private.sweep_stale_analysis_permits();
  if n <> 0 or v_probe.changed() <> '' then
    raise exception 'V4: a further sweep finds nothing stale and retains every receipt (got %, changed %)', n, v_probe.changed();
  end if;
  if v_probe.permits('00000000-0000-4000-8000-000000000073')
     <> '0731=finalized/scored,0732=finalized/scored,0733=reserved/-,0734=released/low_confidence,0735=released/expired' then
    raise exception 'V4: settled permits are terminal to the sweep (got %)', v_probe.permits('00000000-0000-4000-8000-000000000073');
  end if;
end $$;
reset statement_timeout;

-- V5: a stale permit another connection holds FOR UPDATE (a late sync in
-- flight) is skipped, never waited for; once that settlement commits the
-- sweep has nothing to do with it. Vlad and his permit are created and
-- removed by the second connection so they are committed and visible to it.
-- lock_timeout is the proof the sweep never waits: a blocked sweep fails
-- here instead of hanging the matrix.
set local lock_timeout = '5s';
do $$
declare
  connection text := format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database());
  n integer;
  locked record;
begin
  perform v_probe.dblink_connect('w1103_sync', connection || ' application_name=w1103_sync');
  perform v_probe.dblink_exec('w1103_sync', 'set statement_timeout = ''5s''');
  perform v_probe.dblink_exec('w1103_sync', $sql$
    delete from auth.users where id = '00000000-0000-4000-8000-000000000074';
    insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
    values ('00000000-0000-4000-8000-000000000074', 'vlad@example.com', '{"full_name":"Vlad"}', '{"provider":"google"}');
    insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
    values ('00000000-0000-4000-8000-000000000751', '00000000-0000-4000-8000-000000000074', 'w1103-inflight', now() - interval '2 days');
  $sql$);
  perform v_probe.dblink_exec('w1103_sync', 'begin');
  perform 1 from v_probe.dblink('w1103_sync',
    'select id from public.analysis_permits where id = ''00000000-0000-4000-8000-000000000751'' for update') as t(id uuid);
  n := api_private.sweep_stale_analysis_permits();
  select status, outcome into locked from public.analysis_permits where id = '00000000-0000-4000-8000-000000000751';
  if n <> 0 or locked.status <> 'reserved' or locked.outcome is not null then
    raise exception 'V5: a permit locked by an in-flight settlement is skipped, not swept or waited for (got %, %/%)',
      n, locked.status, locked.outcome;
  end if;
  perform v_probe.dblink_exec('w1103_sync',
    'update public.analysis_permits set status = ''finalized'', outcome = ''scored'' where id = ''00000000-0000-4000-8000-000000000751''');
  perform v_probe.dblink_exec('w1103_sync', 'commit');
  n := api_private.sweep_stale_analysis_permits();
  select status, outcome into locked from public.analysis_permits where id = '00000000-0000-4000-8000-000000000751';
  if n <> 0 or locked.status <> 'finalized' or locked.outcome <> 'scored' then
    raise exception 'V5: the settlement that was in flight stands after the sweep (got %, %/%)',
      n, locked.status, locked.outcome;
  end if;
  perform v_probe.dblink_exec('w1103_sync', 'delete from auth.users where id = ''00000000-0000-4000-8000-000000000074''');
  perform v_probe.dblink_disconnect('w1103_sync');
  if exists (select 1 from public.analysis_permits where id = '00000000-0000-4000-8000-000000000751') then
    raise exception 'V5: the second connection must have removed its own rows';
  end if;
end $$;
reset lock_timeout;

-- V6: a malformed batch bound is refused; every client role is 42501.
do $$
begin
  begin
    perform api_private.sweep_stale_analysis_permits(0);
    raise exception 'V6: a zero batch bound must be refused';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform api_private.sweep_stale_analysis_permits(10001);
    raise exception 'V6: an oversized batch bound must be refused';
  exception when invalid_parameter_value then null;
  end;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000073';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-000000007301"}';
do $$
begin
  begin
    perform api_private.sweep_stale_analysis_permits();
    raise exception 'V6: a signed-in API caller must not run the sweep';
  exception when insufficient_privilege then null;
  end;
  begin
    perform api_private.sweep_stale_analysis_permits(10);
    raise exception 'V6: a signed-in API caller must not run a bounded sweep either';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local role service_role;
do $$
begin
  begin
    perform api_private.sweep_stale_analysis_permits();
    raise exception 'V6: service_role must not run the sweep';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform api_private.sweep_stale_analysis_permits();
    raise exception 'V6: anon must not run the sweep';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
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
  lease uuid;
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
  select (value->>'lease_token')::uuid into lease from w07_probe.dblink('w07_setup', format(
    'select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', 'w07-concurrent-audit', payload
  )) as result(value jsonb);
  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[a]::text, 'w07-concurrent-audit', payload, lease
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform value from w07_probe.dblink('w07_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older, inactive
  )) as result(value jsonb);
  proofs := jsonb_build_object(a::text, older);
  query := format('select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb,%L::uuid)', 'w07-concurrent-audit', payload, proofs, lease);
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
    select (value->>'lease_token')::uuid into lease from w07_probe.dblink('w07_first', format(
      'select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', event_id, payload
    )) as result(value jsonb);
    select value into issued from w07_probe.dblink('w07_first', format(
      'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[a]::text, event_id, payload, lease
    )) as result(value jsonb);
    older := (issued->0->>'ticket_id')::uuid;
    perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
    perform w07_probe.dblink_send_query('w07_second', format(
      'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)',
      array[case when conflicting then profile_user else a end]::text, event_id, conflicting_payload, lease
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
  select (value->>'lease_token')::uuid into lease from w07_probe.dblink('w07_setup', format(
    'select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', event_id, payload
  )) as result(value jsonb);
  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[a]::text, event_id, payload, lease
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform value from w07_probe.dblink('w07_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older, inactive
  )) as result(value jsonb);
  select count(*) into ticket_count from api_private.billing_verification_tickets;
  perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
  perform value from w07_probe.dblink('w07_first', format(
    'select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb,%L::uuid)', event_id, payload, jsonb_build_object(a::text, older), lease
  )) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
  perform w07_probe.dblink_send_query('w07_second', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[a]::text, event_id, payload, lease
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
  select (value->>'lease_token')::uuid into lease from w07_probe.dblink('w07_setup', format(
    'select public.claim_billing_webhook_delivery(%L::text,%L::jsonb)', 'w07-conflicting-audit', payload
  )) as result(value jsonb);
  select value into issued from w07_probe.dblink('w07_setup', format(
    'select public.begin_billing_verification(%L::uuid[],%L::text,%L::jsonb,%L::uuid)', array[a]::text, 'w07-conflicting-audit', payload, lease
  )) as result(value jsonb);
  older := (issued->0->>'ticket_id')::uuid;
  perform value from w07_probe.dblink('w07_setup', format(
    'select public.persist_billing_verdict(%L::uuid,%L::uuid,%L::jsonb)', a, older, inactive
  )) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_first', 'begin; set local role service_role');
  perform value from w07_probe.dblink('w07_first', format(
    'select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb,%L::uuid)', 'w07-conflicting-audit', payload, jsonb_build_object(a::text, older), lease
  )) as result(value jsonb);
  perform w07_probe.dblink_exec('w07_second', 'begin; set local role service_role');
  perform w07_probe.dblink_send_query('w07_second', format(
    'select public.complete_billing_webhook(%L::text,%L::jsonb,%L::jsonb,%L::uuid)', 'w07-conflicting-audit', conflicting_payload, jsonb_build_object(a::text, older), lease
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
