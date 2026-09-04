-- ============================================================================
-- Pickle Sensei — cross-user isolation attack matrix (independent harness #1).
--
-- Adversarial companion to security_regression.sql. Two seeded users (Alice
-- the victim, Bob the attacker) plus a FK-attachment pair (Carol/Dave) and an
-- eight-account fuzz pool. Every probe runs the attacker's statement under the
-- exact role + JWT claim PostgREST would set, records the outcome in
-- xc.results (statement text = replayable input), and compares it with the
-- isolation invariant. Alice's complete row-space is hashed before the attack
-- sections and re-hashed at the end: any drift is a P0 mutation leak even if
-- no individual probe noticed.
--
-- Run (see run_xc_cross_user_isolation.sh): shim_auth.sql → every migration →
-- this file. Runs in one transaction and COMMITS so the runner can export
-- xc.results afterwards. Exit is non-zero (raise) when any P0 probe fails.
-- Hygiene probes (severity P3) are recorded and reported, never hidden.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

begin;

-- ---------------------------------------------------------------------------
-- 0. Harness schema (owned by the superuser; never granted to client roles)
-- ---------------------------------------------------------------------------
create schema xc;
revoke all on schema xc from public;

create table xc.results (
  seq         serial primary key,
  section     text not null,
  scenario    text not null,
  severity    text not null,
  actor       text,
  actor_role  text not null,
  kind        text not null,
  statement   text not null,
  expectation text not null,
  observed    text,
  sqlstate    text,
  message     text,
  pass        boolean not null,
  recorded_at timestamptz not null default clock_timestamp()
);

create table xc.ids (name text primary key, id uuid not null);

create function xc.u(p_name text) returns uuid
language sql stable as $$ select id from xc.ids where name = p_name $$;

create function xc.matches(p_observed text, p_state text, p_expect text)
returns boolean
language plpgsql immutable as $$
declare
  alt text;
  n bigint;
begin
  foreach alt in array string_to_array(p_expect, '|') loop
    alt := btrim(alt);
    if alt = 'ok' then
      if p_state is null then return true; end if;
    elsif alt = 'err=any' then
      if p_state is not null then return true; end if;
    elsif alt like 'err=%' then
      if p_state = substr(alt, 5) then return true; end if;
    elsif alt = 'rows>0' then
      if p_state is null and p_observed like 'rows=%' then
        n := substr(p_observed, 6)::bigint;
        if n > 0 then return true; end if;
      end if;
    elsif alt like 'rows=%' or alt like 'value=%' then
      if p_state is null and p_observed = alt then return true; end if;
    else
      raise exception 'xc.matches: unknown expectation token %', alt;
    end if;
  end loop;
  return false;
end $$;

-- One adversarial statement. Runs p_stmt as p_role with request.jwt.claim.sub
-- = p_actor inside a subtransaction; records rows/value/sqlstate; restores the
-- superuser. p_keep=false rolls the statement back after observing it (used
-- for destructive probes so a successful attack cannot poison later sections).
create function xc.probe(
  p_section text, p_scenario text, p_actor uuid, p_role text, p_kind text,
  p_stmt text, p_expect text, p_severity text default 'P0', p_keep boolean default true
) returns boolean
language plpgsql as $$
declare
  v_observed text;
  v_state text;
  v_msg text;
  v_n bigint;
  v_val text;
  v_pass boolean;
  v_table text;
begin
  begin
    execute format('set local role %I', p_role);
    perform set_config('request.jwt.claim.sub', coalesce(p_actor::text, ''), true);
    if p_kind = 'select' then
      execute 'select count(*) from (' || p_stmt || ') xc_q' into v_n;
      v_observed := 'rows=' || v_n;
    elsif p_kind = 'dml' then
      execute p_stmt;
      get diagnostics v_n = row_count;
      v_observed := 'rows=' || v_n;
    elsif p_kind = 'value' then
      execute p_stmt into v_val;
      v_observed := 'value=' || coalesce(v_val, '<null>');
    elsif p_kind = 'truncate' then
      v_table := regexp_replace(regexp_replace(p_stmt, '^\s*truncate\s+(table\s+)?', '', 'i'),
                                '\s+cascade\s*$', '', 'i');
      execute p_stmt;
      execute 'select count(*) from ' || v_table into v_n;
      v_observed := 'rows=' || v_n;
    else
      raise exception 'xc.probe: unknown kind %', p_kind;
    end if;
    if not p_keep then
      raise exception using errcode = 'XC001', message = v_observed;
    end if;
  exception
    when others then
      if sqlstate = 'XC001' then
        v_observed := sqlerrm;
        v_msg := 'rolled back by harness (keep=false)';
      else
        v_state := sqlstate;
        v_msg := sqlerrm;
        v_observed := 'error=' || sqlstate;
      end if;
  end;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  v_pass := xc.matches(v_observed, v_state, p_expect);
  insert into xc.results (section, scenario, severity, actor, actor_role, kind,
                          statement, expectation, observed, sqlstate, message, pass)
  values (p_section, p_scenario, p_severity, p_actor::text, p_role, p_kind,
          p_stmt, p_expect, v_observed, v_state, v_msg, v_pass);
  if not v_pass then
    raise warning 'XC FAIL [%] % :: expected % observed % (%): %',
      p_section, p_scenario, p_expect, v_observed, coalesce(v_state, '-'), p_stmt;
  end if;
  return v_pass;
end $$;

-- Superuser-side truth assertions (ground truth the attacker cannot forge).
create function xc.assert(p_section text, p_scenario text, p_cond boolean,
                          p_detail text, p_severity text default 'P0')
returns boolean
language plpgsql as $$
begin
  insert into xc.results (section, scenario, severity, actor, actor_role, kind,
                          statement, expectation, observed, pass)
  values (p_section, p_scenario, p_severity, null, 'postgres', 'assert',
          p_detail, 'true', coalesce(p_cond::text, 'null'), coalesce(p_cond, false));
  if not coalesce(p_cond, false) then
    raise warning 'XC FAIL [%] % :: %', p_section, p_scenario, p_detail;
  end if;
  return coalesce(p_cond, false);
end $$;

-- Hash of every row a user owns, per table. Any drift after an attack section
-- is a mutation leak regardless of what the attacker's statement reported.
create function xc.snapshot(p_uid uuid) returns jsonb
language plpgsql as $$
declare
  t text;
  h text;
  out jsonb := '{}'::jsonb;
begin
  foreach t in array array[
    'sessions', 'shots', 'shot_phases', 'shot_measurements', 'shot_checkpoints',
    'captures', 'analysis_permits', 'consent_records', 'evaluation_trials',
    'analysis_feedback', 'user_saved_drills', 'player_rank_state',
    'billing_entitlements', 'account_deletion_requests',
    'account_deletion_feedback', 'account_external_credentials'
  ] loop
    execute format(
      'select md5(coalesce(string_agg(r::text, %L order by r::text), %L)) from public.%I r where r.user_id = %L',
      '|', '', t, p_uid) into h;
    out := out || jsonb_build_object(t, h);
  end loop;
  select md5(coalesce(string_agg(r::text, '|' order by r::text), ''))
    into h from public.profiles r where r.id = p_uid;
  out := out || jsonb_build_object('profiles', h);
  return out;
end $$;

create function xc.shot_json(p_id uuid, p_permit uuid, p_session uuid,
                             p_result_kind text default 'scored',
                             p_extra jsonb default '{}'::jsonb)
returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'resultKind', p_result_kind,
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', '2026-09-04T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_result_kind = 'scored' then 6.5 else null end,
    'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(
      jsonb_build_object('key', 'preparation', 'startMs', 0, 'representativeMs', 100, 'endMs', 400, 'confidence', 0.8),
      jsonb_build_object('key', 'contact', 'startMs', 400, 'representativeMs', 500, 'endMs', 600, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(
      jsonb_build_object('key', 'paddle_path', 'score', 70, 'confidence', 0.8, 'band', 'green', 'direction', 'ok', 'severity', 0.1, 'applicable', true))
  ) || p_extra
$$;

-- ---------------------------------------------------------------------------
-- 1. Seed. UUID prefix 1000… so this file can also run after
--    security_regression.sql (prefix 0000…) in the same database.
-- ---------------------------------------------------------------------------
insert into xc.ids (name, id) values
  ('alice',  '10000000-0000-4000-8000-00000000000a'),
  ('bob',    '10000000-0000-4000-8000-00000000000b'),
  ('carol',  '10000000-0000-4000-8000-00000000000c'),
  ('dave',   '10000000-0000-4000-8000-00000000000d'),
  ('sess_a', '10000000-0000-4000-8000-0000000000a1'),
  ('shot_a', '10000000-0000-4000-8000-0000000000a2'),
  ('cap_a',  '10000000-0000-4000-8000-0000000000a3'),
  ('eval_a', '10000000-0000-4000-8000-0000000000a4'),
  ('sess_b', '10000000-0000-4000-8000-0000000000b1'),
  ('shot_b', '10000000-0000-4000-8000-0000000000b2'),
  ('cap_b',  '10000000-0000-4000-8000-0000000000b3'),
  ('eval_b', '10000000-0000-4000-8000-0000000000b4'),
  ('sess_c', '10000000-0000-4000-8000-0000000000c1'),
  ('shot_c', '10000000-0000-4000-8000-0000000000c2'),
  ('cap_c',  '10000000-0000-4000-8000-0000000000c3'),
  ('sess_d', '10000000-0000-4000-8000-0000000000d1'),
  ('shot_d', '10000000-0000-4000-8000-0000000000d2'),
  ('cap_d',  '10000000-0000-4000-8000-0000000000d3'),
  ('shot_d_in_c_sess', '10000000-0000-4000-8000-0000000000d4'),
  ('cap_d_on_c_shot',  '10000000-0000-4000-8000-0000000000d5');

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  (xc.u('alice'), 'xc-alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  (xc.u('bob'),   'xc-bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}'),
  (xc.u('carol'), 'xc-carol@example.com', '{"full_name":"Carol"}', '{"provider":"apple"}'),
  (xc.u('dave'),  'xc-dave@example.com',  '{"full_name":"Dave"}',  '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'xc-google-sub-alice', xc.u('alice'), '{"email":"xc-alice@example.com"}'),
  ('apple',  'xc-apple-sub-bob',    xc.u('bob'),   '{"email":"xc-bob@example.com"}'),
  ('apple',  'xc-apple-sub-carol',  xc.u('carol'), '{"email":"xc-carol@example.com"}'),
  ('google', 'xc-google-sub-dave',  xc.u('dave'),  '{"email":"xc-dave@example.com"}');

-- Service-owned rows (edge function with service role): Alice is premium and
-- holds encrypted external credentials; Bob has neither.
set local role service_role;
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values ('10000000-0000-4000-8000-00000000000a', true, 'pickle_sensei_pro_annual', now() + interval '300 days');
insert into public.account_external_credentials
  (user_id, apple_refresh_token_encrypted, apple_token_captured_at)
values ('10000000-0000-4000-8000-00000000000a', repeat('a', 64), now());
reset role;

-- Alice's owner flow (authenticated, as the edge function performs it).
select xc.probe('SEED', 'alice onboarding patch', xc.u('alice'), 'authenticated', 'dml',
  format($q$update public.profiles set skill_level = 'intermediate', first_name = 'Alice',
         handedness = 'right', focus_checkpoint = 'paddle_path' where id = %L$q$, xc.u('alice')), 'rows=1');
select xc.probe('SEED', 'alice complete_onboarding', xc.u('alice'), 'authenticated', 'value',
  'select public.complete_onboarding()::text', 'ok');
select xc.probe('SEED', 'alice session upsert (PostgREST ignoreDuplicates)', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, kind, started_at, notes)
         values (%L, %L, 'practice', '2026-09-04T09:00:00Z', 'alice private notes')
         on conflict (id) do nothing$q$, xc.u('sess_a'), xc.u('alice')), 'rows=1');
