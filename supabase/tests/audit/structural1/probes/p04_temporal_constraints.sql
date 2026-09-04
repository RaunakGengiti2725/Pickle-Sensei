-- P04 — Temporal invariants on client-writable rows.
--
-- Suspect: 20260829120000_progress_data.sql declares sessions.started_at/
-- ended_at and shots.captured_at/start_ms/contact_ms/end_ms with no CHECK on
-- ordering or range, and neither apply_synced_shot nor the edge validator
-- (index.ts:947-994 only bounds each ms value to [0, 2^31-1]) orders them.
-- Inverted windows and far-future captures land in progress_daily /
-- practice_days / rank inputs unchallenged.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

-- sessions: ended_at before started_at
insert into public.sessions (id, user_id, kind, started_at)
values ('00000000-0000-4000-8000-0000000000c1', auth.uid(), 'practice', '2026-08-31T10:00:00Z');
select pg_temp.check('sessions: ended_at earlier than started_at is refused',
  pg_temp.raises($q$update public.sessions set ended_at = '2026-08-30T10:00:00Z' where id = '00000000-0000-4000-8000-0000000000c1'$q$));

select permit_id as p1 from public.reserve_analysis_permit('key-1') \gset
select permit_id as p2 from public.reserve_analysis_permit('key-2') \gset

-- shots: end_ms < contact_ms < start_ms (fully inverted window)
select pg_temp.check('shots: inverted start/contact/end window is refused → ' ||
  pg_temp.rpc(format($q$select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', %L, 'scored', 7.1, '2026-08-31T10:00:00Z', 1000, 500, 0))$q$, :'p1')),
  pg_temp.rpc(format($q$select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', %L, 'scored', 7.1, '2026-08-31T10:00:00Z', 1000, 500, 0))$q$, :'p1')) <> 'accepted');

-- shots: captured_at in the year 2999 (still a valid timestamptz)
select pg_temp.check('shots: captured_at far in the future is refused → ' ||
  pg_temp.rpc(format($q$select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', %L, 'scored', 7.1, '2999-01-01T00:00:00Z'))$q$, :'p2')),
  pg_temp.rpc(format($q$select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', %L, 'scored', 7.1, '2999-01-01T00:00:00Z'))$q$, :'p2')) <> 'accepted');
select pg_temp.check('progress_daily has no row dated in 2999',
  not exists (select 1 from public.progress_daily where day >= date '2999-01-01'));

select pg_temp.finish();
rollback;
