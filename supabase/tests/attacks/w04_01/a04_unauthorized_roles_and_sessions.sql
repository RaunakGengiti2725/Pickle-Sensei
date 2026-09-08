-- A04 — unauthorised roles for every new surface (allowed AND denied paths).
--
-- Attack: reach the four tables and five RPCs as anon, as an authenticated
-- user with no session claim, with a session that belongs to another user,
-- with an expired session, with a revoked (deleted) session, as a banned
-- user, without the API request header, as another signed-in user, and as
-- service_role. Then confirm the legitimate owner still gets through.
-- Expected: every mutation is refused (42501) and writes nothing; another
-- user sees no rows and cannot consume/release a foreign ticket; the owner's
-- reads and RPCs work.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(6, 'apple', 'apple-sub-a04-owner');
select pg_temp.atk_user(7, 'google', 'google-sub-a04-other');
create temp table a04 (k text primary key, v uuid);
grant all on a04 to authenticated, anon, service_role;

-- the owner allocates two tickets
select pg_temp.atk_become(6);
do $$
declare g record;
begin
  select * into g from public.register_offline_device('a04-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A04 precondition: registration (%)', g.result; end if;
  insert into a04 values ('dev', g.device_id);
  select * into g from public.issue_offline_grant('a04-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A04 precondition: tickets (%, %)', g.result, g.ticket_ids;
  end if;
  insert into a04 values ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]), ('grant', g.grant_id);
end $$;
select pg_temp.atk_reset();

-- every RPC + every table, as one probe set
create function pg_temp.a04_probe(p_label text, p_expect text) returns void
language plpgsql as $$
declare t1 uuid := (select v from a04 where k = 't1'); st text; bad text := '';
  probes text[] := array[
    $q$select * from public.register_offline_device('a04-key', 'production', true)$q$,
    $q$select * from public.register_offline_device('a04-attacker-key', 'production', true)$q$,
    $q$select * from public.issue_offline_grant('a04-key', 2)$q$,
    format($q$select public.consume_offline_ticket(%L, %L)$q$, t1, '00000000-0000-4000-8000-0000000a0401'),
    format($q$select public.release_offline_ticket(%L, 'unused_ticket_returned')$q$, t1),
    $q$insert into public.offline_devices (user_id, installation_key_id, attestation_environment, attestation_state) values (pg_temp.atk_uid(6), 'x', 'production', 'unattested')$q$,
    $q$update public.offline_devices set attestation_state = 'attested', attested_at = now()$q$,
    $q$delete from public.offline_devices$q$,
    $q$update public.offline_grants set expires_at = expires_at + interval '1 day'$q$,
    $q$delete from public.offline_grants$q$,
    format($q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, installation_key_id)
             select user_id, device_id, grant_id, generation, ticket_id, 'released', 'support_review', installation_key_id
             from public.offline_allocation_ledger where ticket_id = %L$q$, t1),
    $q$delete from public.offline_allocation_ledger$q$,
    $q$select * from public.offline_ticket_identities$q$,
    $q$insert into public.offline_ticket_identities (ticket_id, identity_hash) values (gen_random_uuid(), repeat('a', 64))$q$,
    $q$delete from public.offline_ticket_identities$q$
  ];
  p text;
begin
  foreach p in array probes loop
    st := pg_temp.atk_try(p);
    if st is distinct from p_expect then
      bad := bad || format(E'\n  [%s] expected %s got %s :: %s', p_label, p_expect, coalesce(st, 'SUCCESS'), left(p, 90));
    end if;
  end loop;
  if bad <> '' then raise exception 'A04 BREAK:%', bad; end if;
end $$;
grant execute on function pg_temp.a04_probe(text, text) to authenticated, anon, service_role;

-- 1. anon
set local role anon;
select pg_temp.a04_probe('anon', '42501');
do $$ begin
  if pg_temp.atk_try('select public.offline_hold_count()') is distinct from '42501' then
    raise exception 'A04 BREAK: anon can execute offline_hold_count()';
  end if;
end $$;
reset role;

-- 2. authenticated, sub set, no session claim
set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.atk_uid(6)::text, true);
select set_config('request.jwt.claims', '{}', true);
select pg_temp.a04_probe('no-session-claim', '42501');
reset role;

-- 3. authenticated with the OTHER user's live session id in the claim
set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.atk_uid(6)::text, true);
select set_config('request.jwt.claims', jsonb_build_object('session_id', pg_temp.atk_sid(7))::text, true);
select pg_temp.a04_probe('foreign-session', '42501');
reset role;

-- 4. expired session
update auth.sessions set not_after = now() - interval '1 second' where id = pg_temp.atk_sid(6);
select pg_temp.atk_become(6);
select pg_temp.a04_probe('expired-session', '42501');
select pg_temp.atk_reset();
update auth.sessions set not_after = null where id = pg_temp.atk_sid(6);

