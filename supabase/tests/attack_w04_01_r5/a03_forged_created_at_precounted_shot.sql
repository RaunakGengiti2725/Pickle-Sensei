-- A03 — boundary values / clock: the round-5 fix for adversary A01 ("a rating
-- counted before the ticket existed is not the ticket's") is the predicate
--   shots.created_at >= allocation.created_at
-- shots.created_at is a plain client-writable column on a table the client
-- role may INSERT into: it has no gate, no bound and no trigger. A scored row
-- written BEFORE any ticket exists, with a far-future created_at, later
-- passes the temporal predicate and settles a ticket allocated after it.
--
-- Sequence: reserve P0 → direct scored INSERT S0 (created_at = now + 1 year)
-- → cancel P0 → issue ticket T1 (scored 1, no reservation → 1 ticket)
-- → consume(T1, S0). Expected: offline.shot_not_chargeable (S0 predates T1),
-- the hold stays, the refresh re-issues T1 and mints nothing.
begin;
\ir _prelude.sql

select pg_temp.mk_user('00000000-0000-4000-8000-00000000a301', 'google', 'google-sub-a03', '00000000-0000-4000-8000-0000000a0301');
do $$ begin perform set_config('request.headers', pg_temp.api_header(), true); end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a301';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0301"}';

do $$
declare uid uuid := (select auth.uid()); r record; p record; g record; g2 record; v text; t1 uuid;
begin
  select * into r from public.register_offline_device('a03-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A03 precondition: registration (got %)', r.result; end if;

  -- The pre-counted rating, stamped from the future by the client.
  select * into p from public.reserve_analysis_permit('a03-online-0');
  if p.result <> 'accepted' then raise exception 'A03 precondition: online reservation (got %)', p.result; end if;
  perform pg_temp.direct_scored_insert('00000000-0000-4000-8000-00000000a3f0', now() + interval '1 year');
  if pg_temp.scored(uid) <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'A03 precondition: S0 is counted by lifetime_scored_count() before any ticket exists';
  end if;
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = p.permit_id;

  -- The ticket is allocated strictly AFTER S0 was written and counted.
  select * into g from public.issue_offline_grant('a03-key', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 1 then
    raise exception 'A03 precondition: one rating spent leaves one ticket (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1];

  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-00000000a3f0');
  select * into g2 from public.issue_offline_grant('a03-key', 2);
  raise notice 'A03 consume(T1, pre-counted S0) = %; refresh = % tickets=% events=% tickets_ever_allocated=% scored=%',
    v, g2.result, g2.ticket_ids, pg_temp.events(uid), pg_temp.tickets_ever_allocated(uid), pg_temp.scored(uid);

  if v <> 'offline.shot_not_chargeable' then
    raise exception 'A03 BREAK: a rating counted before the allocation settled ticket % (consume returned %) because the client chose created_at; the refresh then returned % with tickets % — % tickets ever allocated + % pre-counted rating = 3 ratings for a 2-rating identity (the r5 A01 fix is bypassed)',
      t1, v, g2.result, g2.ticket_ids, pg_temp.tickets_ever_allocated(uid), pg_temp.scored(uid);
  end if;
  if g2.ticket_ids <> array[t1] or pg_temp.tickets_ever_allocated(uid) <> 1 then
    raise exception 'A03 BREAK: the refresh must re-issue exactly T1 and mint nothing (got %, tickets ever allocated %)', g2.ticket_ids, pg_temp.tickets_ever_allocated(uid);
  end if;
end $$;

rollback;
\echo A03 PASSED
