-- ============================================================================
-- Pickle Sensei — data-integrity adversarial matrix (orphans / duplicates /
-- cascades / sweeps / identity ledger).
--
-- Runs against a throwaway Postgres AFTER shim_auth.sql, integrity/cron_stub.sql
-- and every migration in supabase/migrations (see run_integrity_matrix.sh).
-- Runs as the database owner (superuser) so it can construct bad states from
-- any angle: as a client session (set role authenticated + auth.uid()), as the
-- table owner (a compromised backend), or as raw catalog inspection.
--
-- Every attempt records: the exact statement, the seed data, the actor, the
-- outcome (allowed/rejected), SQLSTATE, the constraint or trigger that
-- fired, what the schema/design CLAIMS should happen, and a verdict:
--   match     — observed == claimed
--   MISMATCH  — observed != claimed (a regression against the migrations' own
--               comments / the security matrix's design)
-- plus `bad_state = true` whenever an ALLOWED attempt leaves data in a state
-- this role considers bad (orphan, duplicate, cross-user reference, business
-- rule bypass), whether or not the design "claims" it. Those rows are the raw
-- material for findings; MISMATCH rows fail the run.
--
-- Everything is written to schema `it` and exported by the runner as JSON.
-- Nothing here touches production; nothing here modifies migrations.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;

drop schema if exists it cascade;
create schema it;

create table it.results (
  seq          serial primary key,
  section      text not null,
  case_id      text not null,
  title        text not null,
  actor        text,
  statement    text,
  seed         jsonb,
  outcome      text,          -- allowed | allowed(rolled back) | rejected | observed
  returned     text,          -- value returned by a SELECT/RPC attempt
  rows_affected int,
  sqlstate     text,
  constraint_name text,
  table_name   text,
  message      text,
  guard        text,          -- the mechanism that decided the outcome
  claim        text,          -- what the schema / migration comments claim
  expected     text,          -- allow | reject[:SQLSTATE] | return:<value> | <free text for observed>
  verdict      text not null, -- match | MISMATCH
  bad_state    boolean not null default false,
  note         text
);

create table it.kv (k text primary key, v jsonb not null);

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------

-- Execute one statement as an actor, inside a subtransaction, and record it.
--   p_expect: 'allow' | 'reject' | 'reject:<sqlstate>' | 'return:<text>'
--   p_keep  : false → the effect is rolled back even when allowed
create function it.attempt(
  p_section text, p_case text, p_title text,
  p_role text, p_uid uuid,
  p_sql text, p_seed jsonb,
  p_expect text, p_claim text,
  p_bad_state boolean default false,
  p_keep boolean default true,
  p_note text default null,
  p_bad_on_reject boolean default false
) returns text
language plpgsql
as $$
declare
  v_state text; v_msg text; v_con text; v_tbl text;
  v_rows int := 0; v_ret text; v_outcome text; v_verdict text; v_guard text;
  v_kind text := split_part(p_expect, ':', 1);
  v_arg  text := substr(p_expect, length(v_kind) + 2);
begin
  begin
    if p_role is not null then
      execute format('set local role %I', p_role);
    end if;
    perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
    if p_sql ~* '^\s*(select|with)\M' then
      execute p_sql into v_ret;
    else
      execute p_sql;
    end if;
    get diagnostics v_rows = row_count;
    if not p_keep then
      raise exception using errcode = 'P0IT1', message = 'it.rollback';
    end if;
    reset role;
    perform set_config('request.jwt.claim.sub', '', true);
    v_outcome := 'allowed';
  exception
    when sqlstate 'P0IT1' then
      v_outcome := 'allowed(rolled back)';
    when others then
      get stacked diagnostics
        v_state = returned_sqlstate, v_msg = message_text,
        v_con = constraint_name, v_tbl = table_name;
      v_outcome := 'rejected';
  end;

  v_guard := case
    when v_outcome = 'rejected' and v_con <> '' then 'constraint ' || v_con
    when v_outcome = 'rejected' and v_state = '42501' then 'privilege/trigger: ' || v_msg
    when v_outcome = 'rejected' then 'error ' || v_state || ': ' || v_msg
    when v_ret is not null and v_ret <> 'accepted' and p_sql ~* 'apply_synced_shot|reserve_analysis_permit'
      then 'function-level check → ' || v_ret
    else 'none (statement succeeded)'
  end;

  v_verdict := case
    when v_kind = 'allow'  and v_outcome like 'allowed%' then 'match'
    when v_kind = 'reject' and v_outcome = 'rejected'
         and (v_arg = '' or v_arg = v_state) then 'match'
    when v_kind = 'return' and v_outcome like 'allowed%' and v_ret = v_arg then 'match'
    else 'MISMATCH'
  end;

  insert into it.results (section, case_id, title, actor, statement, seed, outcome,
    returned, rows_affected, sqlstate, constraint_name, table_name, message,
    guard, claim, expected, verdict, bad_state, note)
  values (p_section, p_case, p_title,
    coalesce(p_role, 'postgres(owner)') || coalesce(' uid=' || p_uid::text, ''),
    p_sql, p_seed, v_outcome, v_ret, v_rows, v_state, v_con, v_tbl, v_msg,
    v_guard, p_claim, p_expect, v_verdict,
    p_bad_state and (v_outcome like 'allowed%' or p_bad_on_reject), p_note);
  return coalesce(v_ret, v_outcome);
end;
$$;

-- Record an observation (no statement of its own).
create function it.observe(
  p_section text, p_case text, p_title text,
  p_facts jsonb, p_expected text, p_matches boolean, p_claim text,
  p_bad_state boolean default false, p_note text default null
) returns void
language plpgsql
as $$
begin
  insert into it.results (section, case_id, title, actor, seed, outcome, guard,
    claim, expected, verdict, bad_state, note)
  values (p_section, p_case, p_title, 'postgres(owner)', p_facts, 'observed',
    'observation', p_claim, p_expected,
    case when p_matches then 'match' else 'MISMATCH' end, p_bad_state, p_note);
end;
$$;

create function it.count_for_user(p_uid uuid) returns jsonb
language plpgsql
as $$
declare
  r record; v jsonb := '{}'; n bigint;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    order by 1
  loop
    execute format('select count(*) from public.%I where user_id = %L', r.relname, p_uid) into n;
    v := v || jsonb_build_object(r.relname, n);
  end loop;
  execute 'select count(*) from public.profiles where id = $1' into n using p_uid;
  v := v || jsonb_build_object('profiles', n);
  execute 'select count(*) from auth.identities where user_id = $1' into n using p_uid;
  v := v || jsonb_build_object('auth.identities', n);
  execute 'select count(*) from auth.users where id = $1' into n using p_uid;
  v := v || jsonb_build_object('auth.users', n);
  return v;
end;
$$;

-- Global orphan scan: for every FK in public/auth, count child rows whose
-- non-null FK value has no parent. Must be {} after any cascade.
create function it.orphan_scan() returns jsonb
language plpgsql
as $$
declare
  r record; n bigint; v jsonb := '{}';
begin
  for r in
    select c.conname, c.conrelid::regclass as child, c.confrelid::regclass as parent,
           (select attname from pg_attribute where attrelid = c.conrelid and attnum = c.conkey[1]) as fkcol,
           (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) as pkcol
    from pg_constraint c
    where c.contype = 'f'
      and c.connamespace in ('public'::regnamespace, 'auth'::regnamespace)
      and array_length(c.conkey, 1) = 1
  loop
    execute format(
      'select count(*) from %s ch where ch.%I is not null and not exists (select 1 from %s p where p.%I = ch.%I)',
      r.child, r.fkcol, r.parent, r.pkcol, r.fkcol) into n;
    if n > 0 then
      v := v || jsonb_build_object(r.conname, n);
    end if;
  end loop;
  return v;
end;
$$;

-- Clone one existing child row of the FK's table, point its FK column at a
-- parent that does not exist (mode 'orphan') or at NULL (mode 'null'),
-- re-key every PK/UNIQUE column so only the FK can fail, and try to insert it.
-- Always rolled back. Generic: the FK list comes from the catalog, so a new
-- FK added by a future migration is probed automatically.
create function it.fk_insert_probe(p_con text, p_mode text) returns jsonb
language plpgsql
as $$
declare
  v_child regclass; v_parent regclass; v_fkcol text; v_notnull boolean;
  v_row jsonb; v_over jsonb := '{}'; c record; v_cols text; v_sql text;
  v_state text; v_msg text; v_conname text; v_outcome text;
begin
  select k.conrelid, k.confrelid, a.attname, a.attnotnull
    into v_child, v_parent, v_fkcol, v_notnull
  from pg_constraint k
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
  where k.conname = p_con and k.contype = 'f';

  execute format('select to_jsonb(t) from %s t where %I is not null limit 1', v_child, v_fkcol) into v_row;
  if v_row is null then
    return jsonb_build_object('outcome', 'no_fixture');
  end if;

  for c in
    select distinct a.attname, format_type(a.atttypid, a.atttypmod) as typ
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
    where k.conrelid = v_child and k.contype in ('p', 'u') and a.attname <> v_fkcol
  loop
    -- deterministic re-keys: md5(constraint || mode || column)
    if c.typ = 'uuid' then
      v_over := v_over || jsonb_build_object(c.attname, md5(p_con || p_mode || c.attname)::uuid);
    elsif c.typ = 'text' then
      v_over := v_over || jsonb_build_object(c.attname, 'it-probe-' || left(md5(p_con || p_mode || c.attname), 12));
    end if;
  end loop;
  v_over := v_over || jsonb_build_object(
    v_fkcol, case when p_mode = 'orphan' then to_jsonb(md5(p_con || 'orphan-parent')::uuid) else 'null'::jsonb end);
  v_row := v_row || v_over;

  select string_agg(quote_ident(attname), ', ' order by attnum) into v_cols
  from pg_attribute
  where attrelid = v_child and attnum > 0 and not attisdropped and attgenerated = '';

  v_sql := format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, %L)',
                  v_child, v_cols, v_cols, v_child, v_row::text);
  begin
    execute v_sql;
    raise exception using errcode = 'P0IT1', message = 'it.rollback';
  exception
    when sqlstate 'P0IT1' then v_outcome := 'allowed(rolled back)';
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_conname = constraint_name;
      v_outcome := 'rejected';
  end;
  return jsonb_build_object(
    'outcome', v_outcome, 'sqlstate', v_state, 'constraint', v_conname, 'message', v_msg,
    'sql', v_sql, 'seed', v_row, 'fk_column', v_fkcol, 'fk_not_null', v_notnull,
    'child', v_child::text, 'parent', v_parent::text);
