-- ============================================================================
-- Pickle Sensei — partial index for the hourly stale-permit sweep.
--
-- pg_cron job `expire-stale-analysis-permits` (20260831000000) runs
--   update public.analysis_permits set status = 'released', outcome = 'expired'
--    where status = 'reserved' and created_at < now() - interval '24 hours'
-- Finalized permits are never deleted (one row per analysis ever performed)
-- and the only non-unique index is user_id-leading, so the sweep scanned the
-- whole permit history every hour. This partial index holds only live
-- reservations — rows leave it the moment they finalize or release — so it
-- stays at roughly the number of in-flight analyses. Idempotent-safe.
-- ============================================================================

create index if not exists analysis_permits_reserved_created_idx
  on public.analysis_permits (created_at)
  where status = 'reserved';
