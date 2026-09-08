-- A07 — nothing ever hands a hold back: lease expiry, device row loss,
-- installation key replacement, account deletion + re-creation through the
-- same sign-in identity, and an unrelated account on the same installation.
--
-- Attack: allocate two tickets under a lease that already expired (owner-side
-- rows dated ten days back — the immutability trigger refuses moving the
-- clock on a live row); then drop the device row; then delete the account and
-- sign the same Apple ID back in on a new installation and on the original
-- one; then put a stranger on the original installation key.
-- Expected: hold stays 2 through every step for the identity; the online
-- path is paywalled; a new installation gets 0 tickets; the original
-- installation recovers exactly its two tickets and can consume one with a
-- fresh shot (scored 1 + hold 1 = 2); the stranger sees, consumes and returns
-- nothing of the victim's and is allotted from their own budget.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(10, 'apple', 'apple-sub-a07-victim');
select pg_temp.atk_user(11, 'google', 'google-sub-a07-stranger');
create temp table a07 (k text primary key, v uuid);
grant all on a07 to authenticated;

-- 1. an expired lease with two outstanding tickets (issued 10 days ago, expired 3 days ago)
select pg_temp.atk_become(10);
do $$
declare g record;
begin
  select * into g from public.register_offline_device('a07-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A07 precondition: registration (%)', g.result; end if;
  insert into a07 values ('dev', g.device_id);
end $$;
select pg_temp.atk_reset();
do $$
declare gid uuid := gen_random_uuid(); t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  dev uuid := (select x.v from a07 x where x.k = 'dev');
begin
  insert into public.offline_grants (id, user_id, device_id, entitlement_source, generation, issued_at, expires_at)
  values (gid, pg_temp.atk_uid(10), dev, 'identity_lifetime_free', 1, now() - interval '10 days', now() - interval '3 days');
  insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, installation_key_id, created_at)
  values (pg_temp.atk_uid(10), dev, gid, 1, t1, 'allocated', 'a07-key', now() - interval '10 days'),
         (pg_temp.atk_uid(10), dev, gid, 1, t2, 'allocated', 'a07-key', now() - interval '10 days');
  insert into a07 values ('t1', t1), ('t2', t2), ('g1', gid);
end $$;

select pg_temp.atk_become(10);
do $$
declare g record; v text; st text;
  t1 uuid := (select x.v from a07 x where x.k = 't1'); t2 uuid := (select x.v from a07 x where x.k = 't2');
begin
  if public.offline_hold_count() <> 2 then raise exception 'A07 BREAK: expired lease reclaimed the hold (%)', public.offline_hold_count(); end if;
  -- online path sees the expired-lease tickets as reserved
  v := (select r.result from public.reserve_analysis_permit('00000000-0000-4000-8000-0000000a0701') r);
  if v <> 'access.paywall_required' then raise exception 'A07 BREAK: online reservation beside an expired lease (%)', v; end if;
  -- the device asks again: same tickets, next generation, nothing new
  select * into g from public.issue_offline_grant('a07-key', 2);
  if g.result <> 'accepted' or g.generation <> 2 or g.ticket_ids <> array[t1, t2] then
    raise exception 'A07 BREAK: re-issue after expiry (%, gen %, %)', g.result, g.generation, g.ticket_ids;
  end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:2' then raise exception 'A07 BREAK: re-issue allocated (%)', pg_temp.atk_events((select auth.uid())); end if;
  -- 2. a second installation of the same account gets nothing
  select * into g from public.register_offline_device('a07-key-2', 'production', true);
  if g.result <> 'accepted' then raise exception 'A07: second device (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a07-key-2', 2);
  if g.result <> 'access.paywall_required' then raise exception 'A07 BREAK: second installation allotted (%, %)', g.result, g.ticket_ids; end if;
  select * into g from public.issue_offline_grant('a07-key-2', 0);
  if g.result <> 'access.paywall_required' then raise exception 'A07 BREAK: second installation refresh (%, %)', g.result, g.ticket_ids; end if;
end $$;
select pg_temp.atk_reset();

