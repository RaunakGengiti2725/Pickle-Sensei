-- ADV INT-analysis-scoring — SQL plane of the scoring definition and release
-- authority, attacked at HEAD 30a4065. Every probe is one `do` block that
-- raises `ADV <id>: …` on a confirmed break; the whole file runs inside one
-- transaction and rolls back, so the database it runs against stays clean.
--
--   RK1  only low_confidence rows           → no player_rank_state row
--   RK2  only partial rows                  → no player_rank_state row
--   RK3  last scored shot deleted           → rank row removed, never stale
--   RK4  scoring_model_version differs      → stored scores rank verbatim
--                                             (no per-version rescale)
--   RK5  low_confidence + numeric score     → refused by the table
--   RK6  scored + null score                → refused by the table
--   RK7  three-decimal score                → column quantizes half away
--                                             from zero exactly once
--   RK8  9 rows for one technique           → window keeps newest 8, weights
--                                             8..1, confidence weight 5
--   RK9  captured_at at the 2100 bound      → refused (never ranks as newest)
--   RA1  same actor approves both outputs   → observation only (independence
--                                             is not a DB invariant)
--   RA2  expired policy (validUntil past)   → activation refused
--   RA3  approval after withdrawal          → refused
--   RA4  decisions log is append-only       → update/delete refused
--   RA5  same version, different bytes      → second install refused
--   RA6  deny_new then re-activate          → the re-activation is audited
--   RA7  read_analysis_release_policy() never invents approval timestamps
\set ON_ERROR_STOP on
begin;

-- Test users; profiles are created by handle_new_user().
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-0000000000a1', 'adv-a1@example.com', '{"full_name":"Adv A1"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000a2', 'adv-a2@example.com', '{"full_name":"Adv A2"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000a3', 'adv-a3@example.com', '{"full_name":"Adv A3"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000a4', 'adv-a4@example.com', '{"full_name":"Adv A4"}', '{"provider":"google"}');

create function pg_temp.adv_shot(
  p_user uuid, p_id uuid, p_shot_type text, p_score numeric, p_kind text,
  p_captured_at timestamptz, p_scoring_version text default 'sm-v1'
) returns void language sql as $$
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms,
    overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
  ) values (
    p_id, p_user, p_shot_type, p_captured_at, 0, 1000,
    p_score, 0.9, p_kind,
    '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', p_scoring_version, 'config-1'
  );
$$;

-- RK1 / RK2 -------------------------------------------------------------------
do $$
declare u uuid := '00000000-0000-4000-8000-0000000000a1';
begin
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', null, 'low_confidence', '2026-08-01T10:00:00Z');
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'serve', null, 'low_confidence', '2026-08-02T10:00:00Z');
  perform public.recompute_player_rank(u);
  if exists (select 1 from public.player_rank_state where user_id = u) then
    raise exception 'ADV RK1: low_confidence-only history produced a rank row';
  end if;
  if exists (select 1 from public.player_technique_rating where user_id = u) then
    raise exception 'ADV RK1: low_confidence rows appear in player_technique_rating';
  end if;
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'drive', null, 'partial', '2026-08-03T10:00:00Z');
  perform public.recompute_player_rank(u);
  if exists (select 1 from public.player_rank_state where user_id = u) then
    raise exception 'ADV RK2: partial-only history produced a rank row';
  end if;
end $$;

-- RK3 -----------------------------------------------------------------------
do $$
declare u uuid := '00000000-0000-4000-8000-0000000000a2';
        sid uuid := gen_random_uuid();
        st record;
begin
  perform pg_temp.adv_shot(u, sid, 'dink', 6.3, 'scored', '2026-08-01T10:00:00Z');
  select * into st from public.player_rank_state where user_id = u;
  if not found or st.rating <> 6.30 or st.tier <> 'gold' or st.technique_count <> 1 or st.scored_shot_count <> 1 then
    raise exception 'ADV RK3: single scored dink 6.3 did not produce Gold 6.30 (got %)', to_jsonb(st);
  end if;
  delete from public.shots where id = sid;
  if exists (select 1 from public.player_rank_state where user_id = u) then
    raise exception 'ADV RK3: rank row survived the deletion of its only evidence';
  end if;
