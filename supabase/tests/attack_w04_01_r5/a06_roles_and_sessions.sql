-- A06 — unauthorised roles and session states on the four new RPCs, allowed
-- AND denied paths:
--   allowed: the owner with a live session registers, allocates, releases
--   denied:  anon (with the API proof), authenticated without the API proof,
--            a session id that belongs to another user, an expired session,
--            a malformed session claim, a banned user, service_role wearing
--            a user's claims, a second user consuming/releasing the first
--            user's ticket, and a second user recycling the first user's
--            installation key (own registration, none of the other's tickets)
-- Expected: every denied call raises insufficient_privilege or returns
-- ticket_not_found; the ledger holds exactly the owner's rows afterwards.
begin;
\ir _prelude.sql

select pg_temp.mk_user('00000000-0000-4000-8000-00000000a601', 'google', 'google-sub-a06-owner', '00000000-0000-4000-8000-0000000a0601');
select pg_temp.mk_user('00000000-0000-4000-8000-00000000a602', 'apple', 'apple-sub-a06-other', '00000000-0000-4000-8000-0000000a0602');
insert into auth.sessions (id, user_id, not_after) values
  ('00000000-0000-4000-8000-0000000a0603', '00000000-0000-4000-8000-00000000a601', now() - interval '1 second');
do $$ begin perform set_config('request.headers', pg_temp.api_header(), true); end $$;

create table pg_temp.a06_state (key text primary key, id uuid);
grant all on pg_temp.a06_state to authenticated, anon, service_role;

-- allowed path: the owner
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0601"}';
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('a06-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A06 precondition: owner registration (got %)', r.result; end if;
  select * into g from public.issue_offline_grant('a06-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then raise exception 'A06 precondition: owner tickets (got %)', g.result; end if;
  insert into pg_temp.a06_state values ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
end $$;

create function pg_temp.expect_denied(p_label text, p_sql text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'A06 BREAK: % must be refused (statement succeeded)', p_label;
  exception when insufficient_privilege then null;
  end;
end $$;
grant execute on function pg_temp.expect_denied(text, text) to authenticated, anon, service_role;

create function pg_temp.all_rpcs() returns text[] language sql as $$
  select array[
    'select * from public.register_offline_device(''a06-key'', ''production'', true)',
    'select * from public.issue_offline_grant(''a06-key'', 2)',
    format('select public.consume_offline_ticket(%L, %L)', (select id from pg_temp.a06_state where key = 't1'), gen_random_uuid()),
    format('select public.release_offline_ticket(%L, ''unused_ticket_returned'')', (select id from pg_temp.a06_state where key = 't2'))
  ]
$$;
grant execute on function pg_temp.all_rpcs() to authenticated, anon, service_role;

-- denied: anon with the API proof
set local role anon;
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('anon ' || q, q); end loop;
end $$;

-- denied: the owner without the API proof
reset role;
do $$ begin perform set_config('request.headers', '{}', true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0601"}';
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('no API proof ' || q, q); end loop;
end $$;
reset role;
do $$ begin perform set_config('request.headers', pg_temp.api_header(), true); end $$;

-- denied: the owner's sub with another user's session id
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0602"}';
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('foreign session ' || q, q); end loop;
end $$;

-- denied: an expired session of the owner
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0603"}';
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('expired session ' || q, q); end loop;
end $$;

-- denied: malformed / missing session claims
set local request.jwt.claims = '{"session_id":"not-a-uuid"}';
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('malformed session ' || q, q); end loop;
end $$;
set local request.jwt.claims = '{}';
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('missing session ' || q, q); end loop;
end $$;

-- denied: a banned owner with an otherwise live session
reset role;
update auth.users set banned_until = now() + interval '1 hour' where id = '00000000-0000-4000-8000-00000000a601';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0601"}';
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('banned ' || q, q); end loop;
end $$;
reset role;
update auth.users set banned_until = null where id = '00000000-0000-4000-8000-00000000a601';

-- denied: service_role wearing the owner's claims
set local role service_role;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0601"}';
do $$ declare q text; begin
  foreach q in array pg_temp.all_rpcs() loop perform pg_temp.expect_denied('service_role ' || q, q); end loop;
end $$;

-- denied by ownership: another live user against the owner's tickets and key
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a602';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0602"}';
do $$
declare v text; r record; g record; p record;
  t1 uuid := (select id from pg_temp.a06_state where key = 't1');
  t2 uuid := (select id from pg_temp.a06_state where key = 't2');
begin
  select * into r from public.register_offline_device('a06-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A06: a recycled installation key registers for its own account (got %)', r.result; end if;
  select * into g from public.issue_offline_grant('a06-key', 1);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 or g.ticket_ids && array[t1, t2] then
    raise exception 'A06 BREAK: the recycled key must mint the stranger''s own ticket, never the owner''s (got % %)', g.result, g.ticket_ids;
  end if;
  select * into p from public.reserve_analysis_permit('a06-other-online');
  if p.result <> 'accepted' then raise exception 'A06 precondition: stranger reservation (got %)', p.result; end if;
  perform pg_temp.direct_scored_insert('00000000-0000-4000-8000-00000000a6f2');
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-00000000a6f2');
  if v <> 'offline.ticket_not_found' then raise exception 'A06 BREAK: another user consumed the owner''s ticket (got %)', v; end if;
  v := public.release_offline_ticket(t2, 'unused_ticket_returned');
  if v <> 'offline.ticket_not_found' then raise exception 'A06 BREAK: another user released the owner''s ticket (got %)', v; end if;
  if pg_temp.outstanding('00000000-0000-4000-8000-00000000a601') <> 2 then
    raise exception 'A06 BREAK: the owner''s holds changed under another user''s calls';
  end if;
end $$;

-- allowed path continues: the owner releases one ticket
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0601"}';
do $$
declare v text;
begin
  v := public.release_offline_ticket((select id from pg_temp.a06_state where key = 't2'), 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A06: the owner must still be able to return a ticket (got %)', v; end if;
  if pg_temp.events((select auth.uid())) <> 'allocated:2,released:1' then
    raise exception 'A06 BREAK: unexpected ledger for the owner: %', pg_temp.events((select auth.uid()));
  end if;
end $$;

rollback;
\echo A06 PASSED
