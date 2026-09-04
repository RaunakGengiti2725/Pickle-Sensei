-- ============================================================================
-- ATTACK MATRIX — db-rls-grants-isolation execution audit (PASS 2 of 3)
-- ============================================================================
-- Adversarial extension of supabase/tests/security_regression.sql. It runs
-- AFTER shim_auth.sql (+ optionally shim_hosted_function_defaults.sql) and
-- every migration, in one transaction that is rolled back at the end.
--
-- Unlike security_regression.sql (which aborts on the first failed case) every
-- case here records PASS/FAIL into public.__attack_results and the file only
-- raises at the very end, so a single run yields the complete verdict table
-- (also written as JSON to /tmp/attack_results.json for the runner to copy).
--
-- Cases (K = "kill chain" probes not covered by A–J of the main matrix):
--   K1  every public table has RLS enabled; every client-readable table has
--       at least one policy (enumerative — new tables cannot slip through)
--   K2  every public view is security_invoker; views are not writable
--   K3  function EXECUTE audit vs. an explicit allowlist (anon: nothing;
--       authenticated: the eight documented RPC/helper functions); every
--       SECURITY DEFINER function pins search_path
--   K4  enumerative cross-user matrix: for EVERY user-owned table, Bob cannot
--       SELECT / UPDATE / DELETE Alice's rows, INSERT rows owned by Alice, nor
--       re-own his rows to Alice (UPDATE user_id / upsert DO UPDATE)
--   K5  security_invoker views leak nothing cross-user (and are non-empty for
--       the owner, so the assertion is not vacuous)
--   K6  free-limit backstop cannot be bypassed by writing public.shots
--       DIRECTLY (PostgREST table INSERT) instead of via apply_synced_shot()
--   K7  cross-user foreign-key references (shot_phases → Alice's shot,
--       shots.session_id → Alice's session) are refused
--   K8  apply_synced_shot() failure / empty / stale / missing-data states never
--       create rows or consume a permit
--   K9  client UPDATE column grants are sized to the Edge Function's writes
--       (AGENTS.md "Defense in depth" contract)
--   K10 permit status is not a client-forgeable authority: re-arming a released
--       permit still cannot record a third free scored shot
--   K11 RLS-blind table privileges (TRUNCATE/TRIGGER/REFERENCES) are not held
--       by the client role; TRUNCATE by one user cannot wipe another's rows
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create table public.__attack_results (
  seq serial primary key,
  case_id text not null,
  verdict text not null check (verdict in ('PASS', 'FAIL', 'INFO')),
  detail text
);
grant insert on public.__attack_results to anon, authenticated, service_role;
grant usage, select on sequence public.__attack_results_seq_seq
  to anon, authenticated, service_role;

create function public.__attack_record(p_case text, p_ok boolean, p_detail text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.__attack_results (case_id, verdict, detail)
  values (p_case, case when p_ok then 'PASS' else 'FAIL' end, p_detail)
$$;
create function public.__attack_info(p_case text, p_detail text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.__attack_results (case_id, verdict, detail)
  values (p_case, 'INFO', p_detail)
$$;
grant execute on function public.__attack_record(text, boolean, text)
  to anon, authenticated, service_role;
grant execute on function public.__attack_info(text, text)
  to anon, authenticated, service_role;

-- ───────────────────────────── fixtures ─────────────────────────────────────
-- Alice (a), Bob (b), Carol (c: fresh free account for the limit probes).
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000000c', 'carol@example.com',
   '{"full_name":"Carol"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-00000000000b',
   '{"sub":"apple-sub-bob"}'),
  ('google', 'google-sub-carol', '00000000-0000-4000-8000-00000000000c',
   '{"sub":"google-sub-carol"}');

do $$
begin
  if (select count(*) from public.profiles) <> 3 then
    raise exception 'SETUP: handle_new_user trigger did not provision profiles';
  end if;
end $$;

-- Seed one Alice-owned row in EVERY user-owned table as the superuser (RLS is
-- bypassed here on purpose — this is the data the client roles must never
-- reach cross-user).
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-00000000000a', now());
insert into public.shots (
  id, user_id, session_id, shot_type, camera_view, captured_at, start_ms,
  contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version,
  shot_config_version
) values (
  '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-0000000000d1', 'drive', 'side', now(), 0, 500, 1000,
  7.5, 0.9, 'scored', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1',
  'phase-1', 'scoring-1', 'config-1'
);
insert into public.shot_phases (shot_id, user_id, phase_key, start_ms,
  representative_ms, end_ms, confidence)
values ('00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-00000000000a', 'contact', 0, 500, 1000, 0.9);
insert into public.shot_measurements (shot_id, user_id, metric_key, value,
  confidence, unit)
values ('00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-00000000000a', 'paddle_speed', 1.0, 0.9, 'ratio');
insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score,
  confidence, band, direction, severity, applicable)
values ('00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-00000000000a', 'contact_position', 70, 0.9,
        'green', 'none', 0.1, true);
insert into public.captures (id, user_id, session_id, shot_id, captured_at,
  duration_ms, fps, capture_mode, evidence_status, status)
values ('00000000-0000-4000-8000-0000000000f1',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-0000000000e1', now(), 1000, 30,
        'automatic_pose_trigger', 'valid', 'analyzed');
insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000a1',
        '00000000-0000-4000-8000-00000000000a', 'alice-key-1');
