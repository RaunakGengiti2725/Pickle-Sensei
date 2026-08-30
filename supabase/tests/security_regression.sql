-- ============================================================================
-- Pickle Sensei — Supabase security regression matrix.
--
-- Runs after every migration in supabase/migrations (see run_rls_tests.sh).
-- Each numbered case asserts one security boundary; any regression aborts the
-- whole script (ON_ERROR_STOP) with the failing case name.
--
-- Matrix:
--   A. owner CRUD works inside the owner's row-space
--   B. cross-user SELECT/UPDATE/DELETE are denied by RLS
--   C. anonymous access is denied outright (no table grants for anon)
--   D. consent/evaluation/feedback ledgers are append-only (grant, policy AND
--      trigger layers), while account-deletion cascades still pass
--   E. column-level grants: identity/score/bookkeeping columns are not
--      client-writable even in the owner's own rows
--   F. payload size caps reject oversized text/jsonb
--   G. privileged functions are not client-executable
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

-- Helper: run a statement that MUST fail. Usage via DO blocks below.

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

-- ───────────────────────── A + B: owner vs cross-user ──────────────────────

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

-- A2: owner creates a session + shot
insert into public.sessions (id, user_id, started_at, kind)
values ('00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-00000000000a', now(), 'practice');

insert into public.shots (
  id, user_id, session_id, shot_type, captured_at, start_ms, end_ms,
  overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version,
  scoring_model_version, shot_config_version
) values (
  '00000000-0000-4000-8000-0000000000e1',
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-0000000000d1',
  'drive', now(), 0, 1000,
  7.1, 0.9, 'scored',
  '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
  'scoring-1', 'config-1'
);

-- A3: owner may curate allowed shot columns
update public.shots set favorite = true, declared_stroke = 'drive'
  where id = '00000000-0000-4000-8000-0000000000e1';

-- A4: owner appends to the consent ledger
insert into public.consent_records (user_id, scope, action, consent_version, source)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant', 'v1', 'mobile_settings');
insert into public.consent_records (user_id, scope, action, consent_version, source)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'withdraw', 'v1', 'mobile_settings');

-- B1: Bob cannot see Alice's rows
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
begin
  if exists (select 1 from public.sessions) or exists (select 1 from public.shots)
     or exists (select 1 from public.consent_records) then
    raise exception 'B1: cross-user rows must be invisible';
  end if;
end $$;

-- B2: Bob's UPDATE against Alice's shot must hit zero rows
update public.shots set favorite = false
  where id = '00000000-0000-4000-8000-0000000000e1';
do $$
declare n int;
begin
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
  select count(*) into n from public.shots
    where id = '00000000-0000-4000-8000-0000000000e1' and favorite;
  if n <> 1 then
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
end $$;

-- B4: Bob cannot insert rows owned by Alice (WITH CHECK)
do $$
begin
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
  begin
    insert into public.consent_records (user_id, scope, action)
    values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant');
    raise exception 'B4: insert-as-other-user must be denied';
  exception when insufficient_privilege or check_violation then null;
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
    'player_technique_rating'
  ] loop
    begin
      execute format('select 1 from public.%I limit 1', t);
      raise exception 'C: anon must not read public.%', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
reset role;

-- ───────────────────────── D: append-only ledgers ──────────────────────────

-- D1: owner cannot UPDATE their own consent history
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
begin
  begin
    update public.consent_records set action = 'grant' where action = 'withdraw';
    raise exception 'D1: consent UPDATE must be denied';
  exception when insufficient_privilege then null;
  end;
end $$;

-- D2: owner cannot DELETE their own consent history
do $$
begin
  begin
    delete from public.consent_records;
    raise exception 'D2: consent DELETE must be denied';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- D3: even a table-owner session (compromised backend / accidental grant)
-- cannot rewrite ledger history — the trigger fires for every role.
do $$
begin
  begin
    update public.consent_records set action = 'grant' where action = 'withdraw';
    raise exception 'D3: consent UPDATE must be trigger-blocked for all roles';
  exception when insufficient_privilege then null;
  end;
