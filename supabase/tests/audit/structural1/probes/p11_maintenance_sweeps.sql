-- P11 — The three pg_cron maintenance statements from
-- 20260831000000_scale_and_security.sql:361-377 are valid against the final
-- schema and touch exactly the rows they should. pg_cron itself is absent in
-- postgres:16 (the migration's DO block raises a NOTICE and schedules
-- nothing), so whether the jobs exist on the hosted project is UNKNOWN from
-- this plane; the statements are run verbatim here as the owner so at least
-- their SQL is exercised somewhere. Anything cron-related found in the
-- catalog is reported as a NOTICE for the log.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

do $$
declare
  v_jobs bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute 'select count(*) from cron.job where jobname in (''expire-stale-analysis-permits'', ''purge-expired-deletion-requests'', ''purge-old-webhook-events'')' into v_jobs;
    raise notice 'info: pg_cron installed; % of 3 maintenance jobs scheduled', v_jobs;
  else
    raise notice 'info: pg_cron NOT installed in this harness — schedules were skipped by the migration (hosted state UNKNOWN)';
  end if;
end $$;

-- Fixture: one fresh + one 25h-old reserved permit, one finalized old permit,
-- one expired + one live deletion request, one 91-day-old + one recent webhook event.
insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'fresh', 'reserved', now()),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'stale', 'reserved', now() - interval '25 hours'),
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-00000000000b', 'done',  'reserved', now() - interval '3 days');
update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = '00000000-0000-4000-8000-0000000000a3';

insert into public.account_deletion_requests (user_id, expires_at) values
  ('00000000-0000-4000-8000-00000000000a', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000000b', now() + interval '10 minutes');

insert into public.webhook_events (id, payload, received_at) values
  ('old', '{}', now() - interval '91 days'),
  ('new', '{}', now() - interval '1 day');

-- The three statements, verbatim from the migration (unescaped).
update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';
delete from public.account_deletion_requests where expires_at < now() - interval '1 day';
delete from public.webhook_events where received_at < now() - interval '90 days';

select pg_temp.check('sweep 1 expires only the stale reserved permit',
  (select string_agg(id::text || '=' || status || '/' || coalesce(outcome, '-'), ',' order by id) from public.analysis_permits)
  = '00000000-0000-4000-8000-0000000000a1=reserved/-,00000000-0000-4000-8000-0000000000a2=released/expired,00000000-0000-4000-8000-0000000000a3=finalized/scored');
select pg_temp.check('sweep 2 purges only the expired deletion request',
  (select string_agg(user_id::text, ',') from public.account_deletion_requests) = '00000000-0000-4000-8000-00000000000b');
select pg_temp.check('sweep 3 purges only the 90-day-old webhook event',
  (select string_agg(id, ',') from public.webhook_events) = 'new');

-- The lazy path the request handlers rely on when cron is absent: a stale
-- reserved permit neither counts nor can be consumed.
insert into public.analysis_permits (id, user_id, idempotency_key, status, created_at) values
  ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-00000000000b', 'stale-b', 'reserved', now() - interval '25 hours');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
select pg_temp.check('access_state ignores a 25h-old reserved permit', (select reserved_count from public.access_state()) = 0);
select pg_temp.check('apply_synced_shot refuses a 25h-old permit as access.permit_expired',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000a4', 'scored', 7.0)) = 'access.permit_expired');
select pg_temp.check('the expired permit was lazily released',
  (select status || '/' || outcome from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000a4') = 'released/expired');

select pg_temp.finish();
rollback;