insert into public.consent_records (user_id, scope, action)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant');
insert into public.evaluation_trials (id, user_id, payload)
values ('00000000-0000-4000-8000-0000000000e5',
        '00000000-0000-4000-8000-00000000000a', '{"trial":1}');
insert into public.analysis_feedback (user_id, analysis_id, rating)
values ('00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-0000000000e1', 'helpful');
insert into public.user_saved_drills (user_id, slug)
values ('00000000-0000-4000-8000-00000000000a', 'dink-ladder');
insert into public.billing_entitlements (user_id, premium, product_key)
values ('00000000-0000-4000-8000-00000000000a', true, 'pickle_sensei_pro');
insert into public.account_deletion_requests (user_id)
values ('00000000-0000-4000-8000-00000000000a');
insert into public.account_deletion_feedback (user_id, reason)
values ('00000000-0000-4000-8000-00000000000a', 'other');
insert into public.account_external_credentials (user_id)
values ('00000000-0000-4000-8000-00000000000a');
insert into public.webhook_events (id, payload) values ('evt-1', '{}');

-- player_rank_state row for Alice exists via the shots trigger; confirm.
do $$
begin
  if not exists (select 1 from public.player_rank_state
                 where user_id = '00000000-0000-4000-8000-00000000000a') then
    raise exception 'SETUP: shots trigger did not create player_rank_state';
  end if;
  if not exists (select 1 from public.free_rating_ledger) then
    raise exception 'SETUP: shots trigger did not write free_rating_ledger';
  end if;
end $$;

-- ───────────────── K1: RLS enabled everywhere, policies present ─────────────
do $$
declare r record; bad text := '';
begin
  for r in
    select c.relname, c.relrowsecurity,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as n_pol,
           has_table_privilege('authenticated', c.oid, 'select')
             or has_table_privilege('authenticated', c.oid, 'insert') as client_reach
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname not like '\_\_attack%'
  loop
    if not r.relrowsecurity then
      bad := bad || format(' %s:no-rls', r.relname);
    elsif r.client_reach and r.n_pol = 0 then
      bad := bad || format(' %s:client-grant-without-policy', r.relname);
    end if;
  end loop;
  perform public.__attack_record('K1', bad = '',
    case when bad = '' then 'every public table has RLS; every client-reachable table has policies'
         else 'offenders:' || bad end);
end $$;