end $$;

-- RK4 -----------------------------------------------------------------------
do $$
declare u uuid := '00000000-0000-4000-8000-0000000000a2';
        st record;
begin
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 5, 'scored', '2026-08-01T10:00:00Z', 'sm-v0');
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 7, 'scored', '2026-08-02T10:00:00Z', 'sm-v1');
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'serve', 9, 'scored', '2026-08-03T10:00:00Z', 'sm-v9-future');
  select * into st from public.player_rank_state where user_id = u;
  -- golden `form-weighted-then-confidence-weighted`: 7.05 Platinum, 2 techniques, 3 analyses
  if not found or st.rating <> 7.05 or st.tier <> 'platinum' or st.technique_count <> 2 or st.scored_shot_count <> 3 then
    raise exception 'ADV RK4: mixed scoring_model_version rows were not ranked verbatim (got %)', to_jsonb(st);
  end if;
  delete from public.shots where user_id = u;
end $$;

-- RK5 / RK6 -------------------------------------------------------------------
do $$
declare u uuid := '00000000-0000-4000-8000-0000000000a3';
begin
  begin
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 7, 'low_confidence', '2026-08-01T10:00:00Z');
    raise exception 'ADV RK5: a low_confidence row with a numeric score was stored';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', null, 'scored', '2026-08-01T10:00:00Z');
    raise exception 'ADV RK6: a scored row with a null score was stored';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 10.01, 'scored', '2026-08-01T10:00:00Z');
    raise exception 'ADV RK6: a scored row above 10 was stored';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', -0.01, 'scored', '2026-08-01T10:00:00Z');
    raise exception 'ADV RK6: a scored row below 0 was stored';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 'NaN'::numeric, 'scored', '2026-08-01T10:00:00Z');
    raise exception 'ADV RK6: a scored row with a NaN score was stored';
  exception when check_violation then null;
  end;
  if exists (select 1 from public.shots where user_id = u) then
    raise exception 'ADV RK5/RK6: a refused row leaked into public.shots';
  end if;
end $$;

-- RK7 -----------------------------------------------------------------------
do $$
declare u uuid := '00000000-0000-4000-8000-0000000000a3';
        st record;
begin
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 6.335, 'scored', '2026-08-01T10:00:00Z');
  select * into st from public.player_rank_state where user_id = u;
  -- golden `three-decimal-scores-quantize-on-decimal-text`: 6.335 → 6.34
  if not found or st.rating <> 6.34 then
    raise exception 'ADV RK7: 6.335 did not quantize to 6.34 exactly once (got %)', to_jsonb(st);
  end if;
  if (select score from public.player_technique_rating where user_id = u and shot_type = 'dink') <> 6.34 then
    raise exception 'ADV RK7: technique view disagrees with the rank row on quantization';
  end if;
  delete from public.shots where user_id = u;
end $$;

-- RK8 -----------------------------------------------------------------------
do $$
declare u uuid := '00000000-0000-4000-8000-0000000000a3';
        tr record;
        st record;
begin
  -- Oldest row is a 10 that must fall OUT of the window; the eight newest are
  -- 1..8 in capture order (newest = 8) → Σ(9-rn)·score = 8·8+7·7+…+1·1 = 204;
  -- Σ(9-rn) = 36 → 5.666… → 5.67.
  perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 10, 'scored', '2026-07-01T10:00:00Z');
  for i in 1..8 loop
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', i, 'scored',
      ('2026-08-0' || i || 'T10:00:00Z')::timestamptz);
  end loop;
  select * into tr from public.player_technique_rating where user_id = u and shot_type = 'dink';
  if not found or tr.score <> 5.67 or tr.sampled_count <> 8 or tr.confidence_weight <> 5
     or tr.captured_at <> '2026-08-08T10:00:00Z'::timestamptz then
    raise exception 'ADV RK8: form window is not newest-8 / weights 8..1 / cap 5 (got %)', to_jsonb(tr);
  end if;
  select * into st from public.player_rank_state where user_id = u;
  if st.rating <> 5.67 or st.scored_shot_count <> 9 then
    raise exception 'ADV RK8: rank row disagrees with the window (got %)', to_jsonb(st);
  end if;
  delete from public.shots where user_id = u;
