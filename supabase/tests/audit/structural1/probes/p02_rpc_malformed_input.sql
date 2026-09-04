-- P02 — RPC error contract: apply_synced_shot / reserve_analysis_permit return
-- a status string for every client-shaped input instead of raising.
--
-- Suspect: 20260902150000_free_rating_identity_ledger.sql:384-386 casts
-- id/analysisPermitId/sessionId to uuid BEFORE the guarded write block
-- (:450-534), and reserve_analysis_permit(:241-355) inserts the key without
-- bounds handling — so malformed ids / null / >128-char keys surface as
-- exceptions (the edge maps those to a generic 5xx "shot.write_failed"
-- instead of a 4xx validation code). The edge validates first
-- (index.ts:966-977, 741-747), so this is a DB-contract gap, not a live
-- outage.
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

select pg_temp.check('apply_synced_shot: malformed id returns a status, not an exception → ' ||
  pg_temp.rpc($q$select public.apply_synced_shot('{"id":"not-a-uuid","analysisPermitId":"00000000-0000-4000-8000-0000000000a1","resultKind":"scored"}')$q$),
  pg_temp.rpc($q$select public.apply_synced_shot('{"id":"not-a-uuid","analysisPermitId":"00000000-0000-4000-8000-0000000000a1","resultKind":"scored"}')$q$) not like 'RAISED%');

select pg_temp.check('apply_synced_shot: malformed analysisPermitId returns a status → ' ||
  pg_temp.rpc($q$select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e1","analysisPermitId":"xyz","resultKind":"scored"}')$q$),
  pg_temp.rpc($q$select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e1","analysisPermitId":"xyz","resultKind":"scored"}')$q$) not like 'RAISED%');

select pg_temp.check('apply_synced_shot: malformed sessionId returns a status → ' ||
  pg_temp.rpc($q$select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e1","analysisPermitId":"00000000-0000-4000-8000-0000000000a1","sessionId":"zzz","resultKind":"scored"}')$q$),
  pg_temp.rpc($q$select public.apply_synced_shot('{"id":"00000000-0000-4000-8000-0000000000e1","analysisPermitId":"00000000-0000-4000-8000-0000000000a1","sessionId":"zzz","resultKind":"scored"}')$q$) not like 'RAISED%');

-- Missing fields are handled (documents the contract that DOES hold).
select pg_temp.check('apply_synced_shot: empty object → access.permit_not_found',
  pg_temp.rpc($q$select public.apply_synced_shot('{}')$q$) = 'access.permit_not_found');

select pg_temp.check('reserve_analysis_permit: null key returns a status → ' ||
  pg_temp.rpc($q$select result from public.reserve_analysis_permit(null)$q$),
  pg_temp.rpc($q$select result from public.reserve_analysis_permit(null)$q$) not like 'RAISED%');

select pg_temp.check('reserve_analysis_permit: 300-char key returns a status → ' ||
  pg_temp.rpc($q$select result from public.reserve_analysis_permit(repeat('k', 300))$q$),
  pg_temp.rpc($q$select result from public.reserve_analysis_permit(repeat('k', 300))$q$) not like 'RAISED%');

-- Edge rejects blank keys (index.ts:742); the RPC itself mints a permit for them.
select pg_temp.check('reserve_analysis_permit: blank key is refused by the RPC → ' ||
  pg_temp.rpc($q$select result from public.reserve_analysis_permit('   ')$q$),
  pg_temp.rpc($q$select result from public.reserve_analysis_permit('   ')$q$) <> 'accepted');

select pg_temp.finish();
rollback;
