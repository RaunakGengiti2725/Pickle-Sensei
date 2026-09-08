-- A06 — Pro lease boundaries and clock games.
--
-- Attack: issue Pro leases against entitlements that expire in 3 days, in
-- 30 days, never, at +7 days exactly, in 1 second, at 'infinity', at
-- 2999-12-31, and against a stored premium=true row whose expires_at is in
-- the past or that has premium=false; flip the entitlement between issues;
-- try to stretch or shift a lease through the table; ask for tickets as Pro.
-- Expected: expires_at = min(issued_at + 7 days, entitlement expiry) exactly,
-- entitlement_expires_at recorded verbatim, no tickets for Pro, an expired or
-- absent entitlement falls back to the free path, leases immutable, and
-- every lease row ever written satisfies both bounds.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(9, 'apple', 'apple-sub-a06');
create temp table a06 (k text primary key, v uuid);
grant all on a06 to authenticated;

-- definer: stands in for the edge function's service-role billing sync
create function pg_temp.a06_entitle(p_premium boolean, p_expires timestamptz) returns void
language plpgsql security definer as $$
begin
  insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
  values (pg_temp.atk_uid(9), p_premium, p_expires, clock_timestamp())
  on conflict (user_id) do update
    set premium = excluded.premium, expires_at = excluded.expires_at, verified_at = excluded.verified_at;
end $$;

create function pg_temp.a06_lease(p_label text, p_expect_lease interval, p_expect_entitlement timestamptz) returns void
language plpgsql as $$
declare g record;
begin
  select * into g from public.issue_offline_grant('a06-key', 2);
  if g.result <> 'accepted' then raise exception 'A06 BREAK [%]: Pro lease refused (%)', p_label, g.result; end if;
  if g.entitlement_source <> 'verified_store' then raise exception 'A06 BREAK [%]: source %', p_label, g.entitlement_source; end if;
  if coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then raise exception 'A06 BREAK [%]: Pro lease handed tickets %', p_label, g.ticket_ids; end if;
  if g.expires_at <> g.issued_at + p_expect_lease then
    raise exception 'A06 BREAK [%]: lease is % (issued %, expires %), expected %', p_label, g.expires_at - g.issued_at, g.issued_at, g.expires_at, p_expect_lease;
  end if;
  if g.entitlement_expires_at is distinct from p_expect_entitlement then
    raise exception 'A06 BREAK [%]: entitlement expiry recorded as %, expected %', p_label, g.entitlement_expires_at, p_expect_entitlement;
  end if;
  if g.expires_at > g.issued_at + interval '7 days' then raise exception 'A06 BREAK [%]: lease > 7 days', p_label; end if;
  if g.entitlement_expires_at is not null and g.expires_at > g.entitlement_expires_at then
    raise exception 'A06 BREAK [%]: lease past entitlement', p_label;
  end if;
  if g.expires_at <= g.issued_at then raise exception 'A06 BREAK [%]: lease does not extend past issue', p_label; end if;
  if g.issued_at <> now() then raise exception 'A06 BREAK [%]: issued_at % is not the transaction clock', p_label, g.issued_at; end if;
end $$;
grant execute on function pg_temp.a06_lease(text, interval, timestamptz), pg_temp.a06_entitle(boolean, timestamptz) to authenticated;