-- ───────────────── K2: views are security_invoker and not writable ──────────
do $$
declare r record; bad text := '';
begin
  for r in
    select c.relname, coalesce(c.reloptions, '{}') as opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
  loop
    if not ('security_invoker=true' = any (r.opts)
            or 'security_invoker=on' = any (r.opts)) then
      bad := bad || format(' %s:not-security-invoker', r.relname);
    end if;
    if has_table_privilege('anon', ('public.' || r.relname)::regclass, 'select') then
      bad := bad || format(' %s:anon-select', r.relname);
    end if;
  end loop;
  perform public.__attack_record('K2a', bad = '',
    case when bad = '' then 'progress_daily/practice_days/player_technique_rating are security_invoker and anon-revoked'
         else 'offenders:' || bad end);
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare v text; n int; leaked text := '';
begin
  -- Hosted default privileges hand the client role INSERT/UPDATE/DELETE on
  -- views too; none of these views may be updatable in practice.
  foreach v in array array['progress_daily', 'practice_days', 'player_technique_rating'] loop
    begin
      execute format('update public.%I set user_id = user_id', v);
      get diagnostics n = row_count;
      if n > 0 then leaked := leaked || format(' %s:update-%s-rows', v, n); end if;
    exception
      when insufficient_privilege or feature_not_supported or object_not_in_prerequisite_state then null;
      when others then
        if sqlstate not in ('55000', '0A000', '42501', '42809') then
          leaked := leaked || format(' %s:update-%s', v, sqlstate);
        end if;
    end;
    begin
      execute format('delete from public.%I', v);
      get diagnostics n = row_count;
      if n > 0 then leaked := leaked || format(' %s:delete-%s-rows', v, n); end if;
    exception
      when others then
        if sqlstate not in ('55000', '0A000', '42501', '42809') then
          leaked := leaked || format(' %s:delete-%s', v, sqlstate);
        end if;
    end;
  end loop;
  perform public.__attack_record('K2b', leaked = '',
    case when leaked = '' then 'views reject UPDATE/DELETE from the client role'
         else 'unexpected:' || leaked end);
end $$;
reset role;

-- ───────────────── K3: function EXECUTE audit vs allowlist ──────────────────
do $$
declare r record; anon_bad text := ''; authed_bad text := ''; definer_bad text := '';
  authed_allow text[] := array[
    'access_lock_key(p_uid uuid)',
    'access_state()',
    'apply_synced_shot(shot jsonb)',
    'complete_onboarding()',
    'identity_scored_count()',
    'lifetime_scored_count()',
    'player_rank_tier(rating numeric)',
    'reserve_analysis_permit(p_idempotency_key text)'
  ];
  definer_allow text[] := array['identity_scored_count()'];
begin
  for r in
    select p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           p.prosecdef, p.proconfig, p.prorettype
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname not like '\_\_attack%'
  loop
    if has_function_privilege('anon', r.oid, 'execute') then
      anon_bad := anon_bad || ' ' || r.sig;
    end if;
    if has_function_privilege('authenticated', r.oid, 'execute')
       and not (r.sig = any (authed_allow)) then
      authed_bad := authed_bad || ' ' || r.sig;
    end if;
    if r.prosecdef then
      if has_function_privilege('authenticated', r.oid, 'execute')
         and not (r.sig = any (definer_allow)) then
        definer_bad := definer_bad || format(' %s:definer-client-callable', r.sig);
      end if;
      if r.proconfig is null
         or not exists (select 1 from unnest(r.proconfig) c where c like 'search_path=%') then
        definer_bad := definer_bad || format(' %s:definer-without-search_path', r.sig);
      end if;
    end if;
  end loop;
  perform public.__attack_record('K3a', anon_bad = '',
    case when anon_bad = '' then 'anon can execute no public function'
         else 'anon EXECUTE on:' || anon_bad end);
  perform public.__attack_record('K3b', authed_bad = '',
    case when authed_bad = '' then 'authenticated EXECUTE limited to the 8 documented functions'
         else 'authenticated EXECUTE beyond allowlist:' || authed_bad end);
  perform public.__attack_record('K3c', definer_bad = '',
    case when definer_bad = '' then 'SECURITY DEFINER functions: only identity_scored_count() client-callable; all pin search_path'
         else 'definer issues:' || definer_bad end);
end $$;

-- ───────────────── K4: enumerative cross-user matrix (Bob vs Alice) ─────────
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare t text; n int; col text; leaked text := '';
  owned text[] := array[
    'profiles', 'sessions', 'shots', 'shot_phases', 'shot_measurements',
    'shot_checkpoints', 'captures', 'analysis_permits', 'consent_records',
    'evaluation_trials', 'analysis_feedback', 'user_saved_drills',
    'player_rank_state', 'billing_entitlements', 'account_deletion_requests',
    'account_deletion_feedback', 'account_external_credentials',
    'webhook_events', 'free_rating_ledger'
  ];