select xc.probe('SEED', 'alice reserve permit 1', xc.u('alice'), 'authenticated', 'value',
  $q$select result from public.reserve_analysis_permit('xc-alice-key-1')$q$, 'value=accepted');
select xc.probe('SEED', 'alice reserve permit 2 (stays reserved)', xc.u('alice'), 'authenticated', 'value',
  $q$select result from public.reserve_analysis_permit('xc-alice-key-2')$q$, 'value=accepted');
insert into xc.ids (name, id)
  select 'permit_a1', id from public.analysis_permits where user_id = xc.u('alice') and idempotency_key = 'xc-alice-key-1';
insert into xc.ids (name, id)
  select 'permit_a2', id from public.analysis_permits where user_id = xc.u('alice') and idempotency_key = 'xc-alice-key-2';
select xc.probe('SEED', 'alice apply_synced_shot', xc.u('alice'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json(xc.u('shot_a'), xc.u('permit_a1'), xc.u('sess_a'))), 'value=accepted');
select xc.probe('SEED', 'alice shot_measurements insert', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
         values (%L, %L, 'hip_rotation', 42.0, 0.9, 'degrees')$q$, xc.u('shot_a'), xc.u('alice')), 'rows=1');
select xc.probe('SEED', 'alice capture insert', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps,
         capture_mode, evidence_status, status)
         values (%L, %L, %L, %L, now(), 3000, 30, 'automatic_pose_trigger', 'valid', 'analyzed')$q$,
         xc.u('cap_a'), xc.u('alice'), xc.u('sess_a'), xc.u('shot_a')), 'rows=1');
select xc.probe('SEED', 'alice consent', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.consent_records (user_id, scope, action, consent_version)
         values (%L, 'model_training', 'grant', 'v1')$q$, xc.u('alice')), 'rows=1');
select xc.probe('SEED', 'alice evaluation trial (PostgREST ignoreDuplicates)', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.evaluation_trials (id, user_id, payload) values (%L, %L, '{"trial":"alice"}')
         on conflict (id) do nothing$q$, xc.u('eval_a'), xc.u('alice')), 'rows=1');
select xc.probe('SEED', 'alice analysis feedback', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.analysis_feedback (user_id, analysis_id, rating, category)
         values (%L, %L, 'helpful', 'accuracy')$q$, xc.u('alice'), xc.u('shot_a')), 'rows=1');
select xc.probe('SEED', 'alice saved drill (PostgREST ignoreDuplicates)', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.user_saved_drills (user_id, slug) values (%L, 'third-shot-drop')
         on conflict (user_id, slug) do nothing$q$, xc.u('alice')), 'rows=1');
select xc.probe('SEED', 'alice deletion request (PostgREST merge-duplicates)', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
         values (%L, gen_random_uuid(), now(), now() + interval '15 minutes')
         on conflict (user_id) do update set challenge = excluded.challenge,
           created_at = excluded.created_at, expires_at = excluded.expires_at$q$, xc.u('alice')), 'rows=1');
select xc.probe('SEED', 'alice deletion feedback', xc.u('alice'), 'authenticated', 'dml',
  format($q$insert into public.account_deletion_feedback (user_id, reason, details)
         values (%L, 'other', 'alice private exit survey')$q$, xc.u('alice')), 'rows=1');

-- Bob's own rows (so reassignment attacks have a source row and owner
-- controls prove the denied paths are not vacuous).
select xc.probe('SEED', 'bob session', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, kind, started_at) values (%L, %L, 'practice', now())
         on conflict (id) do nothing$q$, xc.u('sess_b'), xc.u('bob')), 'rows=1');
select xc.probe('SEED', 'bob reserve permit 1 (stays reserved)', xc.u('bob'), 'authenticated', 'value',
  $q$select result from public.reserve_analysis_permit('xc-bob-key-1')$q$, 'value=accepted');
select xc.probe('SEED', 'bob reserve permit 2', xc.u('bob'), 'authenticated', 'value',
  $q$select result from public.reserve_analysis_permit('xc-bob-key-2')$q$, 'value=accepted');
insert into xc.ids (name, id)
  select 'permit_b1', id from public.analysis_permits where user_id = xc.u('bob') and idempotency_key = 'xc-bob-key-1';
insert into xc.ids (name, id)
  select 'permit_b2', id from public.analysis_permits where user_id = xc.u('bob') and idempotency_key = 'xc-bob-key-2';
select xc.probe('SEED', 'bob apply_synced_shot', xc.u('bob'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json(xc.u('shot_b'), xc.u('permit_b2'), xc.u('sess_b'))), 'value=accepted');
select xc.probe('SEED', 'bob capture', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps,
         capture_mode, evidence_status, status)
         values (%L, %L, %L, %L, now(), 2000, 30, 'imported_video', 'valid', 'analyzed')$q$,
         xc.u('cap_b'), xc.u('bob'), xc.u('sess_b'), xc.u('shot_b')), 'rows=1');
select xc.probe('SEED', 'bob evaluation trial', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.evaluation_trials (id, user_id, payload) values (%L, %L, '{"trial":"bob"}')
         on conflict (id) do nothing$q$, xc.u('eval_b'), xc.u('bob')), 'rows=1');
select xc.probe('SEED', 'bob saved drill', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.user_saved_drills (user_id, slug) values (%L, 'dink-ladder')
         on conflict (user_id, slug) do nothing$q$, xc.u('bob')), 'rows=1');
select xc.probe('SEED', 'bob deletion request', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.account_deletion_requests (user_id) values (%L)
         on conflict (user_id) do update set challenge = excluded.challenge$q$, xc.u('bob')), 'rows=1');

-- Ground truth after seeding.
select xc.assert('SEED', 'alice owns exactly 1 session, 1 shot, 2 phases, 1 checkpoint, 1 measurement, 1 capture',
  (select count(*) from public.sessions where user_id = xc.u('alice')) = 1
  and (select count(*) from public.shots where user_id = xc.u('alice')) = 1
  and (select count(*) from public.shot_phases where user_id = xc.u('alice')) = 2
  and (select count(*) from public.shot_checkpoints where user_id = xc.u('alice')) = 1
  and (select count(*) from public.shot_measurements where user_id = xc.u('alice')) = 1
  and (select count(*) from public.captures where user_id = xc.u('alice')) = 1,
  'seed counts for alice');
