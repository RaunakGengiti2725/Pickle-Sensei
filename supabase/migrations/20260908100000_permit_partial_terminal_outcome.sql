-- ============================================================================
-- Pickle Sensei — an honest PARTIAL terminal outcome for analysis permits
-- (W01-01; follows 20260908020000).
--
-- THE GAP. The analyzer can deliver mechanics-only output — a stroke was
-- recognised and phased, but no validated benchmark exists for it, so there is
-- no rating. Before this migration that result had no name in the database:
--   * public.shots.result_kind admitted only scored | low_confidence
--     (20260829120000), so apply_synced_shot() answered
--     shot.write_failed:23514 — a TRANSIENT code the mobile outbox retries
--     until exhausted — for a result that will never change;
--   * the permit lifecycle guards (guard_analysis_permit_lifecycle,
--     api_private.enforce_permit_transition) had no settled state for it, so
--     the reservation stayed open (and was eventually swept to
--     released/expired) although the analysis had finished.
-- The only ways to persist such a result were to relabel it low_confidence
-- (a lie: the pose WAS confident, the benchmark is what is missing) or to
-- upgrade it to scored (a fabricated rating that would ALSO consume a free
-- rating / be charged). Neither is acceptable.
--
-- THE FIX — vocabulary only. `partial` becomes an explicit, settled,
-- released permit outcome and shot result kind. It is admitted BESIDE the
-- free-rating accounting path, never by rewriting it:
--   1. public.shots.result_kind ∈ {scored, low_confidence, partial}.
--      shots_low_confidence_unscored (20260905000000: result_kind = 'scored'
--      OR overall_score IS NULL) is untouched — it already makes every
--      non-scored row unscored, so a partial can never carry a score.
--   2. guard_analysis_permit_lifecycle: 'partial' joins the settled-outcome
--      vocabulary, and a partial outcome may ONLY be released — there is no
--      finalized/partial (finalized is the shape of a delivered rating).
--      reserved → released/partial is the normal settlement;
--      released/expired → released/partial is the late (offline) settlement,
--      mirroring released/low_confidence. released/partial itself is
--      terminal like every other settled state.
--   3. api_private.enforce_permit_transition (the API-plane guard on the same
--      table) admits released/expired → released/partial; reserved → released
--      was already allowed.
--
-- WHAT IS DELIBERATELY NOT TOUCHED, and why the objective holds anyway:
--   * apply_synced_shot(jsonb) — its settlement is already
--       status  = case when result_kind = 'scored' then 'finalized' else 'released' end,
--       outcome = result_kind,
--     guarded by permit_backs_sync(status, outcome), so a partial settles the
--     named permit released/partial through the same code path and the same
--     access_lock_key(uid) advisory lock as every other result. The scored
--     free-limit backstop (lifetime_scored_count() >= 2) fires for
--     result_kind = 'scored' only, so a partial is accepted with both free
--     ratings spent and is never a charge.
--   * permit_backs_sync(status, outcome) — coalesce(reserved OR
--     released/expired, false). released/partial is NOT backing: a second
--     shot on the permit is access.permit_not_reserved, and the shots gate
--     refuses a direct client scored INSERT that names it (42501).
--   * lifetime_scored_count(), identity_scored_count(),
--     record_scored_shot_in_ledger() — count result_kind = 'scored' rows
--     only. A partial neither increments the account count nor the identity
--     ledger, so the lifetime-spent floor, late-linked identity inheritance
--     (20260905000100) and the delete-and-recreate anti-reset (J1–J9) are
--     exactly as before.
--   * Tombstones (20260907100000) — an owner DELETE of a released/partial
--     permit leaves the released/partial tombstone; the id can only be
--     restored byte-identical and never reopened as reserved; the RPC
--     answers access.permit_not_reserved for the tombstoned id.
--   * Grants, policies, RLS — none change. The client role's column grant on
--     analysis_permits (status, outcome) is unchanged and the guards above
--     decide what it may write.
--
-- Live proof: supabase/tests/security_regression.sql section S (S1–S7).
-- Static pin: supabase/functions/api/__wf__/db_migrations_rls_indexes.test.ts
-- ("W01-01"). The edge function's sync parser (supabase/functions/api/index.ts,
-- serial group edge-index) still narrows resultKind to scored|low_confidence;
-- widening it to accept resultKind='partial' with overallScore=null is the
-- one remaining step for a partial to reach this table from the shipping app,
-- and it lands on the same RPC contract proven here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. shots.result_kind admits 'partial'. NOT VALID + VALIDATE: the validation
--    scan takes SHARE UPDATE EXCLUSIVE only, never an exclusive lock over the
--    live table. Every existing row is scored or low_confidence, so the
--    validation cannot fail.
-- ---------------------------------------------------------------------------
alter table public.shots drop constraint shots_result_kind_check;
alter table public.shots add constraint shots_result_kind_check
  check (result_kind in ('scored', 'low_confidence', 'partial')) not valid;