begin
  -- K4a: SELECT — Bob owns nothing but his own profile, so any other row is a leak.
  foreach t in array owned loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if t = 'profiles' then
        if n <> 1 then leaked := leaked || format(' %s:%s-rows', t, n); end if;
      elsif n <> 0 then
        leaked := leaked || format(' %s:%s-rows', t, n);
      end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  perform public.__attack_record('K4a', leaked = '',
    case when leaked = '' then 'Bob sees zero Alice rows across all 19 tables'
         else 'leak:' || leaked end);

  -- K4b: UPDATE — pick any column the client role may update; the statement
  -- must touch 0 rows (RLS) or be refused (grant).
  leaked := '';
  foreach t in array owned loop
    select column_name into col
    from information_schema.role_column_grants
    where table_schema = 'public' and table_name = t
      and grantee = 'authenticated' and privilege_type = 'UPDATE'
    order by column_name limit 1;
    if col is null then continue; end if;
    begin
      execute format('update public.%I set %I = %I', t, col, col);
      get diagnostics n = row_count;
      if t = 'profiles' then
        if n <> 1 then leaked := leaked || format(' %s:%s-rows', t, n); end if;
      elsif n <> 0 then
        leaked := leaked || format(' %s:%s-rows', t, n);
      end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  perform public.__attack_record('K4b', leaked = '',
    case when leaked = '' then 'Bob UPDATE touches zero Alice rows on every updatable table'
         else 'leak:' || leaked end);

  -- K4c: DELETE — 0 rows or refused.
  leaked := '';
  foreach t in array owned loop
    begin
      execute format('delete from public.%I', t);
      get diagnostics n = row_count;
      if n <> 0 then leaked := leaked || format(' %s:%s-rows', t, n); end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  perform public.__attack_record('K4c', leaked = '',
    case when leaked = '' then 'Bob DELETE removes zero Alice rows on every table'
         else 'leak:' || leaked end);
end $$;

-- K4d: INSERT rows owned by Alice from Bob's session (WITH CHECK) — one probe
-- per client-insertable table.
do $$
declare leaked text := '';
begin
  begin
    insert into public.sessions (id, user_id, started_at)
    values ('00000000-0000-4000-8000-0000000000d9', '00000000-0000-4000-8000-00000000000a', now());
    leaked := leaked || ' sessions';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms,
      overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version)
    values ('00000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-00000000000a',
      'drive', now(), 0, 1000, 5, 0.9, 'scored', '1','1','1','1','1','1','1','1');
    leaked := leaked || ' shots';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000a', 'follow_through', 0, 1, 2, 0.5);
    leaked := leaked || ' shot_phases';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.shot_measurements (shot_id, user_id, metric_key, value, confidence, unit)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000a', 'x', 1, 0.5, 'ratio');
    leaked := leaked || ' shot_measurements';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
    values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000000a', 'x', 1, 0.5, 'green', 'none', 0.1, true);
    leaked := leaked || ' shot_checkpoints';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
    values ('00000000-0000-4000-8000-0000000000f9', '00000000-0000-4000-8000-00000000000a', now(), 1, 1, 'imported_video', 'valid');
    leaked := leaked || ' captures';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values ('00000000-0000-4000-8000-0000000000a9', '00000000-0000-4000-8000-00000000000a', 'bob-forges-alice');
    leaked := leaked || ' analysis_permits';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.consent_records (user_id, scope, action)
    values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'withdraw');
    leaked := leaked || ' consent_records';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.evaluation_trials (id, user_id, payload)
    values ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-00000000000a', '{}');
    leaked := leaked || ' evaluation_trials';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.analysis_feedback (user_id, analysis_id, rating)
    values ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000e2', 'x');
    leaked := leaked || ' analysis_feedback';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.user_saved_drills (user_id, slug)
    values ('00000000-0000-4000-8000-00000000000a', 'forged');
    leaked := leaked || ' user_saved_drills';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.account_deletion_requests (user_id)
    values ('00000000-0000-4000-8000-00000000000a');
    leaked := leaked || ' account_deletion_requests';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.account_deletion_feedback (user_id, reason)
    values ('00000000-0000-4000-8000-00000000000a', 'other');
    leaked := leaked || ' account_deletion_feedback';
  exception when insufficient_privilege or check_violation then null; end;
  perform public.__attack_record('K4d', leaked = '',
    case when leaked = '' then 'Bob cannot INSERT rows owned by Alice on any client-insertable table'
         else 'forged owner accepted on:' || leaked end);
end $$;