end;
$$;

-- Delete the parent of one existing child row and observe what happened to
-- the child (gone / FK nulled / delete refused). Always rolled back.
create function it.fk_delete_probe(p_con text) returns jsonb
language plpgsql
as $$
declare
  v_child regclass; v_parent regclass; v_fkcol text; v_pkcol text; v_deltype text;
  v_row jsonb; v_fkval text; v_pkcols text; v_pkvals text; v_sql text;
  v_cnt bigint; v_nulled boolean; v_state text; v_msg text; v_outcome text; v_observed text;
  v_orphans jsonb;
begin
  select k.conrelid, k.confrelid, a.attname, pa.attname, k.confdeltype
    into v_child, v_parent, v_fkcol, v_pkcol, v_deltype
  from pg_constraint k
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
  join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = k.confkey[1]
  where k.conname = p_con and k.contype = 'f';

  execute format('select to_jsonb(t) from %s t where %I is not null limit 1', v_child, v_fkcol) into v_row;
  if v_row is null then
    return jsonb_build_object('outcome', 'no_fixture');
  end if;
  v_fkval := v_row ->> v_fkcol;

  select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
         string_agg(quote_literal(v_row ->> a.attname), ', ' order by a.attnum)
    into v_pkcols, v_pkvals
  from pg_constraint k
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
  where k.conrelid = v_child and k.contype = 'p';

  v_sql := format('delete from %s where %I = %L', v_parent, v_pkcol, v_fkval);
  begin
    execute v_sql;
    execute format('select count(*), bool_and(%I is null) from %s where (%s) = (%s)',
                   v_fkcol, v_child, v_pkcols, v_pkvals) into v_cnt, v_nulled;
    v_orphans := it.orphan_scan();
    raise exception using errcode = 'P0IT1', message = 'it.rollback';
  exception
    when sqlstate 'P0IT1' then
      v_outcome := 'allowed(rolled back)';
      v_observed := case when v_cnt = 0 then 'child deleted'
                         when v_nulled then 'child kept, FK set to NULL'
                         else 'child kept, FK still set (ORPHAN)' end;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_outcome := 'rejected';
      v_observed := 'parent delete refused';
  end;
  return jsonb_build_object(
    'outcome', v_outcome, 'observed', v_observed, 'sqlstate', v_state, 'message', v_msg,
    'declared_on_delete', case v_deltype when 'c' then 'CASCADE' when 'n' then 'SET NULL'
                                          when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
                                          when 'd' then 'SET DEFAULT' end,
    'sql', v_sql, 'child_row', v_row, 'child', v_child::text, 'parent', v_parent::text,
    'fk_column', v_fkcol, 'orphans_after', v_orphans);
end;
$$;

-- Minimal valid sync payload for apply_synced_shot.
create function it.shot_payload(
  p_id uuid, p_permit uuid, p_session uuid, p_kind text, p_score numeric default 7.1
) returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'resultKind', p_kind,
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', '2026-09-01T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then p_score else null end,
    'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 400, 'representativeMs', 500, 'endMs', 600, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object(
      'key', 'contact_position', 'score', 71, 'confidence', 0.9, 'band', 'green',
      'direction', 'ok', 'severity', 0.1, 'applicable', true))
  )
$$;

-- Direct (owner) insert of a shot row — the same columns apply_synced_shot writes.
create function it.insert_shot(
  p_id uuid, p_uid uuid, p_session uuid, p_kind text, p_score numeric default 7.1
) returns void
language sql
as $$
  insert into public.shots (
    id, user_id, session_id, shot_type, camera_view, captured_at,
    start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
  values (p_id, p_uid, p_session, 'drive', 'side', '2026-09-01T10:00:00Z',
    0, 500, 1000, case when p_kind = 'scored' then p_score else null end, 0.9, p_kind,
    '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real')
$$;

-- Delete a shot as the owner and report how many feedback rows still point at it.
create function it.delete_shot_count_feedback(p_shot uuid) returns text
language plpgsql
as $$
declare n bigint;
begin
  delete from public.shots where id = p_shot;
  select count(*) into n from public.analysis_feedback where analysis_id = p_shot;
  return n::text;
end;
$$;

-- Client sessions must be able to reach the two invoker-rights helpers above.
grant usage on schema it to anon, authenticated;
grant execute on function it.insert_shot(uuid, uuid, uuid, text, numeric) to authenticated;
grant execute on function it.shot_payload(uuid, uuid, uuid, text, numeric) to authenticated;

-- One full "world" for a user: a row in EVERY user-owned table, so cascade
-- and FK probes have a fixture per relationship. Returns the ids it minted.
create function it.seed_world(p_uid uuid, p_tag text) returns jsonb
language plpgsql
as $$
declare
  v_session uuid := gen_random_uuid();
  v_shot1 uuid := gen_random_uuid();
  v_shot2 uuid := gen_random_uuid();
  v_capture uuid := gen_random_uuid();
  v_permit1 uuid := gen_random_uuid();
  v_permit2 uuid := gen_random_uuid();
  v_trial uuid := gen_random_uuid();
begin
  insert into public.sessions (id, user_id, started_at, ended_at)
  values (v_session, p_uid, now() - interval '1 hour', now());

  perform it.insert_shot(v_shot1, p_uid, v_session, 'scored', 7.1);
  perform it.insert_shot(v_shot2, p_uid, v_session, 'low_confidence');

  insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
  values (v_shot1, p_uid, 'contact', 400, 500, 600, 0.9);
  insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
  values (v_shot1, p_uid, 'contact_position', 71, 0.9, 'green', 'ok', 0.1, true);
  insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
  values (v_shot1, p_uid, 'paddle_angle', 12.5, 0.8, 'degrees');

  insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps,
    capture_mode, evidence_status, status)
  values (v_capture, p_uid, v_session, v_shot1, now() - interval '30 minutes', 3000, 30,
    'automatic_pose_trigger', 'valid', 'analyzed');

  insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
  values (v_permit1, p_uid, p_tag || '-permit-finalized', 'finalized', 'scored'),
         (v_permit2, p_uid, p_tag || '-permit-reserved', 'reserved', null);

  insert into public.consent_records (user_id, scope, consent_version, action, source)
  values (p_uid, 'video_analysis', '2026-08', 'grant', 'onboarding');
  insert into public.evaluation_trials (id, user_id, payload)
  values (v_trial, p_uid, jsonb_build_object('trialId', v_trial, 'tag', p_tag));
  insert into public.analysis_feedback (user_id, analysis_id, rating)
  values (p_uid, v_shot1, 'accurate');
  insert into public.user_saved_drills (user_id, slug) values (p_uid, p_tag || '-drill');
  insert into public.billing_entitlements (user_id, premium) values (p_uid, false);
  insert into public.account_deletion_requests (user_id) values (p_uid);
  insert into public.account_deletion_feedback (user_id, reason, provider, platform, app_version)
  values (p_uid, 'other', 'google', 'ios', '1.0.0');
  insert into public.account_external_credentials (user_id, revenuecat_deleted_at)
  values (p_uid, null);

  return jsonb_build_object(
    'user_id', p_uid, 'session', v_session, 'shot_scored', v_shot1, 'shot_low_conf', v_shot2,
    'capture', v_capture, 'permit_finalized', v_permit1, 'permit_reserved', v_permit2, 'trial', v_trial);
end;
$$;

-- Fail the run loudly (called by the runner after export).
create function it.fail_if_mismatch() returns void
language plpgsql
as $$
declare n int;
begin
  select count(*) into n from it.results where verdict = 'MISMATCH';
  if n > 0 then
    raise exception 'integrity matrix: % MISMATCH row(s) — schema behaviour deviates from its documented design', n;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Fixtures. Fixed UUIDs so every artifact is replayable byte-for-byte.
-- ----------------------------------------------------------------------------
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000aa', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000bb', 'bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000cc', 'carol@example.com', '{"full_name":"Carol"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000dd', 'dave@example.com',  '{"full_name":"Dave"}',  '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000ee', 'eve@example.com',   '{"full_name":"Eve"}',   '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000ff', 'frank@example.com', '{"full_name":"Frank"}', '{"provider":"google"}');

insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'it-google-alice', '00000000-0000-4000-8000-0000000000aa', '{"sub":"it-google-alice","email":"alice@example.com"}'),
  ('apple',  'it-apple-bob',    '00000000-0000-4000-8000-0000000000bb', '{"sub":"it-apple-bob","email":"bob@example.com"}'),
  ('google', 'it-google-carol', '00000000-0000-4000-8000-0000000000cc', '{"sub":"it-google-carol","email":"carol@example.com"}'),
  ('apple',  'it-apple-carol',  '00000000-0000-4000-8000-0000000000cc', '{"sub":"it-apple-carol","email":"carol@example.com"}'),
  -- dave: deliberately NO identity row
  ('apple',  'it-apple-eve',    '00000000-0000-4000-8000-0000000000ee', '{"sub":"it-apple-eve","email":"eve@example.com"}'),
  ('google', 'it-google-frank', '00000000-0000-4000-8000-0000000000ff', '{"sub":"it-google-frank","email":"frank@example.com"}');

do $$
begin
  if (select count(*) from public.profiles) <> 6 then
    raise exception 'SETUP: handle_new_user did not provision 6 profiles';
  end if;
end $$;

insert into it.kv values
  ('world_alice', it.seed_world('00000000-0000-4000-8000-0000000000aa', 'alice')),
  ('world_bob',   it.seed_world('00000000-0000-4000-8000-0000000000bb', 'bob')),
  ('world_carol', it.seed_world('00000000-0000-4000-8000-0000000000cc', 'carol'));
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-00000000e5e5', '00000000-0000-4000-8000-0000000000ee', now());

insert into it.kv values ('fixture_counts_alice', it.count_for_user('00000000-0000-4000-8000-0000000000aa'));

