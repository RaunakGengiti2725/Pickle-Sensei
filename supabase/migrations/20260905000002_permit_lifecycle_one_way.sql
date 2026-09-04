-- 20260905000002_permit_lifecycle_one_way.sql
--
-- analysis_permits carries a client UPDATE (status, outcome) grant so the
-- edge fn's finalize route and the sync RPC can settle a permit. Nothing
-- constrained the TRANSITION: with the user's own access token, PostgREST
-- `PATCH /rest/v1/analysis_permits?id=eq.<p>` could move a finalized or
-- released permit back to `reserved` (consuming one permit twice, inflating
-- access_state().reserved_count until reserve self-locked) and write any
-- text as `outcome` (the only CHECK was on status). The identity ledger and
-- the RPC's free-limit backstop kept the paywall intact, but the permit
-- ledger itself was client-forgeable.
--
-- The lifecycle is now enforced at the table, for every role:
--
--   reserved ──► finalized | released      (once; carries a known outcome)
--   finalized / released                    immutable — no UPDATE at all
--
--   * BEFORE UPDATE trigger enforce_permit_lifecycle():
--       - a permit whose stored status is not `reserved` rejects every update
--         (42501 insufficient_privilege — the same posture as the append-only
--         ledgers in 20260831160000);
--       - a terminal status must carry an outcome, and a still-reserved
--         permit must not carry one (23514 check_violation);
--     The existing status CHECK still bounds status to the three values.
--   * CHECK analysis_permits_outcome_known bounds outcome to the documented
--     set — exactly what the edge fn (RELEASABLE_OUTCOMES), the sync RPC
--     (result_kind: scored | low_confidence; free_limit_exceeded) and the
--     pg_cron sweep (expired) write.
--
-- Every supported writer still works unchanged, because each of them only
-- ever touches `status = 'reserved'` rows and moves them forward:
--   - index.ts finalizeAnalysisPermitRoute: update {status:'finalized',
--     outcome} where id, user_id, status='reserved' — the idempotent replay
--     matches zero rows and raises nothing;
--   - apply_synced_shot(): reserved → finalized/scored or released/<kind>,
--     released/expired, released/free_limit_exceeded;
--   - the hourly sweep: reserved → released/expired.
--
-- Static pin: supabase/functions/api/__wf__/db_migrations_rls_indexes.test.ts
-- ("permits: the lifecycle is one-way …"). Live:
-- supabase/tests/security_regression.sql L1–L4;
-- supabase/tests/adjudication_db_rls_grants_isolation.sql ADJ-D1..D4.

-- ---------------------------------------------------------------------------
-- 1. The transition guard.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_permit_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'reserved' then
    raise exception 'analysis permit % is already % and cannot be changed',
      old.id, old.status
      using errcode = 'insufficient_privilege';
  end if;
  if new.status <> 'reserved' and new.outcome is null then
    raise exception 'a % analysis permit must record an outcome', new.status
      using errcode = 'check_violation';
  end if;
  if new.status = 'reserved' and new.outcome is not null then
    raise exception 'a reserved analysis permit cannot carry an outcome (%)', new.outcome
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_permit_lifecycle() from public, anon, authenticated;

comment on function public.enforce_permit_lifecycle() is
  'BEFORE UPDATE guard on public.analysis_permits: settled (finalized/released) permits are immutable for every role (42501); a terminal status must carry an outcome and a reserved permit must not (23514). Together with the analysis_permits_outcome_known CHECK this makes the permit lifecycle one-way: reserved -> finalized | released, once.';

drop trigger if exists analysis_permits_lifecycle_one_way on public.analysis_permits;
create trigger analysis_permits_lifecycle_one_way
  before update on public.analysis_permits
  for each row execute function public.enforce_permit_lifecycle();

-- ---------------------------------------------------------------------------
-- 2. The outcome enumeration. Every writer in the chain has only ever
--    produced these values, so the constraint is validated immediately.
-- ---------------------------------------------------------------------------
alter table public.analysis_permits
  drop constraint if exists analysis_permits_outcome_known;
alter table public.analysis_permits
  add constraint analysis_permits_outcome_known check (
    outcome is null or outcome in (
      'scored',
      'low_confidence',
      'cancelled',
      'failed',
      'unsupported',
      'incorrect_recognition',
      'expired',
      'free_limit_exceeded'
    )
  );

comment on constraint analysis_permits_outcome_known on public.analysis_permits is
  'outcome is one of the documented permit outcomes: scored | low_confidence (sync result kinds), cancelled | failed | unsupported | incorrect_recognition (edge fn finalize), expired (sweep / RPC), free_limit_exceeded (RPC backstop).';
