-- ============================================================================
-- Adjudication reproductions for area db-rls-grants-isolation (baseline 4d812e1a).
--
-- Run via ./supabase/tests/run_adjudication_repro.sh (same shim + migrations
-- as run_rls_tests.sh). Every case asserts the SECURE expectation, so on the
-- baseline the confirmed defects show up as FAIL rows and the script exits
-- non-zero; a fix is complete when this script exits 0. Nothing here mutates
-- production code or the existing matrix.
--
--   ADJ-B  authenticated retains RLS-blind TRUNCATE / TRIGGER / REFERENCES
--          on every public table (hosted default privileges never revoked)
--   ADJ-C  a plain INSERT into public.shots records a scored shot with no
--          permit and past the two-lifetime-free-ratings limit
--   ADJ-D  analysis_permits.status is reversible by the client
--          (finalized/released -> reserved), so one permit is consumed twice
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create temp table adj_results (case_id text, ok boolean, detail text) on commit drop;
grant all on adj_results to authenticated;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000000c', 'carol@example.com',
   '{"full_name":"Carol"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000d', 'dave@example.com',
   '{"full_name":"Dave"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-00000000000b',
   '{"sub":"apple-sub-bob"}'),
  ('google', 'google-sub-carol', '00000000-0000-4000-8000-00000000000c',
   '{"sub":"google-sub-carol"}'),
  ('apple', 'apple-sub-dave', '00000000-0000-4000-8000-00000000000d',
   '{"sub":"apple-sub-dave"}');

create or replace function pg_temp.shot_payload(p_id uuid, p_permit uuid, p_kind text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'sessionId', null,
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-09-01T00:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.5,
    'confidence', 0.9, 'resultKind', p_kind, 'phases', '[]'::jsonb,
    'checkpoints', '[]'::jsonb,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'b1', 'poseModelVersion', 'p1',
      'paddleModelVersion', 'pd1', 'strokeDetectorVersion', 's1',
      'phaseModelVersion', 'ph1', 'scoringModelVersion', 'sc1',
      'shotConfigVersion', 'c1'))
$$;

-- ───────────── ADJ-B: no TRUNCATE / TRIGGER / REFERENCES for client roles ─────────────

insert into adj_results
select 'ADJ-B1 no TRUNCATE/TRIGGER/REFERENCES for anon/authenticated on public tables',
       count(*) = 0,
       format('%s grants on %s tables: %s', count(*), count(distinct table_name),
              coalesce(string_agg(distinct privilege_type, '/'), 'none'))
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES');

do $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', true);
  begin
    execute 'truncate public.consent_records';
    insert into adj_results values ('ADJ-B2 authenticated TRUNCATE consent_records refused', false, 'TRUNCATE succeeded');
  exception when insufficient_privilege then
    insert into adj_results values ('ADJ-B2 authenticated TRUNCATE consent_records refused', true, sqlerrm);
  end;
  begin
    execute 'truncate public.billing_entitlements';
    insert into adj_results values ('ADJ-B3 authenticated TRUNCATE billing_entitlements refused', false, 'TRUNCATE succeeded');
  exception when insufficient_privilege then
    insert into adj_results values ('ADJ-B3 authenticated TRUNCATE billing_entitlements refused', true, sqlerrm);
  end;
  begin
    execute 'truncate public.shots';
    insert into adj_results values ('ADJ-B4 authenticated TRUNCATE shots refused (42501)', false, 'TRUNCATE succeeded');
  exception
    when insufficient_privilege then
      insert into adj_results values ('ADJ-B4 authenticated TRUNCATE shots refused (42501)', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
    when feature_not_supported then
      -- The privilege check passed and TRUNCATE only stopped at the FK
      -- (shot_phases etc. reference shots): the grant is still there.
      insert into adj_results values ('ADJ-B4 authenticated TRUNCATE shots refused (42501)', false, 'privilege held; ' || sqlstate || ' ' || sqlerrm);
  end;
  execute 'create function pg_temp.adj_b5_fn() returns trigger language plpgsql as $f$ begin return new; end $f$';
  begin
    execute 'create trigger adj_b5_trg before insert on public.shots for each row execute function pg_temp.adj_b5_fn()';
    insert into adj_results values ('ADJ-B5 authenticated CREATE TRIGGER on shots refused (42501)', false, 'CREATE TRIGGER succeeded');
  exception when insufficient_privilege then
    insert into adj_results values ('ADJ-B5 authenticated CREATE TRIGGER on shots refused (42501)', sqlstate = '42501', sqlstate || ' ' || sqlerrm);
  end;
  perform set_config('role', 'none', true);
end $$;
reset role;

-- Default privileges: a table created AFTER every migration must not inherit
-- the hosted "grant all" shape for the client roles.
create table public.adj_b6_probe (id int primary key);
insert into adj_results
select 'ADJ-B6 new tables inherit no TRUNCATE/TRIGGER/REFERENCES for client roles (default privileges)',
       count(*) = 0,
       format('%s blind grants on a table created after all migrations', count(*))
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'adj_b6_probe'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES');
drop table public.adj_b6_probe;

-- ───────────── ADJ-C: shots is INSERT-only through apply_synced_shot() ─────────────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('k1');
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', r.permit_id, 'scored'));
  if v <> 'accepted' then raise exception 'SETUP: first sync %', v; end if;
  select * into r from public.reserve_analysis_permit('k2');
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', r.permit_id, 'scored'));
  if v <> 'accepted' then raise exception 'SETUP: second sync %', v; end if;
  select * into r from public.reserve_analysis_permit('k3');
  if r.result <> 'access.paywall_required' then raise exception 'SETUP: third reserve %', r.result; end if;

  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000000a',
      'drive', now(), 0, 1000, 9.9, 0.99, 'scored',
      '1', '1', '1', '1', '1', '1', '1', '1');
    insert into adj_results values (
      'ADJ-C1 direct INSERT of a 3rd scored shot at the free limit refused', false,
      format('inserted; lifetime_scored_count()=%s', public.lifetime_scored_count()));
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into adj_results values ('ADJ-C1 direct INSERT of a 3rd scored shot at the free limit refused', true, sqlerrm);
  end;
  select * into r from public.access_state();
  insert into adj_results values (
    'ADJ-C3 lifetime_scored_count()=2 and access_state().scored_count=2 after the direct INSERT attempt',
    public.lifetime_scored_count() = 2 and r.scored_count = 2,
    format('lifetime_scored_count()=%s access_state().scored_count=%s', public.lifetime_scored_count(), r.scored_count));