end $$;

-- RK9 -----------------------------------------------------------------------
do $$
declare u uuid := '00000000-0000-4000-8000-0000000000a3';
begin
  begin
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 7, 'scored', '2100-01-01T00:00:00Z');
    raise exception 'ADV RK9: a capture at the year-2100 bound was stored';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.adv_shot(u, gen_random_uuid(), 'dink', 7, 'scored', '1999-12-31T23:59:59Z');
    raise exception 'ADV RK9: a capture before 2000 was stored';
  exception when check_violation then null;
  end;
end $$;

-- Release authority ---------------------------------------------------------
create function pg_temp.adv_policy(p_version text, p_valid_from bigint, p_valid_until bigint, p_report text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'schemaVersion','analysis-release-policy-v1','version',p_version,
    'validFrom',p_valid_from,'validUntil',p_valid_until,
    'mechanics',jsonb_build_object('lineage',jsonb_build_object(
      'validationReport',jsonb_build_object('version','fixture-1','sha256',p_report))),
    'benchmark',jsonb_build_object('lineage',jsonb_build_object(
      'validationReport',jsonb_build_object('version','fixture-1','sha256',p_report))),
    'supportedInputs',jsonb_build_array())
$$;

create function pg_temp.adv_install(p_document jsonb) returns text language plpgsql as $$
declare serialized text := p_document::text; h text;
begin
  h := encode(sha256(convert_to(serialized,'UTF8')),'hex');
  perform public.install_analysis_release_policy(serialized, h);
  return h;
end $$;