-- ============================================================================
-- Section FK — every foreign key: orphan insert, NULL insert, ON DELETE probe
-- ============================================================================
do $$
declare
  r record; p jsonb; v_claim text; v_expected text; v_match boolean;
begin
  for r in
    select k.conname, k.conrelid::regclass as child, k.confrelid::regclass as parent,
           k.confdeltype, k.convalidated,
           a.attname as fkcol, a.attnotnull
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.contype = 'f'
      and k.connamespace in ('public'::regnamespace, 'auth'::regnamespace)
    order by k.conrelid::regclass::text, a.attname
  loop
    -- FK-ORPHAN: child pointing at a parent that does not exist
    p := it.fk_insert_probe(r.conname, 'orphan');
    perform it.observe('FK', 'FK-ORPHAN-' || r.conname,
      format('%s.%s → %s: insert child with non-existent parent', r.child, r.fkcol, r.parent),
      p, 'reject:23503', (p ->> 'outcome') = 'rejected' and (p ->> 'sqlstate') = '23503',
      'FK ' || r.conname || ' (validated=' || r.convalidated || ') must refuse the orphan',
      (p ->> 'outcome') like 'allowed%');

    -- FK-NULL: child with NULL FK
    p := it.fk_insert_probe(r.conname, 'null');
    if r.attnotnull then
      v_expected := 'reject:23502';
      v_claim := 'column is NOT NULL — an owner-less row is impossible';
      v_match := (p ->> 'outcome') = 'rejected' and (p ->> 'sqlstate') = '23502';
    else
      v_expected := 'allow';
      v_claim := 'column is nullable by design (' ||
        case r.conname
          when 'shots_session_id_fkey' then 'a shot may outlive its session; SET NULL on session delete'
          when 'captures_session_id_fkey' then 'capture may outlive its session; SET NULL'
          when 'captures_shot_id_fkey' then 'capture may outlive its shot; SET NULL'
          when 'account_deletion_feedback_user_id_fkey' then 'exit survey is anonymized (SET NULL) on account deletion'
          else 'no documented reason found' end || ')';
      v_match := (p ->> 'outcome') like 'allowed%';
    end if;
    perform it.observe('FK', 'FK-NULL-' || r.conname,
      format('%s.%s: insert child with NULL FK (declared %s)', r.child, r.fkcol,
             case when r.attnotnull then 'NOT NULL' else 'nullable' end),
      p, v_expected, v_match, v_claim,
      (not r.attnotnull) and v_claim like '%no documented reason%');

    -- FK-DEL: delete the parent, observe the child
    p := it.fk_delete_probe(r.conname);
    v_expected := case r.confdeltype when 'c' then 'child deleted'
                                     when 'n' then 'child kept, FK set to NULL'
                                     else 'parent delete refused' end;
    perform it.observe('FK', 'FK-DEL-' || r.conname,
      format('%s.%s → %s: delete parent (declared ON DELETE %s)', r.child, r.fkcol, r.parent,
             p ->> 'declared_on_delete'),
      p, v_expected,
      (p ->> 'observed') = v_expected and coalesce(p -> 'orphans_after', '{}') = '{}'::jsonb,
      'declared ON DELETE ' || (p ->> 'declared_on_delete') || ' must be what actually happens, and leave zero orphans',
      (p ->> 'observed') like '%ORPHAN%' or coalesce(p -> 'orphans_after', '{}') <> '{}'::jsonb);
  end loop;
end $$;

-- Catalog snapshot of the FK model (for the artifact).
insert into it.kv
select 'fk_catalog', jsonb_agg(jsonb_build_object(
  'constraint', k.conname, 'child', k.conrelid::regclass::text, 'column', a.attname,
  'not_null', a.attnotnull, 'parent', k.confrelid::regclass::text,
  'on_delete', case k.confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL'
                                  when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' end,
  'on_update', case k.confupdtype when 'c' then 'CASCADE' when 'n' then 'SET NULL'
                                  when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' end,
  'validated', k.convalidated, 'deferrable', k.condeferrable) order by k.conrelid::regclass::text, a.attname)
from pg_constraint k
join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
where k.contype = 'f' and k.connamespace in ('public'::regnamespace, 'auth'::regnamespace);

-- Tables that carry a user_id but have NO FK on it (would silently orphan).
insert into it.kv
select 'user_id_columns_without_fk', coalesce(jsonb_agg(c.relname order by c.relname), '[]')
from pg_class c
join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  and not exists (
    select 1 from pg_constraint k
    where k.conrelid = c.oid and k.contype = 'f' and k.conkey = array[a.attnum]);

do $$
declare v jsonb;
begin
  select kv.v into v from it.kv kv where k = 'user_id_columns_without_fk';
  perform it.observe('FK', 'FK-NOFK-user_id', 'every public.*.user_id column is FK-protected',
    v, '[]', v = '[]'::jsonb, 'every user-owned table cascades from profiles', v <> '[]'::jsonb);
end $$;

-- uuid columns that NAME a relationship but carry no FK (analysis_feedback.analysis_id).
insert into it.kv
select 'relationship_columns_without_fk', coalesce(jsonb_agg(jsonb_build_object(
  'table', c.relname, 'column', a.attname) order by c.relname, a.attname), '[]')
from pg_class c
join pg_attribute a on a.attrelid = c.oid and not a.attisdropped and a.attnum > 0
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  and a.atttypid = 'uuid'::regtype
  and a.attname like '%\_id' and a.attname <> 'id'
  and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'f' and k.conkey = array[a.attnum])
  and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p' and k.conkey = array[a.attnum]);

-- ============================================================================
-- Section XU — cross-user references the FKs cannot see (child.user_id = me,
-- parent row belongs to someone else). Attempted as the client role.
-- ============================================================================
do $$
declare
  a jsonb := (select kv.v from it.kv kv where k = 'world_alice');
  b jsonb := (select kv.v from it.kv kv where k = 'world_bob');
  alice uuid := '00000000-0000-4000-8000-0000000000aa';
  v_shot uuid := gen_random_uuid(); v_cap uuid := gen_random_uuid();
begin
  perform it.attempt('XU', 'XU-shots.session_id', 'Alice inserts a shot whose session_id is Bob''s session (direct INSERT, not the RPC)',
    'authenticated', alice,
    format('select it.insert_shot(%L, %L, %L, %L)', v_shot, alice, b ->> 'session', 'low_confidence'),
    jsonb_build_object('shot', v_shot, 'bob_session', b ->> 'session'),
    'allow', 'no constraint ties shots.user_id to sessions.user_id; the FK check runs as table owner and ignores RLS',
    true, false,
    'apply_synced_shot refuses this (shot.session_not_found, tested in PERMIT section) but authenticated still holds INSERT on shots');

  perform it.attempt('XU', 'XU-shot_phases.shot_id', 'Alice inserts a phase row attached to Bob''s shot (user_id = Alice)',
    'authenticated', alice,
    format('insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence) values (%L, %L, %L, 0, 1, 2, 0.5)',
           b ->> 'shot_scored', alice, 'xu-phase'),
    jsonb_build_object('bob_shot', b ->> 'shot_scored'),
    'allow', 'no constraint ties shot_phases.user_id to shots.user_id', true, false);

  perform it.attempt('XU', 'XU-shot_checkpoints.shot_id', 'Alice inserts a checkpoint row attached to Bob''s shot',
    'authenticated', alice,
    format('insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable) values (%L, %L, %L, 50, 0.5, ''red'', ''low'', 0.5, true)',
           b ->> 'shot_scored', alice, 'xu-checkpoint'),
    jsonb_build_object('bob_shot', b ->> 'shot_scored'),
    'allow', 'no constraint ties shot_checkpoints.user_id to shots.user_id', true, false);

  perform it.attempt('XU', 'XU-shot_measurements.shot_id', 'Alice inserts a measurement row attached to Bob''s shot',
    'authenticated', alice,
    format('insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit) values (%L, %L, %L, 1, 0.5, ''ms'')',
           b ->> 'shot_scored', alice, 'xu-metric'),
    jsonb_build_object('bob_shot', b ->> 'shot_scored'),
    'allow', 'no constraint ties shot_measurements.user_id to shots.user_id', true, false);

  perform it.attempt('XU', 'XU-captures.shot_id+session_id', 'Alice inserts a capture pointing at Bob''s session and shot',
    'authenticated', alice,
    format('insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status) values (%L, %L, %L, %L, now(), 1000, 30, ''imported_video'', ''valid'')',
           v_cap, alice, b ->> 'session', b ->> 'shot_scored'),
    jsonb_build_object('capture', v_cap, 'bob_session', b ->> 'session', 'bob_shot', b ->> 'shot_scored'),
    'allow', 'no constraint ties captures.user_id to the parent rows'' user_id', true, false);

  perform it.attempt('XU', 'XU-analysis_feedback.analysis_id-other-user', 'Alice records feedback on Bob''s shot id',
    'authenticated', alice,
    format('insert into public.analysis_feedback (user_id, analysis_id, rating) values (%L, %L, ''accurate'')', alice, b ->> 'shot_scored'),
    jsonb_build_object('bob_shot', b ->> 'shot_scored'),
    'allow', 'analysis_feedback.analysis_id has no FK at all; the Edge Function checks shot ownership before inserting (index.ts:1621-1632)', true, false);

  perform it.attempt('XU', 'XU-analysis_feedback.analysis_id-nonexistent', 'Alice records feedback on a shot id that does not exist anywhere',
    'authenticated', alice,
    format('insert into public.analysis_feedback (user_id, analysis_id, rating) values (%L, %L, ''accurate'')', alice, '00000000-0000-4000-8000-00000000dead'),
    jsonb_build_object('analysis_id', '00000000-0000-4000-8000-00000000dead'),
    'allow', 'analysis_feedback.analysis_id has no FK; an orphan, append-only feedback row is possible from a client session', true, false);

  -- Sanity: the same cross-user shapes ARE refused when RLS can see them.
  perform it.attempt('XU', 'XU-rls-shots.user_id', 'Alice inserts a shot owned by Bob (RLS WITH CHECK)',
    'authenticated', alice,
    format('select it.insert_shot(%L, %L, %L, %L)', gen_random_uuid(), '00000000-0000-4000-8000-0000000000bb', b ->> 'session', 'low_confidence'),
    '{}', 'reject:42501', 'shots_insert_own WITH CHECK forces user_id = auth.uid()', false, false);

  -- The one dangling reference the schema permits by design: feedback outlives
  -- its analysis (no FK), so a service-side shot delete leaves feedback rows
  -- whose analysis_id points nowhere. Rolled back.
  perform it.attempt('XU', 'XU-feedback-outlives-shot', 'owner deletes Alice''s scored shot; her feedback row on it stays behind (returns feedback rows still referencing the deleted shot)',
    null, null,
    format('select it.delete_shot_count_feedback(%L)', a ->> 'shot_scored'),
    jsonb_build_object('shot', a ->> 'shot_scored',
      'feedback_rows_before', (select count(*) from public.analysis_feedback f where f.analysis_id = (a ->> 'shot_scored')::uuid)),
    'return:1', 'analysis_feedback.analysis_id has no FK; rows are append-only telemetry and are only ever removed by the user cascade', true, false,
    'Client sessions hold no DELETE on shots (E1), so this needs the service role. The row is not an orphan under any FK; it is a dangling analysis_id by design.');
