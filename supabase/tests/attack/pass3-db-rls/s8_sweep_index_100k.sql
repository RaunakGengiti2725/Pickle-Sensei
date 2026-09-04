-- S8: with 100k finalized permits on the table, the pg_cron stale-permit sweep
-- (20260831000000_scale_and_security.sql) must plan through the partial index
-- analysis_permits_reserved_created_idx, and executing the sweep must flip
-- ONLY reserved rows older than 24 h to released/expired.
--
-- Seeded reserved rows: 25 old (25..49 h), 25 fresh (0..23 h), plus one at
-- exactly the 24 h boundary minus 1 s (must stay) and one at 24 h + 1 s
-- (must flip). Runs in one transaction and rolls back.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _seed_alice.sql

-- 100k finalized permits spread across the last 400 days.
insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
select '00000000-0000-4000-8000-00000000000a',
       'bulk-' || g,
       'finalized',
       (array['scored','low_confidence','cancelled'])[1 + (g % 3)],
       now() - (g * interval '5 minutes')
from generate_series(1, 100000) g;

-- Reserved rows: 25 old, 25 fresh, two boundary rows (Bob owns the fresh ones
-- so the sweep is visibly cross-user).
insert into public.analysis_permits (user_id, idempotency_key, created_at)
select '00000000-0000-4000-8000-00000000000a', 'old-' || g,
       now() - interval '25 hours' - (g * interval '1 hour')
from generate_series(0, 24) g;
insert into public.analysis_permits (user_id, idempotency_key, created_at)
select '00000000-0000-4000-8000-00000000000b', 'fresh-' || g,
       now() - (g * interval '1 hour')
from generate_series(0, 23) g;
insert into public.analysis_permits (user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-00000000000b', 'boundary-stay', now() - interval '24 hours' + interval '1 second'),
       ('00000000-0000-4000-8000-00000000000a', 'boundary-flip', now() - interval '24 hours' - interval '1 second');

analyze public.analysis_permits;

-- Plan artifact (printed): the exact pg_cron sweep statement.
\pset format unaligned
\pset tuples_only on
explain (format json)
update public.analysis_permits
set status = 'released', outcome = 'expired'
where status = 'reserved'
  and created_at < now() - interval '24 hours';
\pset tuples_only off
\pset format aligned

do $$
declare
  v_total int; v_reserved int; v_plan jsonb; v_plan_text text;
  v_flipped int; v_stay_reserved int; v_old_left int;
  v_wrong_outcome int; v_finalized_after int;
  t0 timestamptz; t1 timestamptz;
begin
  select count(*), count(*) filter (where status = 'reserved')
    into v_total, v_reserved from public.analysis_permits;
  raise notice 'RESULT S8: rows total=% reserved=%', v_total, v_reserved;
  if v_total < 100050 then
    raise exception 'S8 setup: expected >= 100050 permits, got %', v_total;
  end if;

  -- The exact sweep statement pg_cron schedules, as EXPLAIN (FORMAT JSON).
  execute $q$
    explain (format json)
    update public.analysis_permits
    set status = 'released', outcome = 'expired'
    where status = 'reserved'
      and created_at < now() - interval '24 hours'
  $q$ into v_plan;
  v_plan_text := v_plan::text;
  raise notice 'RESULT S8: plan node=% index=%',
    v_plan -> 0 -> 'Plan' -> 'Plans' -> 0 ->> 'Node Type',
    v_plan -> 0 -> 'Plan' -> 'Plans' -> 0 ->> 'Index Name';
  if position('analysis_permits_reserved_created_idx' in v_plan_text) = 0 then
    raise exception 'S8: BROKEN sweep plan does not use analysis_permits_reserved_created_idx: %', v_plan_text;
  end if;
  if position('Seq Scan' in v_plan_text) > 0 then
    raise exception 'S8: BROKEN sweep plan contains a Seq Scan over 100k rows: %', v_plan_text;
  end if;
  raise notice 'RESULT S8: HELD sweep plans through analysis_permits_reserved_created_idx';

  -- Execute the sweep for real.
  t0 := clock_timestamp();
  update public.analysis_permits
  set status = 'released', outcome = 'expired'
  where status = 'reserved'
    and created_at < now() - interval '24 hours';
  get diagnostics v_flipped = row_count;
  t1 := clock_timestamp();
  raise notice 'RESULT S8: sweep flipped % rows in % ms', v_flipped,
    round(extract(epoch from (t1 - t0)) * 1000, 1);

  -- Exactly the 25 old + boundary-flip rows.
  if v_flipped <> 26 then
    raise exception 'S8: BROKEN sweep flipped % rows, expected 26', v_flipped;
  end if;
  select count(*) into v_stay_reserved from public.analysis_permits
  where status = 'reserved';
  if v_stay_reserved <> 25 then
    raise exception 'S8: BROKEN % rows still reserved, expected 25 (24 fresh + boundary-stay)', v_stay_reserved;
  end if;
  if not exists (select 1 from public.analysis_permits
                 where idempotency_key = 'boundary-stay' and status = 'reserved') then
    raise exception 'S8: BROKEN boundary-stay (24h - 1s) was swept';
  end if;
  if not exists (select 1 from public.analysis_permits
                 where idempotency_key = 'boundary-flip' and status = 'released' and outcome = 'expired') then
    raise exception 'S8: BROKEN boundary-flip (24h + 1s) was not swept';
  end if;
  select count(*) into v_old_left from public.analysis_permits
  where status = 'reserved' and created_at < now() - interval '24 hours';
  if v_old_left <> 0 then
    raise exception 'S8: BROKEN % stale reserved rows survived the sweep', v_old_left;
  end if;
  select count(*) into v_wrong_outcome from public.analysis_permits
  where status = 'released' and outcome <> 'expired';
  if v_wrong_outcome <> 0 then
    raise exception 'S8: BROKEN sweep released rows with a non-expired outcome';
  end if;
  select count(*) into v_finalized_after from public.analysis_permits
  where status = 'finalized';
  if v_finalized_after <> 100000 then
    raise exception 'S8: BROKEN finalized rows changed (%)', v_finalized_after;
  end if;
  raise notice 'RESULT S8: HELD only reserved rows older than 24h flipped to released/expired (finalized untouched)';

  -- Idempotence: a second sweep is a no-op.
  update public.analysis_permits
  set status = 'released', outcome = 'expired'
  where status = 'reserved'
    and created_at < now() - interval '24 hours';
  get diagnostics v_flipped = row_count;
  if v_flipped <> 0 then
    raise exception 'S8: BROKEN second sweep flipped % rows', v_flipped;
  end if;
  raise notice 'RESULT S8: HELD second sweep is a no-op';
end $$;

-- S8b: access math after the sweep — Alice's swept permits no longer count as
-- holds (reserved_count = 0) and Bob's fresh ones still do.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare a record;
begin
  select * into a from public.access_state();
  raise notice 'RESULT S8b: alice after sweep scored_count=% reserved_count=%', a.scored_count, a.reserved_count;
  if a.reserved_count <> 0 then
    raise exception 'S8b: BROKEN swept permits still count as holds (%)', a.reserved_count;
  end if;
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
declare a record;
begin
  select * into a from public.access_state();
  raise notice 'RESULT S8b: bob after sweep reserved_count=%', a.reserved_count;
  if a.reserved_count <> 25 then
    raise exception 'S8b: BROKEN fresh holds miscounted (%)', a.reserved_count;
  end if;
end $$;
reset role;

rollback;
\echo S8 DONE
