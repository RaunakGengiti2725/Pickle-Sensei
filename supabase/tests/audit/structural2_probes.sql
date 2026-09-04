-- ============================================================================
-- Structural audit #2 — db-rls-grants-isolation probes (ADDITIVE test file).
--
-- Runs after supabase/tests/shim_auth.sql + every migration, in a throwaway
-- Postgres (see run_structural2_probes.sh). Never touches the existing
-- security_regression.sql matrix. Every probe records the behaviour the
-- codebase CLAIMS (comment / invariant, cited inline) as `expected` and what
-- the database actually did as `observed`; a probe FAILS only when the two
-- disagree. The script never aborts on a failing probe — it collects all
-- results, prints the table, rolls the fixtures back and exits non-zero
-- (ON_ERROR_STOP + a raised exception) when any probe failed, so the
-- runner's exit code is the verdict.
--
-- STATUS ON 4d812e1a: 19 probes FAIL (P01a-f, P02b-e, P03a, P04a-c, P05a,
-- P15a, P16a-c) — each is a reported audit finding, not a harness bug; the
-- expected values are the codebase's own claims. Fix the schema (new
-- migration) or revise the claim, never the probe.
--
-- Shim fidelity: everything here is proven against shim_auth.sql (hosted-like
-- default privileges, auth.uid() from request.jwt.claim.sub). Hosted-only
-- behaviour (PostgREST role switching, supabase_auth_admin, pg_cron) is out
-- of reach of this harness.
--
-- Fixture users (fresh here, independent of the matrix):
--   alice 00000000-0000-4000-8000-0000000000a1  (google)
--   bob   00000000-0000-4000-8000-0000000000b1  (apple)
--   carol 00000000-0000-4000-8000-0000000000c1  (google) — at the free limit
-- ============================================================================

\set QUIET on
\set ON_ERROR_STOP on
\pset pager off

begin;

create schema audit;

create table audit.results (
  seq serial primary key,
  probe text not null,
  expected text not null,
  observed text not null,
  pass boolean not null
);

-- SECURITY DEFINER so the recorder works while the block runs as a client role.
create function audit.record(p_probe text, p_expected text, p_observed text)
returns void language sql security definer as $$
  insert into audit.results (probe, expected, observed, pass)
  values (p_probe, p_expected, coalesce(p_observed, '<null>'), p_expected = p_observed);
$$;

-- Switch the effective client identity inside a DO block (SET LOCAL semantics:
-- rolled back with the enclosing subtransaction, so a caught exception never
-- leaks a role).
create function audit.as_user(p_role text, p_uid uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute format('set local role %I', p_role);
end;
$$;

create function audit.as_postgres()
returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;

grant usage on schema audit to anon, authenticated;
grant execute on all functions in schema audit to anon, authenticated;

-- Direct-INSERT helper: the shape a modified client would POST to PostgREST
-- /rest/v1/shots. SECURITY INVOKER — runs under the caller's RLS + grants.
create function audit.direct_insert_shot(
  p_id uuid, p_uid uuid, p_kind text, p_score numeric,
  p_type text default 'drive', p_session uuid default null
) returns void language sql security invoker as $$
  insert into public.shots (
    id, user_id, session_id, shot_type, captured_at, start_ms, end_ms,
    overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version,
    shot_config_version
  ) values (
    p_id, p_uid, p_session, p_type, now(), 0, 1000, p_score, 0.9, p_kind,
    '1.0', 'mb', 'pose', 'paddle', 'sd', 'ph', 'score-v2', 'cfg'
  );
$$;
grant execute on function audit.direct_insert_shot(uuid, uuid, text, numeric, text, uuid)
  to anon, authenticated;

-- Sync payload in the exact shape supabase/functions/api/index.ts hands to
-- apply_synced_shot (only the fields the RPC reads).
create function audit.sync_payload(
  p_id text, p_permit text, p_kind text, p_score text,
  p_session text default null, p_captured text default '2026-09-04T12:00:00Z'
) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'shotType', 'drive',
    'cameraView', 'side',
    'capturedAt', p_captured,
    'startMs', 0, 'contactMs', 400, 'endMs', 1000,
    'overallScore', p_score,
    'confidence', 0.91,
    'resultKind', p_kind,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0', 'modelBundleVersion', 'mb', 'poseModelVersion', 'pose',
      'paddleModelVersion', 'paddle', 'strokeDetectorVersion', 'sd',
      'phaseModelVersion', 'ph', 'scoringModelVersion', 'score-v2',
      'shotConfigVersion', 'cfg'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 380, 'representativeMs', 400, 'endMs', 420,
      'confidence', 0.8)),
    'checkpoints', jsonb_build_array(jsonb_build_object(
      'key', 'paddle_prep', 'score', 70, 'confidence', 0.8, 'band', 'green',
      'direction', 'higher', 'severity', 0.1, 'applicable', true))
  ));