-- 5. banned user with a live session
update auth.users set banned_until = now() + interval '1 day' where id = pg_temp.atk_uid(6);
select pg_temp.atk_become(6);
select pg_temp.a04_probe('banned', '42501');
select pg_temp.atk_reset();
update auth.users set banned_until = null where id = pg_temp.atk_uid(6);

-- 6. live session but the request did not come through the edge function
select set_config('request.headers', '{}', true);
select pg_temp.atk_become(6);
select pg_temp.a04_probe('no-api-key', '42501');
select pg_temp.atk_reset();
select set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);

-- 7. service_role: intentionally revoked from the new tables and RPCs
set local role service_role;
select pg_temp.a04_probe('service_role', '42501');
do $$ begin
  if pg_temp.atk_try('select public.offline_hold_count()') is distinct from '42501' then
    raise exception 'A04 BREAK: service_role can execute offline_hold_count()';
  end if;
  if pg_temp.atk_try('select * from public.offline_allocation_ledger') is distinct from '42501'
     or pg_temp.atk_try('select * from public.offline_devices') is distinct from '42501'
     or pg_temp.atk_try('select * from public.offline_grants') is distinct from '42501' then
    raise exception 'A04 BREAK: service_role can read the offline tables';
  end if;
end $$;
reset role;

-- 8. another signed-in user: RLS hides rows, RPCs refuse foreign tickets, no write lands
select pg_temp.atk_become(7);
do $$
declare t1 uuid := (select v from a04 where k = 't1'); n integer; v text; st text; g record;
begin
  select count(*) into n from public.offline_devices; if n <> 0 then raise exception 'A04 BREAK: other user sees % device rows', n; end if;
  select count(*) into n from public.offline_grants; if n <> 0 then raise exception 'A04 BREAK: other user sees % grant rows', n; end if;
  select count(*) into n from public.offline_allocation_ledger; if n <> 0 then raise exception 'A04 BREAK: other user sees % ledger rows', n; end if;
  if public.offline_hold_count() <> 0 then raise exception 'A04 BREAK: other user counts foreign holds'; end if;
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'offline.ticket_not_found' then raise exception 'A04 BREAK: other user released a foreign ticket (%)', v; end if;
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0401');
  if v <> 'offline.ticket_not_found' then raise exception 'A04 BREAK: other user consumed a foreign ticket (%)', v; end if;
  -- registering the owner's installation key does not reach the owner's tickets
  select * into g from public.register_offline_device('a04-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A04: other user registration (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a04-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2
     or g.ticket_ids && array(select x.v from a04 x where x.k in ('t1', 't2')) then
    raise exception 'A04 BREAK: other user on the same installation key got the owner''s tickets (%, %)', g.result, g.ticket_ids;
  end if;
  st := pg_temp.atk_try(format($q$update public.offline_devices set attestation_state = 'unattested' where id = %L$q$, (select x.v from a04 x where x.k = 'dev')));
  if st is distinct from '42501' then raise exception 'A04 BREAK: other user updated the owner''s device (%)', st; end if;
end $$;
select pg_temp.atk_reset();

-- 9. the owner, legitimately
select pg_temp.atk_become(6);
do $$
declare t1 uuid := (select v from a04 where k = 't1'); n integer; v text; g record;
begin
  select count(*) into n from public.offline_devices; if n <> 1 then raise exception 'A04 BREAK: owner sees % devices', n; end if;
  select count(*) into n from public.offline_grants; if n <> 1 then raise exception 'A04 BREAK: owner sees % grants', n; end if;
  select count(*) into n from public.offline_allocation_ledger; if n <> 2 then raise exception 'A04 BREAK: owner sees % ledger rows', n; end if;
  if public.offline_hold_count() <> 2 then raise exception 'A04 BREAK: owner hold count %', public.offline_hold_count(); end if;
  select * into g from public.issue_offline_grant('a04-key', 2);
  if g.result <> 'accepted' or g.generation <> 2 or g.ticket_ids <> array(select x.v from a04 x where x.k in ('t1', 't2') order by x.k) then
    raise exception 'A04 BREAK: owner re-issue changed (%, %, %)', g.result, g.generation, g.ticket_ids;
  end if;
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A04 BREAK: owner release refused (%)', v; end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:2,released:1' then
    raise exception 'A04 BREAK: unauthorised probes left writes behind (%)', pg_temp.atk_events((select auth.uid()));
  end if;
end $$;
select pg_temp.atk_reset();
do $$
declare n integer;
begin
  select count(*) into n from public.offline_devices where installation_key_id = 'a04-attacker-key';
  if n <> 0 then raise exception 'A04 BREAK: an unauthorised registration landed'; end if;
  select count(*) into n from public.offline_ticket_identities where identity_hash = repeat('a', 64);
  if n <> 0 then raise exception 'A04 BREAK: an unauthorised identity binding landed'; end if;
end $$;
rollback;
\echo A04 PASS: every unauthorised role/session is refused, owner path intact