end $$;

-- ============================================================================
-- Section DUP — duplicate rows vs the unique constraints the code leans on
-- ============================================================================
do $$
declare
  a jsonb := (select kv.v from it.kv kv where k = 'world_alice');
  alice uuid := '00000000-0000-4000-8000-0000000000aa';
  bob   uuid := '00000000-0000-4000-8000-0000000000bb';
  v_before int; v_after int;
begin
  perform it.attempt('DUP', 'DUP-permit-idempotency-key', 'second permit with the same (user_id, idempotency_key)',
    'authenticated', alice,
    format('insert into public.analysis_permits (user_id, idempotency_key) values (%L, %L)', alice, 'alice-permit-finalized'),
    jsonb_build_object('idempotency_key', 'alice-permit-finalized'),
    'reject:23505', 'unique (user_id, idempotency_key) — one permit per client attempt', false, false);

  perform it.attempt('DUP', 'DUP-permit-key-other-user', 'Bob reuses Alice''s idempotency key (must be allowed: keys are per-user)',
    'authenticated', bob,
    format('insert into public.analysis_permits (user_id, idempotency_key) values (%L, %L)', bob, 'alice-permit-finalized'),
    jsonb_build_object('idempotency_key', 'alice-permit-finalized'),
    'allow', 'the unique key is scoped by user_id', false, false);

  perform it.attempt('DUP', 'DUP-feedback-same-analysis', 'second feedback row for the same (analysis_id, user_id)',
    'authenticated', alice,
    format('insert into public.analysis_feedback (user_id, analysis_id, rating) values (%L, %L, ''not_quite'')', alice, a ->> 'shot_scored'),
    jsonb_build_object('analysis_id', a ->> 'shot_scored'),
    'reject:23505', 'unique (analysis_id, user_id); the Edge Function maps 23505 → 409 analysis.feedback_exists', false, false);

  perform it.attempt('DUP', 'DUP-saved-drill', 'saving the same drill slug twice',
    'authenticated', alice,
    format('insert into public.user_saved_drills (user_id, slug) values (%L, %L)', alice, 'alice-drill'),
    jsonb_build_object('slug', 'alice-drill'),
    'reject:23505', 'primary key (user_id, slug)', false, false);

  perform it.attempt('DUP', 'DUP-shot-phase-key', 'second phase row with the same (shot_id, phase_key)',
    'authenticated', alice,
    format('insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence) values (%L, %L, ''contact'', 0, 1, 2, 0.5)', a ->> 'shot_scored', alice),
    jsonb_build_object('shot', a ->> 'shot_scored'),
    'reject:23505', 'primary key (shot_id, phase_key); apply_synced_shot uses ON CONFLICT DO NOTHING', false, false);

  perform it.attempt('DUP', 'DUP-shot-checkpoint-key', 'second checkpoint row with the same (shot_id, checkpoint_key)',
    'authenticated', alice,
    format('insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable) values (%L, %L, ''contact_position'', 1, 0.5, ''red'', ''low'', 0.5, true)', a ->> 'shot_scored', alice),
    jsonb_build_object('shot', a ->> 'shot_scored'),
    'reject:23505', 'primary key (shot_id, checkpoint_key)', false, false);

  perform it.attempt('DUP', 'DUP-shot-measurement-key', 'second measurement row with the same (shot_id, metric_key)',
    'authenticated', alice,
    format('insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit) values (%L, %L, ''paddle_angle'', 1, 0.5, ''degrees'')', a ->> 'shot_scored', alice),
    jsonb_build_object('shot', a ->> 'shot_scored'),
    'reject:23505', 'primary key (shot_id, metric_key)', false, false);

  perform it.attempt('DUP', 'DUP-session-id-other-user', 'Bob upserts a session with Alice''s session id (createSession shape: ON CONFLICT DO NOTHING)',
    'authenticated', bob,
    format('insert into public.sessions (id, user_id, started_at) values (%L, %L, now()) on conflict (id) do nothing', a ->> 'session', bob),
    jsonb_build_object('alice_session', a ->> 'session'),
    'allow', 'PK collision is swallowed (0 rows); the Edge Function then fails its ownership read → 409 session.id_conflict (index.ts:1313-1324)',
    false, false);

  select count(*) into v_before from public.sessions where id = (a ->> 'session')::uuid and user_id = bob;
  perform it.observe('DUP', 'DUP-session-id-other-user-rows', 'Bob''s colliding upsert wrote nothing',
    jsonb_build_object('bob_rows_with_alice_session_id', v_before), '0', v_before = 0,
    'primary key sessions_pkey', false);

  perform it.attempt('DUP', 'DUP-session-id-plain-insert', 'Bob plain-inserts Alice''s session id (no ON CONFLICT)',
    'authenticated', bob,
    format('insert into public.sessions (id, user_id, started_at) values (%L, %L, now())', a ->> 'session', bob),
    jsonb_build_object('alice_session', a ->> 'session'),
    'reject:23505', 'primary key sessions_pkey', false, false);

  perform it.attempt('DUP', 'DUP-shot-id-other-user-rpc', 'Bob syncs a shot with Alice''s shot id through apply_synced_shot',
    'authenticated', bob,
    format('select public.apply_synced_shot(%L::jsonb)',
      it.shot_payload((a ->> 'shot_scored')::uuid, (select kv.v ->> 'permit_reserved' from it.kv kv where k = 'world_bob')::uuid, null, 'low_confidence')),
    jsonb_build_object('alice_shot', a ->> 'shot_scored'),
    'return:shot.id_conflict', 'shots_pkey + RLS-invisible owner → shot.id_conflict (permanent client rejection)', false, true);

  perform it.attempt('DUP', 'DUP-deletion-request-second-insert', 'second deletion request row for the same user (plain INSERT)',
    'authenticated', alice,
    format('insert into public.account_deletion_requests (user_id) values (%L)', alice),
    '{}', 'reject:23505', 'primary key (user_id) — the Edge Function upserts ON CONFLICT (user_id) instead', false, false);

  perform it.attempt('DUP', 'DUP-deletion-request-upsert-rearm', 'PostgREST upsert shape re-arms the challenge (DO UPDATE sets every payload column)',
    'authenticated', alice,
    format('insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at) values (%L, %L, now(), now() + interval ''15 minutes'') on conflict (user_id) do update set user_id = excluded.user_id, challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at',
           alice, '00000000-0000-4000-8000-00000000c0de'),
    jsonb_build_object('challenge', '00000000-0000-4000-8000-00000000c0de'),
    'allow', 'column grants cover user_id, challenge, created_at, expires_at (20260831160000)', false, true);

  perform it.attempt('DUP', 'DUP-webhook-event-id', 'replayed webhook event id',
    null, null,
    'insert into public.webhook_events (id, payload) values (''evt-dup'', ''{}''), (''evt-dup'', ''{}'')',
    jsonb_build_object('id', 'evt-dup'),
    'reject:23505', 'primary key webhook_events_pkey (idempotency)', false, false);

  perform it.attempt('DUP', 'DUP-ledger-identity-hash', 'duplicate identity hash in free_rating_ledger',
    null, null,
    format('insert into public.free_rating_ledger (identity_hash, scored_count) values (%L, 1), (%L, 1)', repeat('a', 64), repeat('a', 64)),
    '{}', 'reject:23505', 'primary key (identity_hash)', false, false);

  perform it.attempt('DUP', 'DUP-ledger-bad-hash', 'ledger row with a malformed identity hash',
    null, null,
    'insert into public.free_rating_ledger (identity_hash, scored_count) values (''not-a-hash'', 1)',
    '{}', 'reject:23514', 'check identity_hash ~ ^[0-9a-f]{64}$', false, false);

  perform it.attempt('DUP', 'DUP-identity-provider-subject', 'a second auth user claiming the same (provider, provider_id)',
    null, null,
    format('insert into auth.identities (provider, provider_id, user_id, identity_data) values (''google'', ''it-google-alice'', %L, ''{}'')', bob),
    '{}', 'reject:23505', 'auth.identities unique (provider_id, provider) — one ledger identity can never belong to two live users (shim mirrors GoTrue)', false, false);
end $$;

-- ============================================================================
-- Section PERMIT — "one permit per shot" and the free-rating accounting
-- (user Eve: fresh account, one session, zero shots)
-- ============================================================================
do $$
declare
  eve uuid := '00000000-0000-4000-8000-0000000000ee';
  sess uuid := '00000000-0000-4000-8000-00000000e5e5';
  p1 uuid; p2 uuid; p3 uuid; p_old uuid := gen_random_uuid(); p_fresh uuid := gen_random_uuid();
  s1 uuid := '00000000-0000-4000-8000-00000000e001';
  s2 uuid := '00000000-0000-4000-8000-00000000e002';
  s3 uuid := '00000000-0000-4000-8000-00000000e003';
  s4 uuid := '00000000-0000-4000-8000-00000000e004';
  s5 uuid := '00000000-0000-4000-8000-00000000e005';
  s6 uuid := '00000000-0000-4000-8000-00000000e006';
  v text; r record; v_state jsonb;