-- RA1 (observation) / RA6 / RA7 ----------------------------------------------
do $$
declare h text; state jsonb; n int; now_s bigint := floor(extract(epoch from now()))::bigint;
begin
  state := public.read_analysis_release_policy();
  if state -> 'approval' is distinct from 'null'::jsonb and (
       state #>> '{approval,mechanicsApprovedAt}' is not null
    or state #>> '{approval,benchmarkApprovedAt}' is not null) then
    -- Another fixture may have activated a policy in this session; this file
    -- only asserts that no timestamps exist WITHOUT a policy.
    null;
  end if;
  if state -> 'document' = 'null'::jsonb and state -> 'approval' is distinct from 'null'::jsonb then
    raise exception 'ADV RA7: approval object reported without an active policy: %', state;
  end if;

  h := pg_temp.adv_install(pg_temp.adv_policy('adv-ra1', now_s - 60, now_s + 3600, repeat('1',64)));
  perform public.approve_analysis_release_output(h, 'mechanics', 'same-person', repeat('1',64));
  perform public.approve_analysis_release_output(h, 'benchmark', 'same-person', repeat('1',64));
  begin
    perform public.activate_analysis_release_policy(h, 'same-person');
    raise notice 'ADV RA1 OBSERVATION: one actor approved mechanics, benchmark and activated policy % (independence is not a DB invariant)', h;
  exception when check_violation then
    raise notice 'ADV RA1: single-actor dual approval refused at activation';
  end;

  -- RA6: deny_new then re-activate — every state change must be audited.
  perform public.deny_new_analysis_authorizations('operator');
  state := public.read_analysis_release_policy();
  if not (state ->> 'denyNewAuthorizations')::boolean then
    raise exception 'ADV RA6: deny_new did not stop new authorizations';
  end if;
  perform public.activate_analysis_release_policy(h, 'operator');
  state := public.read_analysis_release_policy();
  if (state ->> 'denyNewAuthorizations')::boolean then
    raise exception 'ADV RA6: re-activation must clear deny_new (operator action)';
  end if;
  select count(*) into n from api_private.analysis_release_decisions where policy_sha256 = h;
  -- approve_mechanics, approve_benchmark, activate, deny_new, activate = 5
  if n <> 5 then
    raise exception 'ADV RA6: expected 5 audited decisions for %, found %', h, n;
  end if;
end $$;

-- RA2 -----------------------------------------------------------------------
do $$
declare h text; now_s bigint := floor(extract(epoch from now()))::bigint;
begin
  h := pg_temp.adv_install(pg_temp.adv_policy('adv-ra2-expired', now_s - 7200, now_s - 3600, repeat('2',64)));
  perform public.approve_analysis_release_output(h, 'mechanics', 'reviewer-m', repeat('2',64));
  perform public.approve_analysis_release_output(h, 'benchmark', 'reviewer-b', repeat('2',64));
  begin
    perform public.activate_analysis_release_policy(h, 'operator');
    raise exception 'ADV RA2: an expired policy was activated';
  exception when check_violation then null;
  end;
  h := pg_temp.adv_install(pg_temp.adv_policy('adv-ra2-future', now_s + 3600, now_s + 7200, repeat('3',64)));
  perform public.approve_analysis_release_output(h, 'mechanics', 'reviewer-m', repeat('3',64));
  perform public.approve_analysis_release_output(h, 'benchmark', 'reviewer-b', repeat('3',64));
  begin
    perform public.activate_analysis_release_policy(h, 'operator');
    raise exception 'ADV RA2: a not-yet-valid policy was activated';
  exception when check_violation then null;
  end;
end $$;

-- RA3 -----------------------------------------------------------------------
do $$
declare h text; now_s bigint := floor(extract(epoch from now()))::bigint;
begin
  h := pg_temp.adv_install(pg_temp.adv_policy('adv-ra3', now_s - 60, now_s + 3600, repeat('4',64)));
  perform public.approve_analysis_release_output(h, 'mechanics', 'reviewer-m', repeat('4',64));
  perform public.withdraw_analysis_release_policy(h, 'operator');
  begin
    perform public.approve_analysis_release_output(h, 'benchmark', 'reviewer-b', repeat('4',64));
    raise exception 'ADV RA3: approval recorded on a withdrawn policy';
  exception when check_violation then null;
  end;
  begin
    perform public.activate_analysis_release_policy(h, 'operator');
    raise exception 'ADV RA3: withdrawn policy activated';
  exception when check_violation then null;
  end;
end $$;

-- RA4 -----------------------------------------------------------------------
do $$
begin
  begin
    update api_private.analysis_release_decisions set actor = 'forged' where action = 'withdraw';
    raise exception 'ADV RA4: decision history was rewritten';
  exception when check_violation then null;
  end;
  begin
    delete from api_private.analysis_release_decisions where action = 'withdraw';
    raise exception 'ADV RA4: decision history was deleted';
  exception when check_violation then null;
  end;
  begin
    delete from api_private.analysis_release_policies where version = 'adv-ra3';
    raise exception 'ADV RA4: an installed (withdrawn) policy was deleted';
  exception when check_violation then null;
  end;
end $$;

-- RA5 -----------------------------------------------------------------------
do $$
declare now_s bigint := floor(extract(epoch from now()))::bigint;
begin
  perform pg_temp.adv_install(pg_temp.adv_policy('adv-ra5', now_s - 60, now_s + 3600, repeat('5',64)));
  begin
    perform pg_temp.adv_install(pg_temp.adv_policy('adv-ra5', now_s - 60, now_s + 7200, repeat('5',64)));
    raise exception 'ADV RA5: two different documents installed under one version';
  exception when unique_violation then null;
  end;
end $$;

rollback;
\echo 'ADV analysis-scoring SQL attacks: all probes ran'
