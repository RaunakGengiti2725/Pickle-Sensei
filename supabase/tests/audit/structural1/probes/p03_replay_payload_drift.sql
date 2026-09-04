-- P03 — Idempotent replay by shot id is scoped to the ORIGINAL permit.
--
-- Suspect: 20260902150000_free_rating_identity_ledger.sql:391-393 returns
-- 'accepted' whenever this user already owns the shot id, before the permit
-- named in the payload is looked at. A re-sync that (through a client bug or
-- a crafted payload) names a DIFFERENT still-reserved permit is acknowledged
-- although that permit was neither consumed nor released — it keeps occupying
-- an allowance slot until the 24h expiry. index.ts:1203-1226 short-circuits
-- the same way, so the behaviour is consistent across layers; the probe pins
-- what the DB contract is today.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

select permit_id as p1 from public.reserve_analysis_permit('key-1') \gset
select permit_id as p2 from public.reserve_analysis_permit('key-2') \gset

select pg_temp.check('first sync accepted',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1', 'scored', 7.1)) = 'accepted');

-- Exact replay: must be accepted and must not change anything.
select pg_temp.check('exact replay accepted',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1', 'scored', 7.1)) = 'accepted');
select pg_temp.check('exact replay leaves one shot row',
  (select count(*) from public.shots where id = '00000000-0000-4000-8000-0000000000e1') = 1);

-- Drifted replay: same id, different (reserved) permit, different kind/score.
select pg_temp.check('replay naming a different reserved permit is NOT blindly accepted',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p2', 'low_confidence', null)) <> 'accepted');
select pg_temp.check('the other permit is still reserved (not consumed, not released) — slot leak until expiry',
  (select status from public.analysis_permits where id = :'p2') = 'reserved');

-- Garbage replay (only the id is meaningful) — accepted on the id alone.
select pg_temp.check('replay with no permit / no fields is NOT blindly accepted',
  public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e1"}') <> 'accepted');

-- Stored row is untouched by drift (the good half of the contract).
select pg_temp.check('stored shot keeps original result_kind/score',
  (select result_kind || '/' || overall_score from public.shots where id = '00000000-0000-4000-8000-0000000000e1') = 'scored/7.10');

select pg_temp.finish();
rollback;
