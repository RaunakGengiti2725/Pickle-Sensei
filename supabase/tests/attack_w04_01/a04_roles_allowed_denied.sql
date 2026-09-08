-- ATTACK A04 — unauthorised roles on the new surfaces, allowed AND denied:
-- anon (with the API header and a forged live session claim), another
-- authenticated user (own key, the victim's tickets, the victim's live
-- session id), service_role with a user sub, and the owner path that must
-- keep working. Also: a second account registering the SAME installation
-- key never sees or re-obtains the first account's tickets.
begin;
\ir _setup.sql

-- Victim e1 holds two tickets.
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('shared-key', 'production', true);
  select * into g from public.issue_offline_grant('shared-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A04 precondition: victim holds two tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  if (select count(*) from public.offline_allocation_ledger) <> 2
     or (select count(*) from public.offline_devices) <> 1
     or (select count(*) from public.offline_grants) <> 1 then
    raise exception 'A04: the owner reads exactly its own rows';
  end if;
end $$;

-- anon: API header present, forged live session claim of the victim.
select pg_temp.as_owner();
set local role anon;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000e1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000000e101"}';
do $$
declare v text; n int;
begin
  begin
    select count(*) into n from public.offline_allocation_ledger;
    raise exception 'A04 BREAK: anon can read the ledger (% rows)', n;
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.register_offline_device('anon-key', 'production', true);
    raise exception 'A04 BREAK: anon registered a device';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.issue_offline_grant('shared-key', 2);
    raise exception 'A04 BREAK: anon was issued a grant';
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.consume_offline_ticket(pg_temp.first_ticket('00000000-0000-4000-8000-0000000000e1'), gen_random_uuid());
    raise exception 'A04 BREAK: anon consumed (%)', v;
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.release_offline_ticket(pg_temp.first_ticket('00000000-0000-4000-8000-0000000000e1'), 'unused_ticket_returned');
    raise exception 'A04 BREAK: anon released (%)', v;
  exception when insufficient_privilege then null;
  end;
  begin
    n := public.offline_hold_count();
    raise exception 'A04 BREAK: anon read the hold count (%)', n;
  exception when insufficient_privilege then null;
  end;
end $$;

-- another authenticated user: same installation key, the victim's tickets,
-- then the victim's live session id in its own claims.
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000e201');
do $$
declare r record; g record; v text; t uuid := pg_temp.first_ticket('00000000-0000-4000-8000-0000000000e1');
begin
  if (select count(*) from public.offline_allocation_ledger) <> 0
     or (select count(*) from public.offline_devices) <> 0
     or (select count(*) from public.offline_grants) <> 0 then
    raise exception 'A04 BREAK: another user reads the victim''s rows';
  end if;
  v := public.consume_offline_ticket(t, gen_random_uuid());
  if v <> 'offline.ticket_not_found' then raise exception 'A04 BREAK: another user consumed the victim''s ticket (%)', v; end if;
  v := public.release_offline_ticket(t, 'unused_ticket_returned');
  if v <> 'offline.ticket_not_found' then raise exception 'A04 BREAK: another user released the victim''s ticket (%)', v; end if;
  select * into r from public.register_offline_device('shared-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A04: a second account may register the same installation (got %)', r.result; end if;
  select * into g from public.issue_offline_grant('shared-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2
     or g.ticket_ids && (select array_agg(ticket_id) from public.offline_allocation_ledger where user_id = '00000000-0000-4000-8000-0000000000e1') then
    raise exception 'A04 BREAK: the second account re-obtained the first account''s tickets (%, %)', g.result, g.ticket_ids;
  end if;
  if pg_temp.tickets_ever('shared-key') <> 4 then
    raise exception 'A04: two accounts, two budgets, four tickets on one key (got %)', pg_temp.tickets_ever('shared-key');
  end if;
  -- stolen session id of the victim inside this user's claims
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-00000000e101"}', true);
  begin
    v := public.release_offline_ticket(t, 'unused_ticket_returned');
    raise exception 'A04 BREAK: a foreign session id authorised a mutation (%)', v;
  exception when insufficient_privilege then null;
  end;
  begin
    select * into g from public.issue_offline_grant('shared-key', 2);
    raise exception 'A04 BREAK: a foreign session id authorised a grant (%)', g.result;
  exception when insufficient_privilege then null;
  end;
end $$;

-- service_role carrying the victim's sub and live session
select pg_temp.as_owner();
set local role service_role;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000e1';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000000e101"}';
do $$
declare v text;
begin
  begin
    perform public.issue_offline_grant('shared-key', 2);
    raise exception 'A04 BREAK: service_role was issued a grant as the victim';
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.consume_offline_ticket(pg_temp.first_ticket('00000000-0000-4000-8000-0000000000e1'), gen_random_uuid());
    raise exception 'A04 BREAK: service_role consumed as the victim (%)', v;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, installation_key_id)
    select user_id, device_id, grant_id, generation, ticket_id, 'released', 'support_closed', installation_key_id
    from public.offline_allocation_ledger where event = 'allocated' limit 1;
    raise exception 'A04 BREAK: service_role wrote a ledger row';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.offline_allocation_ledger;
    raise exception 'A04 BREAK: service_role deleted ledger rows';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.offline_grants set expires_at = expires_at + interval '30 days';
    raise exception 'A04 BREAK: service_role extended a lease';
  exception when insufficient_privilege then null;
  end;
end $$;

-- the victim still has everything
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
begin
  if public.offline_hold_count() <> 2 or pg_temp.events((select auth.uid())) <> 'allocated:2' then
    raise exception 'A04: the denied attempts changed the victim''s state (hold %, events %)',
      public.offline_hold_count(), pg_temp.events((select auth.uid()));
  end if;
end $$;
rollback;
