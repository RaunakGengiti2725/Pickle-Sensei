-- ============================================================================
-- Scale stage: :scale_users users, each with a full "world" (every user table
-- populated) plus 10 permits at staggered ages and a deletion request.
-- Measures the cascade delete per user, the three pg_cron sweeps under
-- EXPLAIN (ANALYZE, BUFFERS), FK-index coverage for every cascade/set-null
-- path, heap sizes, and re-runs the orphan scan. Requires integrity_matrix.sql
-- to have run first (schema `it`). Fails loudly on any orphan.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;

create table if not exists it.scale (k text primary key, v jsonb not null);
create table if not exists it.scale_plans (k text primary key, v text not null);
create table if not exists it.scale_users (i int primary key, uid uuid not null, world jsonb);
create table if not exists it.scale_timings (i int primary key, delete_ms numeric not null, rows_before jsonb);

-- psql does not interpolate :variables inside dollar quotes → pass via a GUC.
select set_config('it.scale_users', :'scale_users', false);

-- Deterministic users: uid = md5('scale-user-' || i)::uuid, one Google identity each.
do $$
declare
  n int := current_setting('it.scale_users')::int;
  i int; uid uuid; t0 timestamptz := clock_timestamp(); w jsonb;
begin
  for i in 1..n loop
    uid := md5('scale-user-' || i)::uuid;
    insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
    values (uid, 'scale' || i || '@example.com', jsonb_build_object('full_name', 'Scale ' || i), '{"provider":"google"}');
    insert into auth.identities (provider, provider_id, user_id, identity_data)
    values ('google', 'scale-google-' || i, uid, jsonb_build_object('sub', 'scale-google-' || i));
    w := it.seed_world(uid, 'scale-' || i);
    insert into it.scale_users values (i, uid, w);
    -- 10 permits: 4 fresh reserved, 3 stale reserved (25h..27h), 2 finalized, 1 released
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
    select uid, 'scale-' || i || '-p' || k,
           case when k <= 7 then 'reserved' when k <= 9 then 'finalized' else 'released' end,
           case when k <= 7 then null when k <= 9 then 'scored' else 'cancelled' end,
           case when k <= 4 then now() - (k || ' hours')::interval
                when k <= 7 then now() - ((20 + k) || ' hours')::interval
                else now() - interval '10 days' end
    from generate_series(1, 10) k;
    -- deletion request: odd users expired 2 days ago (purgeable), even users live
    update public.account_deletion_requests
       set expires_at = case when i % 2 = 1 then now() - interval '2 days' else now() + interval '10 minutes' end,
           created_at = case when i % 2 = 1 then now() - interval '2 days 15 minutes' else now() end
     where user_id = uid;
  end loop;
  insert into public.webhook_events (id, payload, received_at)
  select 'scale-evt-' || k, jsonb_build_object('k', k),
         now() - ((k % 200) || ' days')::interval
  from generate_series(1, n * 5) k;
  insert into it.scale values ('seed', jsonb_build_object(
    'users', n, 'seed_ms', round(extract(epoch from clock_timestamp() - t0) * 1000, 1),
    'permits_per_user', 10, 'webhook_events', n * 5));
end $$;