$$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 'alice2@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000b1', 'bob2@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000c1', 'carol2@example.com', '{"full_name":"Carol"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'g-alice2', '00000000-0000-4000-8000-0000000000a1', '{}'),
  ('apple',  'a-bob2',   '00000000-0000-4000-8000-0000000000b1', '{}'),
  ('google', 'g-carol2', '00000000-0000-4000-8000-0000000000c1', '{}');

-- Alice: a session, a scored shot (with details), a capture, a permit, one
-- row in every append-only ledger, a saved drill, an entitlement, a pending
-- deletion request — data in EVERY user table so the isolation matrix has
-- something to leak.
do $$
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000a1');
  insert into public.sessions (id, user_id, kind, started_at)
  values ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'practice', now());
  perform audit.direct_insert_shot('20000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000a1', 'scored', 6.5, 'drive',
    '10000000-0000-4000-8000-0000000000a1');
  insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
  values ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'contact', 380, 400, 420, 0.8);
  insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
  values ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'hip_rotation', 0.5, 0.8, 'ratio');
  insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
  values ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'paddle_prep', 70, 0.8, 'green', 'higher', 0.1, true);
  insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
  values ('30000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1',
          '10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-0000000000a1',
          now(), 1500, 30, 'automatic_pose_trigger', 'valid');
  insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
  values ('40000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'alice-p1', 'finalized', 'scored');
  insert into public.consent_records (user_id, scope, action, consent_version)
  values ('00000000-0000-4000-8000-0000000000a1', 'video_analysis', 'grant', '1');
  insert into public.evaluation_trials (id, user_id, payload)
  values ('50000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', '{"k":1}');
  insert into public.analysis_feedback (user_id, analysis_id, rating)
  values ('00000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-0000000000a1', 'accurate');
  insert into public.user_saved_drills (user_id, slug)
  values ('00000000-0000-4000-8000-0000000000a1', 'dink-ladder');
  insert into public.account_deletion_requests (user_id)
  values ('00000000-0000-4000-8000-0000000000a1');
  perform audit.as_postgres();
  insert into public.billing_entitlements (user_id, premium, expires_at)
  values ('00000000-0000-4000-8000-0000000000a1', true, now() + interval '30 days');
end $$;

-- Carol: exactly 2 scored shots → at the lifetime free limit.
do $$
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000c1');
  perform audit.direct_insert_shot('20000000-0000-4000-8000-0000000000c1',
    '00000000-0000-4000-8000-0000000000c1', 'scored', 5.0, 'drive');
  perform audit.direct_insert_shot('20000000-0000-4000-8000-0000000000c2',
    '00000000-0000-4000-8000-0000000000c1', 'scored', 5.0, 'dink');
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P01 — detail rows can only be attached to the caller's OWN shot.
-- Claim: 20260829120000_progress_data.sql:260-263 "a CHECK-by-policy
-- guarantees a user can only attach details to their own shot (the FK plus
-- shots RLS closes the loop)". Bob inserts phase/measurement/checkpoint rows
-- with user_id = bob but shot_id = ALICE's shot.
-- ===========================================================================
do $$
declare v text;
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'recover', 900, 950, 1000, 0.7);
    v := 'inserted';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.record('P01a shot_phases attach to other user''s shot', 'rejected', regexp_replace(v, ':.*$', ''));

  begin
    insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
    values ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'bogus', 1, 0.5, 'count');
    v := 'inserted';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.record('P01b shot_measurements attach to other user''s shot', 'rejected', regexp_replace(v, ':.*$', ''));

  begin
    insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'bogus_cp', 1, 0.5, 'red', 'lower', 0.9, true);
    v := 'inserted';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.record('P01c shot_checkpoints attach to other user''s shot', 'rejected', regexp_replace(v, ':.*$', ''));

  -- Same shape through the FK-only columns of shots/captures: a direct
  -- INSERT may point session_id / shot_id at ANOTHER user's row.
  begin
    perform audit.direct_insert_shot('20000000-0000-4000-8000-0000000000b9',
      '00000000-0000-4000-8000-0000000000b1', 'low_confidence', null, 'drive',
      '10000000-0000-4000-8000-0000000000a1');
    v := 'inserted';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.record('P01d shots.session_id -> other user''s session (direct insert)', 'rejected', regexp_replace(v, ':.*$', ''));

  begin
    insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('30000000-0000-4000-8000-0000000000b9', '00000000-0000-4000-8000-0000000000b1',
            '10000000-0000-4000-8000-0000000000a1', '20000000-0000-4000-8000-0000000000a1',
            now(), 10, 30, 'imported_video', 'valid');
    v := 'inserted';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.record('P01e captures.session_id/shot_id -> other user''s rows', 'rejected', regexp_replace(v, ':.*$', ''));

  -- Existence oracle: does the FK error text differ between a real foreign
  -- id and a random one? (Only relevant if P01x are rejected by FK, not RLS.)
  perform audit.as_postgres();
