-- A02 — replay / conservation: a scored shot the ONLINE reservation paid for
-- must never settle an offline ticket. The candidate decides "no online
-- permit paid for it" by analysis_permit_id IS NULL, but a direct client
-- INSERT under a live permit is gated on that permit and is forced to carry
-- analysis_permit_id NULL. The ticket's hold is then cleared by a rating the
-- device never produced offline (the device still holds the ticket and can
-- render a rating against it), the permit is cancelled by the client (the
-- normal finalize transition), and the next refresh mints a fresh ticket.
--
-- Expected: consume_offline_ticket(T1, S1) = offline.shot_not_chargeable, the
-- hold stays, and the refresh after the cancel re-issues T1 without minting a
-- second ticket (tickets ever allocated stays 1 beside the 1 online rating).
begin;
\ir _prelude.sql

select pg_temp.mk_user('00000000-0000-4000-8000-00000000a201', 'apple', 'apple-sub-a02', '00000000-0000-4000-8000-0000000a0201');
do $$ begin perform set_config('request.headers', pg_temp.api_header(), true); end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a201';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0201"}';

do $$
declare uid uuid := (select auth.uid()); r record; p record; g record; g2 record; v text; t1 uuid;
begin
  select * into r from public.register_offline_device('a02-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A02 precondition: registration (got %)', r.result; end if;

  select * into p from public.reserve_analysis_permit('a02-online-1');
  if p.result <> 'accepted' then raise exception 'A02 precondition: online reservation (got %)', p.result; end if;

  select * into g from public.issue_offline_grant('a02-key', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'A02 precondition: one ticket beside one reservation (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1];

  -- The online rating: a direct scored write under the live permit P1.
  perform pg_temp.direct_scored_insert('00000000-0000-4000-8000-00000000a2f1');
  if pg_temp.scored(uid) <> 1 then raise exception 'A02 precondition: the online rating was written'; end if;

  -- The device never rendered anything for T1; S1 was paid by P1.
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-00000000a2f1');
  raise notice 'A02 consume(T1, online shot S1) = %', v;

  -- The client closes P1 the way the finalize route does.
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = p.permit_id;

  select * into g2 from public.issue_offline_grant('a02-key', 2);
  raise notice 'A02 refresh after cancel: % tickets=% events=% tickets_ever_allocated=% scored=%',
    g2.result, g2.ticket_ids, pg_temp.events(uid), pg_temp.tickets_ever_allocated(uid), pg_temp.scored(uid);

  if v <> 'offline.shot_not_chargeable' then
    raise exception 'A02 BREAK: a rating the online reservation paid for settled offline ticket % (consume returned %); after cancelling the permit the refresh returned % with tickets % — % tickets ever allocated (each one rating the device renders offline) beside % online rating for a 2-rating identity',
      t1, v, g2.result, g2.ticket_ids, pg_temp.tickets_ever_allocated(uid), pg_temp.scored(uid);
  end if;
  if g2.ticket_ids <> array[t1] or pg_temp.tickets_ever_allocated(uid) <> 1 then
    raise exception 'A02 BREAK: the refresh must re-issue exactly T1 and mint nothing (got %, tickets ever allocated %)', g2.ticket_ids, pg_temp.tickets_ever_allocated(uid);
  end if;
end $$;

rollback;
\echo A02 PASSED
