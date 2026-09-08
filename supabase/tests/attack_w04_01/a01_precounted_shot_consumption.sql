-- ATTACK A01 — free-rating conservation: a ticket consumed by a shot that was
-- ALREADY counted when the ticket was allocated.
--
-- Every scored shot synced before 20260907000000 (analysis_permit_id did not
-- exist) and every server-written scored row has analysis_permit_id NULL.
-- consume_offline_ticket() only asks "scored, mine, no permit, no other
-- ticket" — never whether the shot predates the allocation it settles.
-- The client chooses p_shot_id, so it binds the ticket that funded a NEW
-- offline rating to an OLD already-counted shot; the hold disappears and
-- issue_offline_grant() allocates again. Invariant under test:
--   tickets ever allocated + ratings counted before the first allocation ≤ 2.
begin;
\ir _setup.sql

-- A legacy rating: one scored shot from a month ago, no permit (pre-20260907 shape).
select pg_temp.owner_scored_shot('00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-0000000000e1', now() - interval '30 days');
update public.shots set created_at = now() - interval '30 days' where id = '00000000-0000-4000-8000-00000000a101';

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare r record; g record; g2 record; v text; t1 uuid; held int; ever int; lifetime int;
begin
  if public.lifetime_scored_count() <> 1 then
    raise exception 'A01 precondition: one rating already counted (got %)', public.lifetime_scored_count();
  end if;
  select * into r from public.register_offline_device('e1-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A01 precondition: registration (got %)', r.result; end if;

  select * into g from public.issue_offline_grant('e1-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then
    raise exception 'A01 precondition: 1 rating used → exactly 1 ticket (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1];

  -- The device rated a NEW shot offline under t1, but the client names the
  -- OLD, already-counted shot when it settles the ticket.
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-00000000a101');
  held := public.offline_hold_count();
  select * into g2 from public.issue_offline_grant('e1-key', 2);
  ever := pg_temp.tickets_ever('e1-key');
  lifetime := public.lifetime_scored_count();

  if ever + 1 > 2 then
    raise exception 'A01 BREAK: consume(t1, pre-counted shot) → %, hold after = %, second issue → % with % new ticket(s) (gen %); tickets ever allocated = %, lifetime_scored_count = %: % tickets + 1 pre-existing rating > 2',
      v, held, g2.result, coalesce(array_length(g2.ticket_ids, 1), 0), g2.generation, ever, lifetime, ever;
  end if;
  if v <> 'offline.shot_not_chargeable' then
    raise exception 'A01: a shot that predates the allocation must be offline.shot_not_chargeable (got %)', v;
  end if;
end $$;
rollback;
