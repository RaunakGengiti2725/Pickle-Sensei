-- A01 — free-rating conservation across the two decision points.
--
-- Attack: a free user reserved one rating online and did not sync it within
-- 24 h (the "offline > 24 h" durability case section N of the matrix keeps
-- syncable). Back online, the device asks for an offline grant FIRST, then
-- the app reserves online again. The allocator (issue_offline_grant) counts
-- the stale permit as a reservation and hands out ONE ticket; the online
-- reservation path (reserve_analysis_permit, redefined by the same
-- migration) counts only permits younger than 24 h, sees hold 1 + reserved 0
-- and hands out a SECOND live permit. Both permits then sync (section N
-- honours a reserved permit at any age) while the offline ticket stays
-- outstanding: 2 scored + 1 outstanding ticket = 3 > 2.
--
-- Expected (work-package objective, candidate comment on issue_offline_grant):
-- outstanding + consumed + released + online reservations ≤ entitlement at
-- every step — the second online reservation must be access.paywall_required.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(1, 'google', 'google-sub-a01');
-- the clock: a reservation made 25 h ago that nothing has settled (hourly
-- sweep is best-effort; both 'reserved' and swept 'released/expired' back a sync)
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-0000000a0101', pg_temp.atk_uid(1), 'a01-stale', now() - interval '25 hours');

select pg_temp.atk_become(1);
do $$
declare g record; p record; v text; used integer;
begin
  select * into g from public.register_offline_device('a01-key', 'production', true);
  if g.result <> 'accepted' then
    raise exception 'A01 precondition: registration (got %)', g.result;
  end if;

  -- allocator: the stale permit occupies one of the two ratings → 1 ticket
  select * into g from public.issue_offline_grant('a01-key', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'A01 precondition: one ticket beside the stale reservation (got %, %)', g.result, g.ticket_ids;
  end if;
  used := pg_temp.atk_budget_used((select auth.uid()));
  if used <> 2 then
    raise exception 'A01 precondition: budget fully used after allocation (got %)', used;
  end if;

  -- the attack: reserve online AFTER the offline allocation
  select * into p from public.reserve_analysis_permit('a01-online-2');
  used := pg_temp.atk_budget_used((select auth.uid()));
  if p.result = 'accepted' then
    -- follow through: both permits sync (section N), the ticket stays held
    v := public.apply_synced_shot(pg_temp.atk_shot('00000000-0000-4000-8000-0000000a0102', '00000000-0000-4000-8000-0000000a0101'));
    v := v || '/' || public.apply_synced_shot(pg_temp.atk_shot('00000000-0000-4000-8000-0000000a0103', p.permit_id));
    raise exception 'A01 BREAK: online reservation granted beside a stale syncable permit and an outstanding offline ticket (reserve=%, budget used after reserve=% > 2; syncs=%; scored=%, outstanding tickets=%, ledger=%)',
      p.result, used, v, pg_temp.atk_scored((select auth.uid())), pg_temp.atk_outstanding((select auth.uid())), pg_temp.atk_events((select auth.uid()));
  end if;
  if p.result <> 'access.paywall_required' then
    raise exception 'A01: unexpected reserve verdict % (budget used %)', p.result, used;
  end if;
  if used <> 2 then
    raise exception 'A01 BREAK: conservation violated (budget used % > 2)', used;
  end if;
end $$;
select pg_temp.atk_reset();
rollback;
\echo A01 PASS: online reservation refused beside stale permit + offline hold
