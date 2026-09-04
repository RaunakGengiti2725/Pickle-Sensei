-- P06 — apply_synced_shot's failure status is a closed code, not raw sqlerrm.
--
-- Suspect: 20260902150000_free_rating_identity_ledger.sql:533 returns
-- 'shot.write_failed:' || sqlerrm, so constraint/relation names and the
-- offending values travel to the edge function. index.ts:1268-1275 logs the
-- string and answers the client with a generic body, so nothing reaches the
-- device today — but the RPC is directly callable by any authenticated JWT
-- (PostgREST /rpc/apply_synced_shot), so the leak is one hop away.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select permit_id as p1 from public.reserve_analysis_permit('key-1') \gset

-- A checkpoint band outside the CHECK vocabulary makes the detail insert fail.
select public.apply_synced_shot(
  jsonb_set(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1', 'scored', 7.1),
            '{checkpoints,0,band}', '"purple"')) as status \gset

select pg_temp.check('failed write is refused (status starts with shot.write_failed)', :'status' like 'shot.write_failed%');
select pg_temp.check('failed write leaves no shot row (atomic)',
  not exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000e1'));
select pg_temp.check('failed write leaves the permit reserved (retryable)',
  (select status from public.analysis_permits where id = :'p1') = 'reserved');
select pg_temp.check('status is a closed code — carries no relation/constraint names → ' || :'status',
  :'status' not like '%shot_checkpoints%' and :'status' not like '%violates%');

select pg_temp.finish();
rollback;
