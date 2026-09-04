-- Adjudication: real postgres:16 + real migrations.
-- (1) uppercase uuid text folds onto the same billing_entitlements row
-- (2) FK violation vs transient error are both surfaced only as an error string
--     to the edge fn (both go down the same "persist failed → 200" branch)
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'victim@example.com');
insert into public.profiles (id) values ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  on conflict do nothing;
-- verified premium row written by a legitimate sync (lowercase canonical id)
insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
values ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', true, 'pickle_sensei_pro_annual', now() + interval '30 days', now());

-- what the webhook does for app_user_id = UPPERCASE variant (RevenueCat answered premium:false for the unknown subject)
insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
values ('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', false, null, null, now())
on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key,
  expires_at = excluded.expires_at, verified_at = excluded.verified_at;

select 'rows_for_victim' as k, count(*) as v from public.billing_entitlements
  where user_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
union all
select 'victim_premium_after_uppercase_upsert', (select premium::int from public.billing_entitlements
  where user_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

do $$
begin
  if (select premium from public.billing_entitlements where user_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') then
    raise exception 'uppercase upsert did NOT fold onto the lowercase row';
  end if;
  raise notice 'CONFIRMED: uppercase uuid upsert revoked the lowercase victim row (premium=false)';
end $$;
rollback;

-- FK: an unbootstrapped user (no profiles row) → 23503
begin;
do $$
begin
  insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values ('bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', true, 'x', now() + interval '1 day', now());
  raise exception 'expected FK violation';
exception when foreign_key_violation then
  raise notice 'CONFIRMED: unbootstrapped user → SQLSTATE 23503 (%), this is the case the persist-failed branch was written for', sqlerrm;
end $$;
rollback;
