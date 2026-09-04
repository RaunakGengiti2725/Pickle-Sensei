-- ============================================================================
-- S6 — one permit, two scored shots.
--
-- A permit is meant to be the one-time authority for exactly one analysis:
-- reserve → sync → finalized. The owner holds UPDATE on status/outcome, so a
-- client can rewind a finalized permit to 'reserved', outcome = null and sync
-- a SECOND scored shot through it. apply_synced_shot() checks only that the
-- permit is currently reserved, unexpired, and that the identity ledger is
-- below the free cap — nothing ties a permit to the shot it already backed.
--
--   A. reserve → sync scored #1 (accepted, permit finalized/scored).
--   B. UPDATE analysis_permits SET status='reserved', outcome=null → sync
--      scored #2 through the SAME permit id. Expected: refused. If it is
--      accepted this probe fails and the log carries the exact shape.
--   C. Blast radius: rewind again → sync scored #3 through the same permit.
--      The identity ledger (2) must now refuse it, i.e. the free cap survives
--      permit reuse even if B was accepted. Rewind once more → an abstention
--      still lands (abstentions are free).
--   D. Premium owner (billing_entitlements row): the same rewind loop yields
--      unbounded scored shots off ONE permit — recorded for context; premium
--      is unlimited anyway so this is bookkeeping, not revenue.
--   E. Cross-check: is there ANY column linking shots to the permit that
--      admitted them (shots.* or analysis_permits.*)? If not, reuse is also
--      undetectable after the fact.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

select attack.new_user('00000000-0000-4000-8000-0000000000a6'::uuid, 's6-owner@attack.example', 'apple', 'apple-sub-s6');
select attack.new_user('00000000-0000-4000-8000-0000000000b6'::uuid, 's6-premium@attack.example', 'google', 'google-sub-s6');
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-0000000000b6', true, now() + interval '30 days');

create temporary table attack_failures (probe text, detail text);
create temporary table results (k text, v text);
grant all on attack_failures, results to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a6';

-- A
insert into results select 'reserve', result from public.reserve_analysis_permit('s6-permit');
insert into results select 'sync_1', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e1'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's6-permit')));
insert into results select 'permit_after_sync_1', status || '/' || coalesce(outcome, 'null')
from public.analysis_permits where idempotency_key = 's6-permit';

-- B
update public.analysis_permits set status = 'reserved', outcome = null where idempotency_key = 's6-permit';
insert into results select 'sync_2_same_permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e2'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's6-permit')));
insert into results select 'permit_after_sync_2', status || '/' || coalesce(outcome, 'null')
from public.analysis_permits where idempotency_key = 's6-permit';
insert into results select 'access_after_sync_2', format('scored=%s reserved=%s', scored_count, reserved_count) from public.access_state();

-- C
update public.analysis_permits set status = 'reserved', outcome = null where idempotency_key = 's6-permit';
insert into results select 'sync_3_same_permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e3'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's6-permit')));
update public.analysis_permits set status = 'reserved', outcome = null where idempotency_key = 's6-permit';
insert into results select 'sync_4_abstained_same_permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e4'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's6-permit'), 'low_confidence'));

-- D
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b6';
insert into results select 'premium_reserve', result from public.reserve_analysis_permit('s6-premium-permit');
do $$
declare
  i int;
  v_permit uuid := (select id from public.analysis_permits where idempotency_key = 's6-premium-permit');
  v_accepted int := 0;
begin
  for i in 1..10 loop
    if public.apply_synced_shot(attack.shot_payload(
         ('00000000-0000-4000-8000-00000000d0' || lpad(to_hex(i), 2, '0'))::uuid, v_permit)) = 'accepted' then
      v_accepted := v_accepted + 1;
    end if;
    update public.analysis_permits set status = 'reserved', outcome = null where id = v_permit;
  end loop;
  insert into results values ('premium_scored_shots_off_one_permit', v_accepted::text);
end $$;

reset role;

-- E
insert into results
select 'columns_linking_shots_to_permit',
       coalesce((select string_agg(table_name || '.' || column_name, ', ')
                 from information_schema.columns
                 where table_schema = 'public'
                   and ((table_name = 'shots' and column_name ilike '%permit%')
                     or (table_name = 'analysis_permits' and column_name ilike '%shot%'))), '(none)');

do $$
declare
  r record;
  v_scored int;
  v_ledger int;
begin
  for r in select * from results loop
    raise notice 'OBSERVED % = %', r.k, r.v;
  end loop;
  select count(*) into v_scored from public.shots
  where user_id = '00000000-0000-4000-8000-0000000000a6' and result_kind = 'scored';
  select coalesce(max(l.scored_count), 0) into v_ledger
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = '00000000-0000-4000-8000-0000000000a6';
  raise notice 'OBSERVED free owner final: scored_shots=% ledger=% permits=%', v_scored, v_ledger,
    (select count(*) from public.analysis_permits where user_id = '00000000-0000-4000-8000-0000000000a6');

  if (select v from results where k = 'sync_1') <> 'accepted' then
    insert into attack_failures values ('S6-A', 'first scored sync did not land');
  end if;
  if (select v from results where k = 'sync_2_same_permit') = 'accepted' then
    insert into attack_failures values ('S6-B', format(
      'a finalized/scored permit rewound to reserved admitted a SECOND scored shot (permit now %s, %s)',
      (select v from results where k = 'permit_after_sync_2'),
      (select v from results where k = 'access_after_sync_2')));
  end if;
  -- C is the blast-radius bound: the free cap must hold regardless of B.
  if (select v from results where k = 'sync_3_same_permit') = 'accepted' or v_scored > 2 or v_ledger > 2 then
    insert into attack_failures values ('S6-C', format(
      'permit reuse broke the free cap: third scored sync=%s scored_shots=%s ledger=%s',
      (select v from results where k = 'sync_3_same_permit'), v_scored, v_ledger));
  end if;
  if (select v from results where k = 'sync_4_abstained_same_permit') <> 'accepted' then
    insert into attack_failures values ('S6-C', 'abstention through a rewound permit was refused (abstentions are free)');
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'S6 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo S6: HELD
