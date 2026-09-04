-- ============================================================================
-- Analysis permits are a ONE-WAY state machine.
--
-- THE HOLE. analysis_permits_status_check pins the vocabulary (reserved /
-- finalized / released) but nothing pinned the transitions, and clients hold
-- a column UPDATE grant on status/outcome (20260831160000: the finalize and
-- release routes need it). An owner could therefore `update analysis_permits
-- set status = 'reserved', outcome = null` on a permit apply_synced_shot()
-- had just finalized and hand the same permit to the RPC again — one permit,
-- two scored shots. The lifetime backstop still capped free accounts at two,
-- so what degraded was permit accounting (membership usage, audit trail).
--
-- THE FIX. A BEFORE UPDATE trigger on public.analysis_permits refuses any
-- UPDATE that changes status or outcome once the row has left 'reserved':
--
--     reserved → finalized | released        (owner finalize / release, the
--                                             RPC, the pg_cron expiry sweep)
--     finalized | released | * → anything     REFUSED (42501)
--     outcome change on a non-reserved row    REFUSED (42501)
--
-- The rule keys off OLD.status <> 'reserved', so every terminal value — the
-- current two, the 'expired' the sweep records as released/expired today, and
-- any status a later migration adds — is locked without another migration.
-- A no-op UPDATE (same status, same outcome; e.g. an idempotent finalize
-- replay) still passes. It binds every role, like the append-only ledgers:
-- the Edge routes only ever update `where status = 'reserved'`, and
-- apply_synced_shot() / reserve_analysis_permit() do the same, so no
-- legitimate writer is affected. Not client-executable.
--
-- Pinned live by security_regression.sql L1–L3 and statically by
-- __wf__/db_migrations_rls_indexes.test.ts.
-- ============================================================================

create or replace function public.reject_terminal_permit_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status <> 'reserved'
     and (new.status is distinct from old.status
          or new.outcome is distinct from old.outcome) then
    raise exception 'access.permit_already_finalized'
      using errcode = 'insufficient_privilege',
            detail = format(
              'Analysis permit %s is %s/%s; a permit never leaves a terminal status and its outcome is fixed.',
              old.id, old.status, coalesce(old.outcome, 'null'));
  end if;
  return new;
end;
$$;

comment on function public.reject_terminal_permit_transition() is
  'BEFORE UPDATE on public.analysis_permits: once status has left reserved, any change of status or outcome is refused (42501). reserved → finalized|released stays open to the owner, the RPC and the expiry sweep.';

revoke execute on function public.reject_terminal_permit_transition()
  from public, anon, authenticated;

drop trigger if exists analysis_permits_terminal_lock on public.analysis_permits;
create trigger analysis_permits_terminal_lock
  before update of status, outcome on public.analysis_permits
  for each row execute function public.reject_terminal_permit_transition();
