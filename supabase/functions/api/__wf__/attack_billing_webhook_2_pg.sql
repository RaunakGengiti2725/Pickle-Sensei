-- ADVERSARIAL TESTER #2 (pass 3) — PG16 acceptance of the expires_date strings
-- the edge function forwards VERBATIM into billing_entitlements.expires_at
-- (index.ts persistBillingVerdict sends verdict.expiresAt unnormalised).
--
-- Run via attack_billing_webhook_2_pg.sh (Docker postgres:16 + all migrations).
-- Every statement that is EXPECTED to fail is wrapped so the script keeps going
-- and the outcome is reported as a row; the harness asserts on the report.

\set ON_ERROR_STOP on
set client_min_messages = warning;

create temp table probe_result (
  label text primary key,
  literal text,
  accepted boolean,
  stored timestamptz,
  sqlstate text,
  sqlerrm text
);

create or replace function pg_temp.probe(p_label text, p_literal text) returns void
language plpgsql as $$
declare v timestamptz;
begin
  begin
    v := p_literal::timestamptz;
    insert into probe_result values (p_label, p_literal, true, v, null, null);
  exception when others then
    insert into probe_result values (p_label, p_literal, false, null, sqlstate, sqlerrm);
  end;
end $$;

-- S1: the assigned literal.
select pg_temp.probe('S1 legacy GMT', 'Dec 31 2099 00:00:00 GMT');
-- RevenueCat's documented format (ISO 8601, what activeSubscriber() emits).
select pg_temp.probe('ISO Z', '2030-01-01T00:00:00Z');
select pg_temp.probe('ISO ms Z', '2030-01-01T00:00:00.000Z');
-- Other strings V8 Date.parse accepts (so the server treats them as ACTIVE).
select pg_temp.probe('Date#toString', 'Sun Dec 31 2099 00:00:00 GMT+0000 (Coordinated Universal Time)');
select pg_temp.probe('Date#toUTCString', 'Sun, 31 Dec 2099 00:00:00 GMT');
select pg_temp.probe('US slash', '12/31/2099');
select pg_temp.probe('ISO no tz', '2099-12-31T00:00:00');
select pg_temp.probe('year only', '2099');
select pg_temp.probe('ISO +05:30', '2099-12-31T00:00:00+05:30');
-- V8 REJECTS these (server would persist premium:false), PG opinion for the record.
select pg_temp.probe('month 13', '2030-13-45T00:00:00Z');
select pg_temp.probe('epoch ms as text', '4102444800000');

-- The real column, through the real table (FK → profiles → auth.users).
insert into auth.users (id, email) values ('11111111-1111-4111-8111-111111111111', 'attack@example.test')
  on conflict (id) do nothing;
insert into public.profiles (id) values ('11111111-1111-4111-8111-111111111111')
  on conflict (id) do nothing;

do $$
begin
  insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
  values ('11111111-1111-4111-8111-111111111111', true, 'pickle_sensei_pro_lifetime',
          'Dec 31 2099 00:00:00 GMT', now())
  on conflict (user_id) do update
    set premium = excluded.premium, product_key = excluded.product_key,
        expires_at = excluded.expires_at, verified_at = excluded.verified_at;
  insert into probe_result values ('S1 real upsert', 'Dec 31 2099 00:00:00 GMT', true,
    (select expires_at from public.billing_entitlements where user_id = '11111111-1111-4111-8111-111111111111'),
    null, null);
exception when others then
  insert into probe_result values ('S1 real upsert', 'Dec 31 2099 00:00:00 GMT', false, null, sqlstate, sqlerrm);
end $$;

-- Does the DB-side premium predicate agree with the server's Date.parse verdict?
-- (access_state() treats expires_at IS NULL OR expires_at > now() as active.)
select 'S1 predicate' as label,
       (select expires_at is null or expires_at > now()
          from public.billing_entitlements
         where user_id = '11111111-1111-4111-8111-111111111111') as active_in_db;

-- webhook_events.id is text with NO length cap: an 8 KB / NUL-free id is a valid PK.
do $$
begin
  insert into public.webhook_events (id, event_type, app_user_id, payload)
  values (repeat('e', 8192), 'RENEWAL', null, '{}'::jsonb);
  insert into probe_result values ('X1 8KB event id', '<8192 x e>', true, null, null, null);
exception when others then
  insert into probe_result values ('X1 8KB event id', '<8192 x e>', false, null, sqlstate, sqlerrm);
end $$;

-- A NUL byte inside the id (the server forwards it verbatim, X1 in the deno file).
do $$
begin
  insert into public.webhook_events (id, event_type, app_user_id, payload)
  values (convert_from('\x6576742d002d6e756c'::bytea, 'UTF8'), 'RENEWAL', null, '{}'::jsonb);
  insert into probe_result values ('X1 NUL in event id', 'evt-\0-nul', true, null, null, null);
exception when others then
  insert into probe_result values ('X1 NUL in event id', 'evt-\0-nul', false, null, sqlstate, sqlerrm);
end $$;

select label, literal, accepted, stored, sqlstate, sqlerrm
  from probe_result
 order by label;

-- Pin the OBSERVED PG16 behaviour so a change in either direction is loud.
do $$
declare
  bad text;
begin
  select string_agg(label, ', ') into bad from probe_result
   where (label in ('S1 legacy GMT', 'S1 real upsert', 'ISO Z', 'ISO ms Z', 'Date#toUTCString',
                    'X1 8KB event id') and not accepted)
      or (label in ('Date#toString', 'year only', 'month 13', 'X1 NUL in event id') and accepted);
  if bad is not null then
    raise exception 'PG16 acceptance differs from the pinned matrix for: %', bad;
  end if;
  if not (select stored = '2099-12-31 00:00:00+00'::timestamptz
            from probe_result where label = 'S1 real upsert') then
    raise exception 'S1: legacy GMT literal did not round-trip to 2099-12-31T00:00:00Z';
  end if;
end $$;