-- Row counts + heap sizes before anything is deleted.
insert into it.scale
select 'rows_before', jsonb_object_agg(relname, cnt)
from (
  select c.relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint as cnt
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') x;
insert into it.scale
select 'heap_bytes_before', jsonb_object_agg(relname, jsonb_build_object(
  'total', pg_total_relation_size(c.oid), 'table', pg_relation_size(c.oid),
  'indexes', pg_indexes_size(c.oid)))
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';

-- FK index coverage: every FK child column that participates in CASCADE /
-- SET NULL needs an index or the parent delete seq-scans the child.
insert into it.scale
select 'fk_index_coverage', jsonb_agg(jsonb_build_object(
  'constraint', k.conname, 'child', k.conrelid::regclass::text, 'column', a.attname,
  'on_delete', case k.confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL' else k.confdeltype::text end,
  'indexed', exists (
    select 1 from pg_index ix
    where ix.indrelid = k.conrelid and ix.indkey[0] = a.attnum and ix.indpred is null)) order by k.conrelid::regclass::text, a.attname)
from pg_constraint k
join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
where k.contype = 'f' and k.connamespace in ('public'::regnamespace, 'auth'::regnamespace);

-- The three sweeps, verbatim, under EXPLAIN (ANALYZE, BUFFERS).
do $$
declare
  j record; r record; plan text; t0 timestamptz; ms numeric; n_before bigint; n_after bigint;
  v jsonb := '{}';
begin
  for j in select jobname, command from cron.job order by jobname loop
    plan := '';
    if j.jobname = 'expire-stale-analysis-permits' then
      select count(*) into n_before from public.analysis_permits where status = 'reserved';
    elsif j.jobname = 'purge-expired-deletion-requests' then
      select count(*) into n_before from public.account_deletion_requests;
    else
      select count(*) into n_before from public.webhook_events;
    end if;
    t0 := clock_timestamp();
    for r in execute 'explain (analyze, buffers, format text) ' || j.command loop
      plan := plan || r."QUERY PLAN" || E'\n';
    end loop;
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    if j.jobname = 'expire-stale-analysis-permits' then
      select count(*) into n_after from public.analysis_permits where status = 'reserved';
    elsif j.jobname = 'purge-expired-deletion-requests' then
      select count(*) into n_after from public.account_deletion_requests;
    else
      select count(*) into n_after from public.webhook_events;
    end if;
    insert into it.scale_plans values ('sweep:' || j.jobname, '-- ' || j.command || E'\n' || plan);
    v := v || jsonb_build_object(j.jobname, jsonb_build_object(
      'ms', round(ms, 2), 'rows_before', n_before, 'rows_after', n_after,
      'uses_index', plan ~ 'Index (Only )?Scan|Bitmap'));
  end loop;
  insert into it.scale values ('sweeps', v);
end $$;

-- Sweep correctness at scale: no fresh reserved permit flipped, every stale one did.
do $$
declare v jsonb;
begin
  select jsonb_build_object(
    'stale_reserved_left', (select count(*) from public.analysis_permits where status = 'reserved' and created_at < now() - interval '24 hours'),
    'fresh_reserved_left', (select count(*) from public.analysis_permits where status = 'reserved' and created_at >= now() - interval '24 hours'),
    'expired_total', (select count(*) from public.analysis_permits where status = 'released' and outcome = 'expired'),
    'expected_expired_from_scale', (select count(*) from it.scale_users) * 3,
    'deletion_requests_left', (select count(*) from public.account_deletion_requests where user_id in (select uid from it.scale_users)),
    'deletion_requests_expected_left', (select count(*) from it.scale_users where i % 2 = 0),
    'webhook_events_left', (select count(*) from public.webhook_events where id like 'scale-evt-%'),
    'webhook_events_expected_left', (select count(*) from generate_series(1, (select count(*)::int * 5 from it.scale_users)) k where (k % 200) < 90))
  into v;
  insert into it.scale values ('sweep_correctness', v);
  if (v ->> 'stale_reserved_left')::int <> 0 then
    raise exception 'scale: stale reserved permits survived the sweep: %', v;
  end if;
  if (v ->> 'deletion_requests_left')::int <> (v ->> 'deletion_requests_expected_left')::int then
    raise exception 'scale: deletion-request purge count mismatch: %', v;
  end if;
  if (v ->> 'webhook_events_left')::int <> (v ->> 'webhook_events_expected_left')::int then
    raise exception 'scale: webhook purge count mismatch: %', v;
  end if;
end $$;

-- Cascade delete of every odd user, one statement each (what auth.admin.deleteUser does), timed.
do $$
declare
  u record; t0 timestamptz; ms numeric; plan text; r record;
begin
  for u in select i, uid from it.scale_users where i % 2 = 1 order by i loop
    t0 := clock_timestamp();
    delete from auth.users where id = u.uid;
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    insert into it.scale_timings values (u.i, round(ms, 3), null);
  end loop;
  -- One more with the plan (user 2), to show the RI trigger costs.
  plan := '';
  for r in execute format('explain (analyze, buffers, format text) delete from auth.users where id = %L',
                          (select uid from it.scale_users where i = 2)) loop
    plan := plan || r."QUERY PLAN" || E'\n';
  end loop;
  insert into it.scale_plans values ('cascade:delete auth.users (user 2)', plan);
  delete from it.scale_timings where i = 2;
end $$;

insert into it.scale
select 'cascade_delete_ms', jsonb_build_object(
  'deleted_users', count(*),
  'min', min(delete_ms), 'p50', percentile_cont(0.5) within group (order by delete_ms),
  'p95', percentile_cont(0.95) within group (order by delete_ms), 'max', max(delete_ms),
  'total', sum(delete_ms))
from it.scale_timings;

-- Post-cascade state.
insert into it.scale
select 'rows_after', jsonb_object_agg(relname, cnt)
from (
  select c.relname, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint as cnt
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') x;

do $$
declare
  orphans jsonb := it.orphan_scan();
  deleted int := (select count(*) from it.scale_users where i % 2 = 1) + 1; -- + user 2 (plan run)
  leftover jsonb; ledger jsonb; summary text;
begin
  -- Any row still owned by a deleted scale user?
  select jsonb_object_agg(t, n) into leftover from (
    select 'sessions' t, count(*) n from public.sessions s where s.user_id in (select uid from it.scale_users where i % 2 = 1 or i = 2)
    union all select 'shots', count(*) from public.shots s where s.user_id in (select uid from it.scale_users where i % 2 = 1 or i = 2)
    union all select 'analysis_permits', count(*) from public.analysis_permits s where s.user_id in (select uid from it.scale_users where i % 2 = 1 or i = 2)
    union all select 'consent_records', count(*) from public.consent_records s where s.user_id in (select uid from it.scale_users where i % 2 = 1 or i = 2)
    union all select 'profiles', count(*) from public.profiles s where s.id in (select uid from it.scale_users where i % 2 = 1 or i = 2)
    union all select 'deletion_feedback_named', count(*) from public.account_deletion_feedback s where s.user_id in (select uid from it.scale_users where i % 2 = 1 or i = 2)
  ) x;
  select jsonb_build_object(
    'ledger_rows_for_scale_identities', count(*), 'sum_scored_count', coalesce(sum(scored_count), 0),
    'expected_rows', (select count(*) from it.scale_users))
  into ledger
  from public.free_rating_ledger
  where identity_hash in (select public.free_rating_identity_hash('google', 'scale-google-' || i) from it.scale_users);
  insert into it.scale values ('post_cascade', jsonb_build_object(
    'orphans', orphans, 'deleted_users', deleted, 'rows_still_owned_by_deleted_users', leftover,
    'anonymized_exit_surveys', (select count(*) from public.account_deletion_feedback where user_id is null),
    'ledger', ledger));
  if orphans <> '{}'::jsonb then
    raise exception 'scale: orphans after cascade: %', orphans;
  end if;
  if (select bool_or((value)::int > 0) from jsonb_each_text(leftover)) then
    raise exception 'scale: rows survived their owner''s deletion: %', leftover;
  end if;
  if (ledger ->> 'ledger_rows_for_scale_identities')::int <> (ledger ->> 'expected_rows')::int then
    raise exception 'scale: ledger rows did not survive: %', ledger;
  end if;
  summary := format('scale: users=%s deleted=%s cascade_p50=%sms cascade_p95=%sms cascade_max=%sms sweeps=%s orphans=%s ledger_rows=%s',
    (select count(*) from it.scale_users), deleted,
    (select v ->> 'p50' from it.scale where k = 'cascade_delete_ms'),
    (select v ->> 'p95' from it.scale where k = 'cascade_delete_ms'),
    (select v ->> 'max' from it.scale where k = 'cascade_delete_ms'),
    (select v from it.scale where k = 'sweeps'), orphans, ledger ->> 'ledger_rows_for_scale_identities');
  insert into it.scale values ('summary', jsonb_build_object('summary', summary));
end $$;

-- Cost of the un-indexed SET NULL paths: grow the two tables whose FK child
-- columns have no index, then time one more account deletion and one session
-- deletion. The RI triggers on those FKs must scan the whole child table.
do $$
declare
  n int := current_setting('it.scale_users')::int * 500;
  keeper uuid := (select uid from it.scale_users where i = 4);
  victim uuid := (select uid from it.scale_users where i = 6);
  victim_session uuid := (select (world ->> 'session')::uuid from it.scale_users where i = 6);
  r record; plan text; t0 timestamptz; ms_user numeric; ms_session numeric; v jsonb := '{}';
begin
  insert into public.account_deletion_feedback (user_id, reason, provider, platform, app_version)
  select null, 'other', 'google', 'ios', '1.0.0' from generate_series(1, n);
  insert into public.captures (id, user_id, session_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
  select md5('scale-capture-' || k)::uuid, keeper, null, null, now(), 1000, 30, 'imported_video', 'valid' from generate_series(1, n) k;
  analyze public.account_deletion_feedback; analyze public.captures;

  plan := '';
  t0 := clock_timestamp();
  for r in execute format('explain (analyze, buffers, format text) delete from public.sessions where id = %L', victim_session) loop
    plan := plan || r."QUERY PLAN" || E'\n';
  end loop;
  ms_session := extract(epoch from clock_timestamp() - t0) * 1000;
  insert into it.scale_plans values ('unindexed_fk:delete one session with ' || n || ' captures', plan);

  plan := '';
  t0 := clock_timestamp();
  for r in execute format('explain (analyze, buffers, format text) delete from auth.users where id = %L', victim) loop
    plan := plan || r."QUERY PLAN" || E'\n';
  end loop;
  ms_user := extract(epoch from clock_timestamp() - t0) * 1000;
  insert into it.scale_plans values ('unindexed_fk:delete one user with ' || n || ' exit surveys + captures', plan);

  v := jsonb_build_object(
    'extra_rows_each_table', n,
    'delete_session_ms', round(ms_session, 2),
    'delete_user_ms', round(ms_user, 2),
    'baseline_delete_user_p50_ms', (select s.v ->> 'p50' from it.scale s where s.k = 'cascade_delete_ms'),
    'trigger_times_ms', (
      select jsonb_object_agg(m[1], m[2]::numeric)
      from regexp_matches(plan, 'Trigger for constraint (\S+) on \S+: time=([0-9.]+)', 'g') m));
  insert into it.scale values ('unindexed_fk_cost', v);
  delete from it.scale_timings where i = 6;
end $$;

insert into it.scale
select 'heap_bytes_after', jsonb_object_agg(relname, jsonb_build_object(
  'total', pg_total_relation_size(c.oid), 'table', pg_relation_size(c.oid),
  'indexes', pg_indexes_size(c.oid)))
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r';
