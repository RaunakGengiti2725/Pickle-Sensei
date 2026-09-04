-- ============================================================================
-- Pickle Sensei — adversarial pass 3: db-rls-grants-isolation (FINDINGS).
--
-- Each block below asserts the SECURE expectation for an attack that
-- SUCCEEDED on the audited revision (4d812e1a). While the hole is open the
-- block emits `WARNING:  FINDING <id> REPRODUCED: ...` and the script keeps
-- going (so every finding is reported in one run); once a fix migration lands
-- the block emits `NOTICE:  FINDING <id> FIXED` instead. Infrastructure errors
-- still abort (ON_ERROR_STOP). run_attack_db_rls_grants_isolation_3.sh greps
-- the REPRODUCED lines and fails with ATTACK_STRICT=1.
--
--   F1. analysis_permits lifecycle is not a state machine: the owner (any
--       PostgREST caller holding their own access token; the edge fn itself
--       guards with .eq("status","reserved")) can UPDATE a finalized or
--       released permit back to status='reserved'. Effects on 4d812e1a:
--         * access_state().reserved_count counts the consumed permit again
--         * reserve_analysis_permit() answers access.paywall_required with
--           only 1 of 2 free ratings spent (self lock-out for up to 24h)
--         * apply_synced_shot() accepts a NEW scored shot against the
--           resurrected permit — the reserve step (and its paywall check)
--           is skipped; only the lifetime backstop caps it at 2
--   F2. reject_deletion_feedback_mutation() waves through EVERY statement at
--       pg_trigger_depth() > 1, not just the FK ON DELETE SET NULL it exists
--       for: a table-owner session (the same threat model D2d/D2e in
--       security_regression.sql guards against) rewrites or deletes exit
--       survey rows from any nested trigger. Client roles cannot reach this
--       (K6 in the HELD matrix) — grants stop them, the trigger does not.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

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

create function pg_temp.shot_payload(p_id text, p_permit uuid, p_kind text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.shot_payload(text, uuid, text) to authenticated;

-- ───────────── F1: finalized permit resurrected by its owner ─────────────────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

do $$
declare r record; v text; n int; st text; oc text; a record; broke text := '';
begin
  select * into r from public.reserve_analysis_permit('alice-k1');
  if r.result <> 'accepted' then
    raise exception 'F1 SETUP: reserve must be accepted (got %)', r.result;
  end if;
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e1', r.permit_id, 'scored'));
  if v <> 'accepted' then
    raise exception 'F1 SETUP: scored sync must be accepted (got %)', v;
  end if;
  select p.status, p.outcome into st, oc from public.analysis_permits p where p.id = r.permit_id;
  if st <> 'finalized' or oc <> 'scored' then
    raise exception 'F1 SETUP: permit must be finalized/scored (got %/%)', st, oc;
  end if;
  select * into a from public.access_state();
  if a.scored_count <> 1 or a.reserved_count <> 0 then
    raise exception 'F1 SETUP: access_state must be scored 1 / reserved 0 (got %/%)',
      a.scored_count, a.reserved_count;
  end if;

  -- THE ATTACK: finalized → reserved (column grant on status allows it; no
  -- transition guard exists).
  begin
    update public.analysis_permits set status = 'reserved' where id = r.permit_id;
    get diagnostics n = row_count;
  exception
    when insufficient_privilege or check_violation or raise_exception then n := 0;
  end;

  if n = 0 then
    raise notice 'FINDING F1 FIXED: finalized permit can no longer be reverted to reserved';
    return;
  end if;

  broke := format('UPDATE finalized→reserved affected %s row', n);
  select * into a from public.access_state();
  if a.reserved_count <> 0 then
    broke := broke || format('; access_state().reserved_count over-counts (%s, expected 0)', a.reserved_count);
  end if;
  select * into r from public.reserve_analysis_permit('alice-k2');
  if r.result <> 'accepted' then
    broke := broke || format('; reserve_analysis_permit(''alice-k2'') → %s with scored_count=%s (1 free rating should remain)',
      r.result, a.scored_count);
  else
    -- keep the world identical to the "refused" branch for the next probe
    update public.analysis_permits set status = 'released', outcome = 'cancelled'
     where idempotency_key = 'alice-k2';
  end if;

  -- Second consumption of the SAME permit: a brand-new scored shot.
  update public.analysis_permits set status = 'reserved', outcome = null
   where idempotency_key = 'alice-k1';
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e2',
    (select id from public.analysis_permits where idempotency_key = 'alice-k1'),
    'scored'));
  if v = 'accepted' then
    broke := broke || format('; apply_synced_shot re-consumed the resurrected permit for a 2nd scored shot (accepted; lifetime_scored_count now %s)',
      public.lifetime_scored_count());
  end if;

  -- The lifetime backstop is the ONLY thing left standing: a 3rd scored shot
  -- through the same resurrected permit must still be refused.
  update public.analysis_permits set status = 'reserved', outcome = null
   where idempotency_key = 'alice-k1';
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e3',
    (select id from public.analysis_permits where idempotency_key = 'alice-k1'),
    'scored'));
  if v <> 'access.paywall_required' then
    raise exception 'F1 ESCALATION: 3rd scored shot via resurrected permit returned % — free limit BYPASSED', v;
  end if;

  raise warning 'FINDING F1 REPRODUCED: %; 3rd scored shot correctly refused (%) — free limit held only by the apply_synced_shot backstop',
    broke, v;