-- K4e: re-owning — Bob creates a legitimate row, then tries to hand it to
-- Alice through every path that can write user_id (plain UPDATE and the
-- PostgREST upsert's DO UPDATE branch). WITH CHECK must refuse each.
do $$
declare leaked text := ''; n int;
begin
  insert into public.account_deletion_requests (user_id)
  values ('00000000-0000-4000-8000-00000000000b');
  insert into public.user_saved_drills (user_id, slug)
  values ('00000000-0000-4000-8000-00000000000b', 'bob-drill');
  insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
  values ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-00000000000b',
          now(), 1, 1, 'imported_video', 'valid');

  begin
    update public.account_deletion_requests set user_id = '00000000-0000-4000-8000-00000000000a'
     where user_id = '00000000-0000-4000-8000-00000000000b';
    get diagnostics n = row_count;
    if n > 0 then leaked := leaked || ' account_deletion_requests(update)'; end if;
  exception when insufficient_privilege or check_violation then null; end;
  begin
    insert into public.account_deletion_requests (user_id)
    values ('00000000-0000-4000-8000-00000000000b')
    on conflict (user_id) do update set user_id = '00000000-0000-4000-8000-00000000000a';
    leaked := leaked || ' account_deletion_requests(upsert)';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    update public.user_saved_drills set user_id = '00000000-0000-4000-8000-00000000000a'
     where slug = 'bob-drill';
    get diagnostics n = row_count;
    if n > 0 then leaked := leaked || ' user_saved_drills(update)'; end if;
  exception when insufficient_privilege or check_violation then null; end;
  begin
    update public.captures set user_id = '00000000-0000-4000-8000-00000000000a'
     where id = '00000000-0000-4000-8000-0000000000f2';
    get diagnostics n = row_count;
    if n > 0 then leaked := leaked || ' captures(update)'; end if;
  exception when insufficient_privilege or check_violation then null; end;

  perform public.__attack_record('K4e', leaked = '',
    case when leaked = '' then 'Bob cannot re-own his rows to Alice via UPDATE user_id or upsert DO UPDATE'
         else 're-own accepted on:' || leaked end);
end $$;

-- ───────────────── K5: views leak nothing cross-user ────────────────────────
do $$
declare n1 int; n2 int; n3 int;
begin
  select count(*) into n1 from public.progress_daily;
  select count(*) into n2 from public.practice_days;
  select count(*) into n3 from public.player_technique_rating;
  perform public.__attack_record('K5a', n1 = 0 and n2 = 0 and n3 = 0,
    format('Bob sees progress_daily=%s practice_days=%s player_technique_rating=%s (all must be 0)', n1, n2, n3));
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare n1 int; n2 int; n3 int;
begin
  select count(*) into n1 from public.progress_daily;
  select count(*) into n2 from public.practice_days;
  select count(*) into n3 from public.player_technique_rating;
  perform public.__attack_record('K5b', n1 >= 1 and n2 >= 1 and n3 >= 1,
    format('Alice sees her own progress_daily=%s practice_days=%s player_technique_rating=%s (non-vacuous)', n1, n2, n3));
end $$;
reset role;