begin
  -- P1: reserve + replay
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', eve::text, true);
  select permit_id into p1 from public.reserve_analysis_permit('eve-k1');
  reset role;
  perform it.attempt('PERMIT', 'PERMIT-reserve-replay', 'replaying idempotency key eve-k1 returns the SAME permit id',
    'authenticated', eve, 'select permit_id::text from public.reserve_analysis_permit(''eve-k1'')',
    jsonb_build_object('first_permit', p1), 'return:' || p1::text,
    'reserve_analysis_permit fast path + unique (user_id, idempotency_key)', false, true);

  -- P2: consume p1 with shot s1 (scored)
  perform it.attempt('PERMIT', 'PERMIT-consume', 'Eve syncs scored shot s1 with permit p1',
    'authenticated', eve, format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(s1, p1, sess, 'scored')),
    jsonb_build_object('shot', s1, 'permit', p1), 'return:accepted', 'happy path', false, true);
  select status || '/' || coalesce(outcome, '∅') into v from public.analysis_permits where id = p1;
  perform it.observe('PERMIT', 'PERMIT-consume-finalized', 'p1 is finalized/scored after the sync',
    jsonb_build_object('permit', p1, 'status_outcome', v), 'finalized/scored', v = 'finalized/scored',
    'apply_synced_shot finalizes the permit in the same transaction', false);

  -- P3: same permit, a DIFFERENT shot
  perform it.attempt('PERMIT', 'PERMIT-reuse-across-shots', 'Eve syncs a second, different shot s2 with the already-consumed permit p1',
    'authenticated', eve, format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(s2, p1, sess, 'scored')),
    jsonb_build_object('shot', s2, 'permit', p1), 'return:access.permit_not_reserved',
    'no FK/unique links shots↔permits; the RPC refuses via status <> reserved (function-level, not a constraint)', false, true);
  perform it.observe('PERMIT', 'PERMIT-reuse-across-shots-no-row', 's2 was not written',
    jsonb_build_object('s2_rows', (select count(*) from public.shots where id = s2)), '0',
    (select count(*) from public.shots where id = s2) = 0, 'refused sync writes nothing', false);

  -- P4: same shot id, a DIFFERENT (fresh) permit → replay-accept, permit stranded
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', eve::text, true);
  select permit_id into p2 from public.reserve_analysis_permit('eve-k2');
  reset role;
  perform it.attempt('PERMIT', 'PERMIT-stranded-by-replay', 'Eve re-syncs the SAME shot s1 carrying a NEW permit p2',
    'authenticated', eve, format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(s1, p2, sess, 'scored')),
    jsonb_build_object('shot', s1, 'permit', p2), 'return:accepted',
    'idempotent replay returns accepted before touching the permit (20260902150000 lines 389-393)', false, true);
  select status into v from public.analysis_permits where id = p2;
  select to_jsonb(x) into v_state from (select * from public.access_state()) x;
  -- access_state must run as Eve for RLS
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', eve::text, true);
  select to_jsonb(x) into v_state from (select * from public.access_state()) x;
  reset role;
  perform it.observe('PERMIT', 'PERMIT-stranded-by-replay-state', 'p2 stays reserved and occupies a free-rating slot for 24h',
    jsonb_build_object('permit', p2, 'status', v, 'access_state_as_eve', v_state),
    'reserved, reserved_count=1', v = 'reserved' and (v_state ->> 'reserved_count')::int = 1,
    'no constraint binds a shot to exactly one permit; a replay with a fresh permit leaves that permit reserved until the hourly sweep (24h)',
    true, 'Client path: the outbox stores analysisPermitId with the analysis (apps/mobile/src/data/sync.ts:197-207), so a normal retry reuses the same permit — this needs a client that mints a new permit for an already-synced shot id. INFERRED.');
  perform it.attempt('PERMIT', 'PERMIT-stranded-blocks-reserve', 'with 1 scored + 1 stranded reserved, a new reservation is refused',
    'authenticated', eve, 'select result from public.reserve_analysis_permit(''eve-k3'')',
    jsonb_build_object('scored', 1, 'reserved', 1), 'return:access.paywall_required',
    'reserve: remaining(1) <= reserved(1) → paywall_required', true, true,
    'Consequence of the stranded permit: the second free rating is unavailable for up to 24 hours.');
  -- release p2 so the rest of the section starts clean (client-permitted column update)
  perform it.attempt('PERMIT', 'PERMIT-client-release', 'Eve releases p2 herself (status/outcome column grant)',
    'authenticated', eve, format('update public.analysis_permits set status = ''released'', outcome = ''cancelled'' where id = %L', p2),
    jsonb_build_object('permit', p2), 'allow', 'E6: lifecycle columns are client-writable', false, true);

  -- P5: client rewinds a FINALIZED permit back to reserved
  perform it.attempt('PERMIT', 'PERMIT-rewind-finalized', 'Eve flips consumed permit p1 from finalized back to reserved',
    'authenticated', eve, format('update public.analysis_permits set status = ''reserved'', outcome = null where id = %L', p1),
    jsonb_build_object('permit', p1), 'allow',
    'no check constraint / trigger pins the status state machine (reserved→finalized|released only); the UPDATE grant on status/outcome allows any transition',
    true, true);
  perform it.attempt('PERMIT', 'PERMIT-rewind-then-consume-again', 'the rewound p1 is consumed a second time by a new scored shot s3',
    'authenticated', eve, format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(s3, p1, sess, 'scored')),
    jsonb_build_object('shot', s3, 'permit', p1), 'return:accepted',
    'one permit, two scored shots — the lifetime backstop (count < 2) still lets this one through', true, true,
    'Total scored stays bounded by the backstop, so this cannot exceed two lifetime ratings; it does break the "one permit per shot" bookkeeping and access_state.reserved_count semantics.');

  -- P6: direct INSERT into shots bypasses the permit entirely
  perform it.attempt('PERMIT', 'PERMIT-bypass-direct-insert', 'Eve INSERTs a scored shot directly (no permit at all) — at the free limit (2 scored)',
    'authenticated', eve, format('select it.insert_shot(%L, %L, %L, ''scored'', 8.0)', s4, eve, sess),
    jsonb_build_object('shot', s4, 'lifetime_scored_before', 2), 'allow',
    'authenticated holds INSERT on public.shots (shots_insert_own); no trigger enforces the permit or the free limit — only apply_synced_shot does',
    true, true,
    'The RPC backstop (H3 in security_regression.sql) is bypassed by not calling the RPC.');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', eve::text, true);
  select to_jsonb(x) into v_state from (select * from public.access_state()) x;
  reset role;
  perform it.observe('PERMIT', 'PERMIT-bypass-direct-insert-state', 'Eve now has 3 lifetime scored shots against 1 consumed permit',
    jsonb_build_object('access_state_as_eve', v_state,
      'scored_shots', (select count(*) from public.shots where user_id = eve and result_kind = 'scored'),
      'finalized_permits', (select count(*) from public.analysis_permits where user_id = eve and status = 'finalized'),
      'ledger', (select jsonb_agg(jsonb_build_object('hash', identity_hash, 'count', scored_count)) from public.free_rating_ledger where identity_hash = public.free_rating_identity_hash('apple', 'it-apple-eve'))),
    'scored_count=3', (v_state ->> 'scored_count')::int = 3,
    'scored shots (3) > permits ever finalized (1): the "one permit per scored shot" assumption does not hold at the DB layer', true);

  perform it.attempt('PERMIT', 'PERMIT-bypass-direct-insert-reserve-after', 'after the bypass, the RPC gate still says paywall',
    'authenticated', eve, 'select result from public.reserve_analysis_permit(''eve-k4'')',
    '{}', 'return:access.paywall_required', 'gates read lifetime_scored_count (3 ≥ 2)', false, true);

  -- P7: permit expiry boundary (24h) vs the sweep vs reserved_count
  insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at)
  values (p_old, eve, 'eve-old', 'reserved', now() - interval '24 hours 1 second'),
         (p_fresh, eve, 'eve-fresh', 'reserved', now() - interval '23 hours 59 minutes');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', eve::text, true);
  select to_jsonb(x) into v_state from (select * from public.access_state()) x;
  reset role;
  perform it.observe('PERMIT', 'PERMIT-expiry-reserved-count', 'a 24h01s-old reserved permit is not counted; a 23h59m one is',
    jsonb_build_object('access_state_as_eve', v_state, 'p_old', p_old, 'p_fresh', p_fresh),
    'reserved_count=1', (v_state ->> 'reserved_count')::int = 1,
    'access_state counts created_at > now() - 24h', false);
  -- Eve is at the paywall, so use an abstention (no backstop) to isolate the expiry check.
  perform it.attempt('PERMIT', 'PERMIT-expiry-consume-old', 'sync (abstention) with the 24h01s-old permit',
    'authenticated', eve, format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(s5, p_old, sess, 'low_confidence')),
    jsonb_build_object('shot', s5, 'permit', p_old), 'return:access.permit_expired',
    'apply_synced_shot: created_at <= now() - 24h → permit_expired and released/expired', false, true);
  select status || '/' || coalesce(outcome, '∅') into v from public.analysis_permits where id = p_old;
  perform it.observe('PERMIT', 'PERMIT-expiry-consume-old-state', 'the expired permit was lazily released by the request path',
    jsonb_build_object('permit', p_old, 'status_outcome', v, 's5_rows', (select count(*) from public.shots where id = s5)),
    'released/expired, s5 not written', v = 'released/expired' and (select count(*) from public.shots where id = s5) = 0,
    'lazy expiry mirrors the sweep', false,
    'Client impact (INFERRED from apps/mobile/src/data/sync.ts:101-110): access.permit_expired is not in TRANSIENT_SYNC_REJECTION_CODES, so a shot that stays offline > 24h after its permit was reserved is marked a permanent sync failure and never reaches the server.');
  perform it.attempt('PERMIT', 'PERMIT-expiry-consume-fresh', 'sync (abstention) with the 23h59m-old permit',
    'authenticated', eve, format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(s6, p_fresh, sess, 'low_confidence')),
    jsonb_build_object('shot', s6, 'permit', p_fresh), 'return:accepted', 'inside the 24h window', false, true);
  select status || '/' || coalesce(outcome, '∅') into v from public.analysis_permits where id = p_fresh;
  perform it.observe('PERMIT', 'PERMIT-abstention-releases', 'an abstention releases its permit with outcome low_confidence',
    jsonb_build_object('permit', p_fresh, 'status_outcome', v), 'released/low_confidence', v = 'released/low_confidence',
    'apply_synced_shot: non-scored → released', false);

  -- P8: RPC refuses another user's session (the XU case, through the sanctioned path)
  perform it.attempt('PERMIT', 'PERMIT-rpc-foreign-session', 'apply_synced_shot with Bob''s session id (Eve, abstention, fresh permit)',
    'authenticated', eve,
    format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(gen_random_uuid(),
      (select id from public.analysis_permits where user_id = eve and idempotency_key = 'eve-k2'),
      (select (kv.v ->> 'session')::uuid from it.kv kv where k = 'world_bob'), 'low_confidence')),
    '{}', 'return:access.permit_not_reserved',
    'p2 was released above, so the permit check fires first; the session check is exercised next', false, true);
  p3 := '00000000-0000-4000-8000-00000000e0a5';
  insert into public.analysis_permits (id, user_id, idempotency_key, status) values (p3, eve, 'eve-k5', 'reserved');
  perform it.attempt('PERMIT', 'PERMIT-rpc-foreign-session-2', 'apply_synced_shot with Bob''s session id and a live permit',
    'authenticated', eve,
    format('select public.apply_synced_shot(%L::jsonb)', it.shot_payload(gen_random_uuid(), p3,
      (select (kv.v ->> 'session')::uuid from it.kv kv where k = 'world_bob'), 'low_confidence')),
    jsonb_build_object('permit', p3, 'bob_session', (select kv.v ->> 'session' from it.kv kv where k = 'world_bob')),
    'return:shot.session_not_found', 'RPC validates session ownership under RLS (unlike the direct INSERT in XU-shots.session_id)', false, true);