end $$;

-- Is Alice's shot now carrying a row she cannot see? (owner-scoped SELECT
-- hides bob's phase row from alice; the row exists for the table owner.)
do $$
declare n_owner int; n_alice int;
begin
  select count(*) into n_owner from public.shot_phases where shot_id = '20000000-0000-4000-8000-0000000000a1';
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000a1');
  select count(*) into n_alice from public.shot_phases where shot_id = '20000000-0000-4000-8000-0000000000a1';
  perform audit.as_postgres();
  perform audit.record('P01f phase rows on alice''s shot: owner-visible vs alice-visible',
    'owner=1 alice=1', format('owner=%s alice=%s', n_owner, n_alice));
end $$;

-- ===========================================================================
-- P02 — the lifetime free-rating limit is enforced for a direct INSERT.
-- Claims: architecture invariant "Non-premium lifetime free ratings = 2";
-- 20260902130000_shots_delete_revoke.sql:4-6 "the shots table must be
-- append-only for the authenticated role"; AGENTS.md "shot sync goes through
-- apply_synced_shot() (INSERT-only on shots)". Carol has 2 scored shots and
-- is refused by reserve_analysis_permit; can she still record a 3rd (and a
-- fabricated 10.0) with a plain INSERT — no permit, no RPC?
-- ===========================================================================
do $$
declare r record; v text; cnt int; rank_before text; rank_after text; ledger int;
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000c1');
  select * into r from public.reserve_analysis_permit('carol-k3');
  perform audit.record('P02a precondition: carol at limit -> reserve refused',
    'access.paywall_required', r.result);
  select coalesce(tier, 'unranked') into rank_before from public.player_rank_state;

  begin
    perform audit.direct_insert_shot('20000000-0000-4000-8000-0000000000c3',
      '00000000-0000-4000-8000-0000000000c1', 'scored', 10.0, 'drive');
    v := 'inserted';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.record('P02b direct INSERT of 3rd scored shot without permit (at limit)',
    'rejected', regexp_replace(v, ':.*$', ''));

  select public.lifetime_scored_count() into cnt;
  perform audit.record('P02c lifetime_scored_count after direct insert', '2', cnt::text);
  select coalesce(tier, 'unranked') into rank_after from public.player_rank_state;
  perform audit.record('P02d rank tier before/after fabricated 10.0 shot',
    format('%s->%s', rank_before, rank_before), format('%s->%s', rank_before, rank_after));
  perform audit.as_postgres();
  select scored_count into ledger from public.free_rating_ledger
   where identity_hash = public.free_rating_identity_hash('google', 'g-carol2');
  perform audit.record('P02e identity ledger after direct insert', '2', coalesce(ledger::text, 'null'));
