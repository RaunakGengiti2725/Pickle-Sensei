-- P01 — analysis_permits lifecycle is a state machine (reserved -> finalized |
-- released), and a permit is consumed by AT MOST ONE shot.
--
-- Suspect: 20260831160000_defense_in_depth.sql:66 grants UPDATE (status,
-- outcome) to authenticated with only the enum CHECK from
-- 20260829140000_permits_sync_consent.sql:39-41 — no transition constraint,
-- no trigger. An owner can reopen a finalized permit and sync a second scored
-- shot against it (the lifetime backstop still caps the total at 2).
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

select permit_id as p1 from public.reserve_analysis_permit('key-1') \gset
select permit_id as p2 from public.reserve_analysis_permit('key-2') \gset

-- Consume the permit with a scored shot; it must now be finalized/scored.
select pg_temp.check('scored sync accepted',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1', 'scored', 7.1)) = 'accepted');
select pg_temp.check('permit finalized by sync',
  (select status || '/' || outcome from public.analysis_permits where id = :'p1') = 'finalized/scored');

-- INVARIANT 1: a finalized permit cannot be moved back to reserved by its owner.
select pg_temp.check('owner cannot reopen finalized permit (finalized -> reserved)',
  pg_temp.raises(format('update public.analysis_permits set status = %L, outcome = null where id = %L', 'reserved', :'p1')));

-- INVARIANT 2: even if reopened, the permit must not admit a second scored shot.
update public.analysis_permits set status = 'reserved', outcome = null where id = :'p1';
select pg_temp.check('second scored shot on the same permit is refused',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', :'p1', 'scored', 6.5)) <> 'accepted');
select pg_temp.check('exactly one scored shot exists for the permit holder',
  (select count(*) from public.shots where user_id = auth.uid() and result_kind = 'scored') = 1);

-- INVARIANT 3: outcome is a closed vocabulary (scored|low_confidence|expired|free_limit_exceeded).
select pg_temp.check('owner cannot write an arbitrary outcome string',
  pg_temp.raises(format('update public.analysis_permits set status = %L, outcome = %L where id = %L', 'released', 'whatever_i_like', :'p1')));

-- INVARIANT 4: an owner cannot mark a permit finalized/scored without any shot.
select pg_temp.check('owner cannot finalize a permit with no shot behind it',
  pg_temp.raises(format('update public.analysis_permits set status = %L, outcome = %L where id = %L', 'finalized', 'scored', :'p2')));

select pg_temp.finish();
rollback;
