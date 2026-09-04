-- ============================================================================
-- S4 — three reserved permits minted directly by the owner.
--
-- reserve_analysis_permit() is the only sanctioned way to get a permit, but
-- RLS insert_own + the column grant let the owner INSERT reserved rows by
-- hand (status defaults to 'reserved'). Holding three permits must not turn
-- into three ratings.
--
--   A. access_state() reports the raw truth (reserved_count = 3) and the
--      edge arithmetic that consumes it (supabase/functions/api/index.ts
--      accessPayload, lines 712-720, mirrored here verbatim) clamps
--      reserved to remaining (2) and yields availableToReserve = 0,
--      canStartRating = false.
--   B. reserve_analysis_permit('fresh') returns access.paywall_required —
--      2 - min(scored,2) = 2 <= reserved 3.
--   C. Sync three scored shots, one per hand-made permit: exactly two are
--      accepted, the third is access.paywall_required and its permit is
--      released with outcome free_limit_exceeded (backstop). Final state:
--      2 scored shots, ledger = 2, permits = finalized, finalized, released.
--   D. Unusual: the same three syncs replayed (idempotent 'accepted' for the
--      two that landed, still refused for the third), then a fourth permit
--      inserted with created_at 10 years in the FUTURE (clock skew / never
--      expires / never swept) — still no third rating.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

select attack.new_user('00000000-0000-4000-8000-0000000000a4'::uuid, 's4-owner@attack.example', 'apple', 'apple-sub-s4');

create temporary table attack_failures (probe text, detail text);
create temporary table results (k text, v text);
grant all on attack_failures, results to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';

insert into public.analysis_permits (id, user_id, idempotency_key)
values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a4', 's4-hand-1'),
       ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000a4', 's4-hand-2'),
       ('00000000-0000-4000-8000-0000000000f3', '00000000-0000-4000-8000-0000000000a4', 's4-hand-3');

-- A
create temporary table edge as
select s.premium, s.scored_count, s.reserved_count,
       least(2, s.scored_count) as used,
       2 - least(2, s.scored_count) as remaining,
       least(s.reserved_count, 2 - least(2, s.scored_count)) as reserved,
       (2 - least(2, s.scored_count)) - least(s.reserved_count, 2 - least(2, s.scored_count)) as available_to_reserve
from public.access_state() s;

-- B
insert into results select 'reserve_fresh', result from public.reserve_analysis_permit('s4-fresh');

-- C
insert into results select 'sync_1', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e1'::uuid, '00000000-0000-4000-8000-0000000000f1'::uuid));
insert into results select 'sync_2', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e2'::uuid, '00000000-0000-4000-8000-0000000000f2'::uuid));
insert into results select 'sync_3', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e3'::uuid, '00000000-0000-4000-8000-0000000000f3'::uuid));

-- D: replay all three, then a future-dated permit.
insert into results select 'replay_1', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e1'::uuid, '00000000-0000-4000-8000-0000000000f1'::uuid));
insert into results select 'replay_3', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e3'::uuid, '00000000-0000-4000-8000-0000000000f3'::uuid));

insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-0000000000f4', '00000000-0000-4000-8000-0000000000a4', 's4-future',
        now() + interval '10 years');
insert into results select 'sync_future_permit', public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e4'::uuid, '00000000-0000-4000-8000-0000000000f4'::uuid));
insert into results select 'reserved_count_after_future', reserved_count::text from public.access_state();

reset role;

do $$
declare
  e record;
  r record;
  v_shots int;
  v_ledger int;
  v_permits text;
begin
  select * into e from edge;
  raise notice 'OBSERVED access_state raw: premium=% scored_count=% reserved_count=%', e.premium, e.scored_count, e.reserved_count;
  raise notice 'OBSERVED edge arithmetic (index.ts:712-720): used=% remaining=% reserved=% availableToReserve=% canStartRating=%',
    e.used, e.remaining, e.reserved, e.available_to_reserve, (e.premium or e.available_to_reserve > 0);
  for r in select * from results loop
    raise notice 'OBSERVED % = %', r.k, r.v;
  end loop;

  select count(*) into v_shots from public.shots
  where user_id = '00000000-0000-4000-8000-0000000000a4' and result_kind = 'scored';
  select coalesce(max(l.scored_count), 0) into v_ledger
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = '00000000-0000-4000-8000-0000000000a4';
  select string_agg(idempotency_key || ':' || status || '/' || coalesce(outcome, 'null'), ', ' order by idempotency_key)
    into v_permits
  from public.analysis_permits where user_id = '00000000-0000-4000-8000-0000000000a4';
  raise notice 'OBSERVED final scored_shots=% ledger=% permits=[%]', v_shots, v_ledger, v_permits;

  if e.reserved_count <> 3 then
    insert into attack_failures values ('S4-A', format('access_state().reserved_count=%s, expected raw 3', e.reserved_count));
  end if;
  if e.reserved <> 2 or e.available_to_reserve <> 0 or (e.premium or e.available_to_reserve > 0) then
    insert into attack_failures values ('S4-A', format(
      'edge clamp: reserved=%s availableToReserve=%s (expected 2/0, canStartRating=false)', e.reserved, e.available_to_reserve));
  end if;
  if (select v from results where k = 'reserve_fresh') <> 'access.paywall_required' then
    insert into attack_failures values ('S4-B', format(
      'reserve_analysis_permit with 3 hand-made reserved permits returned %s', (select v from results where k = 'reserve_fresh')));
  end if;
  if (select v from results where k = 'sync_1') <> 'accepted'
     or (select v from results where k = 'sync_2') <> 'accepted'
     or (select v from results where k = 'sync_3') <> 'access.paywall_required' then
    insert into attack_failures values ('S4-C', format('syncs = %s / %s / %s (expected accepted/accepted/access.paywall_required)',
      (select v from results where k = 'sync_1'), (select v from results where k = 'sync_2'), (select v from results where k = 'sync_3')));
  end if;
  if v_shots <> 2 or v_ledger <> 2 then
    insert into attack_failures values ('S4-C', format('final scored shots=%s ledger=%s (expected 2/2)', v_shots, v_ledger));
  end if;
  if (select status || '/' || coalesce(outcome, '') from public.analysis_permits where id = '00000000-0000-4000-8000-0000000000f3')
     <> 'released/free_limit_exceeded' then
    insert into attack_failures values ('S4-C', 'third hand-made permit was not released with free_limit_exceeded');
  end if;
  if (select v from results where k = 'replay_1') <> 'accepted'
     or (select v from results where k = 'replay_3') = 'accepted' then
    insert into attack_failures values ('S4-D', format('replays: landed shot -> %s, refused shot -> %s',
      (select v from results where k = 'replay_1'), (select v from results where k = 'replay_3')));
  end if;
  if (select v from results where k = 'sync_future_permit') = 'accepted' then
    insert into attack_failures values ('S4-D', 'a future-dated hand-made permit produced a third scored rating');
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'S4 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo S4: HELD
