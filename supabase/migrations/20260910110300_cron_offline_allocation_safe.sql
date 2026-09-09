-- W11-03: the hourly pg_cron sweep of stale online permits is a named,
-- owner-only function whose write set is pinned by the SQL matrix — never an
-- anonymous UPDATE that only the cron job table knows about.
--
-- 20260831000000 scheduled 'expire-stale-analysis-permits' as a bare
-- statement: reserved public.analysis_permits older than 24 h become
-- released/expired. That statement is the one piece of maintenance whose
-- scope was declared nowhere in the schema and exercised by nothing but a
-- hand-copied string in the matrix; it also waits on any row a settlement is
-- consuming at that moment, in an hourly job that needs no row in particular.
-- Every offline artefact — devices, grants, allocation ledger, offline receipt
-- settlements — and every settlement receipt is written by its own RPC and
-- fenced by its own trigger; none of it is a "stale" state a job may reclaim
-- (allocation ≠ consumption; a disconnected device's ticket is never
-- reclaimed automatically; receipts are append-only).
--
-- api_private.sweep_stale_analysis_permits(p_limit):
--   * updates ONLY public.analysis_permits rows with status='reserved' and
--     created_at older than 24 hours, to released/expired — the exact
--     predicate and outcome the applied schedule used, so the API's view of
--     a swept permit (online_reservation_count(), permit_backs_sync() and the
--     late sync it still backs) is unchanged;
--   * takes each row FOR UPDATE SKIP LOCKED: a permit an in-flight
--     apply_synced_shot()/consume path holds is skipped this hour, never
--     waited on and never contended with;
--   * returns the number of permits it released; an optional batch bound
--     1..10000 (NULL = every stale row) is validated (22023);
--   * SECURITY DEFINER with a pinned search_path, EXECUTE revoked from anon,
--     authenticated and service_role — only the owner (the pg_cron job) runs
--     it.
-- Where pg_cron is installed, the 'expire-stale-analysis-permits' job is
-- rescheduled (same name, same '17 * * * *') to call the function; where it
-- is not (the matrix, local Postgres), the function alone is installed and
-- the matrix runs it directly (security_regression.sql section V). The
-- applied migration is not edited.

create or replace function api_private.sweep_stale_analysis_permits(p_limit integer default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_limit is not null and p_limit not between 1 and 10000 then
    raise exception 'Invalid stale permit sweep batch' using errcode = '22023';
  end if;
  update public.analysis_permits p
  set status = 'released', outcome = 'expired'
  where p.id in (
    select s.id
    from public.analysis_permits s
    where s.status = 'reserved'
      and s.created_at < now() - interval '24 hours'
    order by s.created_at, s.id
    limit p_limit
    for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function api_private.sweep_stale_analysis_permits(integer) is
  'The hourly pg_cron sweep (expire-stale-analysis-permits). Releases reserved public.analysis_permits older than 24 hours as released/expired — its ONLY write. Rows locked by an in-flight settlement are skipped, not waited on. Never touches offline_devices, offline_grants, offline_allocation_ledger, settlement_receipts or offline_receipt_settlements: an offline allocation is never reclaimed automatically and receipts are append-only. Owner-only (EXECUTE revoked from anon, authenticated, service_role). Returns the swept count; p_limit bounds one run (1..10000, NULL = all).';

revoke all on function api_private.sweep_stale_analysis_permits(integer) from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron unavailable. Skipping the stale-permit sweep reschedule.';
    return;
  end if;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'expire-stale-analysis-permits';
  perform cron.schedule(
    'expire-stale-analysis-permits',
    '17 * * * *',
    'select api_private.sweep_stale_analysis_permits()'
  );
end;
$$;