-- ───────────────── K6: direct table INSERT vs the free-limit backstop ───────
-- Carol legitimately spends both free ratings through the documented RPC
-- path, then tries to record a THIRD scored shot by inserting into
-- public.shots directly — the PostgREST `POST /rest/v1/shots` a client holding
-- a JWT + the anon key can issue. The backstop (apply_synced_shot) is the
-- documented "unforgeable" limit; a direct insert must be refused too.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare v text; p uuid; i int; r record; before_cnt int; after_cnt int;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('carol-key-' || i);
    v := public.apply_synced_shot(jsonb_build_object(
      'id', ('00000000-0000-4000-8000-0000000000c' || i)::uuid,
      'analysisPermitId', p, 'resultKind', 'scored',
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
      raise exception 'K6 SETUP: free rating % must be accepted (got %)', i, v;
    end if;
  end loop;
  select * into r from public.access_state();
  if r.scored_count <> 2 or r.premium then
    raise exception 'K6 SETUP: Carol must be at the free limit (scored=%, premium=%)', r.scored_count, r.premium;
  end if;
  select * into r from public.reserve_analysis_permit('carol-key-3');
  perform public.__attack_record('K6a', r.result = 'access.paywall_required',
    format('RPC path at the limit: reserve_analysis_permit -> %s', r.result));

  before_cnt := public.lifetime_scored_count();
  begin
    insert into public.shots (id, user_id, shot_type, camera_view, captured_at,
      start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version,
      shot_config_version)
    values ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-00000000000c',
      'drive', 'side', now(), 0, 500, 1000, 9.9, 0.95, 'scored',
      '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
    after_cnt := public.lifetime_scored_count();
    select * into r from public.access_state();
    perform public.__attack_record('K6b', false,
      format('DIRECT INSERT into public.shots of a 3rd scored shot SUCCEEDED with no permit: lifetime_scored_count %s -> %s, access_state.scored_count=%s, player_rank_state.scored_shot_count=%s',
        before_cnt, after_cnt, r.scored_count,
        (select scored_shot_count from public.player_rank_state
          where user_id = '00000000-0000-4000-8000-00000000000c')));
  exception when insufficient_privilege or check_violation then
    perform public.__attack_record('K6b', true,
      format('direct INSERT into public.shots past the free limit refused (%s)', sqlstate));
  end;

  -- Even a shot with NO permit at all and a fresh id (not at the limit) is a
  -- bypass of the permit contract; report how the grant layer treats it.
  begin
    insert into public.shots (id, user_id, shot_type, captured_at, start_ms, end_ms,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version)
    values ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-00000000000c',
      'drive', now(), 0, 1000, 0.3, 'low_confidence', '1','1','1','1','1','1','1','1');
    perform public.__attack_info('K6c',
      'authenticated holds table-level INSERT on public.shots (progress_data.sql:303) — a permit-less low_confidence row was accepted; the permit contract is enforced only inside apply_synced_shot()');
  exception when insufficient_privilege or check_violation then
    perform public.__attack_info('K6c', format('permit-less direct INSERT refused (%s)', sqlstate));
  end;
end $$;
reset role;

-- ───────────────── K7: cross-user foreign-key references ────────────────────
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare ok1 boolean := false; ok2 boolean := false; d1 text; d2 text;
begin
  -- Bob attaches a phase row to ALICE's shot (his own user_id satisfies RLS;
  -- the FK is checked as the table owner, i.e. RLS-blind).
  begin
    insert into public.shot_phases (shot_id, user_id, phase_key, start_ms,
      representative_ms, end_ms, confidence)
    values ('00000000-0000-4000-8000-0000000000e1',
            '00000000-0000-4000-8000-00000000000b', 'backswing', 0, 1, 2, 0.5);
    d1 := 'Bob INSERTED shot_phases(shot_id=<Alice shot>, user_id=Bob): accepted — FK existence oracle + orphan evidence under another user''s shot';
  exception
    when foreign_key_violation then ok1 := true; d1 := 'refused as FK violation (row invisible to Bob)';
    when insufficient_privilege or check_violation then ok1 := true; d1 := format('refused (%s)', sqlstate);
  end;
  perform public.__attack_record('K7a', ok1, d1);

  -- Bob files a shot into ALICE's session.
  begin
    insert into public.shots (id, user_id, session_id, shot_type, captured_at,
      start_ms, end_ms, analysis_confidence, result_kind, app_version,
      model_bundle_version, pose_model_version, paddle_model_version,
      stroke_detector_version, phase_model_version, scoring_model_version,
      shot_config_version)
    values ('00000000-0000-4000-8000-0000000000e8', '00000000-0000-4000-8000-00000000000b',
      '00000000-0000-4000-8000-0000000000d1', 'drive', now(), 0, 1000, 0.3,
      'low_confidence', '1','1','1','1','1','1','1','1');
    d2 := 'Bob INSERTED shots(session_id=<Alice session>, user_id=Bob): accepted — cross-user session reference / existence oracle';
  exception
    when foreign_key_violation then ok2 := true; d2 := 'refused as FK violation (row invisible to Bob)';
    when insufficient_privilege or check_violation then ok2 := true; d2 := format('refused (%s)', sqlstate);
  end;
  perform public.__attack_record('K7b', ok2, d2);
end $$;
reset role;

-- ───────────────── K8: RPC failure / empty / stale / missing states ─────────
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare v text; p uuid; n_before int; n_after int; bad text := ''; r record;
  vv jsonb := jsonb_build_object(
    'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
    'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
    'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
    'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1');
