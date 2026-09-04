-- analysis_permits: the lifecycle is one-way and the outcome vocabulary is
-- closed (2026-09-05, ADJ-D).
--
-- Defect: 20260831160000_defense_in_depth.sql sized the client UPDATE grant
-- on analysis_permits to (status, outcome) for POST /v1/permits/:id/finalize,
-- with the RLS policy analysis_permits_update_own and only the status CHECK
-- ('reserved' | 'finalized' | 'released') constraining values. Nothing
-- constrained the TRANSITION or the outcome text, so through PostgREST
-- (`PATCH /rest/v1/analysis_permits?id=eq.<own permit>`) a client could:
--   * flip a finalized/released permit back to 'reserved' — the sync RPC then
--     consumed the same permit twice (the identity ledger + lifetime
--     backstop still held the paywall, but permit accounting was forged and
--     reserved_count could be inflated until reserve self-locked);
--   * write any outcome ('totally_made_up'), or 'scored' without a shot.
--
-- Fix, in three layers, all of which fire for every role so a compromised
-- backend path is bounded too:
--   1. CHECK analysis_permits_outcome_check — outcome is one of the eight
--      documented values or null, and it is null EXACTLY while the permit is
--      reserved (a terminal permit always carries its outcome). NOT VALID so
--      the migration never fails on historical rows; every new write obeys it.
--   2. BEFORE UPDATE trigger analysis_permits_lifecycle_guard:
--        reserved  -> finalized | released   allowed (with an outcome)
--        reserved  -> reserved              allowed only as a no-op on the
--                                           lifecycle columns
--        terminal  -> anything different    refused (23514 check_violation)
--      A client session (anon/authenticated, i.e. PostgREST with the user's
--      JWT) may additionally only record the outcomes the finalize route
--      accepts — low_confidence | cancelled | failed | unsupported |
--      incorrect_recognition. 'scored', 'expired' and 'free_limit_exceeded'
--      are written only by apply_synced_shot() (SECURITY DEFINER since
--      20260905000000) and the pg_cron sweep, both of which run as the
--      migration role.
--   3. Grants sized to the writes: the client INSERT is narrowed to the
--      columns reserve_analysis_permit() supplies (id, user_id,
--      idempotency_key — status/outcome/created_at take their defaults, so a
--      client cannot mint a pre-terminal or back-dated permit), and DELETE is
--      revoked (no shipped path deletes permits; the ledger of attempts is
--      append-once). UPDATE stays (status, outcome).
--
-- Unchanged behaviour: the finalize route (`update ... set status =
-- 'finalized', outcome = <releasable> where status = 'reserved'`) and its
-- idempotent same-outcome replay (which never issues an UPDATE on a terminal
-- row); apply_synced_shot()'s finalized/scored and released/<abstention>
-- writes; the sweep's released/expired.
--
-- Pins: __wf__/db_migrations_rls_indexes.test.ts (static) and
-- security_regression.sql E6a–E6e (live), adjudication ADJ-D1–D4.

-- ---------------------------------------------------------------------------
-- 1. Outcome vocabulary + reserved <-> no outcome.
-- ---------------------------------------------------------------------------
alter table public.analysis_permits drop constraint if exists analysis_permits_outcome_check;
alter table public.analysis_permits add constraint analysis_permits_outcome_check
  check (
    (status = 'reserved') = (outcome is null)
    and (
      outcome is null
      or outcome in (
        'scored', 'low_confidence', 'expired', 'free_limit_exceeded',
        'cancelled', 'failed', 'unsupported', 'incorrect_recognition'
      )
    )
  ) not valid;

comment on constraint analysis_permits_outcome_check on public.analysis_permits is
  'outcome is null exactly while status = reserved and otherwise one of the documented values: scored | low_confidence | expired | free_limit_exceeded (sync RPC / sweep) and low_confidence | cancelled | failed | unsupported | incorrect_recognition (finalize route). NOT VALID: historical rows are not re-checked.';

-- ---------------------------------------------------------------------------
-- 2. One-way transitions.
-- ---------------------------------------------------------------------------
create or replace function public.guard_analysis_permit_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_client_session constant boolean := current_user in ('anon', 'authenticated');
begin
  if old.status <> 'reserved' then
    -- Terminal. The lifecycle columns are frozen; a same-value write is a
    -- harmless no-op, anything else is a reversal or a rewrite.
    if new.status is distinct from old.status or new.outcome is distinct from old.outcome then
      raise exception using
        errcode = 'check_violation',
        message = format('analysis_permits.%s is %s/%s: a terminal permit cannot change status or outcome',
                         old.id, old.status, old.outcome),
        constraint = 'analysis_permits_lifecycle_one_way',
        table = 'analysis_permits',
        schema = 'public';
    end if;
    return new;
  end if;

  if new.status = 'reserved' then
    if new.outcome is not null then
      raise exception using
        errcode = 'check_violation',
        message = format('analysis_permits.%s is reserved: an outcome is recorded only with the terminal transition', old.id),
        constraint = 'analysis_permits_lifecycle_one_way',
        table = 'analysis_permits',
        schema = 'public';
    end if;
    return new;
  end if;

  -- reserved -> finalized | released
  if new.outcome is null then
    raise exception using
      errcode = 'check_violation',
      message = format('analysis_permits.%s: the terminal transition to %s requires an outcome', old.id, new.status),
      constraint = 'analysis_permits_lifecycle_one_way',
      table = 'analysis_permits',
      schema = 'public';
  end if;
  if v_client_session and new.outcome not in (
    'low_confidence', 'cancelled', 'failed', 'unsupported', 'incorrect_recognition'
  ) then
    raise exception using
      errcode = 'check_violation',
      message = format('analysis_permits.%s: outcome %s is recorded only by the sync RPC or the sweep, not by a client session', old.id, new.outcome),
      constraint = 'analysis_permits_lifecycle_one_way',
      table = 'analysis_permits',
      schema = 'public';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_analysis_permit_lifecycle() from public, anon, authenticated;

comment on function public.guard_analysis_permit_lifecycle() is
  'BEFORE UPDATE guard on analysis_permits: reserved -> finalized|released once (with an outcome), never back, never rewritten; client sessions (anon/authenticated) may only record the finalize-route outcomes. Raises 23514 check_violation. Runs for every role.';

drop trigger if exists analysis_permits_lifecycle_guard on public.analysis_permits;
create trigger analysis_permits_lifecycle_guard
  before update on public.analysis_permits
  for each row execute function public.guard_analysis_permit_lifecycle();

-- ---------------------------------------------------------------------------
-- 3. Grants sized to the writes.
-- ---------------------------------------------------------------------------
revoke insert on public.analysis_permits from authenticated;
grant insert (id, user_id, idempotency_key) on public.analysis_permits to authenticated;
revoke delete on public.analysis_permits from authenticated;
drop policy if exists "analysis_permits_delete_own" on public.analysis_permits;