select xc.assert('SEED', 'alice rank state exists (trigger)',
  exists (select 1 from public.player_rank_state where user_id = xc.u('alice')), 'player_rank_state row for alice');
select xc.assert('SEED', 'alice permit 2 still reserved / bob permit 1 still reserved',
  (select status from public.analysis_permits where id = xc.u('permit_a2')) = 'reserved'
  and (select status from public.analysis_permits where id = xc.u('permit_b1')) = 'reserved',
  'reserved permits available as attack targets/tools');

create table xc.alice_before as select xc.snapshot(xc.u('alice')) as snap;

-- ---------------------------------------------------------------------------
-- R. Cross-user READS (Bob → Alice): every table, by victim id and by
--    victim user_id, plus derived views and identity-scoped RPCs.
-- ---------------------------------------------------------------------------
select xc.probe('R', 'R01 sessions by victim id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.sessions where id = %L', xc.u('sess_a')), 'rows=0');
select xc.probe('R', 'R02 sessions by victim user_id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.sessions where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R03 shots by victim id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.shots where id = %L', xc.u('shot_a')), 'rows=0');
select xc.probe('R', 'R04 shots by victim session', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.shots where session_id = %L', xc.u('sess_a')), 'rows=0');
select xc.probe('R', 'R05 shot_phases by victim shot', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.shot_phases where shot_id = %L', xc.u('shot_a')), 'rows=0');
select xc.probe('R', 'R06 shot_checkpoints by victim shot', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.shot_checkpoints where shot_id = %L', xc.u('shot_a')), 'rows=0');
select xc.probe('R', 'R07 shot_measurements by victim shot', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.shot_measurements where shot_id = %L', xc.u('shot_a')), 'rows=0');
select xc.probe('R', 'R08 captures by victim id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.captures where id = %L', xc.u('cap_a')), 'rows=0');
select xc.probe('R', 'R09 analysis_permits by victim user_id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.analysis_permits where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R10 analysis_permits by victim permit id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.analysis_permits where id = %L', xc.u('permit_a2')), 'rows=0');
select xc.probe('R', 'R11 analysis_permits by colliding idempotency key', xc.u('bob'), 'authenticated', 'select',
  $q$select * from public.analysis_permits where idempotency_key = 'xc-alice-key-2'$q$, 'rows=0');
select xc.probe('R', 'R12 profiles by victim id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.profiles where id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R13 profiles by victim email', xc.u('bob'), 'authenticated', 'select',
  $q$select * from public.profiles where email = 'xc-alice@example.com'$q$, 'rows=0');
select xc.probe('R', 'R14 billing_entitlements by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.billing_entitlements where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R15 billing_entitlements premium scan', xc.u('bob'), 'authenticated', 'select',
  'select * from public.billing_entitlements where premium', 'rows=0');
select xc.probe('R', 'R16 player_rank_state by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.player_rank_state where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R17 consent_records by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.consent_records where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R18 evaluation_trials by victim trial id', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.evaluation_trials where id = %L', xc.u('eval_a')), 'rows=0');
select xc.probe('R', 'R19 analysis_feedback by victim analysis', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.analysis_feedback where analysis_id = %L', xc.u('shot_a')), 'rows=0');
select xc.probe('R', 'R20 user_saved_drills by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.user_saved_drills where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R21 account_deletion_requests by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.account_deletion_requests where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R22 account_deletion_requests challenge scan', xc.u('bob'), 'authenticated', 'select',
  'select challenge from public.account_deletion_requests', 'rows=1');
select xc.probe('R', 'R23 account_deletion_feedback (service-only)', xc.u('bob'), 'authenticated', 'select',
  'select * from public.account_deletion_feedback', 'err=42501');
select xc.probe('R', 'R24 account_external_credentials (service-only)', xc.u('bob'), 'authenticated', 'select',
  'select * from public.account_external_credentials', 'err=42501');
select xc.probe('R', 'R25 free_rating_ledger (service-only)', xc.u('bob'), 'authenticated', 'select',
  'select * from public.free_rating_ledger', 'err=42501');
select xc.probe('R', 'R26 webhook_events (service-only)', xc.u('bob'), 'authenticated', 'select',
  'select * from public.webhook_events', 'err=42501');
select xc.probe('R', 'R27 view player_technique_rating by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.player_technique_rating where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R28 view progress_daily by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.progress_daily where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R29 view practice_days by victim', xc.u('bob'), 'authenticated', 'select',
  format('select * from public.practice_days where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('R', 'R30 unfiltered scans return only own rows (sessions+shots+captures+permits+drills+profiles)', xc.u('bob'), 'authenticated', 'select',
  $q$select 1 from public.sessions union all select 1 from public.shots union all select 1 from public.captures
     union all select 1 from public.analysis_permits union all select 1 from public.user_saved_drills
     union all select 1 from public.profiles$q$, 'rows=7');
select xc.probe('R', 'R31 join through victim session (sessions⋈shots)', xc.u('bob'), 'authenticated', 'select',
  format('select s.notes from public.sessions s join public.shots sh on sh.session_id = s.id where s.id = %L', xc.u('sess_a')), 'rows=0');
select xc.probe('R', 'R32 exists() side channel on victim shot', xc.u('bob'), 'authenticated', 'value',
  format('select exists(select 1 from public.shots where id = %L)::text', xc.u('shot_a')), 'value=false');
select xc.probe('R', 'R33 access_state() reflects only bob (alice is premium)', xc.u('bob'), 'authenticated', 'value',
  'select premium::text || '','' || scored_count || '','' || reserved_count from public.access_state()', 'value=false,1,1');
select xc.probe('R', 'R34 lifetime_scored_count() is bob-scoped', xc.u('bob'), 'authenticated', 'value',
  'select public.lifetime_scored_count()::text', 'value=1');
select xc.probe('R', 'R35 identity_scored_count() (definer) is bob-scoped', xc.u('bob'), 'authenticated', 'value',
  'select public.identity_scored_count()::text', 'value=1');
-- Owner controls: the same reads succeed for Alice, so the denials above are real.
select xc.probe('R', 'R90 owner control: alice sees her session', xc.u('alice'), 'authenticated', 'select',
  format('select * from public.sessions where id = %L', xc.u('sess_a')), 'rows=1');
select xc.probe('R', 'R91 owner control: alice sees her shot details', xc.u('alice'), 'authenticated', 'select',
  format('select * from public.shot_phases where shot_id = %L', xc.u('shot_a')), 'rows=2');
select xc.probe('R', 'R92 owner control: alice sees her billing', xc.u('alice'), 'authenticated', 'select',
  'select * from public.billing_entitlements where premium', 'rows=1');
select xc.probe('R', 'R93 owner control: alice access_state()', xc.u('alice'), 'authenticated', 'value',
  'select premium::text || '','' || scored_count || '','' || reserved_count from public.access_state()', 'value=true,1,1');
select xc.probe('R', 'R94 owner control: alice technique rating view', xc.u('alice'), 'authenticated', 'select',
  'select * from public.player_technique_rating', 'rows=1');

-- ---------------------------------------------------------------------------
-- W. Cross-user WRITES: spoofed-owner inserts (every insertable table),
--    inserts into service-only tables, and inserts through views.
-- ---------------------------------------------------------------------------
select xc.probe('W', 'W01 insert session owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), %L, now())$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W02 insert session with alice id AND alice owner (RLS must fire before PK)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, started_at) values (%L, %L, now())$q$, xc.u('sess_a'), xc.u('alice')), 'err=42501');
select xc.probe('W', 'W03 insert shot owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, analysis_confidence,
         result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
         stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
         values (gen_random_uuid(), %L, 'drive', now(), 0, 1000, 0.5, 'low_confidence',
         '1','1','1','1','1','1','1','1')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W04 insert shot_phases owned by alice on alice shot', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
         values (%L, %L, 'follow_through', 600, 700, 900, 0.5)$q$, xc.u('shot_a'), xc.u('alice')), 'err=42501');
select xc.probe('W', 'W05 insert shot_checkpoints owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
         values (%L, %L, 'spoof', 1, 0.5, 'red', 'x', 0.5, true)$q$, xc.u('shot_a'), xc.u('alice')), 'err=42501');
select xc.probe('W', 'W06 insert shot_measurements owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
         values (%L, %L, 'spoof', 1, 0.5, 'count')$q$, xc.u('shot_a'), xc.u('alice')), 'err=42501');
select xc.probe('W', 'W07 insert capture owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
         values (gen_random_uuid(), %L, now(), 1, 30, 'imported_video', 'valid')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W08 insert analysis_permit owned by alice (direct, bypassing RPC)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.analysis_permits (user_id, idempotency_key) values (%L, 'xc-forged')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W09 insert consent owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.consent_records (user_id, scope, action) values (%L, 'model_training', 'withdraw')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W10 insert evaluation trial owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.evaluation_trials (id, user_id, payload) values (gen_random_uuid(), %L, '{}')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W11 insert analysis_feedback owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.analysis_feedback (user_id, analysis_id, rating) values (%L, %L, 'bad')$q$, xc.u('alice'), xc.u('shot_a')), 'err=42501');
select xc.probe('W', 'W12 insert saved drill owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.user_saved_drills (user_id, slug) values (%L, 'planted-drill')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W13 insert deletion request owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.account_deletion_requests (user_id) values (%L)$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W14 insert deletion feedback owned by alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.account_deletion_feedback (user_id, reason) values (%L, 'other')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W15 insert profile row for alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.profiles (id, provider) values (%L, 'apple')$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W16 insert billing for bob (client can never grant premium)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.billing_entitlements (user_id, premium) values (%L, true)$q$, xc.u('bob')), 'err=42501');
select xc.probe('W', 'W17 insert billing for alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.billing_entitlements (user_id, premium) values (%L, false)$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W18 insert player_rank_state for alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.player_rank_state (user_id, rating, tier, technique_count, scored_shot_count)
         values (%L, 1, 'bronze', 1, 1)$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W19 insert free_rating_ledger', xc.u('bob'), 'authenticated', 'dml',
  $q$insert into public.free_rating_ledger (identity_hash, scored_count) values (repeat('0', 64), 0)$q$, 'err=42501');
select xc.probe('W', 'W20 insert external credentials for alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.account_external_credentials (user_id) values (%L)$q$, xc.u('alice')), 'err=42501');
select xc.probe('W', 'W21 insert through view progress_daily', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.progress_daily (user_id) values (%L)$q$, xc.u('alice')), 'err=any');
select xc.probe('W', 'W22 insert through view player_technique_rating', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.player_technique_rating (user_id) values (%L)$q$, xc.u('alice')), 'err=any');
select xc.probe('W', 'W23 insert through view practice_days', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.practice_days (user_id) values (%L)$q$, xc.u('alice')), 'err=any');
select xc.probe('W', 'W24 insert with NULL owner (orphan invisible to every owner)', xc.u('bob'), 'authenticated', 'dml',
  $q$insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), null, now())$q$, 'err=any');
