-- ============================================================================
-- Pickle Sensei — db-schema-migrations execution audit: pg_cron for real.
--
-- Requires a server with pg_cron preloaded (run_audit_probes.sh builds
-- postgres:16 + postgresql-16-cron and starts it with
-- shared_preload_libraries=pg_cron, cron.database_name=postgres). On such a
-- server the guarded block in 20260831000000_scale_and_security.sql no longer
-- takes its "unavailable" branch: this file asserts the three jobs were
-- registered, that re-running the block replaces rather than duplicates them,
-- and that the scheduler actually EXECUTES a job body against seeded rows.
--
-- Not wrapped in a transaction: pg_cron runs jobs on separate connections and
-- must see committed rows.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

-- ───────────── P1: the migration registered exactly the three jobs ──────────
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'P1: pg_cron is not installed — this probe needs the pg_cron image';
  end if;
  if (select count(*) from cron.job) <> 3 then
    raise exception 'P1: expected exactly 3 cron jobs (got %)', (select count(*) from cron.job);
  end if;
  if (select array_agg(jobname order by jobname) from cron.job) <>
     array['expire-stale-analysis-permits', 'purge-expired-deletion-requests', 'purge-old-webhook-events'] then
    raise exception 'P1: job names differ from the migration';
  end if;
  if exists (select 1 from cron.job where not active) then
    raise exception 'P1: every job must be active';
  end if;
end $$;

-- ───────────── P2: re-running the block is idempotent (same names) ───────────
-- Verbatim copy of the migration's block (the migration itself is immutable).
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension pg_cron;
    exception when others then
      raise notice 'pg_cron unavailable (%). Skipping maintenance schedules.', sqlerrm;
      return;
    end;
  end if;
  perform cron.schedule(
    'expire-stale-analysis-permits',
    '17 * * * *',
    'update public.analysis_permits set status = ''released'', outcome = ''expired'' where status = ''reserved'' and created_at < now() - interval ''24 hours'''
  );
  perform cron.schedule(
    'purge-expired-deletion-requests',
    '23 3 * * *',
    'delete from public.account_deletion_requests where expires_at < now() - interval ''1 day'''
  );
  perform cron.schedule(
    'purge-old-webhook-events',
    '41 4 * * *',
    'delete from public.webhook_events where received_at < now() - interval ''90 days'''
  );
end
$cron$;
do $$
begin
  if (select count(*) from cron.job) <> 3 then
    raise exception 'P2: re-running the schedule block must not duplicate jobs (got %)', (select count(*) from cron.job);
  end if;
end $$;

-- ───────────── P3: the scheduler executes the sweep bodies ──────────────────
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-c000-000000000001', 'cron@example.com', '{"full_name":"Cron"}', '{"provider":"google"}');
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-c000-0000000000c1', '00000000-0000-4000-c000-000000000001', 'cron-stale', now() - interval '25 hours'),
  ('00000000-0000-4000-c000-0000000000c2', '00000000-0000-4000-c000-000000000001', 'cron-fresh', now());
insert into public.account_deletion_requests (user_id, expires_at) values
  ('00000000-0000-4000-c000-000000000001', now() - interval '2 days');
insert into public.webhook_events (id, event_type, payload, received_at) values
  ('cron-evt-old', 'INITIAL_PURCHASE', '{}', now() - interval '91 days'),
  ('cron-evt-new', 'RENEWAL', '{}', now());

-- Tighten every schedule to once per second (pg_cron >= 1.5 interval syntax),
-- wait for the runner, then restore the shipped schedules.
do $$ begin perform cron.alter_job(jobid, schedule := '1 second') from cron.job; end $$;
select pg_sleep(6) \gset

do $$
declare failed int; ran int;
begin
  select count(*) into ran from cron.job_run_details where status = 'succeeded';
  select count(*) into failed from cron.job_run_details where status not in ('succeeded', 'running', 'starting');
  if ran < 3 then
    raise exception 'P3: expected the scheduler to have run the jobs (succeeded=%, failed=%)', ran, failed;
  end if;
  if failed > 0 then
    raise exception 'P3: % job runs did not succeed: %', failed,
      (select string_agg(jobid || ':' || status || ':' || coalesce(return_message, ''), '; ')
       from cron.job_run_details where status not in ('succeeded', 'running', 'starting'));
  end if;
  if (select status || '/' || outcome from public.analysis_permits where id = '00000000-0000-4000-c000-0000000000c1') <> 'released/expired' then
    raise exception 'P3: the scheduled sweep must have released the 25h permit as expired';
  end if;
  if (select status from public.analysis_permits where id = '00000000-0000-4000-c000-0000000000c2') <> 'reserved' then
    raise exception 'P3: the scheduled sweep must leave a fresh permit alone';
  end if;
  if exists (select 1 from public.account_deletion_requests where user_id = '00000000-0000-4000-c000-000000000001') then
    raise exception 'P3: the scheduled purge must remove the expired deletion request';
  end if;
  if exists (select 1 from public.webhook_events where id = 'cron-evt-old')
     or not exists (select 1 from public.webhook_events where id = 'cron-evt-new') then
    raise exception 'P3: the scheduled purge must remove only >90d webhook events';
  end if;
end $$;

-- restore the shipped schedules
do $$
begin
  perform cron.alter_job(jobid, schedule := '17 * * * *') from cron.job where jobname = 'expire-stale-analysis-permits';
  perform cron.alter_job(jobid, schedule := '23 3 * * *') from cron.job where jobname = 'purge-expired-deletion-requests';
  perform cron.alter_job(jobid, schedule := '41 4 * * *') from cron.job where jobname = 'purge-old-webhook-events';
end $$;

\echo === job run details ===
\set QUIET off
select jobid, status, return_message, end_time - start_time as took
from cron.job_run_details order by runid limit 12;
\set QUIET on

delete from auth.users where id = '00000000-0000-4000-c000-000000000001';
delete from public.webhook_events where id like 'cron-evt-%';

\echo PG_CRON PROBES: ALL CASES PASSED
