-- P09 — shots.overall_score is "null exactly when result_kind='low_confidence'"
-- (the column comment at 20260829120000_progress_data.sql:79).
--
-- Suspect: the only CHECK (scored_shots_have_scores, :86-87) enforces the
-- scored half; an abstention carrying a score is stored verbatim. Views and
-- rank filter on result_kind so quota/rank are unaffected — this pins the
-- gap between the documented invariant and the constraint.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select permit_id as p1 from public.reserve_analysis_permit('key-1') \gset

select pg_temp.rpc(format($q$select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', %L, 'low_confidence', 9.5))$q$, :'p1')) as status \gset

select pg_temp.check('low_confidence shot with a non-null overall_score is refused → ' || :'status', :'status' <> 'accepted');
select pg_temp.check('no abstention row carries a score',
  not exists (select 1 from public.shots where result_kind = 'low_confidence' and overall_score is not null));

-- The parts that hold regardless (documents the safety net).
select pg_temp.check('abstention released its permit (or never consumed it)',
  (select status from public.analysis_permits where id = :'p1') in ('released', 'reserved'));
select pg_temp.check('abstention never counts as a free rating', public.lifetime_scored_count() = 0);
select pg_temp.check('abstention never reaches progress_daily', not exists (select 1 from public.progress_daily));
select pg_temp.check('abstention never creates a rank row', not exists (select 1 from public.player_rank_state));

select pg_temp.finish();
rollback;