select xc.probe('W', 'W90 owner control: bob inserts his own consent', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.consent_records (user_id, scope, action) values (%L, 'model_training', 'grant')$q$, xc.u('bob')), 'rows=1');

-- ---------------------------------------------------------------------------
-- U. Cross-user UPDATES and owner reassignment.
-- ---------------------------------------------------------------------------
select xc.probe('U', 'U01 finalize alice session', xc.u('bob'), 'authenticated', 'dml',
  format('update public.sessions set ended_at = now() where id = %L', xc.u('sess_a')), 'rows=0');
select xc.probe('U', 'U02 unfiltered session update touches only own rows', xc.u('bob'), 'authenticated', 'dml',
  'update public.sessions set ended_at = now()', 'rows=1', 'P0', false);
select xc.probe('U', 'U03 edit alice profile', xc.u('bob'), 'authenticated', 'dml',
  format($q$update public.profiles set first_name = 'pwned', skill_level = 'pro' where id = %L$q$, xc.u('alice')), 'rows=0');
select xc.probe('U', 'U04 unfiltered profile update touches only own row', xc.u('bob'), 'authenticated', 'dml',
  $q$update public.profiles set first_name = 'pwned'$q$, 'rows=1', 'P0', false);
select xc.probe('U', 'U05 release alice reserved permit', xc.u('bob'), 'authenticated', 'dml',
  format($q$update public.analysis_permits set status = 'released', outcome = 'stolen' where id = %L$q$, xc.u('permit_a2')), 'rows=0');
select xc.probe('U', 'U06 finalize every reserved permit (unfiltered)', xc.u('bob'), 'authenticated', 'dml',
  $q$update public.analysis_permits set status = 'finalized' where status = 'reserved'$q$, 'rows=1', 'P0', false);
select xc.probe('U', 'U07 re-arm alice deletion challenge', xc.u('bob'), 'authenticated', 'dml',
  format('update public.account_deletion_requests set expires_at = now() + interval ''1 year'' where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('U', 'U08 edit alice capture', xc.u('bob'), 'authenticated', 'dml',
  format($q$update public.captures set status = 'awaiting_model' where id = %L$q$, xc.u('cap_a')), 'rows=0');
select xc.probe('U', 'U09 edit alice saved drill', xc.u('bob'), 'authenticated', 'dml',
  format('update public.user_saved_drills set saved_at = now() where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('U', 'U10 update alice shot (no client UPDATE grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.shots set overall_score = 0 where id = %L', xc.u('shot_a')), 'err=42501');
select xc.probe('U', 'U11 update alice shot_phases (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.shot_phases set confidence = 0 where shot_id = %L', xc.u('shot_a')), 'err=42501');
select xc.probe('U', 'U12 update alice consent (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format($q$update public.consent_records set action = 'withdraw' where user_id = %L$q$, xc.u('alice')), 'err=42501');
select xc.probe('U', 'U13 update alice billing (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.billing_entitlements set premium = false where user_id = %L', xc.u('alice')), 'err=42501');
select xc.probe('U', 'U14 update own billing to premium (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.billing_entitlements set premium = true where user_id = %L', xc.u('bob')), 'err=42501');
select xc.probe('U', 'U15 update alice rank state (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.player_rank_state set rating = 0 where user_id = %L', xc.u('alice')), 'err=42501');
-- Owner reassignment: move Bob's own row into Alice's row-space (WITH CHECK)
-- or pull Alice's row into Bob's.
select xc.probe('U', 'U20 reassign own capture to alice', xc.u('bob'), 'authenticated', 'dml',
  format('update public.captures set user_id = %L where id = %L', xc.u('alice'), xc.u('cap_b')), 'err=42501');
select xc.probe('U', 'U21 reassign own saved drill to alice', xc.u('bob'), 'authenticated', 'dml',
  format('update public.user_saved_drills set user_id = %L where user_id = %L', xc.u('alice'), xc.u('bob')), 'err=42501');
select xc.probe('U', 'U22 reassign own deletion request to alice (user_id IS in the column grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.account_deletion_requests set user_id = %L where user_id = %L', xc.u('alice'), xc.u('bob')), 'err=42501');
select xc.probe('U', 'U23 reassign own permit to alice (no column grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.analysis_permits set user_id = %L where id = %L', xc.u('alice'), xc.u('permit_b1')), 'err=42501');
select xc.probe('U', 'U24 reassign own session to alice (no column grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.sessions set user_id = %L where id = %L', xc.u('alice'), xc.u('sess_b')), 'err=42501');
select xc.probe('U', 'U25 rename own profile id to alice (no column grant)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.profiles set id = %L where id = %L', xc.u('alice'), xc.u('bob')), 'err=42501');
select xc.probe('U', 'U26 pull alice capture into own row-space (USING fails first)', xc.u('bob'), 'authenticated', 'dml',
  format('update public.captures set user_id = %L where id = %L', xc.u('bob'), xc.u('cap_a')), 'rows=0');
select xc.probe('U', 'U27 pull alice deletion request into own row-space', xc.u('bob'), 'authenticated', 'dml',
  format('update public.account_deletion_requests set user_id = %L where user_id = %L', xc.u('bob'), xc.u('alice')), 'rows=0');
select xc.probe('U', 'U28 profile email/display_name not client-writable', xc.u('bob'), 'authenticated', 'dml',
  format($q$update public.profiles set email = 'x@example.com', display_name = 'x' where id = %L$q$, xc.u('bob')), 'err=42501');
select xc.probe('U', 'U90 owner control: bob finalizes his own session', xc.u('bob'), 'authenticated', 'dml',
  format('update public.sessions set ended_at = now() where id = %L', xc.u('sess_b')), 'rows=1');

