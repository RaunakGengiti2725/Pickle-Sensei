-- A09 — A01 through the production clock: the hourly sweep has already run.
--
-- Attack: a free user reserved one rating online, went offline for a day, and
-- pg_cron's `expire-stale-analysis-permits` moved the permit to
-- released/expired (which permit_backs_sync() still honours, so the shot it
-- backs syncs later). Back online, the device asks for an offline grant and
-- gets ONE ticket (the allocator counts the swept permit), the app then
-- reserves online: reserve_analysis_permit() counts only status='reserved'
-- rows younger than 24 h → reserved 0 + hold 1 < 2 → a second live permit.
-- Both permits sync, the ticket stays outstanding: 3 > 2. access_state() also
-- reports reserved_count 1 while two reservations are honoured.
-- Expected: the second online reservation is access.paywall_required and
-- access_state().reserved_count counts the swept-but-syncable permit.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(15, 'apple', 'apple-sub-a09');
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
values ('00000000-0000-4000-8000-0000000a0901', pg_temp.atk_uid(15), 'a09-stale', now() - interval '25 hours');
-- the sweep (20260831000000 cron job body, verbatim predicate)
update public.analysis_permits set status = 'released', outcome = 'expired'
 where status = 'reserved' and created_at < now() - interval '24 hours';
do $$
declare n integer;
begin
  select count(*) into n from public.analysis_permits where id = '00000000-0000-4000-8000-0000000a0901' and public.permit_backs_sync(status, outcome);
  if n <> 1 then raise exception 'A09 precondition: swept permit no longer backs a sync'; end if;
end $$;

select pg_temp.atk_become(15);
do $$
declare g record; p record; a record; v text; used integer;
begin
  select * into g from public.register_offline_device('a09-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A09 precondition: registration (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a09-key', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'A09 precondition: one ticket beside the swept reservation (got %, %)', g.result, g.ticket_ids;
  end if;
  used := pg_temp.atk_budget_used((select auth.uid()));
  if used <> 2 then raise exception 'A09 precondition: budget fully used after allocation (%)', used; end if;

  select * into a from public.access_state();
  select * into p from public.reserve_analysis_permit('a09-online-2');
  used := pg_temp.atk_budget_used((select auth.uid()));
  if p.result = 'accepted' then
    v := public.apply_synced_shot(pg_temp.atk_shot('00000000-0000-4000-8000-0000000a0902', '00000000-0000-4000-8000-0000000a0901'));
    v := v || '/' || public.apply_synced_shot(pg_temp.atk_shot('00000000-0000-4000-8000-0000000a0903', p.permit_id));
    raise exception 'A09 BREAK: online reservation granted beside a swept-but-syncable permit and an outstanding offline ticket (access_state before reserve: scored=%, reserved=%; reserve=%, budget used after reserve=% > 2; syncs=%; scored=%, outstanding tickets=%, ledger=%)',
      a.scored_count, a.reserved_count, p.result, used, v, pg_temp.atk_scored((select auth.uid())), pg_temp.atk_outstanding((select auth.uid())), pg_temp.atk_events((select auth.uid()));
  end if;
  if p.result <> 'access.paywall_required' then raise exception 'A09: unexpected reserve verdict % (budget used %)', p.result, used; end if;
  if used <> 2 then raise exception 'A09 BREAK: conservation violated (budget used % > 2)', used; end if;
  if a.reserved_count <> 2 then raise exception 'A09 BREAK: access_state reserved_count % while two reservations are honoured', a.reserved_count; end if;
end $$;
select pg_temp.atk_reset();
rollback;
\echo A09 PASS: online reservation refused beside swept permit + offline hold
