-- Adversarial probe for W11-03 on a pg_cron-capable database: the scheduled
-- job really executes api_private.sweep_stale_analysis_permits() from a
-- pg_cron worker session (no API proof, no JWT, scheduling user) and moves
-- exactly the stale reserved permits.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/attack_w11_03_cron.sql
--
-- Requires: shared_preload_libraries=pg_cron, cron.database_name = this
-- database, shim_auth.sql + every migration applied. Runs in autocommit
-- because the cron worker is a separate session; cleans up after itself.
-- Attack A7:
--   1. exactly one job 'expire-stale-analysis-permits' exists, active, owned
--      by the function owner, whose command is exactly the select of the
--      sweep (the 20260831000000 anonymous UPDATE was unscheduled, not
--      duplicated).
--   2. a copy of that job's command scheduled every 5 seconds runs to
--      'succeeded' from the worker and releases the stale permit while the
--      live one stays reserved.

\set ON_ERROR_STOP on

do $$
declare j record; owner text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'A7 precondition: pg_cron is not installed in this database';
  end if;
  if current_setting('cron.database_name') <> current_database() then
    raise exception 'A7 precondition: cron.database_name (%) must be this database (%)', current_setting('cron.database_name'), current_database();
  end if;
  if (select count(*) from cron.job where jobname = 'expire-stale-analysis-permits') <> 1 then
    raise exception 'A7: exactly one expire-stale-analysis-permits job (got %)', (select count(*) from cron.job where jobname = 'expire-stale-analysis-permits');
  end if;
  select * into j from cron.job where jobname = 'expire-stale-analysis-permits';
  select r.rolname into owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
  where n.nspname = 'api_private' and p.proname = 'sweep_stale_analysis_permits';
  if j.command <> 'select api_private.sweep_stale_analysis_permits()' or not j.active or j.username <> owner
     or j.database <> current_database() or j.schedule <> '17 * * * *' then
    raise exception 'A7: job shape (command %, active %, username %, owner %, database %, schedule %)',
      j.command, j.active, j.username, owner, j.database, j.schedule;
  end if;
  if exists (select 1 from cron.job where command ilike '%update public.analysis_permits%') then
    raise exception 'A7: the anonymous UPDATE sweep must no longer be scheduled';
  end if;
end $$;

delete from auth.users where id = '00000000-0000-4000-8000-00000000a091';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000a091', 'ari@example.com', '{"full_name":"Ari"}', '{"provider":"google"}');
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000a901', '00000000-0000-4000-8000-00000000a091', 'a7-stale', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000a902', '00000000-0000-4000-8000-00000000a091', 'a7-live', now());

-- the launcher only sees a committed cron.job row, so the schedule is its
-- own statement; the poll runs in the next one
select cron.schedule('atk-w1103-sweep', '5 seconds',
  (select command from cron.job where jobname = 'expire-stale-analysis-permits'));
do $$
declare
  v_jobid bigint := (select jobid from cron.job where jobname = 'atk-w1103-sweep');
  waited integer := 0; run record; stale record; live record;
begin
  while waited < 90 loop
    perform pg_sleep(1);
    waited := waited + 1;
    select d.status, d.return_message into run
    from cron.job_run_details d where d.jobid = v_jobid and d.status in ('succeeded', 'failed')
    order by d.start_time limit 1;
    exit when run.status is not null;
  end loop;
  perform cron.unschedule(v_jobid);
  if run.status is distinct from 'succeeded' then
    raise exception 'A7: the scheduled sweep must run to succeeded from the cron worker within 90s (got %, %)', run.status, run.return_message;
  end if;
  select p.status, p.outcome into stale from public.analysis_permits p where p.id = '00000000-0000-4000-8000-00000000a901';
  select p.status, p.outcome into live from public.analysis_permits p where p.id = '00000000-0000-4000-8000-00000000a902';
  if stale.status <> 'released' or stale.outcome <> 'expired' or live.status <> 'reserved' or live.outcome is not null then
    raise exception 'A7: the worker run releases the stale permit and leaves the live one (got %/%, %/%)',
      stale.status, stale.outcome, live.status, live.outcome;
  end if;
end $$;

delete from auth.users where id = '00000000-0000-4000-8000-00000000a091';
delete from cron.job_run_details where jobid not in (select jobid from cron.job);
\echo W11-03 ATTACK A7 (pg_cron live run): NO BREAK REPRODUCED
