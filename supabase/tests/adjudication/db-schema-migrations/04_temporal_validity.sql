-- Candidate: no temporal sanity constraints — far-future captured_at pins the
-- rank window (rn=1 forever), inverted/negative shot timings, ended_at before
-- started_at, infinity timestamps. Reachable through the canonical RPC (the
-- Edge fn only checks Date.parse) and through direct inserts.
\echo '== 04: constraints currently declared on shots/sessions =='
select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
from pg_constraint
where conrelid in ('public.shots'::regclass, 'public.sessions'::regclass) and contype = 'c'
order by 1, 2;

insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now());

\echo '== 04a: through apply_synced_shot(): capturedAt year 2999, then a real newer shot — which one leads the rank window? =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select result, permit_id from public.reserve_analysis_permit('k1') \gset p1_
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2999-01-01T00:00:00Z', 0, 500, 1000, 9.9)) as future_shot;
select result, permit_id from public.reserve_analysis_permit('k2') \gset p2_
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', :'p2_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-09-01T00:00:00Z', 0, 500, 1000, 2.0)) as real_shot;
select id, captured_at, overall_score from public.shots order by captured_at desc;
select rating, tier from public.player_rank_state where user_id = '00000000-0000-4000-8000-00000000000a';
select day, avg_score from public.progress_daily order by day;
select case when exists (select 1 from public.shots where captured_at > now() + interval '1 year')
  then 'DEFECT_REPRODUCED 04a: RPC accepted captured_at in 2999; it now sits at rn=1 (weight 8) of the rank window permanently'
  else 'HELD 04a' end as verdict;
rollback;

\echo '== 04b: through apply_synced_shot(): endMs < startMs, negative contactMs =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select result, permit_id from public.reserve_analysis_permit('k1') \gset p1_
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e3', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-09-01T00:00:00Z', 5000, -300, 10)) as inverted_ms;
select id, start_ms, contact_ms, end_ms from public.shots where id = '00000000-0000-4000-8000-0000000000e3';
select case when exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000e3' and end_ms < start_ms)
  then 'DEFECT_REPRODUCED 04b: RPC stored start_ms=5000 contact_ms=-300 end_ms=10'
  else 'HELD 04b' end as verdict;
rollback;

\echo '== 04c: direct: session ended_at < started_at, infinity captured_at =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
insert into public.sessions (id, user_id, started_at, ended_at)
values ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-00000000000a', '2026-09-01T10:00:00Z', '2026-09-01T09:00:00Z');
select id, started_at, ended_at from public.sessions where id = '00000000-0000-4000-8000-0000000000d3';
select pg_temp.raw_shot('00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-0000000000d1', 'scored', 5.0, 'infinity'::timestamptz);
select id, captured_at from public.shots where id = '00000000-0000-4000-8000-0000000000e5';
select day from public.progress_daily;
select case when exists (select 1 from public.sessions where id = '00000000-0000-4000-8000-0000000000d3')
  then 'DEFECT_REPRODUCED 04c: sessions accepted ended_at < started_at'
  else 'HELD 04c' end as verdict;
rollback;