begin
  select count(*) into n_before from public.shots;

  -- empty payload
  v := public.apply_synced_shot('{}'::jsonb);
  if v <> 'access.permit_not_found' then bad := bad || format(' empty->%s', v); end if;
  -- null payload
  v := public.apply_synced_shot(null);
  if v <> 'access.permit_not_found' then bad := bad || format(' null->%s', v); end if;
  -- malformed uuid: must surface as an error, never as a silent accept
  begin
    v := public.apply_synced_shot('{"id":"not-a-uuid","analysisPermitId":"x"}'::jsonb);
    bad := bad || format(' malformed-uuid->%s', v);
  exception when invalid_text_representation then null;
  end;

  select permit_id into p from public.reserve_analysis_permit('bob-k8-1');
  -- stale: age the permit past the 24h window (as the owner we may not touch
  -- created_at — do it as superuser inside a nested role switch).
  reset role;
  update public.analysis_permits set created_at = now() - interval '25 hours' where id = p;
  set local role authenticated;
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000b1', 'analysisPermitId', p,
    'resultKind', 'scored', 'shotType', 'drive', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'overallScore', 5.0, 'confidence', 0.9,
    'versionVector', vv));
  if v <> 'access.permit_expired' then bad := bad || format(' stale->%s', v); end if;
  select * into r from public.analysis_permits where id = p;
  if r.status <> 'released' or r.outcome <> 'expired' then
    bad := bad || format(' stale-permit-state=%s/%s', r.status, r.outcome);
  end if;

  -- not reserved: reuse the now-released permit
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000b2', 'analysisPermitId', p,
    'resultKind', 'scored', 'shotType', 'drive', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'overallScore', 5.0, 'confidence', 0.9,
    'versionVector', vv));
  if v <> 'access.permit_not_reserved' then bad := bad || format(' released->%s', v); end if;

  -- missing session
  select permit_id into p from public.reserve_analysis_permit('bob-k8-2');
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000b3', 'analysisPermitId', p,
    'sessionId', '00000000-0000-4000-8000-0000000000d1',  -- Alice's session
    'resultKind', 'scored', 'shotType', 'drive', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'overallScore', 5.0, 'confidence', 0.9,
    'versionVector', vv));
  if v <> 'shot.session_not_found' then bad := bad || format(' foreign-session->%s', v); end if;

  -- invalid result kind → constraint violation inside the write block
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000b4', 'analysisPermitId', p,
    'resultKind', 'Scored', 'shotType', 'drive', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'overallScore', 5.0, 'confidence', 0.9,
    'versionVector', vv));
  if v not like 'shot.write_failed:%' then bad := bad || format(' bad-kind->%s', v); end if;

  -- scored without a score → constraint violation, permit stays reserved
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000b5', 'analysisPermitId', p,
    'resultKind', 'scored', 'shotType', 'drive', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'confidence', 0.9, 'versionVector', vv));
  if v not like 'shot.write_failed:%' then bad := bad || format(' scored-no-score->%s', v); end if;
  select * into r from public.analysis_permits where id = p;
  if r.status <> 'reserved' then bad := bad || format(' permit-after-failed-write=%s', r.status); end if;

  -- id collision with ALICE's shot → conflict, not accept
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000e1', 'analysisPermitId', p,
    'resultKind', 'low_confidence', 'shotType', 'drive', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'confidence', 0.3, 'versionVector', vv));
  if v <> 'shot.id_conflict' then bad := bad || format(' foreign-id->%s', v); end if;

  select count(*) into n_after from public.shots;
  if n_after <> n_before then bad := bad || format(' rows-created=%s', n_after - n_before); end if;

  perform public.__attack_record('K8', bad = '',
    case when bad = '' then 'empty/null/malformed/stale/released/foreign-session/bad-kind/no-score/foreign-id all refused; zero rows written; failed writes leave the permit reserved'
         else 'unexpected:' || bad end);
end $$;
reset role;

-- ───────────────── K9: UPDATE grants sized to the Edge Function's writes ────
do $$
declare r record; bad text := '';
  expected jsonb := jsonb_build_object(
    'profiles', 'biggest_problem,first_name,focus_checkpoint,gender,handedness,onboarding_state,primary_goal,provider,skill_level',
    'sessions', 'ended_at',
    'analysis_permits', 'outcome,status',
    'account_deletion_requests', 'challenge,created_at,expires_at,user_id',
    'user_saved_drills', 'saved_at,slug,user_id'
  );
