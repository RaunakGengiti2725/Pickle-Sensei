-- ============================================================================
-- X2 — the pg_cron sweep statements and time-skewed permits.
--
-- pg_cron is not installable in this throwaway container (the migration
-- logs "pg_cron unavailable" and skips scheduling), so the SCHEDULING is
-- UNVERIFIED here. What can be verified is the SQL each job runs, copied
-- verbatim from 20260831000000_scale_and_security.sql:361-377, executed as
-- the superuser pg_cron would use:
--
--   A. expire-stale-analysis-permits at scale: 100,000 background permits
--      (mostly finalized/released, 2% stale reserved) — the UPDATE must use
--      analysis_permits_reserved_created_idx (20260902130200), touch exactly
--      the stale reserved rows, and leave fresh reserved rows alone.
--   B. Lazy expiry on the request path: a permit reserved 25h ago is refused
--      by apply_synced_shot with access.permit_expired and released; the
--      same permit is invisible to access_state().reserved_count.
--   C. Clock skew: a permit whose created_at is 10 years in the FUTURE is
--      never swept (created_at < now() - 24h is never true), is counted by
--      reserved_count for ever, and so closes reserve_analysis_permit() for
--      its owner until it is deleted. Recorded as observed; the owner can
--      only create such a row against themselves (RLS), so this is
--      self-inflicted and NOT raised as a failure — the assertion is that
--      it still cannot produce a third rating.
--   D. purge-expired-deletion-requests / purge-old-webhook-events: the exact
--      statements run and remove only rows past their windows.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

create temporary table attack_failures (probe text, detail text);
create temporary table results (k text, v text);
grant all on attack_failures, results to authenticated;

select attack.new_user('00000000-0000-4000-8000-0000000000c2'::uuid, 'x2-owner@attack.example', 'apple', 'apple-sub-x2');

-- Background population: 1,000 users x 100 permits.
insert into auth.users (id, email)
select ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 'x2-bg-' || g || '@attack.example'
from generate_series(1, 1000) g;

insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
select u.id, 'x2-bg-' || p,
       case when p % 50 = 0 then 'reserved' when p % 3 = 0 then 'released' else 'finalized' end,
       case when p % 50 = 0 then null when p % 3 = 0 then 'low_confidence' else 'scored' end,
       now() - (p || ' hours')::interval
from auth.users u
cross join generate_series(1, 100) p
where u.email like 'x2-bg-%';
-- fresh reserved holds that must survive the sweep
insert into public.analysis_permits (user_id, idempotency_key, status, created_at)
select u.id, 'x2-fresh', 'reserved', now() - interval '1 hour'
from auth.users u where u.email like 'x2-bg-%' limit 100;
analyze public.analysis_permits;

insert into results select 'A stale reserved before', count(*)::text from public.analysis_permits
where status = 'reserved' and created_at < now() - interval '24 hours';
insert into results select 'A fresh reserved before', count(*)::text from public.analysis_permits
where status = 'reserved' and created_at >= now() - interval '24 hours';

create temporary table sweep_plan (line text);
do $$
declare r record;
begin
  for r in execute $q$
    explain (analyze, buffers)
    update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours'
  $q$ loop
    insert into sweep_plan values (r."QUERY PLAN");
  end loop;
end $$;

insert into results select 'A stale reserved after', count(*)::text from public.analysis_permits
where status = 'reserved' and created_at < now() - interval '24 hours';
insert into results select 'A fresh reserved after', count(*)::text from public.analysis_permits
where status = 'reserved' and created_at >= now() - interval '24 hours';
insert into results select 'A sweep used index', exists(select 1 from sweep_plan where line like '%analysis_permits_reserved_created_idx%')::text;
insert into results select 'A sweep seq scan', exists(select 1 from sweep_plan where line like '%Seq Scan on analysis_permits%')::text;
insert into results select 'A sweep timing', line from sweep_plan where line like 'Execution Time%';

-- B + C as the owner
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000c2';

insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-00000000c2f1', '00000000-0000-4000-8000-0000000000c2', 'x2-stale', now() - interval '25 hours'),
       ('00000000-0000-4000-8000-00000000c2f2', '00000000-0000-4000-8000-0000000000c2', 'x2-future', now() + interval '10 years');

