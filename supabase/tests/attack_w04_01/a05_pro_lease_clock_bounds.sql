-- ATTACK A05 — Pro lease against the clock: an entitlement that expires in
-- seconds, exactly now, in the past, at 'infinity', far in the future; the
-- entitlement being shortened / revoked between generations; and a Pro user
-- who still holds free tickets from before the purchase. Invariant: every
-- lease row satisfies issued < expires ≤ issued + 7d and ≤ the entitlement
-- expiry verified AT ISSUE; a lease is never extended after the fact.
begin;
\ir _setup.sql

insert into public.billing_entitlements (user_id, premium, expires_at) values
  ('00000000-0000-4000-8000-0000000000e1', true, now() + interval '3 seconds'),
  ('00000000-0000-4000-8000-0000000000e2', true, 'infinity'),
  ('00000000-0000-4000-8000-0000000000e3', true, now());

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('e1-key', 'production', true);
  select * into g from public.issue_offline_grant('e1-key', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'verified_store'
     or g.expires_at <> g.entitlement_expires_at or g.expires_at - g.issued_at <> interval '3 seconds'
     or coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then
    raise exception 'A05: a 3-second entitlement yields a 3-second lease and no tickets (got %, %, %, %, %)',
      g.result, g.entitlement_source, g.issued_at, g.expires_at, g.ticket_ids;
  end if;
end $$;

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000e201');
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('e2-key', 'production', true);
  select * into g from public.issue_offline_grant('e2-key', 2);
  if g.result <> 'accepted' or g.expires_at - g.issued_at <> interval '7 days' or g.entitlement_expires_at <> 'infinity' then
    raise exception 'A05: an infinite entitlement is capped at 7 days (got % → %, %)', g.issued_at, g.expires_at, g.entitlement_expires_at;
  end if;
end $$;

-- expires_at = now(): NOT premium (same predicate as effectivePremium) → free path
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000e301');
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('e3-key', 'production', true);
  select * into g from public.issue_offline_grant('e3-key', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A05: an entitlement expiring exactly now is not Pro (got %, %, %)', g.result, g.entitlement_source, g.ticket_ids;
  end if;
end $$;

-- Entitlement shortened, then revoked, between generations.
select pg_temp.as_owner();
update public.billing_entitlements set expires_at = now() + interval '30 days' where user_id = '00000000-0000-4000-8000-0000000000e2';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000e201');
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('e2-key', 2);
  if g.generation <> 2 or g.expires_at - g.issued_at <> interval '7 days' then
    raise exception 'A05: 30-day entitlement → 7-day lease (got gen %, % → %)', g.generation, g.issued_at, g.expires_at;
  end if;
end $$;
select pg_temp.as_owner();
update public.billing_entitlements set expires_at = now() + interval '1 hour' where user_id = '00000000-0000-4000-8000-0000000000e2';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000e201');
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('e2-key', 2);
  if g.generation <> 3 or g.expires_at - g.issued_at <> interval '1 hour' or g.entitlement_expires_at <> g.expires_at then
    raise exception 'A05: a shortened entitlement shortens the next lease (got gen %, % → %, ent %)', g.generation, g.issued_at, g.expires_at, g.entitlement_expires_at;
  end if;
end $$;
select pg_temp.as_owner();
update public.billing_entitlements set premium = false where user_id = '00000000-0000-4000-8000-0000000000e2';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000e201');
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('e2-key', 2);
  if g.entitlement_source <> 'identity_lifetime_free' or g.generation <> 4 then
    raise exception 'A05: a revoked entitlement falls back to the free path on the next generation (got %, gen %)', g.entitlement_source, g.generation;
  end if;
  -- Every lease ever written obeys the bounds and no earlier lease moved.
  if exists (
    select 1 from public.offline_grants
    where not (expires_at > issued_at and expires_at <= issued_at + interval '7 days'
               and (entitlement_expires_at is null or expires_at <= entitlement_expires_at))
  ) then
    raise exception 'A05 BREAK: a lease row violates the bounds';
  end if;
  if (select count(*) from public.offline_grants where entitlement_source = 'verified_store'
        and expires_at - issued_at not in (interval '7 days', interval '1 hour')) <> 0 then
    raise exception 'A05 BREAK: an earlier Pro lease was rewritten';
  end if;
end $$;

-- A free-era ticket survives a purchase and its expiry: not re-credited, not lost.
select pg_temp.as_owner();
update public.billing_entitlements set premium = true, expires_at = now() + interval '1 day' where user_id = '00000000-0000-4000-8000-0000000000e3';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000e301');
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('e3-key', 2);
  if g.entitlement_source <> 'verified_store' or coalesce(array_length(g.ticket_ids, 1), 0) <> 0 then
    raise exception 'A05: Pro leases carry no tickets (got %, %)', g.entitlement_source, g.ticket_ids;
  end if;
  if public.offline_hold_count() <> 2 then
    raise exception 'A05 BREAK: the purchase changed the free holds (hold %)', public.offline_hold_count();
  end if;
end $$;
select pg_temp.as_owner();
update public.billing_entitlements set expires_at = now() - interval '1 second' where user_id = '00000000-0000-4000-8000-0000000000e3';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000e301');
do $$
declare g record;
begin
  select * into g from public.issue_offline_grant('e3-key', 2);
  if g.entitlement_source <> 'identity_lifetime_free' or array_length(g.ticket_ids, 1) <> 2 or pg_temp.tickets_ever('e3-key') <> 2 then
    raise exception 'A05 BREAK: after Pro lapses the SAME two tickets come back, none new (got %, %, ever %)',
      g.entitlement_source, g.ticket_ids, pg_temp.tickets_ever('e3-key');
  end if;
end $$;
rollback;