alter table public.shots validate constraint shots_result_kind_check;

comment on column public.shots.result_kind is
  'scored: a validated rating (overall_score present, consumes a free rating / is charged). low_confidence: the analyzer abstained (no score). partial: mechanics-only output without a validated benchmark (no score, never counted, never charged). Every non-scored kind is unscored (shots_low_confidence_unscored).';

-- ---------------------------------------------------------------------------
-- 2. The permit lifecycle guard learns the word.
-- ---------------------------------------------------------------------------
create or replace function public.guard_analysis_permit_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_from text := case
    when tg_op = 'UPDATE' then old.status || '/' || coalesce(old.outcome, 'NULL')
    else 'INSERT'
  end;
  v_to text := new.status || '/' || coalesce(new.outcome, 'NULL');
begin
  -- Shape: a reservation has no outcome yet; a settled permit always names
  -- one of the known outcomes. released/NULL and finalized/NULL cannot be
  -- written by any role from here on. A partial is only ever released: it
  -- is not a delivered rating, so finalized/partial is not a permit state.
  if (new.status = 'reserved') <> (new.outcome is null)
     or (new.status <> 'reserved' and new.outcome not in (
       'scored', 'low_confidence', 'partial', 'cancelled', 'failed', 'unsupported',
       'incorrect_recognition', 'expired', 'free_limit_exceeded'))
     or (new.outcome = 'partial' and new.status <> 'released') then
    raise exception using
      errcode = 'check_violation',
      message = format('analysis_permits: illegal permit state %s (%s)', v_to, v_from),
      hint = 'access.permit_transition_rejected';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  -- Bookkeeping updates that leave the lifecycle alone.
  if new.status = old.status and new.outcome is not distinct from old.outcome then
    return new;
  end if;

  -- reserved → any settled state (the edge finalize route, the sync RPC, the
  -- pg_cron sweep). Shape above already pins the outcome vocabulary.
  if old.status = 'reserved' then
    return new;
  end if;

  -- released/expired (swept while the device was offline) → exactly the
  -- states apply_synced_shot() settles a late permit into.
  if old.status = 'released' and old.outcome = 'expired'
     and (new.status, new.outcome) in (
       ('finalized', 'scored'),
       ('released', 'low_confidence'),
       ('released', 'partial'),
       ('released', 'free_limit_exceeded')) then
    return new;
  end if;

  -- Every other settled state is terminal: consumed permits are never
  -- revived, a refused permit is never re-labelled into acceptable backing,
  -- and a partial is never upgraded into a rating.
  raise exception using
    errcode = 'check_violation',
    message = format('analysis_permits: illegal permit transition %s -> %s', v_from, v_to),
    hint = 'access.permit_transition_rejected';
end;
$$;

comment on function public.guard_analysis_permit_lifecycle() is
  'BEFORE INSERT OR UPDATE guard on public.analysis_permits: reserved ⇔ outcome IS NULL, settled rows carry a known outcome (partial only ever released), and the only lifecycle moves are reserved → any settled state and released/expired → finalized/scored | released/low_confidence | released/partial | released/free_limit_exceeded. Every other transition raises check_violation (23514, hint access.permit_transition_rejected) — PostgREST 400, edge 409, never a 503. Applies to every role; clients cannot disable triggers (no TRIGGER privilege).';

revoke execute on function public.guard_analysis_permit_lifecycle()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The API-plane transition guard admits the same late settlement.
-- ---------------------------------------------------------------------------
create or replace function api_private.enforce_permit_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at
     or not (
       (new.status = old.status and new.outcome is not distinct from old.outcome)
       or (old.status = 'reserved' and new.status in ('finalized', 'released'))
       or (old.status = 'released' and old.outcome = 'expired'
           and (new.status, new.outcome) in (
             ('finalized', 'scored'),
             ('released', 'low_confidence'),
             ('released', 'partial'),
             ('released', 'free_limit_exceeded')))
     ) then
    raise exception using errcode = 'check_violation',
      message = 'Invalid analysis permit transition',
      hint = 'access.permit_transition_rejected';
  end if;
  return new;
end;
$$;
revoke all on function api_private.enforce_permit_transition()
  from public, anon, authenticated, service_role;