-- 3. the device row disappears (owner-side delete, e.g. an admin cleanup) — the ledger does not
delete from public.offline_devices where id = (select x.v from a07 x where x.k = 'dev');
do $$
declare n integer;
begin
  select count(*) into n from public.offline_grants where id = (select x.v from a07 x where x.k = 'g1');
  if n <> 0 then raise exception 'A07: grant survived its device (%)', n; end if;
  select count(*) into n from public.offline_allocation_ledger where installation_key_id = 'a07-key';
  if n <> 2 then raise exception 'A07 BREAK: ledger rows cascaded with the device (%)', n; end if;
end $$;
select pg_temp.atk_become(10);
do $$
declare g record; v text;
  t1 uuid := (select x.v from a07 x where x.k = 't1'); t2 uuid := (select x.v from a07 x where x.k = 't2');
begin
  if public.offline_hold_count() <> 2 then raise exception 'A07 BREAK: device deletion reclaimed the hold (%)', public.offline_hold_count(); end if;
  select * into g from public.issue_offline_grant('a07-key', 2);
  if g.result <> 'offline.device_not_registered' then raise exception 'A07: unregistered key (%)', g.result; end if;
  select * into g from public.register_offline_device('a07-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A07: re-registration (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a07-key', 2);
  if g.result <> 'accepted' or g.generation <> 1 or g.ticket_ids <> array[t1, t2] then
    raise exception 'A07 BREAK: re-registered installation (%, gen %, %)', g.result, g.generation, g.ticket_ids;
  end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:2' then raise exception 'A07 BREAK: re-registration allocated (%)', pg_temp.atk_events((select auth.uid())); end if;
end $$;
select pg_temp.atk_reset();

-- 4. account deletion (Auth admin deleteUser cascade) and re-creation through the same Apple ID
delete from auth.users where id = pg_temp.atk_uid(10);
do $$
declare n integer;
begin
  select count(*) into n from public.offline_devices where user_id = pg_temp.atk_uid(10);
  if n <> 0 then raise exception 'A07: devices survived the account'; end if;
  select count(*) into n from public.offline_allocation_ledger where user_id = pg_temp.atk_uid(10);
  if n <> 2 then raise exception 'A07 BREAK: ledger rows cascaded with the account (%)', n; end if;
  select count(*) into n from public.offline_ticket_identities where ticket_id in (select x.v from a07 x where x.k in ('t1', 't2'));
  if n <> 2 then raise exception 'A07 BREAK: identity bindings lost (%)', n; end if;
end $$;
select pg_temp.atk_user(12, 'apple', 'apple-sub-a07-victim');
select pg_temp.atk_become(12);
do $$
declare g record; v text; st text; shot uuid := '00000000-0000-4000-8000-0000000a0702';
  t1 uuid := (select x.v from a07 x where x.k = 't1'); t2 uuid := (select x.v from a07 x where x.k = 't2');