insert into results select 'B/C reserved_count (stale + future hand-made)', reserved_count::text from public.access_state();
insert into results select 'B sync via 25h-old permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-00000000c2e1'::uuid, '00000000-0000-4000-8000-00000000c2f1'::uuid));
insert into results select 'B stale permit after', status || '/' || coalesce(outcome, 'null') from public.analysis_permits where id = '00000000-0000-4000-8000-00000000c2f1';
insert into results select 'C reserve with future permit held (0 scored)', result from public.reserve_analysis_permit('x2-r1');
insert into results select 'C sync via future permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-00000000c2e2'::uuid, '00000000-0000-4000-8000-00000000c2f2'::uuid));
-- future permit is now finalized; re-mint another future hold and try to go past 2
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-00000000c2f3', '00000000-0000-4000-8000-0000000000c2', 'x2-future-2', now() + interval '10 years'),
       ('00000000-0000-4000-8000-00000000c2f4', '00000000-0000-4000-8000-0000000000c2', 'x2-future-3', now() + interval '10 years');
insert into results select 'C sync 2 via future permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-00000000c2e3'::uuid, '00000000-0000-4000-8000-00000000c2f3'::uuid));
insert into results select 'C sync 3 via future permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-00000000c2e4'::uuid, '00000000-0000-4000-8000-00000000c2f4'::uuid));
reset role;

update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';
insert into results select 'C future permits surviving sweep', count(*)::text from public.analysis_permits
where user_id = '00000000-0000-4000-8000-0000000000c2' and status = 'reserved' and created_at > now();

-- D
insert into public.account_deletion_requests (user_id, created_at, expires_at)
values ('00000000-0000-4000-8000-0000000000c2', now() - interval '2 days', now() - interval '2 days');
insert into public.webhook_events (id, event_type, received_at, payload)
values ('x2-old', 'TEST', now() - interval '91 days', '{}'::jsonb),
       ('x2-new', 'TEST', now() - interval '1 day', '{}'::jsonb);
delete from public.account_deletion_requests where expires_at < now() - interval '1 day';
delete from public.webhook_events where received_at < now() - interval '90 days';
insert into results select 'D deletion requests left', count(*)::text from public.account_deletion_requests where user_id = '00000000-0000-4000-8000-0000000000c2';
insert into results select 'D webhook events left', string_agg(id, ',') from public.webhook_events where id like 'x2-%';

do $$
declare r record;
begin
  for r in select * from results loop
    raise notice 'OBSERVED % = %', r.k, r.v;
  end loop;
  for r in select * from sweep_plan loop
    raise notice 'PLAN %', r.line;
  end loop;

  if (select v from results where k = 'A stale reserved after') <> '0' then
    insert into attack_failures values ('X2-A', 'sweep left stale reserved permits behind');
  end if;
  if (select v from results where k = 'A fresh reserved before') <> (select v from results where k = 'A fresh reserved after') then
    insert into attack_failures values ('X2-A', 'sweep released FRESH reserved permits');
  end if;
  if (select v from results where k = 'A sweep used index') <> 'true' or (select v from results where k = 'A sweep seq scan') <> 'false' then
    insert into attack_failures values ('X2-A', 'stale-permit sweep did not use analysis_permits_reserved_created_idx on 100k rows');
  end if;
  if (select v from results where k = 'B sync via 25h-old permit') <> 'access.permit_expired'
     or (select v from results where k = 'B stale permit after') <> 'released/expired' then
    insert into attack_failures values ('X2-B', 'a 25h-old reserved permit was not lazily expired by apply_synced_shot');
  end if;
  if (select v from results where k = 'B/C reserved_count (stale + future hand-made)') <> '1' then
    insert into attack_failures values ('X2-B', format('reserved_count with one stale + one future permit = %s (expected 1: stale excluded, future counted)',
      (select v from results where k = 'B/C reserved_count (stale + future hand-made)')));
  end if;
  if (select v from results where k = 'C sync 3 via future permit') = 'accepted' then
    insert into attack_failures values ('X2-C', 'future-dated permits produced a third free rating');
  end if;
  if (select v from results where k = 'D deletion requests left') <> '0'
     or (select v from results where k = 'D webhook events left') <> 'x2-new' then
    insert into attack_failures values ('X2-D', 'purge statements did not remove exactly the expired rows');
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'X2 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo X2: HELD