-- ---------------------------------------------------------------------------
-- D. Cross-user DELETES.
-- ---------------------------------------------------------------------------
select xc.probe('D', 'D01 delete alice session', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.sessions where id = %L', xc.u('sess_a')), 'rows=0');
select xc.probe('D', 'D02 unfiltered session delete touches only own rows', xc.u('bob'), 'authenticated', 'dml',
  'delete from public.sessions', 'rows=1', 'P0', false);
select xc.probe('D', 'D03 delete alice permit', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.analysis_permits where id = %L', xc.u('permit_a2')), 'rows=0');
select xc.probe('D', 'D04 unfiltered permit delete touches only own rows', xc.u('bob'), 'authenticated', 'dml',
  'delete from public.analysis_permits', 'rows=2', 'P0', false);
select xc.probe('D', 'D05 delete alice capture', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.captures where id = %L', xc.u('cap_a')), 'rows=0');
select xc.probe('D', 'D06 delete alice saved drill', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.user_saved_drills where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('D', 'D07 cancel alice deletion request', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.account_deletion_requests where user_id = %L', xc.u('alice')), 'rows=0');
select xc.probe('D', 'D08 unfiltered deletion-request delete touches only own row', xc.u('bob'), 'authenticated', 'dml',
  'delete from public.account_deletion_requests', 'rows=1', 'P0', false);
select xc.probe('D', 'D09 delete alice shot (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.shots where id = %L', xc.u('shot_a')), 'err=42501');
select xc.probe('D', 'D10 delete alice shot_phases (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.shot_phases where shot_id = %L', xc.u('shot_a')), 'err=42501');
select xc.probe('D', 'D11 delete alice consent (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.consent_records where user_id = %L', xc.u('alice')), 'err=42501');
select xc.probe('D', 'D12 delete alice evaluation trial (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.evaluation_trials where id = %L', xc.u('eval_a')), 'err=42501');
select xc.probe('D', 'D13 delete alice analysis_feedback (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.analysis_feedback where user_id = %L', xc.u('alice')), 'err=42501');
select xc.probe('D', 'D14 delete alice profile (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.profiles where id = %L', xc.u('alice')), 'err=42501');
select xc.probe('D', 'D15 delete alice billing (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.billing_entitlements where user_id = %L', xc.u('alice')), 'err=42501');
select xc.probe('D', 'D16 delete alice rank state (no grant)', xc.u('bob'), 'authenticated', 'dml',
  format('delete from public.player_rank_state where user_id = %L', xc.u('alice')), 'err=42501');
select xc.probe('D', 'D90 owner control: bob deletes his own saved drill', xc.u('bob'), 'authenticated', 'dml',
  format($q$delete from public.user_saved_drills where user_id = %L and slug = 'dink-ladder'$q$, xc.u('bob')), 'rows=1', 'P0', false);

-- ---------------------------------------------------------------------------
-- P. PostgREST-style UPSERTS against the victim's primary keys.
--    ignoreDuplicates → ON CONFLICT DO NOTHING; merge-duplicates → DO UPDATE
--    SET every payload column (this is how the edge function syncs sessions,
--    trials, saved drills and deletion requests).
-- ---------------------------------------------------------------------------
select xc.probe('P', 'P01 sessions ignoreDuplicates on alice id (own user_id)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, started_at, notes) values (%L, %L, now(), 'bob squat')
         on conflict (id) do nothing$q$, xc.u('sess_a'), xc.u('bob')), 'rows=0');
select xc.assert('P', 'P01b alice session untouched by squat',
  (select user_id = xc.u('alice') and notes = 'alice private notes' from public.sessions where id = xc.u('sess_a')),
  'sessions row sess_a still owned by alice with original notes');
select xc.probe('P', 'P02 sessions merge-duplicates on alice id (own user_id → steal)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, started_at, ended_at) values (%L, %L, now(), now())
         on conflict (id) do update set user_id = excluded.user_id, ended_at = excluded.ended_at$q$,
         xc.u('sess_a'), xc.u('bob')), 'err=42501');
select xc.probe('P', 'P03 sessions merge-duplicates on alice id (alice user_id → edit)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, started_at, ended_at) values (%L, %L, now(), now())
         on conflict (id) do update set ended_at = excluded.ended_at$q$, xc.u('sess_a'), xc.u('alice')), 'err=42501');
select xc.probe('P', 'P04 shots merge-duplicates on alice shot id', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, analysis_confidence,
         result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
         stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
         values (%L, %L, 'drive', now(), 0, 1000, 0.5, 'low_confidence', '1','1','1','1','1','1','1','1')
         on conflict (id) do update set user_id = excluded.user_id, result_kind = excluded.result_kind$q$,
         xc.u('shot_a'), xc.u('bob')), 'err=42501');
select xc.probe('P', 'P05 shots ignoreDuplicates on alice shot id', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms, analysis_confidence,
         result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
         stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
         values (%L, %L, 'drive', now(), 0, 1000, 0.5, 'low_confidence', '1','1','1','1','1','1','1','1')
         on conflict (id) do nothing$q$, xc.u('shot_a'), xc.u('bob')), 'rows=0');
select xc.probe('P', 'P06 captures merge-duplicates on alice capture id', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
         values (%L, %L, now(), 1, 30, 'imported_video', 'corrupt')
         on conflict (id) do update set user_id = excluded.user_id, evidence_status = excluded.evidence_status$q$,
         xc.u('cap_a'), xc.u('bob')), 'err=42501');
select xc.probe('P', 'P07 evaluation_trials ignoreDuplicates on alice trial id', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.evaluation_trials (id, user_id, payload) values (%L, %L, '{"x":1}')
         on conflict (id) do nothing$q$, xc.u('eval_a'), xc.u('bob')), 'rows=0');
select xc.probe('P', 'P08 evaluation_trials merge-duplicates on alice trial id', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.evaluation_trials (id, user_id, payload) values (%L, %L, '{"x":1}')
         on conflict (id) do update set payload = excluded.payload, user_id = excluded.user_id$q$,
         xc.u('eval_a'), xc.u('bob')), 'err=42501');
select xc.probe('P', 'P09 user_saved_drills upsert spoofing alice (drill exists)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.user_saved_drills (user_id, slug) values (%L, 'third-shot-drop')
         on conflict (user_id, slug) do nothing$q$, xc.u('alice')), 'err=42501');
select xc.probe('P', 'P10 user_saved_drills upsert spoofing alice (drill absent) — same error, no oracle', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.user_saved_drills (user_id, slug) values (%L, 'never-saved-drill')
         on conflict (user_id, slug) do nothing$q$, xc.u('alice')), 'err=42501');
select xc.probe('P', 'P11 deletion request merge-duplicates spoofing alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
         values (%L, gen_random_uuid(), now(), now() + interval '15 minutes')
         on conflict (user_id) do update set user_id = excluded.user_id, challenge = excluded.challenge,
           created_at = excluded.created_at, expires_at = excluded.expires_at$q$, xc.u('alice')), 'err=42501');
select xc.probe('P', 'P12 analysis_permits upsert on (user_id, key) spoofing alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.analysis_permits (user_id, idempotency_key, status) values (%L, 'xc-alice-key-2', 'released')
         on conflict (user_id, idempotency_key) do update set status = excluded.status$q$, xc.u('alice')), 'err=42501');
select xc.probe('P', 'P13 analysis_permits upsert on alice permit id (own user_id → steal)', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.analysis_permits (id, user_id, idempotency_key) values (%L, %L, 'xc-steal')
         on conflict (id) do update set user_id = excluded.user_id$q$, xc.u('permit_a2'), xc.u('bob')), 'err=42501');
select xc.probe('P', 'P14 shot_phases upsert on alice (shot_id, phase_key) with own user_id', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
         values (%L, %L, 'contact', 0, 0, 0, 0)
         on conflict (shot_id, phase_key) do update set user_id = excluded.user_id, confidence = 0$q$,
         xc.u('shot_a'), xc.u('bob')), 'err=42501');
select xc.probe('P', 'P15 profiles merge-duplicates on alice id', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.profiles (id, provider) values (%L, 'apple')
         on conflict (id) do update set first_name = 'pwned'$q$, xc.u('alice')), 'err=42501');
select xc.probe('P', 'P16 billing merge-duplicates on alice', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.billing_entitlements (user_id, premium) values (%L, false)
         on conflict (user_id) do update set premium = false$q$, xc.u('alice')), 'err=42501');
select xc.probe('P', 'P90 owner control: bob merge-duplicates his own deletion request', xc.u('bob'), 'authenticated', 'dml',
  format($q$insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
         values (%L, gen_random_uuid(), now(), now() + interval '15 minutes')
         on conflict (user_id) do update set user_id = excluded.user_id, challenge = excluded.challenge,
           created_at = excluded.created_at, expires_at = excluded.expires_at$q$, xc.u('bob')), 'rows=1');

-- ---------------------------------------------------------------------------
-- X. RPC surface (the only write path the edge function uses for shots).
-- ---------------------------------------------------------------------------
select xc.probe('X', 'X01 apply_synced_shot with alice reserved permit', xc.u('bob'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json('10000000-0000-4000-8000-0000000000e1', xc.u('permit_a2'), null)), 'value=access.permit_not_found');
select xc.probe('X', 'X02 apply_synced_shot with alice finalized permit', xc.u('bob'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json('10000000-0000-4000-8000-0000000000e2', xc.u('permit_a1'), null)), 'value=access.permit_not_found');
select xc.probe('X', 'X03 apply_synced_shot own permit into alice session', xc.u('bob'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json('10000000-0000-4000-8000-0000000000e3', xc.u('permit_b1'), xc.u('sess_a'))), 'value=shot.session_not_found');
select xc.probe('X', 'X04 apply_synced_shot own permit onto alice shot id (overwrite)', xc.u('bob'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json(xc.u('shot_a'), xc.u('permit_b1'), null)), 'value=shot.id_conflict');
select xc.probe('X', 'X05 apply_synced_shot with forged userId/user_id keys (ignored)', xc.u('bob'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json('10000000-0000-4000-8000-0000000000e5', xc.u('permit_a2'), null, 'scored',
                      jsonb_build_object('userId', xc.u('alice'), 'user_id', xc.u('alice')))), 'value=access.permit_not_found');