begin
  for r in
    select table_name, string_agg(column_name, ',' order by column_name) as cols
    from information_schema.role_column_grants
    where table_schema = 'public' and grantee = 'authenticated'
      and privilege_type = 'UPDATE'
      and table_name not like '\_\_attack%'
      and table_name in (select c.relname from pg_class c
                         join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind = 'r')
    group by table_name
  loop
    if expected ->> r.table_name is null then
      bad := bad || format(' %s:UPDATE-not-expected(%s)', r.table_name, r.cols);
    elsif expected ->> r.table_name <> r.cols then
      bad := bad || format(' %s:expected(%s)-got(%s)', r.table_name, expected ->> r.table_name, r.cols);
    end if;
  end loop;
  perform public.__attack_record('K9', bad = '',
    case when bad = '' then 'client UPDATE grants match the documented edge-function writes exactly'
         else 'grant drift:' || bad end);
end $$;

-- ───────────────── K10: permit status is not client-forgeable authority ─────
-- Carol (at the limit since K6) flips a released permit back to 'reserved'
-- using her legitimate status/outcome UPDATE grant, then tries to spend it.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare p uuid; v text; n int;
begin
  select id into p from public.analysis_permits
  where user_id = '00000000-0000-4000-8000-00000000000c' and status = 'finalized'
  order by created_at limit 1;
  update public.analysis_permits set status = 'reserved', outcome = null where id = p;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'K10 SETUP: owner must be able to update status/outcome (grant E6)';
  end if;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', '00000000-0000-4000-8000-0000000000c5', 'analysisPermitId', p,
    'resultKind', 'scored', 'shotType', 'drive', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'endMs', 1000, 'overallScore', 5.0, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')));
  perform public.__attack_record('K10', v = 'access.paywall_required',
    format('re-armed finalized permit via client UPDATE, apply_synced_shot -> %s', v));
end $$;
reset role;

-- ───────────────── K11: TRUNCATE / TRIGGER / REFERENCES are RLS-blind ───────
-- `grant all on tables` (hosted default, mirrored by shim_auth.sql) hands the
-- client role TRUNCATE, which PostgreSQL does NOT filter through RLS: one
-- statement empties every user's rows. PostgREST never emits TRUNCATE, so
-- this is a defense-in-depth gap rather than an HTTP-reachable one — but the
-- migrations' "anon/public revokes" leave it in place on every table.
do $$
declare bad text := '';
begin
  select string_agg(c.relname, ',' order by c.relname) into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname not like '\_\_attack%'
    and (has_table_privilege('authenticated', c.oid, 'truncate')
         or has_table_privilege('authenticated', c.oid, 'trigger')
         or has_table_privilege('authenticated', c.oid, 'references'));
  perform public.__attack_record('K11a', bad is null,
    coalesce('authenticated holds TRUNCATE/TRIGGER/REFERENCES on: ' || bad,
             'no RLS-blind table privileges for the client role'));
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare wiped boolean := false; d text;
begin
  begin
    truncate public.billing_entitlements;
    wiped := true;
  exception when insufficient_privilege then
    d := format('TRUNCATE refused (%s)', sqlstate);
  end;
  if wiped then
    reset role;
    d := format('Bob ran TRUNCATE public.billing_entitlements — Alice''s premium entitlement rows remaining: %s (RLS not applied to TRUNCATE)',
      (select count(*) from public.billing_entitlements
        where user_id = '00000000-0000-4000-8000-00000000000a'));
  end if;
  perform public.__attack_record('K11b', not wiped, d);
end $$;
reset role;

-- ───────────────────────────── verdict table ────────────────────────────────
\set QUIET off
select case_id, verdict, detail from public.__attack_results order by seq;
\set QUIET on
\t on
\a
\o /tmp/attack_results.json
select json_agg(json_build_object('case', case_id, 'verdict', verdict, 'detail', detail) order by seq)
from public.__attack_results;
\o
\a
\t off

do $$
declare n int; names text;
begin
  select count(*), string_agg(case_id, ',' order by seq) into n, names
  from public.__attack_results where verdict = 'FAIL';
  if n > 0 then
    raise exception 'ATTACK MATRIX: % case(s) FAILED: %', n, names;
  end if;
end $$;

rollback;
\echo ATTACK MATRIX: ALL CASES PASSED