select pg_temp.atk_become(9);
do $$
declare g record; v text;
begin
  select * into g from public.register_offline_device('a06-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A06 precondition: registration (%)', g.result; end if;
  insert into a06 values ('dev', g.device_id);
end $$;

-- entitlement 3 days out → lease ends at entitlement expiry
select pg_temp.a06_entitle(true, now() + interval '3 days');
select pg_temp.a06_lease('3d', interval '3 days', now() + interval '3 days');
-- 30 days out → 7 days
select pg_temp.a06_entitle(true, now() + interval '30 days');
select pg_temp.a06_lease('30d', interval '7 days', now() + interval '30 days');
-- exactly +7 days → 7 days
select pg_temp.a06_entitle(true, now() + interval '7 days');
select pg_temp.a06_lease('7d', interval '7 days', now() + interval '7 days');
-- 7 days minus one microsecond → strictly shorter than 7 days
select pg_temp.a06_entitle(true, now() + interval '7 days' - interval '1 microsecond');
select pg_temp.a06_lease('7d-1us', interval '7 days' - interval '1 microsecond', now() + interval '7 days' - interval '1 microsecond');
-- 1 second out → 1 second lease
select pg_temp.a06_entitle(true, now() + interval '1 second');
select pg_temp.a06_lease('1s', interval '1 second', now() + interval '1 second');
-- lifetime (no expiry) → 7 days, entitlement expiry null
select pg_temp.a06_entitle(true, null);
select pg_temp.a06_lease('lifetime', interval '7 days', null);
-- far-future provider clock → still 7 days
select pg_temp.a06_entitle(true, timestamptz '2999-12-31 23:59:59+00');
select pg_temp.a06_lease('2999', interval '7 days', timestamptz '2999-12-31 23:59:59+00');
select pg_temp.a06_entitle(true, 'infinity');
select pg_temp.a06_lease('infinity', interval '7 days', 'infinity');

-- stored premium=true past its expiry is NOT premium: free path, tickets, no Pro lease
select pg_temp.a06_entitle(true, now() - interval '1 second');
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('a06-key', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' or array_length(g.ticket_ids, 1) <> 2
     or g.entitlement_expires_at is not null or g.expires_at <> g.issued_at + interval '7 days' then
    raise exception 'A06 BREAK: expired Pro entitlement (%, %, %, %)', g.result, g.entitlement_source, g.ticket_ids, g.entitlement_expires_at;
  end if;
  insert into a06 values ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
end $$;
-- premium=false with a future expiry → free path, re-issues the same tickets
select pg_temp.a06_entitle(false, now() + interval '30 days');
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('a06-key', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free'
     or g.ticket_ids <> array(select x.v from a06 x where x.k in ('t1', 't2') order by x.k) then
    raise exception 'A06 BREAK: premium=false (%, %, %)', g.result, g.entitlement_source, g.ticket_ids;
  end if;
end $$;
-- back to Pro: lease, no tickets; the free holds are untouched (never reclaimed)
select pg_temp.a06_entitle(true, now() + interval '2 days');
select pg_temp.a06_lease('re-pro', interval '2 days', now() + interval '2 days');
do $$
declare v text; t1 uuid := (select x.v from a06 x where x.k = 't1');
begin
  if public.offline_hold_count() <> 2 then raise exception 'A06 BREAK: Pro flip changed the hold (%)', public.offline_hold_count(); end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:2' then raise exception 'A06 BREAK: ledger %', pg_temp.atk_events((select auth.uid())); end if;
  -- the ticket is still the caller's while Pro: release and consume paths answer
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A06 BREAK: Pro user cannot return their own free ticket (%)', v; end if;
end $$;
select pg_temp.atk_reset();

-- every lease ever written satisfies both bounds, and none can be stretched or moved
do $$
declare n integer; st text; dev uuid := (select x.v from a06 x where x.k = 'dev');
begin
  select count(*) into n from public.offline_grants
  where expires_at > issued_at + interval '7 days'
     or expires_at <= issued_at
     or (entitlement_expires_at is not null and expires_at > entitlement_expires_at)
     or (entitlement_source = 'identity_lifetime_free' and entitlement_expires_at is not null);
  if n <> 0 then raise exception 'A06 BREAK: % lease rows violate the bounds', n; end if;
  select count(*) into n from public.offline_grants where device_id = dev;
  if n <> 11 then raise exception 'A06: expected 11 grants, found %', n; end if;
  select count(distinct generation) into n from public.offline_grants where device_id = dev;
  if n <> 11 then raise exception 'A06 BREAK: generations are not unique per device'; end if;
  st := pg_temp.atk_try('update public.offline_grants set expires_at = expires_at + interval ''1 second''');
  if st is distinct from '23514' then raise exception 'A06 BREAK: lease stretched (%)', st; end if;
  st := pg_temp.atk_try('update public.offline_grants set issued_at = issued_at - interval ''1 day''');
  if st is distinct from '23514' then raise exception 'A06 BREAK: lease shifted (%)', st; end if;
  st := pg_temp.atk_try('update public.offline_grants set entitlement_expires_at = null');
  if st is distinct from '23514' then raise exception 'A06 BREAK: entitlement expiry erased (%)', st; end if;
  -- an owner-side write of a Pro lease that disagrees with the verified entitlement is refused
  perform pg_temp.a06_entitle(true, now() + interval '3 days');
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values (%L, %L, 'verified_store', 99, now(), now() + interval '5 days', now() + interval '5 days')$q$, pg_temp.atk_uid(9), dev));
  if st is distinct from '23514' then raise exception 'A06 BREAK: Pro lease with a forged entitlement expiry stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values (%L, %L, 'verified_store', 99, now() - interval '5 days', now() + interval '2 days 1 second', now() + interval '3 days')$q$, pg_temp.atk_uid(9), dev));
  if st is distinct from '23514' then raise exception 'A06 BREAK: back-dated Pro lease longer than 7 days stored (%)', st; end if;
  perform pg_temp.a06_entitle(true, now() - interval '1 second');
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
    values (%L, %L, 'verified_store', 99, now() - interval '3 days', now() - interval '1 second', now() - interval '1 second')$q$, pg_temp.atk_uid(9), dev));
  if st is distinct from '23514' then raise exception 'A06 BREAK: Pro lease on an expired entitlement stored (%)', st; end if;
end $$;
rollback;
\echo A06 PASS: Pro leases bounded by 7 days and verified entitlement expiry
