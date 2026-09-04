-- ============================================================================
-- Adversarial follow-up to 20260905000002_permit_lifecycle_one_way.sql
-- (candidate 2272819f for db-rls-grants-isolation::ADJ-D).
--
-- Run via ./supabase/tests/run_attack_permit_insert_lifecycle.sh (same shim
-- + migrations as run_rls_tests.sh). Every case asserts the invariant the
-- migration header and AGENTS.md now state — "the lifecycle is enforced at
-- the table, for every role: reserved -> finalized | released once; terminal
-- status <=> outcome present; reserved_count cannot be inflated by the
-- client" — through the INSERT and DELETE grants the client still holds on
-- public.analysis_permits (20260829140000: `grant select, insert, update,
-- delete on public.analysis_permits to authenticated`, policies
-- analysis_permits_insert_own / analysis_permits_delete_own). The guard is
-- a BEFORE UPDATE trigger only, so on the candidate these rows FAIL and the
-- script exits non-zero; a complete fix (an INSERT-side guard, or revoking
-- the client INSERT/DELETE now that reserve_analysis_permit() is the only
-- supported writer) makes it exit 0.
--
-- Not a regression versus 4d812e1a (the same INSERT/DELETE paths existed
-- there); the free-rating paywall is unaffected (apply_synced_shot()'s
-- lifetime backstop still refuses the third scored sync — asserted as the
-- control row ATK-P0). Harm is confined to the caller's own permit rows.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

create temp table atk_results (case_id text, ok boolean, detail text) on commit drop;
grant all on atk_results to authenticated;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-0000000000a1', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000b1', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-0000000000a1',
   '{"sub":"google-sub-alice"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-0000000000b1',
   '{"sub":"apple-sub-bob"}');

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

-- ─────────── ATK-P: the permit ledger must be one-way on INSERT too ───────────

do $$
declare
  r record; v text; st text; n int; before_reserved int; after_reserved int;
  alice constant uuid := '00000000-0000-4000-8000-0000000000a1';
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', alice::text, true);

  -- Control: the supported path still works and the paywall backstop holds.
  select * into r from public.reserve_analysis_permit('k1');
  if r.result <> 'accepted' then raise exception 'SETUP: reserve k1 %', r.result; end if;
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', r.permit_id, 'scored'));
  if v <> 'accepted' then raise exception 'SETUP: sync e1 %', v; end if;
  select * into r from public.reserve_analysis_permit('k2');
  if r.result <> 'accepted' then raise exception 'SETUP: reserve k2 %', r.result; end if;
  v := public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', r.permit_id, 'scored'));
  if v <> 'accepted' then raise exception 'SETUP: sync e2 %', v; end if;
  select * into r from public.reserve_analysis_permit('k3');
  insert into atk_results values (
    'ATK-P0 control: third reserve paywalled after two scored syncs',
    r.result = 'access.paywall_required', 'reserve k3 -> ' || r.result);

  select reserved_count into before_reserved from public.access_state();

  -- P1: a reserved permit must not carry an outcome (the UPDATE guard says
  -- 23514; the INSERT path must agree).
  begin
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (alice, 'p1', 'reserved', 'scored');
    insert into atk_results values ('ATK-P1 client INSERT of reserved permit WITH outcome refused', false, 'INSERT succeeded (reserved/scored row exists)');
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into atk_results values ('ATK-P1 client INSERT of reserved permit WITH outcome refused', true, sqlerrm);
  end;

  -- P2: a terminal status must carry an outcome.
  begin
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (alice, 'p2', 'finalized', null);
    insert into atk_results values ('ATK-P2 client INSERT of finalized permit WITHOUT outcome refused', false, 'INSERT succeeded (finalized/null row exists)');
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into atk_results values ('ATK-P2 client INSERT of finalized permit WITHOUT outcome refused', true, sqlerrm);
  end;

  -- P3: a permit is born reserved; the client cannot mint a settled one
  -- (finalized/scored with no shot behind it = forged permit analytics).
  begin
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (alice, 'p3', 'finalized', 'scored');
    insert into atk_results values ('ATK-P3 client INSERT of an already-settled (finalized/scored) permit refused', false, 'INSERT succeeded (settled permit with no shot)');
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into atk_results values ('ATK-P3 client INSERT of an already-settled (finalized/scored) permit refused', true, sqlerrm);
  end;

  -- P4: reserved_count is derived from live reserved rows; direct INSERTs
  -- (bypassing reserve_analysis_permit) must not inflate it.
  begin
    for n in 1..5 loop
      insert into public.analysis_permits (user_id, idempotency_key, status)
      values (alice, 'p4-' || n, 'reserved');
    end loop;
  exception when insufficient_privilege or check_violation or raise_exception then
    null;
  end;
  select reserved_count into after_reserved from public.access_state();
  insert into atk_results values (
    'ATK-P4 access_state().reserved_count not inflatable by direct permit INSERT',
    after_reserved = before_reserved,
    format('reserved_count %s -> %s', before_reserved, after_reserved));

  -- P5: revive-by-replacement. A settled permit is "immutable for every
  -- role", but DELETE + INSERT under the same idempotency_key recreates it
  -- as reserved with the same key — the transition the UPDATE guard forbids.
  select id, status into r from public.analysis_permits
  where user_id = alice and idempotency_key = 'k1';
  if r.status <> 'finalized' then raise exception 'SETUP: k1 should be finalized, is %', r.status; end if;
  begin
    delete from public.analysis_permits where id = r.id;
    get diagnostics n = row_count;
    insert into public.analysis_permits (user_id, idempotency_key, status)
    values (alice, 'k1', 'reserved');
    select status into st from public.analysis_permits where user_id = alice and idempotency_key = 'k1';
    insert into atk_results values (
      'ATK-P5 settled permit cannot be revived by DELETE + re-INSERT under the same key',
      false, format('deleted=%s, key k1 is now %s', n, st));
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into atk_results values (
      'ATK-P5 settled permit cannot be revived by DELETE + re-INSERT under the same key',
      true, sqlerrm);
  end;

  -- P6: cross-user forgery stays refused (RLS control; must PASS everywhere).
  begin
    insert into public.analysis_permits (user_id, idempotency_key, status)
    values ('00000000-0000-4000-8000-0000000000b1', 'p6', 'reserved');
    insert into atk_results values ('ATK-P6 control: cross-user permit INSERT refused', false, 'INSERT succeeded for another user');
  exception when insufficient_privilege or check_violation or raise_exception then
    insert into atk_results values ('ATK-P6 control: cross-user permit INSERT refused', true, sqlerrm);
  end;
end $$;

reset role;

\set QUIET off
select case when ok then 'PASS' else 'FAIL' end as verdict, case_id, detail from atk_results order by case_id;
\set QUIET on

do $$
declare n int;
begin
  select count(*) into n from atk_results where not ok;
  if n > 0 then
    raise exception 'ATTACK permit-insert lifecycle: % case(s) reproduce on this revision', n;
  end if;
  raise notice 'ATTACK permit-insert lifecycle: all cases closed';
end $$;

rollback;
