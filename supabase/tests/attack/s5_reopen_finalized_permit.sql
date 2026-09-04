-- ============================================================================
-- S5 — reopening finalized permits once both free ratings are spent.
--
-- The owner may UPDATE analysis_permits.status/outcome (column grant sized
-- for the client's finalize/release write). After two legitimate scored
-- ratings the client could flip its two finalized permits back to
-- 'reserved' (or all of them, or mint more — see S4). Reserved permits are
-- "holds" against the allowance, so the question is whether reopened holds
-- reopen the allowance.
--
--   A. Two real reserve+sync cycles → scored_count = 2, both permits
--      finalized/scored.
--   B. Reopen ONE permit → access_state() raw reserved_count = 1,
--      scored_count still 2; edge arithmetic (index.ts:712-720): remaining 0,
--      reserved clamped to 0, availableToReserve 0, paywallRequired true.
--   C. reserve_analysis_permit('new') → access.paywall_required.
--   D. Sync a THIRD scored shot through the reopened permit → refused by the
--      backstop (access.paywall_required), permit released
--      free_limit_exceeded; scored shots stay 2, ledger stays 2.
--   E. Unusual: reopen BOTH permits plus the released one (3 reserved at 2
--      scored) — raw reserved_count 3 > allowance; clamp must hold and the
--      paywall must stay closed; an abstention (resultKind='low_confidence')
--      through a reopened permit must still be recorded (abstentions are
--      free) and release the permit.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

select attack.new_user('00000000-0000-4000-8000-0000000000a5'::uuid, 's5-owner@attack.example', 'google', 'google-sub-s5');

create temporary table attack_failures (probe text, detail text);
create temporary table results (k text, v text);
grant all on attack_failures, results to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a5';

-- A
insert into results select 'reserve_1', result from public.reserve_analysis_permit('s5-real-1');
insert into results select 'sync_1', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e1'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's5-real-1')));
insert into results select 'reserve_2', result from public.reserve_analysis_permit('s5-real-2');
insert into results select 'sync_2', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e2'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's5-real-2')));

-- B
update public.analysis_permits set status = 'reserved', outcome = null
where idempotency_key = 's5-real-1';

create temporary table edge as
select 'one_reopened' as label, s.premium, s.scored_count, s.reserved_count,
       least(2, s.scored_count) as used,
       2 - least(2, s.scored_count) as remaining,
       least(s.reserved_count, 2 - least(2, s.scored_count)) as reserved,
       (2 - least(2, s.scored_count)) - least(s.reserved_count, 2 - least(2, s.scored_count)) as available_to_reserve
from public.access_state() s;

-- C
insert into results select 'reserve_3', result from public.reserve_analysis_permit('s5-real-3');

-- D
insert into results select 'sync_3_via_reopened', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e3'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's5-real-1')));

-- E
update public.analysis_permits set status = 'reserved', outcome = null
where idempotency_key in ('s5-real-1', 's5-real-2');
insert into edge
select 'all_reopened', s.premium, s.scored_count, s.reserved_count,
       least(2, s.scored_count),
       2 - least(2, s.scored_count),
       least(s.reserved_count, 2 - least(2, s.scored_count)),
       (2 - least(2, s.scored_count)) - least(s.reserved_count, 2 - least(2, s.scored_count))
from public.access_state() s;
insert into results select 'reserve_4_all_reopened', result from public.reserve_analysis_permit('s5-real-4');
insert into results select 'sync_4_scored_via_reopened_2', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e4'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's5-real-2')));
update public.analysis_permits set status = 'reserved', outcome = null
where idempotency_key = 's5-real-2';
insert into results select 'sync_5_abstained_via_reopened_2', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e5'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's5-real-2'), 'low_confidence'));

reset role;

do $$
declare
  e record;
  r record;
  v_scored int;
  v_abstained int;
  v_ledger int;
  v_permits text;
begin
  for e in select * from edge loop
    raise notice 'OBSERVED [%] access_state raw: scored_count=% reserved_count=% | edge: remaining=% reserved=% availableToReserve=% paywallRequired=%',
      e.label, e.scored_count, e.reserved_count, e.remaining, e.reserved, e.available_to_reserve,
      not (e.premium or e.available_to_reserve > 0);
  end loop;
  for r in select * from results loop
    raise notice 'OBSERVED % = %', r.k, r.v;
  end loop;
  select count(*) filter (where result_kind = 'scored'), count(*) filter (where result_kind = 'low_confidence')
    into v_scored, v_abstained
  from public.shots where user_id = '00000000-0000-4000-8000-0000000000a5';
  select coalesce(max(l.scored_count), 0) into v_ledger
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = '00000000-0000-4000-8000-0000000000a5';
  select string_agg(idempotency_key || ':' || status || '/' || coalesce(outcome, 'null'), ', ' order by idempotency_key)
    into v_permits
  from public.analysis_permits where user_id = '00000000-0000-4000-8000-0000000000a5';
  raise notice 'OBSERVED final scored=% abstained=% ledger=% permits=[%]', v_scored, v_abstained, v_ledger, v_permits;

  if (select v from results where k = 'sync_1') <> 'accepted' or (select v from results where k = 'sync_2') <> 'accepted' then
    insert into attack_failures values ('S5-A', 'the two legitimate scored syncs did not land');
  end if;
  select * into e from edge where label = 'one_reopened';
  if e.scored_count <> 2 or e.reserved_count <> 1 then
    insert into attack_failures values ('S5-B', format('raw access_state after reopening one permit: scored=%s reserved=%s (expected 2/1)', e.scored_count, e.reserved_count));
  end if;
  if e.reserved <> 0 or e.available_to_reserve <> 0 or (e.premium or e.available_to_reserve > 0) then
    insert into attack_failures values ('S5-B', format('edge clamp after reopening one permit: reserved=%s availableToReserve=%s (expected 0/0, paywall)', e.reserved, e.available_to_reserve));
  end if;
  if (select v from results where k = 'reserve_3') <> 'access.paywall_required' then
    insert into attack_failures values ('S5-C', format('reserve at 2 scored + 1 reopened returned %s', (select v from results where k = 'reserve_3')));
  end if;
  if (select v from results where k = 'sync_3_via_reopened') <> 'access.paywall_required' then
    insert into attack_failures values ('S5-D', format('third scored sync through a reopened permit returned %s', (select v from results where k = 'sync_3_via_reopened')));
  end if;
  select * into e from edge where label = 'all_reopened';
  if e.reserved_count < 2 or e.reserved <> 0 or e.available_to_reserve <> 0 then
    insert into attack_failures values ('S5-E', format('all reopened: raw reserved=%s edge reserved=%s availableToReserve=%s', e.reserved_count, e.reserved, e.available_to_reserve));
  end if;
  if (select v from results where k = 'reserve_4_all_reopened') <> 'access.paywall_required'
     or (select v from results where k = 'sync_4_scored_via_reopened_2') <> 'access.paywall_required' then
    insert into attack_failures values ('S5-E', 'reserve or scored sync succeeded with every permit reopened at 2 scored');
  end if;
  if (select v from results where k = 'sync_5_abstained_via_reopened_2') <> 'accepted' or v_abstained <> 1 then
    insert into attack_failures values ('S5-E', format('abstention through a reopened permit: %s, abstained rows=%s (expected accepted/1 — abstentions are free)',
      (select v from results where k = 'sync_5_abstained_via_reopened_2'), v_abstained));
  end if;
  if v_scored <> 2 or v_ledger <> 2 then
    insert into attack_failures values ('S5', format('final scored=%s ledger=%s (expected 2/2)', v_scored, v_ledger));
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'S5 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo S5: HELD