end $$;

-- D4: account-deletion cascade still removes ledger rows (GDPR path)
do $$
declare remaining int;
begin
  delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';
  select count(*) into remaining from public.consent_records
    where user_id = '00000000-0000-4000-8000-00000000000a';
  if remaining <> 0 then
    raise exception 'D4: account deletion must cascade through the ledgers';
  end if;
end $$;

-- Re-provision Alice for the remaining cases.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
        '{"full_name":"Alice"}', '{"provider":"google"}');

-- ───────────────────────── E: column-level grants ──────────────────────────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

insert into public.sessions (id, user_id, started_at, kind)
values ('00000000-0000-4000-8000-0000000000d2',
        '00000000-0000-4000-8000-00000000000a', now(), 'practice');
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

-- E1: the owner cannot rewrite their own score history
do $$
begin
  begin
    update public.shots set overall_score = 9.9
      where id = '00000000-0000-4000-8000-0000000000e2';
    raise exception 'E1: overall_score must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E2: the owner cannot reassign a row to another user
do $$
begin
  begin
    update public.shots set user_id = '00000000-0000-4000-8000-00000000000b'
      where id = '00000000-0000-4000-8000-0000000000e2';
    raise exception 'E2: user_id must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E3: the owner cannot forge model-version provenance
do $$
begin
  begin
    update public.shots set scoring_model_version = 'forged'
      where id = '00000000-0000-4000-8000-0000000000e2';
    raise exception 'E3: scoring_model_version must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E4: profiles email is trigger-synced only, never client-writable
do $$
begin
  begin
    update public.profiles set email = 'spoof@example.com'
      where id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'E4: profiles.email must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E5: shot detail evidence is write-once (no UPDATE/DELETE grant)
insert into public.shot_phases
  (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
values ('00000000-0000-4000-8000-0000000000e2',
        '00000000-0000-4000-8000-00000000000a', 'prepare', 0, 100, 200, 0.9);
do $$
begin
  begin
    update public.shot_phases set confidence = 1
      where shot_id = '00000000-0000-4000-8000-0000000000e2';
    raise exception 'E5a: shot_phases must not be client-updatable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.shot_phases
      where shot_id = '00000000-0000-4000-8000-0000000000e2';
    raise exception 'E5b: shot_phases must not be client-deletable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- E6: rank state is trigger-maintained; clients cannot write it
do $$
begin
  begin
    update public.player_rank_state set rating = 10
      where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'E6: player_rank_state must not be client-writable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ───────────────────────── F: payload size caps ────────────────────────────

-- F1: oversized session notes rejected
do $$
begin
  begin
    update public.sessions set notes = repeat('x', 5000)
      where id = '00000000-0000-4000-8000-0000000000d2';
    raise exception 'F1: oversized notes must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- F2: oversized evaluation payload rejected
do $$
begin
  begin
    insert into public.evaluation_trials (id, user_id, payload)
    values ('00000000-0000-4000-8000-0000000000f1',
            '00000000-0000-4000-8000-00000000000a',
            jsonb_build_object('blob', repeat('x', 100000)));
    raise exception 'F2: oversized trial payload must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- F3: hostile saved-drill slug rejected
do $$
begin
  begin
    insert into public.user_saved_drills (user_id, slug)
    values ('00000000-0000-4000-8000-00000000000a', '../../../etc/passwd');
    raise exception 'F3: hostile slug must be rejected';
  exception when check_violation then null;
  end;
end $$;

-- ───────────────────────── G: privileged functions ─────────────────────────

-- G1: clients cannot invoke the definer rank recompute directly
do $$
begin
  begin
    perform public.recompute_player_rank('00000000-0000-4000-8000-00000000000b');
    raise exception 'G1: recompute_player_rank must not be client-executable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- G2: clients cannot invoke the provisioning trigger functions
do $$
begin
  begin
    perform public.reject_ledger_mutation();
    raise exception 'G2: reject_ledger_mutation must not be client-executable';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

rollback;

\echo SECURITY REGRESSION MATRIX: ALL CASES PASSED