end $$;

-- F1b: released → reserved (after an abstention) is the same hole. Runs as
-- Bob, whose free ratings are untouched by the F1 world above.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare r record; v text; n int; a record;
begin
  select * into r from public.reserve_analysis_permit('bob-k1');
  if r.result <> 'accepted' then
    raise exception 'F1b SETUP: Bob reserve must be accepted (got %)', r.result;
  end if;
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e4', r.permit_id, 'low_confidence'));
  if v <> 'accepted' then
    raise exception 'F1b SETUP: abstention sync must be accepted (got %)', v;
  end if;
  begin
    update public.analysis_permits set status = 'reserved', outcome = null where id = r.permit_id;
    get diagnostics n = row_count;
  exception
    when insufficient_privilege or check_violation or raise_exception then n := 0;
  end;
  if n = 0 then
    raise notice 'FINDING F1b FIXED: released permit can no longer be reverted to reserved';
  else
    select * into a from public.access_state();
    raise warning 'FINDING F1b REPRODUCED: released permit reverted to reserved (% row); access_state() now scored %/reserved % after an abstention that should hold nothing',
      n, a.scored_count, a.reserved_count;
  end if;
end $$;

reset role;

-- ───── F2: nested-trigger passthrough admits non-FK UPDATE/DELETE (owner) ────

insert into public.account_deletion_feedback (user_id, reason, details)
values ('00000000-0000-4000-8000-00000000000a', 'other', 'orig');

create table public.__attack3_owner_tramp (id int);
create function public.__attack3_owner_upd() returns trigger
language plpgsql as $$
begin
  update public.account_deletion_feedback set details = 'x';
  return new;
end $$;
create function public.__attack3_owner_del() returns trigger
language plpgsql as $$
begin
  delete from public.account_deletion_feedback;
  return new;
end $$;
create trigger upd before insert on public.__attack3_owner_tramp
  for each row execute function public.__attack3_owner_upd();

do $$
declare details_now text; rows_now int; broke text := '';
begin
  -- depth 1 is refused for the owner (D2d already pins this)
  begin
    update public.account_deletion_feedback set details = 'direct';
    raise exception 'F2 SETUP: direct owner UPDATE must be trigger-blocked';
  exception when insufficient_privilege then null;
  end;

  -- depth 2: non-FK UPDATE from a nested trigger
  begin
    insert into public.__attack3_owner_tramp values (1);
  exception when insufficient_privilege then null;
  end;
  select string_agg(details, ',') into details_now from public.account_deletion_feedback;
  if details_now = 'x' then
    broke := 'nested UPDATE set details=''x'' at pg_trigger_depth()=2';
  end if;

  -- depth 2: DELETE from a nested trigger
  drop trigger upd on public.__attack3_owner_tramp;
  create trigger del before insert on public.__attack3_owner_tramp
    for each row execute function public.__attack3_owner_del();
  begin
    insert into public.__attack3_owner_tramp values (2);
  exception when insufficient_privilege then null;
  end;
  select count(*) into rows_now from public.account_deletion_feedback;
  if rows_now = 0 then
    broke := broke || case when broke = '' then '' else '; ' end
             || 'nested DELETE removed the exit survey row at pg_trigger_depth()=2';
  end if;

  if broke = '' then
    raise notice 'FINDING F2 FIXED: depth>1 passthrough no longer admits non-FK UPDATE/DELETE';
  else
    raise warning 'FINDING F2 REPRODUCED: %', broke;
  end if;
end $$;

rollback;

\echo ATTACK PASS 3 (db-rls-grants-isolation) FINDINGS PROBE: COMPLETE (see WARNING lines)
