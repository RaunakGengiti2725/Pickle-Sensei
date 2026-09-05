-- Adjudication: let the REAL pg_cron scheduler fire the three migration jobs
-- (schedules tightened to every minute on the disposable DB only).
-- Run on the pgcron.Dockerfile container, wait ~75s, then read cron.job_run_details:
--   docker exec -i pickle-stress-pgcron psql -U postgres -f - < supabase/tests/stress/repro/pgcron_tick_seed.sql
--   docker exec pickle-stress-pgcron psql -U postgres -c "select j.jobname, d.status, d.return_message, d.start_time from cron.job_run_details d join cron.job j using (jobid) order by d.start_time"
-- Expected: tick-stale released/expired, tick-fresh still reserved, deletion row purged, tick-old purged, tick-recent kept.
\set ON_ERROR_STOP on
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000ce', 'cron-tick@example.test') on conflict (id) do nothing;
insert into public.profiles (id, email) values ('00000000-0000-4000-8000-0000000000ce', 'cron-tick@example.test') on conflict (id) do nothing;
insert into public.analysis_permits (user_id, idempotency_key, status, created_at) values
 ('00000000-0000-4000-8000-0000000000ce','tick-stale','reserved', now() - interval '25 hours'),
 ('00000000-0000-4000-8000-0000000000ce','tick-fresh','reserved', now() - interval '23 hours');
insert into public.account_deletion_requests (user_id, created_at, expires_at) values
 ('00000000-0000-4000-8000-0000000000ce', now() - interval '3 days', now() - interval '2 days');
insert into public.webhook_events (id, payload, received_at) values
 ('tick-old', '{}', now() - interval '91 days'), ('tick-recent', '{}', now() - interval '89 days');
select cron.alter_job(jobid, schedule := '* * * * *') from cron.job;
select jobname, schedule, active from cron.job order by jobname;
select now() as seeded_at;