end $$;

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';

do $$
begin
  begin
    insert into public.shots (
      id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version
    ) values (
      '00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-00000000000b',
      'drive', now(), 0, 1000, 8.0, 0.9, 'scored',
      '1', '1', '1', '1', '1', '1', '1', '1');
    insert into adj_results values (
      'ADJ-C2 direct INSERT of a scored shot with NO permit refused', false,
      format('inserted with %s permits', (select count(*) from public.analysis_permits)));
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into adj_results values ('ADJ-C2 direct INSERT of a scored shot with NO permit refused', true, sqlerrm);
  end;
end $$;

-- Control: the supported path is unaffected — the same fresh user reserves a
-- permit and syncs a scored shot through the RPC.
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('bk1');
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e6', r.permit_id, 'scored'));
  insert into adj_results values (
    'ADJ-C4 apply_synced_shot() with a reserved permit still returns accepted (RPC path unaffected)',
    r.result = 'accepted' and v = 'accepted'
      and exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000e6'
                    and user_id = '00000000-0000-4000-8000-00000000000b' and result_kind = 'scored'),
    format('reserve=%s sync=%s', r.result, v));
end $$;

-- ───────────── ADJ-D: permit status is a one-way lifecycle ─────────────

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';

do $$
declare r record; v text; st text;
begin
  select * into r from public.reserve_analysis_permit('ck1');
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000f1', r.permit_id, 'scored'));
  if v <> 'accepted' then raise exception 'SETUP: carol sync %', v; end if;

  begin
    update public.analysis_permits set status = 'reserved', outcome = null where id = r.permit_id;
    select status into st from public.analysis_permits where id = r.permit_id;
    if st = 'reserved' then
      v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000f2', r.permit_id, 'scored'));
      insert into adj_results values ('ADJ-D1 finalized -> reserved refused (permit consumed once)', false,
        format('reverted to reserved; second sync on same permit returned %s', v));
    else
      insert into adj_results values ('ADJ-D1 finalized -> reserved refused (permit consumed once)', true, 'status stayed ' || st);
    end if;
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into adj_results values ('ADJ-D1 finalized -> reserved refused (permit consumed once)', true, sqlerrm);
  end;
end $$;

-- Fresh identity (Dave) so the lifetime backstop cannot mask the released -> reserved case.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000d';

do $$
declare r record; v text; st text;
begin
  select * into r from public.reserve_analysis_permit('dk1');
  if r.result <> 'accepted' then raise exception 'SETUP: dave reserve %', r.result; end if;
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000f3', r.permit_id, 'low_confidence'));
  if v <> 'accepted' then raise exception 'SETUP: dave abstain %', v; end if;
  begin
    update public.analysis_permits set status = 'reserved', outcome = null where id = r.permit_id;
    select status into st from public.analysis_permits where id = r.permit_id;
    insert into adj_results values ('ADJ-D2 released -> reserved refused', st <> 'reserved', 'status now ' || st);
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into adj_results values ('ADJ-D2 released -> reserved refused', true, sqlerrm);
  end;

  -- Outcome forgery on a reserved permit vs. the edge fn's valid release.
  select * into r from public.reserve_analysis_permit('dk2');
  if r.result <> 'accepted' then raise exception 'SETUP: dave second reserve %', r.result; end if;
  begin
    update public.analysis_permits set status = 'finalized', outcome = 'totally_made_up' where id = r.permit_id;
    insert into adj_results values ('ADJ-D3 outcome outside the known set refused', false, 'UPDATE succeeded with outcome=totally_made_up');
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into adj_results values ('ADJ-D3 outcome outside the known set refused', true, sqlerrm);
  end;
  update public.analysis_permits set status = 'released', outcome = 'low_confidence' where id = r.permit_id;
  select status || '/' || coalesce(outcome, 'null') into st from public.analysis_permits where id = r.permit_id;
  insert into adj_results values ('ADJ-D4 reserved -> released/low_confidence (edge finalize shape) still valid', st = 'released/low_confidence', 'now ' || st);
end $$;

reset role;

\set QUIET off
select case when ok then 'PASS' else 'FAIL' end as verdict, case_id, detail from adj_results order by case_id;
\set QUIET on

do $$
declare n int;
begin
  select count(*) into n from adj_results where not ok;
  if n > 0 then
    raise exception 'ADJUDICATION REPRO: % case(s) still reproduce on this revision', n;
  end if;
  raise notice 'ADJUDICATION REPRO: all cases fixed';
end $$;

rollback;