end $$;

-- ============================================================================
-- Section PRIV — privilege residue that RLS does not govern
-- ============================================================================
do $$
declare
  alice uuid := '00000000-0000-4000-8000-0000000000aa';
  v_before bigint; v_after bigint; v jsonb; r record;
begin
  -- Residual grants snapshot: TRUNCATE / TRIGGER / REFERENCES held by client roles.
  insert into it.kv
  select 'client_role_grants', jsonb_agg(jsonb_build_object(
      'table', table_name, 'grantee', grantee,
      'privileges', privs) order by table_name, grantee)
  from (
    select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
    group by 1, 2) g;

  insert into it.kv
  select 'truncate_grants_to_clients', coalesce(jsonb_agg(table_name order by table_name), '[]')
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type = 'TRUNCATE';

  -- Expectation is read from the catalog: does the GRANT that exists agree with
  -- what execution allows? bad_state flags the allowed outcome either way.
  select count(*) into v_before from public.analysis_permits;
  perform it.attempt('PRIV', 'PRIV-truncate-analysis_permits', 'authenticated TRUNCATEs public.analysis_permits (RLS does not apply to TRUNCATE)',
    'authenticated', alice, 'truncate public.analysis_permits',
    jsonb_build_object('rows_before', v_before,
      'has_table_privilege_TRUNCATE', has_table_privilege('authenticated', 'public.analysis_permits', 'TRUNCATE')),
    case when has_table_privilege('authenticated', 'public.analysis_permits', 'TRUNCATE') then 'allow' else 'reject:42501' end,
    'the migrations REVOKE their way down from the hosted default GRANT ALL; no migration revokes TRUNCATE (E-series revokes name UPDATE/DELETE only)', true, false,
    'Rolled back by the harness. Reachability: PostgREST exposes no TRUNCATE verb, so this needs a SQL path running as `authenticated` (INFERRED: none exists in the Edge Function).');

  select count(*) into v_before from public.shots;
  perform it.attempt('PRIV', 'PRIV-truncate-shots-cascade', 'authenticated TRUNCATEs public.shots CASCADE (takes shot_phases/checkpoints/measurements with it)',
    'authenticated', alice, 'truncate public.shots cascade',
    jsonb_build_object('shots_before', v_before,
      'has_table_privilege_TRUNCATE', has_table_privilege('authenticated', 'public.shots', 'TRUNCATE')),
    case when has_table_privilege('authenticated', 'public.shots', 'TRUNCATE') then 'allow' else 'reject:42501' end,
    'shots are documented "fully immutable from a client session" (E1, 20260831160000); TRUNCATE is the one write RLS cannot see', true, false);

  perform it.attempt('PRIV', 'PRIV-truncate-profiles', 'authenticated TRUNCATEs public.profiles (no CASCADE)',
    'authenticated', alice, 'truncate public.profiles',
    jsonb_build_object('has_table_privilege_TRUNCATE', has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE')),
    'reject:0A000',
    'authenticated holds TRUNCATE on profiles, but a table referenced by FKs cannot be truncated without CASCADE', false, false);
  perform it.attempt('PRIV', 'PRIV-truncate-profiles-cascade', 'authenticated TRUNCATEs public.profiles CASCADE',
    'authenticated', alice, 'truncate public.profiles cascade',
    jsonb_build_object('has_table_privilege_TRUNCATE', has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE'),
      'tables_referencing_profiles_without_TRUNCATE', (
        select coalesce(jsonb_agg(distinct k.conrelid::regclass::text), '[]') from pg_constraint k
        where k.contype = 'f' and k.confrelid = 'public.profiles'::regclass
          and not has_table_privilege('authenticated', k.conrelid, 'TRUNCATE'))),
    'reject:42501',
    'CASCADE needs TRUNCATE on every referencing table; account_deletion_feedback (service-only) lacks it, so the cascade is refused — the guard is incidental, not a design', false, false,
    'profiles survives only because one dependent table happens to lack the grant.');

  perform it.attempt('PRIV', 'PRIV-truncate-as-anon', 'anon TRUNCATEs public.sessions',
    'anon', null, 'truncate public.sessions',
    '{}', 'reject:42501', 'anon has no table grants after 20260831160000', false, false);

  -- TRIGGER privilege: can a client attach a trigger with any function it may execute?
  insert into it.kv
  select 'trigger_functions_executable_by_authenticated', coalesce(jsonb_agg(p.proname order by p.proname), '[]')
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
    and has_function_privilege('authenticated', p.oid, 'execute');

  perform it.attempt('PRIV', 'PRIV-create-trigger', 'authenticated creates a trigger on public.shots using public.reject_ledger_mutation()',
    'authenticated', alice,
    'create trigger it_hostile before insert on public.shots for each row execute function public.reject_ledger_mutation()',
    jsonb_build_object('has_table_privilege_TRIGGER', has_table_privilege('authenticated', 'public.shots', 'TRIGGER'),
      'executable_trigger_functions', (select kv.v from it.kv kv where k = 'trigger_functions_executable_by_authenticated')),
    'reject:42501', 'TRIGGER privilege is granted but EXECUTE on every trigger function is revoked from authenticated (20260831160000) — the grant is inert only because of that', true, false);
  perform it.observe('PRIV', 'PRIV-trigger-privilege-inert', 'no trigger function is executable by authenticated, so the residual TRIGGER grant cannot be used',
    (select kv.v from it.kv kv where k = 'trigger_functions_executable_by_authenticated'), '[]',
    (select kv.v from it.kv kv where k = 'trigger_functions_executable_by_authenticated') = '[]'::jsonb,
    'CREATE TRIGGER needs TRIGGER on the table AND EXECUTE on the function', false);

  -- Append-only ledgers vs the table owner (compromised backend)
  perform it.attempt('PRIV', 'PRIV-owner-update-consent', 'table owner UPDATEs a consent_records row',
    null, null, 'update public.consent_records set action = ''withdraw'' where true',
    '{}', 'reject:42501', 'trigger reject_ledger_mutation (BEFORE UPDATE)', false, false);
  perform it.attempt('PRIV', 'PRIV-owner-delete-trial', 'table owner DELETEs an evaluation_trials row',
    null, null, 'delete from public.evaluation_trials where true',
    '{}', 'reject:42501', 'trigger reject_ledger_mutation (BEFORE DELETE, depth 1)', false, false);
  perform it.attempt('PRIV', 'PRIV-owner-delete-feedback', 'table owner DELETEs an analysis_feedback row',
    null, null, 'delete from public.analysis_feedback where true',
    '{}', 'reject:42501', 'trigger reject_ledger_mutation', false, false);
  perform it.attempt('PRIV', 'PRIV-owner-update-deletion-feedback', 'table owner UPDATEs account_deletion_feedback',
    null, null, 'update public.account_deletion_feedback set reason = ''x'' where true',
    '{}', 'reject:42501', 'trigger reject_deletion_feedback_mutation', false, false);
  perform it.attempt('PRIV', 'PRIV-owner-delete-deletion-feedback', 'table owner DELETEs account_deletion_feedback',
    null, null, 'delete from public.account_deletion_feedback where true',
    '{}', 'reject:42501', 'trigger reject_deletion_feedback_mutation', false, false);

  -- Service-only ledger from a client
  perform it.attempt('PRIV', 'PRIV-client-read-ledger', 'authenticated reads free_rating_ledger',
    'authenticated', alice, 'select count(*)::text from public.free_rating_ledger',
    '{}', 'reject:42501', 'RLS on, no policies, no client grants', false, false);
  perform it.attempt('PRIV', 'PRIV-client-write-ledger', 'authenticated writes free_rating_ledger',
    'authenticated', alice, format('insert into public.free_rating_ledger values (%L, 0)', repeat('b', 64)),
    '{}', 'reject:42501', 'service-only', false, false);
  perform it.attempt('PRIV', 'PRIV-client-update-ledger-via-identity-hash', 'authenticated calls identity_scored_count() (the one definer reader)',
    'authenticated', alice, 'select public.identity_scored_count()::text',
    '{}', 'return:1', 'definer, auth.uid()-scoped: Alice has 1 scored shot recorded in the ledger', false, true);

  -- Deletion-request self-tampering (the grant covers every column)
  perform it.attempt('PRIV', 'PRIV-deletion-request-never-expires', 'Alice sets her own deletion challenge to expire in 100 years',
    'authenticated', alice, format('update public.account_deletion_requests set expires_at = now() + interval ''100 years'' where user_id = %L', alice),
    '{}', 'allow', 'expires_at is client-writable (PostgREST upsert shape needs it); no check bounds it', true, false,
    'Self-only: the challenge value is still required to confirm. It does mean the pg_cron purge never collects such a row.');
  perform it.attempt('PRIV', 'PRIV-deletion-request-backdate', 'Alice backdates created_at to skip the confirm minimum age',
    'authenticated', alice, format('update public.account_deletion_requests set created_at = now() - interval ''1 day'' where user_id = %L', alice),
    '{}', 'allow', 'created_at is client-writable; DELETE_CONFIRM_MIN_AGE_MS is checked in the Edge Function against this column (index.ts:2595)', true, false,
    'Self-only (deleting one''s own account faster).');
end $$;

-- ============================================================================
-- Section SWEEP — the pg_cron jobs exactly as the migration scheduled them
-- ============================================================================
do $$
declare
  alice uuid := '00000000-0000-4000-8000-0000000000aa';
  bob   uuid := '00000000-0000-4000-8000-0000000000bb';
  frank uuid := '00000000-0000-4000-8000-0000000000ff';
  v_cmd text; v jsonb; n int;
  keep_a uuid := gen_random_uuid(); rel_a uuid := gen_random_uuid(); fin_a uuid := gen_random_uuid();
  rel_b uuid := gen_random_uuid(); rel_old_released uuid := gen_random_uuid();
begin
  insert into it.kv select 'cron_jobs', jsonb_agg(to_jsonb(j) order by j.jobname) from cron.job j;
  select kv.v into v from it.kv kv where k = 'cron_jobs';
  perform it.observe('SWEEP', 'SWEEP-jobs-scheduled', 'the three maintenance jobs are registered with the documented names',
    v, 'expire-stale-analysis-permits, purge-expired-deletion-requests, purge-old-webhook-events',
    (select count(*) from cron.job where jobname in ('expire-stale-analysis-permits', 'purge-expired-deletion-requests', 'purge-old-webhook-events')) = 3,
    '20260831000000 §8 (pg_cron present → schedules)', false,
    'pg_cron itself is a harness stub (integrity/cron_stub.sql): the COMMAND text is what the migration passed to cron.schedule; the scheduler is not exercised.');

  -- Permits: boundary fixtures
  insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome, created_at) values
    (keep_a, frank, 'sweep-keep-23h59m', 'reserved', null, now() - interval '23 hours 59 minutes'),
    (rel_a,  frank, 'sweep-release-24h01s', 'reserved', null, now() - interval '24 hours 1 second'),
    (fin_a,  frank, 'sweep-finalized-old', 'finalized', 'scored', now() - interval '30 days'),
    (rel_old_released, frank, 'sweep-released-old', 'released', 'cancelled', now() - interval '30 days'),
    (rel_b,  bob,   'sweep-release-other-user', 'reserved', null, now() - interval '48 hours');
  select command into v_cmd from cron.job where jobname = 'expire-stale-analysis-permits';
  perform it.attempt('SWEEP', 'SWEEP-permits-run', 'run the scheduled stale-permit sweep verbatim',
    null, null, v_cmd,
    jsonb_build_object('keep_23h59m', keep_a, 'release_24h01s', rel_a, 'finalized_old', fin_a,
                       'released_old', rel_old_released, 'release_other_user_48h', rel_b),
    'allow', 'cron command from the migration', false, true);
  select jsonb_object_agg(idempotency_key, status || '/' || coalesce(outcome, '∅')) into v
  from public.analysis_permits where idempotency_key like 'sweep-%';
  perform it.observe('SWEEP', 'SWEEP-permits-result', 'only reserved permits older than 24h flipped to released/expired',
    v, 'keep=reserved/∅, release-24h01s=released/expired, finalized-old untouched, released-old untouched, other-user-48h=released/expired',
    v ->> 'sweep-keep-23h59m' = 'reserved/∅'
      and v ->> 'sweep-release-24h01s' = 'released/expired'
      and v ->> 'sweep-finalized-old' = 'finalized/scored'
      and v ->> 'sweep-released-old' = 'released/cancelled'
      and v ->> 'sweep-release-other-user' = 'released/expired',
    'status = reserved and created_at < now() - 24h', false);
  -- Boundary agreement between the three 24h predicates
  perform it.observe('SWEEP', 'SWEEP-permits-boundary-agreement', 'sweep (<), access_state (>), apply_synced_shot (<=) partition the timeline with no gap',
    jsonb_build_object('sweep', 'created_at < now() - 24h', 'access_state_reserved_count', 'created_at > now() - 24h',
                       'apply_synced_shot_expired', 'created_at <= now() - 24h'),
    'no instant is both counted-as-reserved and refused-as-expired',
    true, 'complement predicates: counted ⇔ > , refused ⇔ <= ; the sweep only touches the refused side', false);

  -- Deletion requests: alice expired 1d01s ago (purge), bob expired 1h ago (keep), frank pending
  update public.account_deletion_requests set expires_at = now() - interval '1 day 1 second', created_at = now() - interval '2 days' where user_id = alice;
  update public.account_deletion_requests set expires_at = now() - interval '1 hour', created_at = now() - interval '2 hours' where user_id = bob;
  insert into public.account_deletion_requests (user_id) values (frank);
  select command into v_cmd from cron.job where jobname = 'purge-expired-deletion-requests';
  perform it.attempt('SWEEP', 'SWEEP-deletion-requests-run', 'run the scheduled deletion-request purge verbatim',
    null, null, v_cmd,
    jsonb_build_object('alice_expires_at', 'now()-1d1s', 'bob_expires_at', 'now()-1h', 'frank_expires_at', 'now()+15m'),
    'allow', 'cron command from the migration', false, true);
  select jsonb_build_object(
    'alice', exists (select 1 from public.account_deletion_requests where user_id = alice),
    'bob', exists (select 1 from public.account_deletion_requests where user_id = bob),
    'frank', exists (select 1 from public.account_deletion_requests where user_id = frank)) into v;
  perform it.observe('SWEEP', 'SWEEP-deletion-requests-result', 'only requests expired for more than 1 day are purged',
    v, 'alice=false, bob=true, frank=true',
    not (v ->> 'alice')::boolean and (v ->> 'bob')::boolean and (v ->> 'frank')::boolean,
    'expires_at < now() - 1 day; an expired-but-unpurged row (bob) is rejected by the confirm route''s expires_at check (index.ts:2588, INFERRED)', false);

  -- Webhook events
  insert into public.webhook_events (id, payload, received_at) values
    ('evt-89d', '{}', now() - interval '89 days'),
    ('evt-91d', '{}', now() - interval '91 days'),
    ('evt-now', '{}', now());
  select command into v_cmd from cron.job where jobname = 'purge-old-webhook-events';
  perform it.attempt('SWEEP', 'SWEEP-webhook-events-run', 'run the scheduled webhook purge verbatim',
    null, null, v_cmd, '{"evt-89d":"keep","evt-91d":"purge","evt-now":"keep"}', 'allow', 'cron command from the migration', false, true);
  select coalesce(jsonb_agg(id order by id), '[]') into v from public.webhook_events where id like 'evt-%';
  perform it.observe('SWEEP', 'SWEEP-webhook-events-result', 'only events older than 90 days are purged',
    v, '["evt-89d","evt-now"]', v = '["evt-89d","evt-now"]'::jsonb, 'received_at < now() - 90 days', false);
