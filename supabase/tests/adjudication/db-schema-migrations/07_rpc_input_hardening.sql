-- Candidates reachable only by calling the RPCs directly (PostgREST with the
-- project publishable key + a user JWT), i.e. bypassing the Edge validator:
--   a. Date.parse-valid / Postgres-invalid capturedAt -> 'shot.write_failed:<sqlerrm>'
--      (mobile treats shot.write_failed as transient => retried forever)
--   b. malformed uuid / non-object payload -> raw SQL error instead of a status
--   c. no server-side cap on phases/checkpoints cardinality
--   d. detail rows attached to ANOTHER user's shot (FK check ignores RLS)
--   e. reserve_analysis_permit with null / empty / oversized idempotency key
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now()),
       ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-00000000000b', now());
select pg_temp.raw_shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-0000000000d2', 'scored', 6.0, now());

\echo '== 07a: capturedAt = 2026-02-30T00:00:00Z (Date.parse -> Mar 2; Postgres -> error) =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select result, permit_id from public.reserve_analysis_permit('k1') \gset p1_
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-02-30T00:00:00Z')) as status_feb30;
select status from public.analysis_permits where id = :'p1_permit_id';
select case when (select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-02-30T00:00:00Z'))) like 'shot.write_failed:%'
  then 'DEFECT_REPRODUCED 07a: deterministic bad capturedAt yields shot.write_failed:<sqlerrm> (retryable class, raw sqlerrm to direct callers)'
  else 'HELD 07a' end as verdict;
rollback;

\echo '== 07b: malformed inputs raise raw SQL errors rather than a closed status =='
\set ON_ERROR_ROLLBACK on
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
\echo '-- id not a uuid'
select public.apply_synced_shot('{"id":"nope","analysisPermitId":"00000000-0000-4000-8000-0000000000a1"}'::jsonb);
\echo '-- scalar json'
select public.apply_synced_shot('"str"'::jsonb);
\echo '-- null permit id'
select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e9"}'::jsonb) as null_permit_id;
\echo '-- reserve with null / empty / 10KB key'
select result from public.reserve_analysis_permit(null);
select result from public.reserve_analysis_permit('');
select result from public.reserve_analysis_permit(repeat('x', 10000));
select length(idempotency_key) as stored_key_len from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000000a' order by created_at desc limit 1;
rollback;

\echo '== 07c: 5000 phases on one shot through the RPC (no cardinality cap) =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select result, permit_id from public.reserve_analysis_permit('k2') \gset p2_
select public.apply_synced_shot(
  pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e6', :'p2_permit_id', '00000000-0000-4000-8000-0000000000d1', 'low_confidence', '2026-09-01T00:00:00Z')
  || jsonb_build_object('phases', (select jsonb_agg(jsonb_build_object('key', 'p' || g, 'startMs', g, 'representativeMs', g, 'endMs', g, 'confidence', 0.5)) from generate_series(1, 5000) g))
) as status_5000_phases;
select count(*) as phases_written from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e6';
select case when (select count(*) from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e6') = 5000
  then 'DEFECT_REPRODUCED 07c: RPC wrote 5000 phase rows for one shot (Edge caps at 32; RPC has no cap)'
  else 'HELD 07c' end as verdict;
rollback;

\echo '== 07d: alice attaches a phase row to BOB''s shot (RLS checks user_id only; FK ignores RLS) =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
insert into public.shot_phases (shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence)
values ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000000a', 'contact', 1, 2, 3, 0.5);
reset role;
select case when exists (select 1 from public.shot_phases where shot_id = '00000000-0000-4000-8000-0000000000e2' and user_id = '00000000-0000-4000-8000-00000000000a')
  then 'DEFECT_REPRODUCED 07d: alice-owned phase row now hangs off bob''s shot'
  else 'HELD 07d' end as verdict;
rollback;