select xc.assert('X', 'X04b alice shot untouched after id-conflict attempt',
  (select user_id = xc.u('alice') and overall_score = 6.5 from public.shots where id = xc.u('shot_a')),
  'shots row shot_a still alice, score 6.5');
select xc.assert('X', 'X04c bob permit still reserved after failed cross-user syncs',
  (select status from public.analysis_permits where id = xc.u('permit_b1')) = 'reserved',
  'permit_b1 status reserved (atomic block rolled back)');
select xc.assert('X', 'X01b alice reserved permit untouched',
  (select status = 'reserved' and outcome is null from public.analysis_permits where id = xc.u('permit_a2')),
  'permit_a2 still reserved with null outcome');
-- Bob has spent one free rating and holds one reserved permit, so his
-- allowance is exhausted: a colliding key must NOT hand him Alice's permit.
select xc.probe('X', 'X06 exhausted bob reserves with alice idempotency key (must not return her permit)', xc.u('bob'), 'authenticated', 'value',
  $q$select result || ':' || coalesce(permit_id::text, 'none') from public.reserve_analysis_permit('xc-alice-key-2')$q$,
  'value=access.paywall_required:none');
-- Dave has a fresh allowance: the colliding key yields a NEW dave-owned permit.
select xc.probe('X', 'X06a dave reserves with alice idempotency key (gets his own permit)', xc.u('dave'), 'authenticated', 'value',
  format($q$select result || ':' || (permit_id <> %L::uuid)::text from public.reserve_analysis_permit('xc-alice-key-2')$q$, xc.u('permit_a2')),
  'value=accepted:true');
select xc.assert('X', 'X06b colliding key produced a dave-owned permit, alice permit unchanged',
  (select count(*) from public.analysis_permits where idempotency_key = 'xc-alice-key-2') = 2
  and (select count(*) from public.analysis_permits where idempotency_key = 'xc-alice-key-2' and user_id = xc.u('dave')) = 1
  and (select status from public.analysis_permits where id = xc.u('permit_a2')) = 'reserved',
  'two permits share the key, one per user');
select xc.probe('X', 'X07 dave replays the key: caller-scoped fast path returns HIS permit (RLS-visible one)', xc.u('dave'), 'authenticated', 'value',
  $q$select (permit_id = (select id from public.analysis_permits where idempotency_key = 'xc-alice-key-2'))::text
     from public.reserve_analysis_permit('xc-alice-key-2')$q$, 'value=true');
select xc.probe('X', 'X07b dave cannot see alice permit sharing the key', xc.u('dave'), 'authenticated', 'select',
  format('select * from public.analysis_permits where id = %L', xc.u('permit_a2')), 'rows=0');
select xc.probe('X', 'X08 recompute_player_rank(alice) not executable by clients', xc.u('bob'), 'authenticated', 'value',
  format('select public.recompute_player_rank(%L)::text', xc.u('alice')), 'err=42501');
select xc.probe('X', 'X09 free_rating_identity_hash not executable by clients', xc.u('bob'), 'authenticated', 'value',
  $q$select public.free_rating_identity_hash('google', 'xc-google-sub-alice')$q$, 'err=42501');
select xc.probe('X', 'X10 trigger functions not executable by clients', xc.u('bob'), 'authenticated', 'value',
  'select public.record_scored_shot_in_ledger()::text', 'err=42501|err=0A000');
select xc.probe('X', 'X11 complete_onboarding() only touches own profile', xc.u('bob'), 'authenticated', 'value',
  'select public.complete_onboarding()::text', 'ok');
select xc.assert('X', 'X11b alice onboarding_state unchanged by bob complete_onboarding',
  (select onboarding_state from public.profiles where id = xc.u('alice')) = 'complete'
  and (select onboarding_state from public.profiles where id = xc.u('bob')) = 'complete',
  'both profiles complete; bob call did not touch alice (alice completed in SEED)');
select xc.probe('X', 'X12 access_lock_key(alice) executable? (informational; pg_advisory_* is not reachable through PostgREST)', xc.u('bob'), 'authenticated', 'value',
  format('select public.access_lock_key(%L)::text', xc.u('alice')), 'ok|err=42501', 'P3');

-- ---------------------------------------------------------------------------
-- A. Anonymous role with a FORGED sub claim = alice (anon key + crafted
--    header): every path must be denied by grants, not just by RLS.
-- ---------------------------------------------------------------------------
select xc.probe('A', 'A01 anon+forged sub reads sessions', xc.u('alice'), 'anon', 'select',
  'select * from public.sessions', 'err=42501');
select xc.probe('A', 'A02 anon+forged sub reads profiles', xc.u('alice'), 'anon', 'select',
  'select * from public.profiles', 'err=42501');
select xc.probe('A', 'A03 anon+forged sub reads shots', xc.u('alice'), 'anon', 'select',
  'select * from public.shots', 'err=42501');
select xc.probe('A', 'A04 anon+forged sub reads billing', xc.u('alice'), 'anon', 'select',
  'select * from public.billing_entitlements', 'err=42501');
select xc.probe('A', 'A05 anon+forged sub access_state()', xc.u('alice'), 'anon', 'value',
  'select premium::text from public.access_state()', 'err=42501');
select xc.probe('A', 'A06 anon+forged sub reserve_analysis_permit', xc.u('alice'), 'anon', 'value',
  $q$select result from public.reserve_analysis_permit('anon-key')$q$, 'err=42501');
select xc.probe('A', 'A07 anon+forged sub apply_synced_shot', xc.u('alice'), 'anon', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json('10000000-0000-4000-8000-0000000000e7', xc.u('permit_a2'), null)), 'err=42501');
select xc.probe('A', 'A08 anon+forged sub inserts session', xc.u('alice'), 'anon', 'dml',
  format('insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), %L, now())', xc.u('alice')), 'err=42501');
select xc.probe('A', 'A09 anon+forged sub deletes deletion request', xc.u('alice'), 'anon', 'dml',
  format('delete from public.account_deletion_requests where user_id = %L', xc.u('alice')), 'err=42501');
select xc.probe('A', 'A10 anon+forged sub reads views', xc.u('alice'), 'anon', 'select',
  'select * from public.player_technique_rating', 'err=42501');
select xc.probe('A', 'A11 authenticated role with NO sub claim sees nothing', null, 'authenticated', 'select',
  'select * from public.sessions union all select * from public.sessions', 'rows=0');
select xc.probe('A', 'A12 authenticated role with NO sub claim cannot reserve', null, 'authenticated', 'value',
  $q$select result from public.reserve_analysis_permit('nosub')$q$, 'value=auth.required');

-- ---------------------------------------------------------------------------
-- F. FK cross-owner attachment (Dave → Carol). FK checks run as table owner
--    and bypass RLS, so a child row can reference a victim's parent id.
--    Invariants: the victim never sees the attacker's rows, the attacker
--    never sees the victim's, and the victim's account deletion is NOT
--    blocked. The attachment result itself is recorded as informational.
-- ---------------------------------------------------------------------------
select xc.probe('SEED', 'carol session', xc.u('carol'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, started_at) values (%L, %L, now())$q$, xc.u('sess_c'), xc.u('carol')), 'rows=1');
select xc.probe('SEED', 'carol reserve permit', xc.u('carol'), 'authenticated', 'value',
  $q$select result from public.reserve_analysis_permit('xc-carol-key-1')$q$, 'value=accepted');
insert into xc.ids (name, id)
  select 'permit_c1', id from public.analysis_permits where user_id = xc.u('carol') and idempotency_key = 'xc-carol-key-1';
select xc.probe('SEED', 'carol apply_synced_shot', xc.u('carol'), 'authenticated', 'value',
  format('select public.apply_synced_shot(%L::jsonb)',
         xc.shot_json(xc.u('shot_c'), xc.u('permit_c1'), xc.u('sess_c'))), 'value=accepted');
select xc.probe('SEED', 'dave session', xc.u('dave'), 'authenticated', 'dml',
  format($q$insert into public.sessions (id, user_id, started_at) values (%L, %L, now())$q$, xc.u('sess_d'), xc.u('dave')), 'rows=1');

select xc.probe('F', 'F01 dave attaches phase to carol shot (own user_id) — informational', xc.u('dave'), 'authenticated', 'dml',
  format($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
         values (%L, %L, 'dave_phase', 0, 0, 0, 0.1)$q$, xc.u('shot_c'), xc.u('dave')), 'ok|err=42501|err=23503', 'P3');
select xc.probe('F', 'F02 dave attaches phase with FK existence oracle (random shot id)', xc.u('dave'), 'authenticated', 'dml',
  format($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
         values (%L, %L, 'dave_phase', 0, 0, 0, 0.1)$q$, '10000000-0000-4000-8000-00000000ffff', xc.u('dave')), 'err=42501|err=23503', 'P3');