end $$;

-- ===========================================================================
-- P03 — EXECUTE surface of every public function for anon / authenticated.
-- Claim: 20260831160000_defense_in_depth.sql:257-262 revokes; hot RPCs are
-- the ONLY client-executable functions. player_rank_tier is revoked from anon
-- at :261 — but a REVOKE FROM anon cannot remove the implicit PUBLIC grant.
-- ===========================================================================
do $$
declare anon_list text; auth_list text;
begin
  select coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ',' order by p.proname), '')
    into anon_list
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('anon', p.oid, 'execute');
  perform audit.record('P03a functions anon can EXECUTE', '', anon_list);

  select coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ',' order by p.proname), '')
    into auth_list
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('authenticated', p.oid, 'execute');
  perform audit.record('P03b functions authenticated can EXECUTE',
    'access_lock_key(p_uid uuid),access_state(),apply_synced_shot(shot jsonb),complete_onboarding(),identity_scored_count(),lifetime_scored_count(),player_rank_tier(rating numeric),reserve_analysis_permit(p_idempotency_key text)',
    auth_list);
end $$;

-- ===========================================================================
-- P04 — apply_synced_shot contract: "Returns a status code string"
-- (20260831000000_scale_and_security.sql:69-72, restated in
-- 20260902150000:~360). Feed malformed JSON and see whether the RPC returns
-- a status string or RAISES. Bob holds a fresh reserved permit.
-- ===========================================================================
do $$
declare r record; v text; pid text;
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  select * into r from public.reserve_analysis_permit('bob-k1');
  pid := r.permit_id::text;

  begin
    v := public.apply_synced_shot(audit.sync_payload('not-a-uuid', pid, 'scored', '7.0'));
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P04a non-uuid id', 'status-string', case when v like 'RAISED:%' then v else 'status-string' end);

  begin
    v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b2', 'nope', 'scored', '7.0'));
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P04b non-uuid analysisPermitId', 'status-string', case when v like 'RAISED:%' then v else 'status-string' end);

  begin
    v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b2', pid, 'scored', '7.0', 'garbage-session'));
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P04c non-uuid sessionId', 'status-string', case when v like 'RAISED:%' then v else 'status-string' end);

  begin
    v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b2', pid, 'scored', '7.0', null, 'yesterday-ish'));
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P04d bad capturedAt', 'shot.write_failed:*', case when v like 'shot.write_failed:%' then 'shot.write_failed:*' else v end);

  begin
    v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b2', pid, 'bogus_kind', '7.0'));
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P04e resultKind outside CHECK', 'shot.write_failed:*', case when v like 'shot.write_failed:%' then 'shot.write_failed:*' else v end);

  begin
    v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b2', pid, 'scored', null));
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P04f scored with null score', 'shot.write_failed:*', case when v like 'shot.write_failed:%' then 'shot.write_failed:*' else v end);

  begin
    v := public.apply_synced_shot('{}'::jsonb);
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P04g empty object', 'status-string', case when v like 'RAISED:%' then v else 'status-string' end);

  -- After all the failures the permit must still be reserved (atomicity claim).
  select status into v from public.analysis_permits where id = pid::uuid;
  perform audit.record('P04h permit still reserved after failed writes', 'reserved', v);
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P05 — reserve_analysis_permit(NULL) / ('') — contract says status strings.
-- ===========================================================================
do $$
declare r record; v text;
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  begin
    select * into r from public.reserve_analysis_permit(null);
    v := r.result;
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P05a reserve_analysis_permit(NULL)', 'status-string', case when v like 'RAISED:%' then v else 'status-string' end);
  begin
    select * into r from public.reserve_analysis_permit('');
    v := r.result;
  exception when others then v := 'RAISED:' || sqlstate;
  end;
  perform audit.record('P05b reserve_analysis_permit('''')', 'accepted', v);
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P06 — exact 24h boundary: access_state counts created_at > now()-24h,
-- apply_synced_shot expires created_at <= now()-24h. At exactly 24h the two
-- must agree (not counted AND expired); at 24h-1s both must treat it live.
-- ===========================================================================
do $$
declare r record; v text; n int; pid uuid;
begin
  -- Clear bob's holds from P04/P05 so the reserve below is decided on the
  -- boundary alone.
  perform audit.as_postgres();
  update public.analysis_permits set status = 'released', outcome = 'cancelled'
   where user_id = '00000000-0000-4000-8000-0000000000b1' and status = 'reserved';
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  select * into r from public.reserve_analysis_permit('bob-boundary');
  pid := r.permit_id;
  perform audit.as_postgres();
  -- Pin to exactly now()-24h as seen by this transaction (now() is frozen).
  update public.analysis_permits set created_at = now() - interval '24 hours' where id = pid;

  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  select reserved_count into n from public.access_state();
  v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b3', pid::text, 'scored', '7.0'));
  perform audit.record('P06a permit at exactly 24h: counted? / sync result',
    format('reserved_count=%s sync=access.permit_expired', n - 1), format('reserved_count=%s sync=%s', n - 1, v));
  perform audit.as_postgres();
  select status || '/' || coalesce(outcome, '') into v from public.analysis_permits where id = pid;
  perform audit.record('P06b expired permit row state', 'released/expired', v);

  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  select * into r from public.reserve_analysis_permit('bob-boundary2');
  pid := r.permit_id;
  perform audit.as_postgres();
  update public.analysis_permits set created_at = now() - interval '24 hours' + interval '1 second' where id = pid;
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  select reserved_count into n from public.access_state();
  v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b3', pid::text, 'low_confidence', null));
  perform audit.record('P06c permit at 24h-1s: counted / sync accepted',
    'counted=t sync=accepted', format('counted=%s sync=%s', n >= 1, v));
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P07 — lifecycle reversal: client sets a FINALIZED permit back to reserved
-- (status is in the column grant). Does the recycled permit mint a 3rd free
-- scored shot for carol (at the limit)?
-- ===========================================================================
do $$
declare v text; n int;
begin
  perform audit.as_postgres();
  insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome)
  values ('40000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1', 'carol-old', 'finalized', 'scored');
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000c1');
  update public.analysis_permits set status = 'reserved', outcome = null
   where id = '40000000-0000-4000-8000-0000000000c1';
  get diagnostics n = row_count;
  perform audit.record('P07a client can flip finalized -> reserved', '1', n::text);
  select reserved_count into n from public.access_state();
  perform audit.record('P07b recycled permit counts as a hold (self-inflicted)', '1', n::text);
  v := public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000c4',
        '40000000-0000-4000-8000-0000000000c1', 'scored', '9.0'));
  perform audit.record('P07c sync with recycled permit at limit', 'access.paywall_required', v);
  perform audit.as_postgres();
  select status || '/' || coalesce(outcome, '-') into v from public.analysis_permits
   where id = '40000000-0000-4000-8000-0000000000c1';
  perform audit.record('P07d backstop releases the recycled permit', 'released/free_limit_exceeded', v);
end $$;

-- ===========================================================================
-- P08 — cross-user isolation matrix over EVERY user table and every
-- security_invoker view: bob (authenticated) sees 0 of alice's rows.
-- Claim: invariant "Owner-only RLS on every user table".
-- ===========================================================================
do $$
declare t text; n int; leaks text := ''; total int := 0;
begin
  -- Alice owns at least one row in every table/view listed (fixture above);
  -- bob must see none of THEM (his own rows are allowed to show up).
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  foreach t in array array[
    'profiles', 'sessions', 'shots', 'shot_phases', 'shot_measurements',
    'shot_checkpoints', 'captures', 'analysis_permits', 'consent_records',
    'evaluation_trials', 'analysis_feedback', 'user_saved_drills',
    'player_rank_state', 'billing_entitlements', 'account_deletion_requests',
    'progress_daily', 'practice_days', 'player_technique_rating'
  ] loop
    execute format('select count(*) from public.%I where %I = %L', t,
      case when t = 'profiles' then 'id' else 'user_id' end,
      '00000000-0000-4000-8000-0000000000a1') into n;
    if n <> 0 then leaks := leaks || t || '=' || n || ' '; end if;
  end loop;
  perform audit.record('P08a bob sees 0 of alice''s rows in every user table/view', '', leaks);
  perform audit.as_postgres();
  foreach t in array array[
    'profiles', 'sessions', 'shots', 'shot_phases', 'shot_measurements',
    'shot_checkpoints', 'captures', 'analysis_permits', 'consent_records',
    'evaluation_trials', 'analysis_feedback', 'user_saved_drills',
    'player_rank_state', 'billing_entitlements', 'account_deletion_requests',
    'progress_daily', 'practice_days', 'player_technique_rating'
  ] loop
    execute format('select count(*) from public.%I where %I = %L', t,
      case when t = 'profiles' then 'id' else 'user_id' end,
      '00000000-0000-4000-8000-0000000000a1') into n;
    if n = 0 then leaks := leaks || t || ' '; end if;
  end loop;
  perform audit.record('P08a-fixture alice has rows in every probed table/view', '', leaks);

  -- alice DOES see her own rows through the views (the views are not empty).
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000a1');
  select count(*) into n from public.progress_daily; leaks := 'progress_daily=' || n;
  select count(*) into n from public.practice_days; leaks := leaks || ' practice_days=' || n;
  select count(*) into n from public.player_technique_rating; leaks := leaks || ' player_technique_rating=' || n;
  perform audit.record('P08b alice sees her own rows through the views',
    'progress_daily=1 practice_days=1 player_technique_rating=1', leaks);

  -- Cross-user UPDATE/DELETE on the writable tables hit 0 rows.
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  leaks := '';
  update public.sessions set ended_at = now() where id = '10000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count; if n <> 0 then leaks := leaks || 'sessions.update '; end if;
  delete from public.sessions where id = '10000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count; if n <> 0 then leaks := leaks || 'sessions.delete '; end if;
  update public.analysis_permits set status = 'released' where id = '40000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count; if n <> 0 then leaks := leaks || 'permits.update '; end if;
  delete from public.captures where id = '30000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count; if n <> 0 then leaks := leaks || 'captures.delete '; end if;
  delete from public.user_saved_drills where user_id = '00000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count; if n <> 0 then leaks := leaks || 'drills.delete '; end if;
  delete from public.account_deletion_requests where user_id = '00000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count; if n <> 0 then leaks := leaks || 'deletion_requests.delete '; end if;
  update public.profiles set first_name = 'Mallory' where id = '00000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count; if n <> 0 then leaks := leaks || 'profiles.update '; end if;
  perform audit.record('P08c cross-user UPDATE/DELETE row counts', '', leaks);
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P09 — identity_scored_count()/lifetime_scored_count() with NULL auth.uid()
-- (no JWT claim, and the anon role has no EXECUTE at all).
-- ===========================================================================
do $$
declare a int; b int; v text;
begin
  perform audit.as_postgres();
  select public.identity_scored_count() into a;
  select public.lifetime_scored_count() into b;
  perform audit.record('P09a null auth.uid(): identity/lifetime counts', '0/0', format('%s/%s', a, b));
  perform audit.as_user('authenticated', null);
  select public.identity_scored_count() into a;
  select public.lifetime_scored_count() into b;
  perform audit.record('P09b authenticated w/o sub claim: identity/lifetime counts', '0/0', format('%s/%s', a, b));
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P10 — sessions upsert with a FOREIGN id (PostgREST upsert = INSERT ... ON
-- CONFLICT DO NOTHING). DB half of the 409 path: bob's row must not land,
-- must not leak, and a later sync against it must say session_not_found.
-- ===========================================================================
do $$
declare n int; v text; r record; owner uuid;
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  insert into public.sessions (id, user_id, kind, started_at)
  values ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', 'practice', now())
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  select count(*) into v from public.sessions where id = '10000000-0000-4000-8000-0000000000a1';
  select * into r from public.reserve_analysis_permit('bob-k-session');
  v := v || '/' || public.apply_synced_shot(audit.sync_payload('20000000-0000-4000-8000-0000000000b4',
        r.permit_id::text, 'scored', '7.0', '10000000-0000-4000-8000-0000000000a1'));
  perform audit.record('P10a foreign-id upsert: rows/visible/sync', '0/0/shot.session_not_found', n || '/' || v);
  perform audit.as_postgres();
  select user_id into owner from public.sessions where id = '10000000-0000-4000-8000-0000000000a1';
  perform audit.record('P10b alice still owns the session', '00000000-0000-4000-8000-0000000000a1', owner::text);
end $$;

-- ===========================================================================
-- P11 — owner DELETE on sessions (grant retained, no route uses it):
-- shots.session_id → NULL, shot count and rank unchanged.
-- ===========================================================================
do $$
declare n int; sid uuid; rank_before text; rank_after text; cnt_before int; cnt_after int;
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000a1');
  select tier into rank_before from public.player_rank_state;
  select public.lifetime_scored_count() into cnt_before;
  delete from public.sessions where id = '10000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count;
  select session_id into sid from public.shots where id = '20000000-0000-4000-8000-0000000000a1';
  select tier into rank_after from public.player_rank_state;
  select public.lifetime_scored_count() into cnt_after;
  perform audit.record('P11a owner session delete: rows/shot.session_id/count/rank',
    format('1/null/%s/%s', cnt_before, rank_before),
    format('%s/%s/%s/%s', n, coalesce(sid::text, 'null'), cnt_after, rank_after));
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P12 — premium expiry: an EXPIRED premium row must not bypass the limit;
-- a live one must.
-- ===========================================================================
do $$
declare r record;
begin
  perform audit.as_postgres();
  insert into public.billing_entitlements (user_id, premium, expires_at)
  values ('00000000-0000-4000-8000-0000000000c1', true, now() - interval '1 second');
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000c1');
  select * into r from public.reserve_analysis_permit('carol-expired-premium');
  perform audit.record('P12a expired premium at limit', 'access.paywall_required', r.result);
  perform audit.as_postgres();
  update public.billing_entitlements set expires_at = now() + interval '1 second'
   where user_id = '00000000-0000-4000-8000-0000000000c1';
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000c1');
  select * into r from public.reserve_analysis_permit('carol-live-premium');
  perform audit.record('P12b live premium at limit', 'accepted', r.result);
  perform audit.as_postgres();
  delete from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000c1';
end $$;

-- ===========================================================================
-- P13 — profiles.provider is client-writable (defense_in_depth.sql:50-53).
-- Pin what a client can write into it and that nothing server-side keys off
-- it (the Edge Function derives provider from the JWT — index.ts:419,2719).
-- ===========================================================================
do $$
declare n int; v text;
begin
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000a1');
  update public.profiles set provider = 'totally-made-up' where id = '00000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count;
  begin
    update public.profiles set provider = repeat('x', 51) where id = '00000000-0000-4000-8000-0000000000a1';
    v := 'accepted';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.record('P13a client sets arbitrary provider / >50 chars', '1 rejected:23514', n || ' ' || v);
  perform audit.as_postgres();
end $$;

-- ===========================================================================
-- P14 — append-only passthrough: which trigger functions could ever issue a
-- nested DELETE/UPDATE against the ledgers? Static pin: no user trigger
-- function body references a ledger table (only the guards themselves).
-- ===========================================================================
do $$
declare v text;
begin
  select coalesce(string_agg(p.proname, ',' order by p.proname), '') into v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype = 'trigger'::regtype
    and p.proname not like 'reject_%'
    and p.prosrc ~* '(consent_records|evaluation_trials|analysis_feedback|account_deletion_feedback)';
  perform audit.record('P14a trigger functions that touch a ledger table', '', v);

  -- And the cascade path still works for a user with rows in every ledger.
  perform audit.as_postgres();
  insert into public.account_deletion_feedback (user_id, reason) values ('00000000-0000-4000-8000-0000000000a1', 'x');
  delete from auth.users where id = '00000000-0000-4000-8000-0000000000a1';
  select format('profiles=%s consent=%s trials=%s feedback=%s survey_user_null=%s rank=%s',
    (select count(*) from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'),
    (select count(*) from public.consent_records where user_id = '00000000-0000-4000-8000-0000000000a1'),
    (select count(*) from public.evaluation_trials where user_id = '00000000-0000-4000-8000-0000000000a1'),
    (select count(*) from public.analysis_feedback where user_id = '00000000-0000-4000-8000-0000000000a1'),
    (select count(*) from public.account_deletion_feedback where user_id is null and reason = 'x'),
    (select count(*) from public.player_rank_state where user_id = '00000000-0000-4000-8000-0000000000a1'))
  into v;
  perform audit.record('P14b account deletion cascade with every ledger populated',
    'profiles=0 consent=0 trials=0 feedback=0 survey_user_null=1 rank=0', v);
end $$;

-- ===========================================================================
-- P15 — FK SET NULL / cascade columns are index-backed (invariant "cascade
-- children ... are index-backed"). List FK columns in public with no index
-- whose leading column is the FK column.
-- ===========================================================================
do $$
declare v text;
begin
  with fks as (
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 1
  ),
  idx_lead as (
    select i.indrelid::regclass as tbl, a.attname as col
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
  )
  select coalesce(string_agg(f.tbl || '.' || f.col, ',' order by f.tbl::text, f.col), '') into v
  from fks f left join idx_lead l on l.tbl = f.tbl and l.col = f.col
  where l.col is null;
  perform audit.record('P15a FK columns without a leading index', '', v);
end $$;

-- ===========================================================================
-- P16 — table privileges beyond SELECT/INSERT/UPDATE/DELETE. The hosted
-- default privileges (mirrored by shim_auth.sql) grant ALL on new tables to
-- anon/authenticated; migrations revoke only the four DML verbs. TRUNCATE is
-- NOT subject to row-level security and fires no BEFORE DELETE trigger, so
-- a client role holding it can empty a table for EVERY user, append-only
-- ledgers included. Claims: "shots have NO client UPDATE or DELETE grant",
-- "consent_records/evaluation_trials/analysis_feedback are append-only at
-- grant AND trigger layer".
-- ===========================================================================
do $$
declare v text; n int;
begin
  select string_agg(grantee || ':' || table_name || ':' || privs, ' ' order by grantee, table_name) into v
  from (
    select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
    from information_schema.role_table_grants
    where grantee in ('anon', 'authenticated') and table_schema = 'public'
      and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
    group by grantee, table_name
  ) g;
  perform audit.record('P16a anon/authenticated TRUNCATE/TRIGGER/REFERENCES grants', '', coalesce(v, ''));

  -- Re-seed the ledger (P14b cascade-deleted alice's rows) so the TRUNCATE
  -- has something of ANOTHER user to destroy.
  insert into public.consent_records (user_id, scope, action, consent_version)
  values ('00000000-0000-4000-8000-0000000000c1', 'video_analysis', 'grant', '1');
  select count(*) into n from public.consent_records;
  perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
  begin
    truncate public.consent_records;
    v := 'truncated';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.as_postgres();
  perform audit.record('P16b authenticated TRUNCATE of the consent ledger (rows before)',
    'rejected', format('%s (%s rows before, %s after)', regexp_replace(v, ':.*$', ''), n,
      (select count(*) from public.consent_records)));

  begin
    perform audit.as_user('authenticated', '00000000-0000-4000-8000-0000000000b1');
    truncate public.shots cascade;
    v := 'truncated';
  exception when others then v := 'rejected:' || sqlstate;
  end;
  perform audit.as_postgres();
  perform audit.record('P16c authenticated TRUNCATE shots CASCADE (all users)',
    'rejected', format('%s (shots left=%s)', regexp_replace(v, ':.*$', ''),
      (select count(*) from public.shots)));
end $$;

-- ===========================================================================
-- Report
-- ===========================================================================
\set QUIET off
\pset format aligned
select probe, pass, expected, observed from audit.results order by seq;
select count(*) filter (where not pass) as failed, count(*) as total from audit.results;

-- Exit non-zero if any probe failed (the runner reads this code).
select count(*) filter (where not pass) > 0 as any_failed,
       count(*) filter (where not pass) as failed_n
  from audit.results \gset

rollback;

\if :any_failed
\echo STRUCTURAL2 PROBES: :failed_n FAILED
select format('do $f$ begin raise exception %L using errcode = $e$P0001$e$; end $f$',
  'STRUCTURAL2 PROBES: ' || :failed_n || ' FAILED') \gexec
\endif
\echo STRUCTURAL2 PROBES: ALL PASSED