end $$;

-- ============================================================================
-- Section LEDGER — free-rating identity ledger semantics
-- ============================================================================
do $$
declare
  dave uuid := '00000000-0000-4000-8000-0000000000dd';
  alice uuid := '00000000-0000-4000-8000-0000000000aa';
  a jsonb := (select kv.v from it.kv kv where k = 'world_alice');
  h_alice text := public.free_rating_identity_hash('google', 'it-google-alice');
  n_before int; n_after int; v jsonb; d_shot uuid := gen_random_uuid(); dave2 uuid := gen_random_uuid();
begin
  -- No decrement on shot delete
  select scored_count into n_before from public.free_rating_ledger where identity_hash = h_alice;
  perform it.attempt('LEDGER', 'LEDGER-no-decrement-on-shot-delete', 'owner deletes Alice''s scored shot (client cannot: no DELETE grant)',
    null, null, format('delete from public.shots where id = %L', a ->> 'shot_scored'),
    jsonb_build_object('shot', a ->> 'shot_scored', 'ledger_before', n_before), 'allow', 'owner may delete', false, false);
  select scored_count into n_after from public.free_rating_ledger where identity_hash = h_alice;
  perform it.observe('LEDGER', 'LEDGER-no-decrement-state', 'ledger count unchanged by the (rolled back) delete',
    jsonb_build_object('before', n_before, 'after', n_after), 'equal', n_before = n_after,
    'trigger listens to INSERT/UPDATE OF result_kind only', false);

  -- Upgrade low_confidence → scored increments (owner-only path; clients have no UPDATE on shots)
  perform it.attempt('LEDGER', 'LEDGER-update-to-scored-increments', 'owner flips Alice''s abstention to scored',
    null, null, format('update public.shots set result_kind = ''scored'', overall_score = 5 where id = %L', a ->> 'shot_low_conf'),
    jsonb_build_object('shot', a ->> 'shot_low_conf'), 'allow', 'owner may update', false, true);
  select scored_count into n_after from public.free_rating_ledger where identity_hash = h_alice;
  perform it.observe('LEDGER', 'LEDGER-update-to-scored-state', 'ledger incremented by exactly one',
    jsonb_build_object('before', n_before, 'after', n_after), 'before+1', n_after = n_before + 1,
    'after update of result_kind', false);

  -- A user with zero identity rows never reaches the ledger
  perform it.attempt('LEDGER', 'LEDGER-no-identity-user-scores', 'Dave (no auth.identities row) records a scored shot',
    'authenticated', dave, format('select it.insert_shot(%L, %L, null, ''scored'', 6.0)', d_shot, dave),
    jsonb_build_object('shot', d_shot), 'allow', 'INSERT grant + RLS own', false, true);
  select count(*) into n_after from public.free_rating_ledger
  where identity_hash in (select public.free_rating_identity_hash(provider, provider_id) from auth.identities where user_id = dave);
  perform it.observe('LEDGER', 'LEDGER-no-identity-user-ledger', 'no ledger row exists for Dave',
    jsonb_build_object('dave_ledger_rows', n_after), '0', n_after = 0,
    'ledger is keyed by auth.identities; a user without one is only counted by own shots', false);
  delete from auth.users where id = dave;
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (dave2, 'dave@example.com', '{"full_name":"Dave"}', '{"provider":"google"}');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', dave2::text, true);
  select public.lifetime_scored_count() into n_after;
  reset role;
  perform it.observe('LEDGER', 'LEDGER-no-identity-user-reset', 'Dave deletes and re-creates (still no identity): lifetime count',
    jsonb_build_object('new_user', dave2, 'lifetime_scored_count', n_after), '0 (free ratings reset)', n_after = 0,
    'identity-less users are outside the ledger design; GoTrue always writes an identity for Apple/Google sign-in (INFERRED)', true,
    'Not reachable through the app''s Apple/Google sign-in (signInWithIdToken always creates auth.identities). Recorded as the documented "known limit" boundary, not a defect.');

  -- Two identities move in step
  select jsonb_object_agg(i.provider, l.scored_count) into v
  from auth.identities i join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = '00000000-0000-4000-8000-0000000000cc';
  perform it.observe('LEDGER', 'LEDGER-linked-identities-in-step', 'Carol (google+apple) has both identities at the same count after one scored shot',
    v, '{"google":1,"apple":1}', v = '{"google":1,"apple":1}'::jsonb, 'every identity of the user is set to identity-max + 1', false);
