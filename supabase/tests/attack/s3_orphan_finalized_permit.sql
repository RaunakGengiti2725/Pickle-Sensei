-- ============================================================================
-- S3 — a permit that claims to be scored, with no shot behind it.
--
-- RLS lets the owner INSERT any analysis_permits row (insert_own policy; the
-- column grant covers status and outcome). If any decision point counted
-- permits with outcome='scored' instead of scored SHOTS, the owner could
-- (a) burn their own allowance, or, worse, a stale client could make the
-- ledger drift. The identity ledger and lifetime_scored_count() must ignore
-- permits entirely.
--
--   A. Owner inserts status='finalized', outcome='scored' with no shot.
--      access_state().scored_count, lifetime_scored_count() and every
--      free_rating_ledger row for the identity must be unchanged.
--   B. Same, but the permit is inserted BEFORE the first real scored sync;
--      the real sync must then land as scored shot #1 (ledger = 1), i.e. the
--      orphan permit never counted as a rating.
--   C. Unusual: 50 orphan finalized/scored permits in one statement +
--      one with an oversized/unicode outcome text (size cap is NOT VALID, so
--      it must still fire for new rows).
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

select attack.new_user('00000000-0000-4000-8000-0000000000a3'::uuid, 's3-owner@attack.example', 'apple', 'apple-sub-s3');

create temporary table attack_failures (probe text, detail text);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';

create temporary table snap as
select 'before' as label,
       (select scored_count from public.access_state()) as scored_count,
       (select reserved_count from public.access_state()) as reserved_count,
       public.lifetime_scored_count() as lifetime;

-- A
insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
values ('00000000-0000-4000-8000-0000000000a3', 's3-orphan-1', 'finalized', 'scored');

insert into snap
select 'after_orphan',
       (select scored_count from public.access_state()),
       (select reserved_count from public.access_state()),
       public.lifetime_scored_count();

-- C: bulk + unicode + oversized outcome
insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
select '00000000-0000-4000-8000-0000000000a3', 's3-bulk-' || g, 'finalized', 'scored'
from generate_series(1, 50) g;

do $$
begin
  insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
  values ('00000000-0000-4000-8000-0000000000a3', 's3-unicode', 'finalized',
          repeat('得点🏓', 20)); -- 60 chars > 50 cap
  insert into attack_failures values ('S3-C', 'outcome longer than 50 chars was accepted (analysis_permits_key_bounds not enforced)');
exception when check_violation then
  perform attack.note('S3-C oversized unicode outcome', 'rejected by analysis_permits_key_bounds (expected)');
end $$;

insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
values ('00000000-0000-4000-8000-0000000000a3', 's3-unicode-ok', 'finalized', '得点🏓');

insert into snap
select 'after_bulk',
       (select scored_count from public.access_state()),
       (select reserved_count from public.access_state()),
       public.lifetime_scored_count();

-- B: the real path still hands out rating #1.
create temporary table results (k text primary key, v text);
insert into results
select 'reserve_result', result from public.reserve_analysis_permit('s3-real-1');
insert into results
select 'permit_id', id::text from public.analysis_permits
where user_id = '00000000-0000-4000-8000-0000000000a3' and idempotency_key = 's3-real-1';
insert into results
select 'sync_1', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e3'::uuid,
  (select v::uuid from results where k = 'permit_id')));

insert into snap
select 'after_real_sync',
       (select scored_count from public.access_state()),
       (select reserved_count from public.access_state()),
       public.lifetime_scored_count();

reset role;

do $$
declare
  r record;
  v_ledger int;
begin
  for r in select * from snap loop
    raise notice 'OBSERVED % scored_count=% reserved_count=% lifetime=%',
      r.label, r.scored_count, r.reserved_count, r.lifetime;
  end loop;

  select coalesce(max(l.scored_count), 0) into v_ledger
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = '00000000-0000-4000-8000-0000000000a3';
  raise notice 'OBSERVED free_rating_ledger(identity) after everything = %', v_ledger;
  raise notice 'OBSERVED reserve_result=% sync_1=% permits(finalized/scored)=%',
    (select v from results where k = 'reserve_result'),
    (select v from results where k = 'sync_1'),
    (select count(*) from public.analysis_permits
     where user_id = '00000000-0000-4000-8000-0000000000a3'
       and status = 'finalized' and outcome = 'scored');

  if (select scored_count from snap where label = 'after_orphan') <> 0
     or (select lifetime from snap where label = 'after_orphan') <> 0 then
    insert into attack_failures values ('S3-A', 'an orphan finalized/scored permit moved scored_count/lifetime_scored_count');
  end if;
  if (select scored_count from snap where label = 'after_bulk') <> 0 then
    insert into attack_failures values ('S3-C', '51 orphan permits moved scored_count');
  end if;
  if (select v from results where k = 'reserve_result') <> 'accepted'
     or (select v from results where k = 'sync_1') <> 'accepted' then
    insert into attack_failures values ('S3-B', format(
      'real reserve/sync after orphan permits: reserve=%s sync=%s (expected accepted/accepted)',
      (select v from results where k = 'reserve_result'),
      (select v from results where k = 'sync_1')));
  end if;
  if (select scored_count from snap where label = 'after_real_sync') <> 1 or v_ledger <> 1 then
    insert into attack_failures values ('S3-B', format(
      'after one real scored sync: scored_count=%s ledger=%s (expected 1/1)',
      (select scored_count from snap where label = 'after_real_sync'), v_ledger));
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'S3 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo S3: HELD
