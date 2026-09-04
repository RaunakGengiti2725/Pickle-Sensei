-- pg_cron stand-in for the throwaway integrity harness.
--
-- The official postgres:16 image ships without pg_cron, so the guarded
-- `do $cron$` block at the end of 20260831000000_scale_and_security.sql would
-- skip scheduling and the sweep SQL would never be exercised. This stub makes
-- the migration take its real path: a `cron` schema whose `schedule()`
-- records (name, schedule, command) into `cron.job` — the same columns
-- pg_cron exposes — plus a catalog row so `pg_extension` reports pg_cron as
-- installed. The harness later executes each recorded `command` verbatim, so
-- the sweep text under test is exactly what production schedules, never a
-- copy typed into the test.
--
-- Throwaway database only. Never apply to a real project.
create schema if not exists cron;

create table if not exists cron.job (
  jobid bigserial primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  scheduled_at timestamptz not null default now()
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (job_name, schedule, command)
  on conflict (jobname) do update
    set schedule = excluded.schedule,
        command = excluded.command,
        scheduled_at = now()
  returning jobid into v_id;
  return v_id;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    insert into pg_extension
      (oid, extname, extowner, extnamespace, extrelocatable, extversion, extconfig, extcondition)
    values (
      pg_catalog.pg_nextoid('pg_catalog.pg_extension'::regclass, 'oid',
                            'pg_catalog.pg_extension_oid_index'::regclass),
      'pg_cron',
      (select oid from pg_roles where rolname = current_user),
      (select oid from pg_namespace where nspname = 'cron'),
      false,
      'harness-stub',
      null,
      null
    );
  end if;
end $$;
