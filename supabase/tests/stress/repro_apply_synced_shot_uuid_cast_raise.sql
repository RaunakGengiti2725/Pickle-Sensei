-- Minimised repro (from stress seeds 1062866799 / 118713406 / 2007236762):
-- apply_synced_shot() casts id / analysisPermitId / sessionId to uuid BEFORE
-- its guarded write block, so a malformed identifier escapes as a raw
-- SQLSTATE 22P02 raise whose message quotes the client's bytes, instead of
-- the typed 'shot.write_failed:<SQLSTATE>' string the function documents.
--
-- Run against a disposable DB (see stress_pg_up.sh); never against hosted:
--   psql "$STRESS_PG_URL" -v ON_ERROR_STOP=0 -f repro_apply_synced_shot_uuid_cast_raise.sql
--
-- Expected today (BROKEN): three "ERROR:  invalid input syntax for type uuid: ..."
-- lines in the output, each echoing the payload value.
-- Expected once fixed: three rows 'shot.write_failed:22P02' (or a typed
-- 'shot.invalid_id' style status) and no ERROR lines.
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000c0de';

\echo '--- analysisPermitId: non-uuid string'
savepoint a;
select public.apply_synced_shot('{"analysisPermitId":"not-a-uuid"}'::jsonb);
rollback to savepoint a;

\echo '--- sessionId: wrong type (array)'
savepoint b;
select public.apply_synced_shot('{"sessionId":[]}'::jsonb);
rollback to savepoint b;

\echo '--- id: empty string'
savepoint c;
select public.apply_synced_shot('{"id":""}'::jsonb);
rollback to savepoint c;

\echo '--- control: no identifiers at all -> typed status, no raise'
select public.apply_synced_shot('{}'::jsonb);

rollback;