select xc.probe('F', 'F03 dave squats carol phase key (PK collision → oracle)', xc.u('dave'), 'authenticated', 'dml',
  format($q$insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
         values (%L, %L, 'contact', 0, 0, 0, 0.1)$q$, xc.u('shot_c'), xc.u('dave')), 'err=42501|err=23505', 'P3');
select xc.probe('F', 'F04 dave inserts own shot into carol session — informational', xc.u('dave'), 'authenticated', 'dml',
  format($q$insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms, analysis_confidence,
         result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
         stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
         values (%L, %L, %L, 'drive', now(), 0, 1000, 0.5, 'low_confidence', '1','1','1','1','1','1','1','1')$q$,
         xc.u('shot_d_in_c_sess'), xc.u('dave'), xc.u('sess_c')), 'ok|err=42501|err=23503', 'P3');
select xc.probe('F', 'F05 dave inserts own capture pointing at carol shot+session — informational', xc.u('dave'), 'authenticated', 'dml',
  format($q$insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
         values (%L, %L, %L, %L, now(), 1, 30, 'imported_video', 'valid')$q$,
         xc.u('cap_d_on_c_shot'), xc.u('dave'), xc.u('sess_c'), xc.u('shot_c')), 'ok|err=42501|err=23503', 'P3');
select xc.probe('F', 'F06 dave leaves feedback on carol analysis id (no FK) — informational', xc.u('dave'), 'authenticated', 'dml',
  format($q$insert into public.analysis_feedback (user_id, analysis_id, rating) values (%L, %L, 'spam')$q$,
         xc.u('dave'), xc.u('shot_c')), 'ok|err=42501', 'P3');
-- Invariants that MUST hold whatever the attachment outcome:
select xc.probe('F', 'F10 carol does not see dave rows on her shot', xc.u('carol'), 'authenticated', 'select',
  format('select * from public.shot_phases where shot_id = %L and user_id <> %L', xc.u('shot_c'), xc.u('carol')), 'rows=0');
select xc.probe('F', 'F11 carol session shots exclude dave', xc.u('carol'), 'authenticated', 'select',
  format('select * from public.shots where session_id = %L and user_id <> %L', xc.u('sess_c'), xc.u('carol')), 'rows=0');
select xc.probe('F', 'F12 carol captures exclude dave', xc.u('carol'), 'authenticated', 'select',
  format('select * from public.captures where shot_id = %L and user_id <> %L', xc.u('shot_c'), xc.u('carol')), 'rows=0');
select xc.probe('F', 'F13 dave still cannot read carol shot through his attached child', xc.u('dave'), 'authenticated', 'select',
  format('select s.* from public.shots s where s.id = %L', xc.u('shot_c')), 'rows=0');
select xc.probe('F', 'F14 dave cannot read carol session through his shot', xc.u('dave'), 'authenticated', 'select',
  format('select se.* from public.sessions se where se.id = %L', xc.u('sess_c')), 'rows=0');
select xc.probe('F', 'F15 carol rank unaffected by dave shot in her session', xc.u('carol'), 'authenticated', 'value',
  'select scored_shot_count::text from public.player_rank_state', 'value=1');
-- Carol deletes her account (auth admin deleteUser → cascade). Must succeed.
delete from auth.users where id = xc.u('carol');
select xc.assert('F', 'F20 carol account deletion cascaded despite dave attachments',
  not exists (select 1 from public.profiles where id = xc.u('carol'))
  and not exists (select 1 from public.sessions where user_id = xc.u('carol'))
  and not exists (select 1 from public.shots where user_id = xc.u('carol')),
  'carol rows gone');
select xc.assert('F', 'F21 dave attached rows resolved by FK actions (phase cascaded; shot/capture parents nulled)',
  not exists (select 1 from public.shot_phases where shot_id = xc.u('shot_c'))
  and coalesce((select session_id is null from public.shots where id = xc.u('shot_d_in_c_sess')), true)
  and coalesce((select shot_id is null and session_id is null from public.captures where id = xc.u('cap_d_on_c_shot')), true),
  'no dangling references to carol parents');

-- ---------------------------------------------------------------------------
-- H. Privilege hygiene (P3): statements PostgREST never emits but that the
--    client role could run if it ever reached SQL directly (SQL injection in
--    a future function, a leaked connection). TRUNCATE ignores RLS.
-- ---------------------------------------------------------------------------
select xc.probe('H', 'H01 authenticated may TRUNCATE billing_entitlements (RLS bypass)', xc.u('bob'), 'authenticated', 'truncate',
  'truncate public.billing_entitlements', 'err=42501', 'P3', false);
select xc.probe('H', 'H02 authenticated may TRUNCATE sessions', xc.u('bob'), 'authenticated', 'truncate',
  'truncate public.sessions cascade', 'err=42501', 'P3', false);
select xc.probe('H', 'H03 authenticated may TRUNCATE profiles (cascade)', xc.u('bob'), 'authenticated', 'truncate',
  'truncate public.profiles cascade', 'err=42501', 'P3', false);
select xc.probe('H', 'H04 authenticated may TRUNCATE player_rank_state', xc.u('bob'), 'authenticated', 'truncate',
  'truncate public.player_rank_state', 'err=42501', 'P3', false);
select xc.probe('H', 'H05 anon may TRUNCATE?', xc.u('bob'), 'anon', 'truncate',
  'truncate public.sessions', 'err=42501', 'P3', false);
select xc.probe('H', 'H06 authenticated reads auth.users (shim has no grants; hosted must match)', xc.u('bob'), 'authenticated', 'select',
  'select * from auth.users', 'err=42501', 'P3');
select xc.probe('H', 'H07 authenticated reads auth.identities', xc.u('bob'), 'authenticated', 'select',
  'select * from auth.identities', 'err=42501', 'P3');

-- ---------------------------------------------------------------------------
-- Z. Alice row-space integrity after every attack section.
-- ---------------------------------------------------------------------------
select xc.assert('Z', 'Z01 alice row-space hash identical before/after attacks',
  (select snap from xc.alice_before) = xc.snapshot(xc.u('alice')),
  'xc.snapshot(alice) before = ' || (select snap::text from xc.alice_before) ||
  ' after = ' || xc.snapshot(xc.u('alice'))::text);
select xc.assert('Z', 'Z02 no row anywhere changed owner to/from alice unexpectedly',
  (select count(*) from public.sessions where user_id = xc.u('alice')) = 1
  and (select count(*) from public.captures where user_id = xc.u('alice')) = 1
  and (select count(*) from public.analysis_permits where user_id = xc.u('alice')) = 2
  and (select count(*) from public.account_deletion_requests where user_id = xc.u('alice')) = 1
  and (select count(*) from public.user_saved_drills where user_id = xc.u('alice')) = 1
  and (select count(*) from public.billing_entitlements where user_id = xc.u('alice') and premium) = 1,
  'alice ownership counts');

-- ---------------------------------------------------------------------------
-- Q. Seeded fuzz: 8-account pool, N random (attacker, victim, template)
--    draws. setseed() makes the draw sequence replayable; every statement is
--    recorded verbatim in xc.results.
-- ---------------------------------------------------------------------------
do $$
declare
  i int;
  uid uuid;
  sid uuid;
  shid uuid;
  cid uuid;
begin
  for i in 1..8 loop
    uid := format('10000000-0000-4000-8000-0000000001%s', lpad(i::text, 2, '0'))::uuid;
    sid := format('10000000-0000-4000-8000-0000000002%s', lpad(i::text, 2, '0'))::uuid;
    shid := format('10000000-0000-4000-8000-0000000003%s', lpad(i::text, 2, '0'))::uuid;
    cid := format('10000000-0000-4000-8000-0000000004%s', lpad(i::text, 2, '0'))::uuid;
    insert into xc.ids values ('pool_' || i, uid), ('pool_' || i || '_sess', sid),
                              ('pool_' || i || '_shot', shid), ('pool_' || i || '_cap', cid);
    insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
      values (uid, format('xc-pool-%s@example.com', i), jsonb_build_object('full_name', 'Pool ' || i), '{"provider":"apple"}');
    insert into auth.identities (provider, provider_id, user_id, identity_data)
      values ('apple', 'xc-apple-sub-pool-' || i, uid, jsonb_build_object('email', format('xc-pool-%s@example.com', i)));
    -- premium so the free-rating gate never masks an isolation result
    insert into public.billing_entitlements (user_id, premium, product_key) values (uid, true, 'pickle_sensei_pro_lifetime');
    insert into public.sessions (id, user_id, started_at, notes) values (sid, uid, now(), 'pool ' || i || ' notes');
    insert into public.shots (id, user_id, session_id, shot_type, captured_at, start_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
      values (shid, uid, sid, 'dink', now(), 0, 1000, 5 + i * 0.1, 0.9, 'scored', '1','1','1','1','1','1','1','1');
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
      values (shid, uid, 'contact', 0, 1, 2, 0.9);
    insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
      values (cid, uid, sid, shid, now(), 1000, 30, 'imported_video', 'valid');
    insert into public.user_saved_drills (user_id, slug) values (uid, 'pool-drill-' || i);
    insert into public.account_deletion_requests (user_id) values (uid);
    -- one reserved permit per pool user, reserved as the owner through the RPC
    perform set_config('request.jwt.claim.sub', uid::text, true);
    execute 'set local role authenticated';
    perform public.reserve_analysis_permit('pool-key-' || i);
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);
    insert into xc.ids select 'pool_' || i || '_permit', id from public.analysis_permits
      where user_id = uid and idempotency_key = 'pool-key-' || i;
  end loop;