begin
  if public.offline_hold_count() <> 2 then raise exception 'A07 BREAK: re-created account sees hold % (expected 2)', public.offline_hold_count(); end if;
  v := (select r.result from public.reserve_analysis_permit('00000000-0000-4000-8000-0000000a0703') r);
  if v <> 'access.paywall_required' then raise exception 'A07 BREAK: re-created account reserved online (%)', v; end if;
  -- fresh installation: nothing
  select * into g from public.register_offline_device('a07-key-3', 'production', true);
  if g.result <> 'accepted' then raise exception 'A07: key-3 (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a07-key-3', 2);
  if g.result <> 'access.paywall_required' then raise exception 'A07 BREAK: re-created account allotted on a new installation (%, %)', g.result, g.ticket_ids; end if;
  -- original installation: exactly its two tickets
  select * into g from public.register_offline_device('a07-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A07: original key (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a07-key', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[t1, t2] then
    raise exception 'A07 BREAK: original installation recovery (%, %)', g.result, g.ticket_ids;
  end if;
  if pg_temp.atk_events((select auth.uid())) <> '' then raise exception 'A07 BREAK: recovery wrote allocations for the new account (%)', pg_temp.atk_events((select auth.uid())); end if;
end $$;
select pg_temp.atk_reset();
-- a durably delivered offline result (owner-side write: the client-side scored
-- shot gate of 20260905000000 still requires a live permit, so the shot row
-- for an offline ticket can only come from a server-owned sync path)
do $$
declare st text;
begin
  st := pg_temp.atk_direct_shot('00000000-0000-4000-8000-0000000a0702', pg_temp.atk_uid(12));
  if st is not null then raise exception 'A07: owner-side shot insert (%)', st; end if;
end $$;
select pg_temp.atk_become(12);
do $$
declare g record; v text; shot uuid := '00000000-0000-4000-8000-0000000a0702';
  t1 uuid := (select x.v from a07 x where x.k = 't1'); t2 uuid := (select x.v from a07 x where x.k = 't2');
begin
  -- consume one with the fresh offline shot: scored 1 + hold 1 = 2
  v := public.consume_offline_ticket(t1, shot);
  if v <> 'accepted' then raise exception 'A07 BREAK: recovered ticket not consumable (%)', v; end if;
  if public.offline_hold_count() <> 1 then raise exception 'A07 BREAK: hold after consume %', public.offline_hold_count(); end if;
  if public.lifetime_scored_count() <> 1 then raise exception 'A07 BREAK: lifetime scored %', public.lifetime_scored_count(); end if;
  v := (select r.result from public.reserve_analysis_permit('00000000-0000-4000-8000-0000000a0704') r);
  if v <> 'access.paywall_required' then raise exception 'A07 BREAK: online reservation after recovery (%)', v; end if;
  select * into g from public.issue_offline_grant('a07-key-3', 2);
  if g.result <> 'access.paywall_required' then raise exception 'A07 BREAK: new installation after recovery (%, %)', g.result, g.ticket_ids; end if;
  -- the same shot cannot settle the second ticket
  v := public.consume_offline_ticket(t2, shot);
  if v <> 'offline.shot_not_chargeable' then raise exception 'A07 BREAK: one shot settled two tickets (%)', v; end if;
end $$;
select pg_temp.atk_reset();

-- 5. a stranger on the original installation key
select pg_temp.atk_become(11);
do $$
declare g record; v text; n integer;
  t1 uuid := (select x.v from a07 x where x.k = 't1'); t2 uuid := (select x.v from a07 x where x.k = 't2');
begin
  if public.offline_hold_count() <> 0 then raise exception 'A07 BREAK: stranger inherits a hold (%)', public.offline_hold_count(); end if;
  select * into g from public.register_offline_device('a07-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A07: stranger registration (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a07-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 or g.ticket_ids && array[t1, t2] then
    raise exception 'A07 BREAK: stranger on the victim''s installation (%, %)', g.result, g.ticket_ids;
  end if;
  v := public.consume_offline_ticket(t2, '00000000-0000-4000-8000-0000000a0705');
  if v <> 'offline.ticket_not_found' then raise exception 'A07 BREAK: stranger reached the victim''s ticket (%)', v; end if;
  v := public.release_offline_ticket(t2, 'unused_ticket_returned');
  if v <> 'offline.ticket_not_found' then raise exception 'A07 BREAK: stranger released the victim''s ticket (%)', v; end if;
  select count(*) into n from public.offline_allocation_ledger; if n <> 2 then raise exception 'A07 BREAK: stranger sees % ledger rows', n; end if;
end $$;
select pg_temp.atk_reset();

-- the victim's second ticket is still theirs and still counted
select pg_temp.atk_become(12);
do $$
declare v text; t2 uuid := (select x.v from a07 x where x.k = 't2');
begin
  if public.offline_hold_count() <> 1 then raise exception 'A07 BREAK: stranger changed the victim''s hold (%)', public.offline_hold_count(); end if;
  v := public.release_offline_ticket(t2, 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A07 BREAK: victim cannot return their ticket (%)', v; end if;
  if public.offline_hold_count() <> 1 then raise exception 'A07 BREAK: return re-credited (%)', public.offline_hold_count(); end if;
end $$;
select pg_temp.atk_reset();
do $$
declare n integer;
begin
  select count(*) into n from public.offline_allocation_ledger where ticket_id in (select x.v from a07 x where x.k in ('t1', 't2'));
  if n <> 4 then raise exception 'A07: expected 4 ledger rows for the victim''s tickets, found %', n; end if;
end $$;
rollback;
\echo A07 PASS: no reclaim through expiry, device loss, deletion, re-creation; stranger isolated