end $$;

-- ============================================================================
-- Section CASCADE — full account deletion (Carol: every table populated, two
-- identities) + orphan scan + re-sign-in inherits the ledger
-- ============================================================================
do $$
declare
  carol uuid := '00000000-0000-4000-8000-0000000000cc';
  carol2 uuid := '00000000-0000-4000-8000-00000000cc02';
  before_counts jsonb; after_counts jsonb; v jsonb; n int; ledger_before jsonb; ledger_after jsonb;
  fb_before int; fb_after_null int; fb_after_total int; orphans jsonb;
  t0 timestamptz; ms numeric;
begin
  before_counts := it.count_for_user(carol);
  select jsonb_object_agg(identity_hash, scored_count) into ledger_before
  from public.free_rating_ledger
  where identity_hash in (public.free_rating_identity_hash('google', 'it-google-carol'),
                          public.free_rating_identity_hash('apple', 'it-apple-carol'));
  select count(*) into fb_before from public.account_deletion_feedback where user_id = carol;
  insert into it.kv values ('cascade_carol_before', before_counts);

  t0 := clock_timestamp();
  perform it.attempt('CASCADE', 'CASCADE-delete-auth-user', 'delete auth.users row for Carol (what auth.admin.deleteUser does)',
    null, null, format('delete from auth.users where id = %L', carol),
    before_counts, 'allow', 'auth.users → profiles → every user table (append-only triggers wave through depth > 1)', false, true);
  ms := extract(epoch from clock_timestamp() - t0) * 1000;

  after_counts := it.count_for_user(carol);
  insert into it.kv values ('cascade_carol_after', after_counts);
  select count(*) into fb_after_null from public.account_deletion_feedback where user_id is null;
  select count(*) into fb_after_total from public.account_deletion_feedback;
  select jsonb_object_agg(identity_hash, scored_count) into ledger_after
  from public.free_rating_ledger
  where identity_hash in (public.free_rating_identity_hash('google', 'it-google-carol'),
                          public.free_rating_identity_hash('apple', 'it-apple-carol'));
  orphans := it.orphan_scan();

  perform it.observe('CASCADE', 'CASCADE-all-user-rows-gone', 'every user_id-keyed row for Carol is gone',
    jsonb_build_object('before', before_counts, 'after', after_counts, 'delete_ms', round(ms, 2)),
    'all zero', (select bool_and((value)::int = 0) from jsonb_each_text(after_counts)),
    'ON DELETE CASCADE on every user table; account_deletion_feedback.user_id is SET NULL (so its per-user count is 0 too)', false);
  perform it.observe('CASCADE', 'CASCADE-exit-survey-retained-anonymized', 'the exit survey row survives with user_id NULL',
    jsonb_build_object('carol_rows_before', fb_before, 'null_user_rows_after', fb_after_null, 'total_rows', fb_after_total),
    'null_user_rows_after >= carol_rows_before', fb_after_null >= fb_before and fb_before = 1,
    '20260902000000: SET NULL + depth>1 waiver in reject_deletion_feedback_mutation', false);
  perform it.observe('CASCADE', 'CASCADE-ledger-survives', 'both identity ledger rows survive with their counts',
    jsonb_build_object('before', ledger_before, 'after', ledger_after), 'equal, non-empty',
    ledger_before = ledger_after and ledger_before is not null, 'free_rating_ledger has no FK', false);
  perform it.observe('CASCADE', 'CASCADE-orphan-scan', 'global orphan scan after the cascade',
    orphans, '{}', orphans = '{}'::jsonb, 'no FK child may outlive its parent', orphans <> '{}'::jsonb);

  -- Re-sign-in with the same Google identity (GoTrue mints a NEW user id)
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (carol2, 'carol@example.com', '{"full_name":"Carol"}', '{"provider":"google"}');
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('google', 'it-google-carol', carol2, '{"sub":"it-google-carol"}');
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', carol2::text, true);
  select to_jsonb(x) into v from (select * from public.access_state()) x;
  reset role;
  perform it.observe('CASCADE', 'CASCADE-recreated-account-inherits', 'the re-created account starts with the identity''s lifetime count, not zero',
    jsonb_build_object('new_user', carol2, 'access_state', v, 'own_shots', (select count(*) from public.shots where user_id = carol2)),
    'scored_count = ledger (1), own shots 0', (v ->> 'scored_count')::int = 1,
    'lifetime_scored_count = greatest(own, identity ledger)', false);
end $$;

-- ============================================================================
-- Section PROV — profile provisioning edge states
-- ============================================================================
do $$
declare
  frank uuid := '00000000-0000-4000-8000-0000000000ff';
  long_user uuid := '00000000-0000-4000-8000-00000000f001';
  v_after jsonb; v text;
begin
  -- Profile deleted from under a live auth user (service-role-only action)
  perform it.attempt('PROV', 'PROV-delete-profile-keep-auth-user', 'owner deletes Frank''s profile row while auth.users keeps him',
    null, null, format('delete from public.profiles where id = %L', frank),
    '{}', 'allow', 'nothing forbids it; only the service role/owner can reach it', true, true,
    'Constructs an auth user with no profile. Every FK insert for him now fails and handle_new_user does not re-fire.');
  perform it.attempt('PROV', 'PROV-orphan-auth-user-cannot-write', 'Frank (auth user, no profile) starts a session',
    'authenticated', frank, format('insert into public.sessions (id, user_id, started_at) values (%L, %L, now())', gen_random_uuid(), frank),
    '{}', 'reject:23503', 'sessions_user_id_fkey → profiles', false, false);
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', frank::text, true);
  select to_jsonb(x) into v_after from (select * from public.access_state()) x;
  reset role;
  perform it.observe('PROV', 'PROV-orphan-auth-user-access-state', 'access_state() for a profile-less auth user',
    v_after, 'premium=false, scored_count=ledger (0), reserved_count=0',
    (v_after ->> 'scored_count')::int = 0 and not (v_after ->> 'premium')::boolean,
    'RPCs do not require the profile row; every table insert does', false,
    'The Edge Function''s bootstrap/onboarding paths read profiles (index.ts:605, 3092) — whether they re-provision a missing row is not exercised here (UNKNOWN).');

  -- handle_new_user vs the NOT VALID text bounds on profiles: the trigger copies
  -- provider metadata verbatim (no truncation), so an over-long value aborts
  -- the auth.users insert itself.
  perform it.attempt('PROV', 'PROV-signup-201-char-name', 'GoTrue inserts an auth user whose provider full_name is 201 chars',
    null, null,
    format('insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values (%L, ''long@example.com'', %L::jsonb, ''{"provider":"google"}'')',
           long_user, jsonb_build_object('full_name', repeat('n', 201))::text),
    jsonb_build_object('user', long_user, 'display_name_length', 201), 'reject:23514',
    'handle_new_user copies raw_user_meta_data.full_name into profiles.display_name untruncated; profiles_text_bounds caps it at 200 (NOT VALID still applies to new rows) → the auth.users INSERT fails',
    true, false,
    'Failure mode: sign-in for such a provider profile fails at user creation. Whether Apple/Google can deliver a > 200-char name or a > 2048-char avatar URL is not verified here (UNKNOWN; both providers bound these well below the caps as far as their docs state).',
    true);
  perform it.attempt('PROV', 'PROV-signup-2049-char-avatar', 'GoTrue inserts an auth user whose avatar_url is 2049 chars',
    null, null,
    format('insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values (%L, ''long2@example.com'', %L::jsonb, ''{"provider":"google"}'')',
           '00000000-0000-4000-8000-00000000f002', jsonb_build_object('full_name', 'ok', 'avatar_url', 'https://x/' || repeat('a', 2039))::text),
    jsonb_build_object('avatar_url_length', 2049), 'reject:23514',
    'profiles_text_bounds caps avatar_url at 2048; handle_new_user does not truncate', true, false, null, true);
  perform it.attempt('PROV', 'PROV-signup-200-char-name', 'control: a 200-char name provisions fine',
    null, null,
    format('insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values (%L, ''ok@example.com'', %L::jsonb, ''{"provider":"google"}'')',
           '00000000-0000-4000-8000-00000000f003', jsonb_build_object('full_name', repeat('n', 200))::text),
    jsonb_build_object('display_name_length', 200), 'allow', 'within bounds', false, false);
end $$;

-- Final: global orphan scan on the whole fixture set, then commit the world so
-- the runner can export it.
insert into it.kv values ('final_orphan_scan', it.orphan_scan());
do $$
declare v jsonb;
begin
  select kv.v into v from it.kv kv where k = 'final_orphan_scan';
  perform it.observe('CASCADE', 'FINAL-orphan-scan', 'orphan scan over every FK at the end of the matrix',
    v, '{}', v = '{}'::jsonb, 'no orphans anywhere', v <> '{}'::jsonb);
end $$;

commit;