end $$;

create table xc.pool_before as
  select n, xc.snapshot(xc.u('pool_' || n)) as snap from generate_series(1, 8) n;

create table xc.fuzz_meta (k text primary key, v text);
insert into xc.fuzz_meta values ('seed', '0.20260904'), ('iterations', '2000'), ('templates', '22');

do $$
declare
  n_iter int := (select m.v::int from xc.fuzz_meta m where m.k = 'iterations');
  i int;
  a int; v int; t int;
  atk uuid; vic uuid;
  ok boolean;
  fails int := 0;
begin
  perform setseed((select m.v::float8 from xc.fuzz_meta m where m.k = 'seed'));
  for i in 1..n_iter loop
    a := 1 + floor(random() * 8)::int;
    v := 1 + floor(random() * 7)::int;
    if v >= a then v := v + 1; end if;           -- victim ≠ attacker
    t := 1 + floor(random() * 22)::int;
    atk := xc.u('pool_' || a);
    vic := xc.u('pool_' || v);
    ok := case t
      when 1 then xc.probe('Q', format('Q%s t01 select victim session', i), atk, 'authenticated', 'select',
        format('select * from public.sessions where id = %L', xc.u('pool_' || v || '_sess')), 'rows=0')
      when 2 then xc.probe('Q', format('Q%s t02 select victim shot', i), atk, 'authenticated', 'select',
        format('select * from public.shots where id = %L', xc.u('pool_' || v || '_shot')), 'rows=0')
      when 3 then xc.probe('Q', format('Q%s t03 select victim profile', i), atk, 'authenticated', 'select',
        format('select * from public.profiles where id = %L', vic), 'rows=0')
      when 4 then xc.probe('Q', format('Q%s t04 select victim permits', i), atk, 'authenticated', 'select',
        format('select * from public.analysis_permits where user_id = %L', vic), 'rows=0')
      when 5 then xc.probe('Q', format('Q%s t05 select victim capture', i), atk, 'authenticated', 'select',
        format('select * from public.captures where id = %L', xc.u('pool_' || v || '_cap')), 'rows=0')
      when 6 then xc.probe('Q', format('Q%s t06 update victim session', i), atk, 'authenticated', 'dml',
        format('update public.sessions set ended_at = now() where id = %L', xc.u('pool_' || v || '_sess')), 'rows=0')
      when 7 then xc.probe('Q', format('Q%s t07 delete victim session', i), atk, 'authenticated', 'dml',
        format('delete from public.sessions where id = %L', xc.u('pool_' || v || '_sess')), 'rows=0')
      when 8 then xc.probe('Q', format('Q%s t08 insert session owned by victim', i), atk, 'authenticated', 'dml',
        format('insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), %L, now())', vic), 'err=42501')
      when 9 then xc.probe('Q', format('Q%s t09 ignoreDuplicates squat on victim session id', i), atk, 'authenticated', 'dml',
        format('insert into public.sessions (id, user_id, started_at) values (%L, %L, now()) on conflict (id) do nothing',
               xc.u('pool_' || v || '_sess'), atk), 'rows=0')
      when 10 then xc.probe('Q', format('Q%s t10 merge-duplicates steal victim session', i), atk, 'authenticated', 'dml',
        format('insert into public.sessions (id, user_id, started_at) values (%L, %L, now()) on conflict (id) do update set user_id = excluded.user_id, ended_at = now()',
               xc.u('pool_' || v || '_sess'), atk), 'err=42501')
      when 11 then xc.probe('Q', format('Q%s t11 update victim profile', i), atk, 'authenticated', 'dml',
        format($q$update public.profiles set first_name = 'fuzz' where id = %L$q$, vic), 'rows=0')
      when 12 then xc.probe('Q', format('Q%s t12 delete victim permits', i), atk, 'authenticated', 'dml',
        format('delete from public.analysis_permits where user_id = %L', vic), 'rows=0')
      when 13 then xc.probe('Q', format('Q%s t13 release victim permits', i), atk, 'authenticated', 'dml',
        format($q$update public.analysis_permits set status = 'released' where user_id = %L$q$, vic), 'rows=0')
      when 14 then xc.probe('Q', format('Q%s t14 apply_synced_shot with victim permit', i), atk, 'authenticated', 'value',
        format('select public.apply_synced_shot(%L::jsonb)',
               xc.shot_json(gen_random_uuid(), xc.u('pool_' || v || '_permit'), null)), 'value=access.permit_not_found')
      when 15 then xc.probe('Q', format('Q%s t15 apply_synced_shot own permit onto victim shot id', i), atk, 'authenticated', 'value',
        format('select public.apply_synced_shot(%L::jsonb)',
               xc.shot_json(xc.u('pool_' || v || '_shot'), xc.u('pool_' || a || '_permit'), null)), 'value=shot.id_conflict')
      when 16 then xc.probe('Q', format('Q%s t16 reassign own capture to victim', i), atk, 'authenticated', 'dml',
        format('update public.captures set user_id = %L where id = %L', vic, xc.u('pool_' || a || '_cap')), 'err=42501')
      when 17 then xc.probe('Q', format('Q%s t17 plant saved drill on victim', i), atk, 'authenticated', 'dml',
        format($q$insert into public.user_saved_drills (user_id, slug) values (%L, 'planted') on conflict (user_id, slug) do nothing$q$, vic), 'err=42501')
      when 18 then xc.probe('Q', format('Q%s t18 read victim billing', i), atk, 'authenticated', 'select',
        format('select * from public.billing_entitlements where user_id = %L', vic), 'rows=0')
      when 19 then xc.probe('Q', format('Q%s t19 delete victim saved drills', i), atk, 'authenticated', 'dml',
        format('delete from public.user_saved_drills where user_id = %L', vic), 'rows=0')
      when 20 then xc.probe('Q', format('Q%s t20 read victim technique rating view', i), atk, 'authenticated', 'select',
        format('select * from public.player_technique_rating where user_id = %L', vic), 'rows=0')
      when 21 then xc.probe('Q', format('Q%s t21 cancel victim deletion request (merge-duplicates)', i), atk, 'authenticated', 'dml',
        format('insert into public.account_deletion_requests (user_id) values (%L) on conflict (user_id) do update set expires_at = now()', vic), 'err=42501')
      else xc.probe('Q', format('Q%s t22 anon with forged victim sub reads sessions', i), vic, 'anon', 'select',
        'select * from public.sessions', 'err=42501')
    end;
    if not ok then fails := fails + 1; end if;
  end loop;
  insert into xc.fuzz_meta values ('failures', fails::text);
  raise notice 'XC FUZZ: % iterations, % failures', n_iter, fails;
end $$;

select xc.assert('Q', 'Q-final pool row-spaces unchanged by 2000 fuzz draws',
  not exists (select 1 from xc.pool_before b where b.snap <> xc.snapshot(xc.u('pool_' || b.n))),
  'xc.snapshot(pool_n) before = after for n in 1..8');
select xc.assert('Q', 'Q-final fuzz draw count recorded',
  (select count(*) from xc.results where section = 'Q' and scenario like 'Q%' and kind <> 'assert')
    = (select v::int from xc.fuzz_meta where k = 'iterations'),
  'one xc.results row per fuzz iteration');

commit;

-- ---------------------------------------------------------------------------
-- Summary (after COMMIT so xc.results survives for export). P0/P1 failures
-- raise → non-zero psql exit; hygiene (P3) failures are warnings the runner
-- surfaces (exit 3).
-- ---------------------------------------------------------------------------
do $$
declare
  v_total int; v_pass int; v_fail_iso int; v_fail_hyg int;
begin
  select count(*), count(*) filter (where pass),
         count(*) filter (where not pass and severity in ('P0', 'P1')),
         count(*) filter (where not pass and severity not in ('P0', 'P1'))
    into v_total, v_pass, v_fail_iso, v_fail_hyg
  from xc.results;
  raise notice 'XC SUMMARY total=% pass=% fail_isolation=% fail_hygiene=%', v_total, v_pass, v_fail_iso, v_fail_hyg;
  if v_fail_hyg > 0 then
    raise warning 'XC HYGIENE: % P3 probe(s) failed (see xc.results where not pass)', v_fail_hyg;
  end if;
  if v_fail_iso > 0 then
    raise exception 'XC ISOLATION FAILURE: % P0/P1 probe(s) leaked or mutated cross-user data', v_fail_iso;
  end if;
end $$;

\o
\echo XC CROSS-USER ISOLATION MATRIX: NO P0/P1 FAILURES (see xc.results for hygiene)
