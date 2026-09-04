-- Exact SQL repros for the boundary/malformed-input behaviour of the two
-- service-only billing tables, distilled from the seeded harness
-- (boundary_malformed.mjs). Each block asserts the observed outcome so the
-- file doubles as a regression pin: run against a database with the
-- supabase/tests/shim_auth.sql shim + every migration applied.
--
--   psql "$PGURL" -v ON_ERROR_STOP=1 -f supabase/tests/stress/boundary_malformed_repro.sql
--
-- Every block runs inside a transaction that is rolled back, so the database
-- is left exactly as it was found. `\set ON_ERROR_STOP on` makes any
-- unexpected outcome (a write that should have been rejected, a leak, an
-- unexpected SQLSTATE) fail the whole file.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

-- Expected-error helper: runs `stmt` as `who` and asserts it fails with
-- `expected_sqlstate` and writes nothing. Any other SQLSTATE, or success,
-- raises.
create or replace function pg_temp.expect_error(who text, stmt text, expected_sqlstate text)
returns void
language plpgsql
as $$
declare
  got text;
begin
  execute format('set local role %I', who);
  begin
    execute stmt;
    reset role;
    raise exception 'EXPECTED % BUT STATEMENT SUCCEEDED: %', expected_sqlstate, stmt;
  exception
    when others then
      got := sqlstate;
      reset role;
      if got <> expected_sqlstate then
        raise exception 'EXPECTED % GOT % FOR: %', expected_sqlstate, got, stmt;
      end if;
  end;
end $$;

-- Incompressible hex of exactly n characters (so btree/TOAST compression
-- cannot hide a size boundary).
create or replace function pg_temp.randhex(n int)
returns text
language sql
as $$
  select left(string_agg(md5(random()::text), ''), n) from generate_series(1, n / 32 + 1)
$$;

begin;
insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-0000000000a1', 'stress-a@example.com', '{"provider":"apple"}'::jsonb),
       ('00000000-0000-4000-8000-0000000000b2', 'stress-b@example.com', '{"provider":"google"}'::jsonb)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- A. webhook_events (service_role is the only writer)
-- ---------------------------------------------------------------------------
-- A1 malformed / truncated / wrong-type JSON never becomes a row.
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a1-trunc', '{"event":{"id":"x"'::jsonb)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a1-empty', ''::jsonb)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a1-bom', E'\ufeff{}'::jsonb)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a1-nan', '{"n":NaN}'::jsonb)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a1-inf', '{"n":Infinity}'::jsonb)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a1-sq', $j${'a':1}$j$::jsonb)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a1-trail', '{} garbage'::jsonb)$q$, '22P02');
-- A2 \u0000 inside JSON is untranslatable (22P05); a raw NUL byte in any text
--    column is 22021. Neither writes.
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a2-nul', '{"event":{"id":"a\u0000b"}}'::jsonb)$q$, '22P05');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a2-surr', '{"s":"\ud800"}'::jsonb)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values (convert_from('\x610062'::bytea, 'UTF8'), '{}'::jsonb)$q$, '22021');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values (convert_from('\x61fffe62'::bytea, 'UTF8'), '{}'::jsonb)$q$, '22021');
-- A3 numeric overflow: 1e200000 overflows numeric (22003); 1e100000 is
--    accepted and stored as a 100 001-digit numeric; -0 is accepted as 0;
--    deep nesting beyond the parser stack is 54001.
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a3-ovf', '{"n":1e200000}'::jsonb)$q$, '22003');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a3-deep', repeat('[', 100000)::jsonb)$q$, '54001');
do $$
declare
  n int;
begin
  set local role service_role;
  insert into public.webhook_events (id, payload) values ('a3-big', '{"n":1e100000}'::jsonb);
  select length((payload->>'n')) into n from public.webhook_events where id = 'a3-big';
  if n <> 100001 then raise exception 'A3 expected 100001-digit numeric, got %', n; end if;
  insert into public.webhook_events (id, payload) values ('a3-negzero', '{"n":-0}'::jsonb);
  if (select payload->>'n' from public.webhook_events where id = 'a3-negzero') <> '0' then raise exception 'A3 -0 not normalised to 0'; end if;
  reset role;
end $$;
-- A4 id is an opaque byte string: NFC and NFD spellings are DIFFERENT ids
--    (both rows exist), duplicate bytes are 23505 / a no-op under ON CONFLICT.
do $$
declare
  n int;
begin
  set local role service_role;
  insert into public.webhook_events (id, payload) values ('a4-' || E'\u00e9', '{}'::jsonb);
  insert into public.webhook_events (id, payload) values ('a4-' || E'e\u0301', '{}'::jsonb);
  select count(*) into n from public.webhook_events where id like 'a4-%';
  if n <> 2 then raise exception 'A4 expected NFC/NFD ids to be distinct rows, got %', n; end if;
  insert into public.webhook_events (id, payload) values ('a4-' || E'\u00e9', '{"replay":true}'::jsonb) on conflict (id) do nothing;
  if (select payload from public.webhook_events where id = 'a4-' || E'\u00e9') <> '{}'::jsonb then raise exception 'A4 replay overwrote the audit row'; end if;
  reset role;
end $$;
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values ('a4-' || E'\u00e9', '{}'::jsonb)$q$, '23505');
-- A5 size boundaries. No cap exists on id/event_type/app_user_id/payload:
--    the only limit is the primary-key btree (index row > 2704 bytes after
--    compression → 54000). Incompressible ids ≥ ~2700 bytes are rejected;
--    a 65 536-byte event_type and a 1 MiB payload string are ACCEPTED.
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values (pg_temp.randhex(2800), '{}'::jsonb)$q$, '54000');
select pg_temp.expect_error('service_role', $q$insert into public.webhook_events (id, payload) values (pg_temp.randhex(65536), '{}'::jsonb)$q$, '54000');
do $$
begin
  set local role service_role;
  insert into public.webhook_events (id, payload) values (repeat('a', 2700), '{}'::jsonb); -- compressible: accepted
  insert into public.webhook_events (id, event_type, app_user_id, payload)
  values ('a5-wide', pg_temp.randhex(65536), pg_temp.randhex(262144), jsonb_build_object('s', pg_temp.randhex(1048576)));
  if (select octet_length(event_type) from public.webhook_events where id = 'a5-wide') <> 65536 then raise exception 'A5 event_type truncated'; end if;
  if (select octet_length(app_user_id) from public.webhook_events where id = 'a5-wide') <> 262144 then raise exception 'A5 app_user_id truncated'; end if;
  if (select octet_length(payload::text) from public.webhook_events where id = 'a5-wide') < 1048576 then raise exception 'A5 payload truncated'; end if;
  reset role;
end $$;
-- A6 prototype-pollution keys, path traversal, SQL-ish text, control chars,
--    RTL override and 20 000-codepoint single-grapheme strings are inert data.
do $$
declare
  r record;
begin
  set local role service_role;
  insert into public.webhook_events (id, event_type, app_user_id, payload)
  values ('__proto__', '../../etc/passwd', $s$'; drop table public.webhook_events; --$s$, '{"__proto__":{"polluted":true},"constructor":{"prototype":1}}'::jsonb);
  insert into public.webhook_events (id, payload) values (E'\u202eabc\u202c', '{}'::jsonb);
  insert into public.webhook_events (id, payload) values ('e' || repeat(E'\u0301', 20000), '{}'::jsonb);
  select * into r from public.webhook_events where id = '__proto__';
  if r.payload->'__proto__'->>'polluted' <> 'true' then raise exception 'A6 payload lost __proto__ key'; end if;
  if not exists (select 1 from public.webhook_events where id = 'e' || repeat(E'\u0301', 20000)) then raise exception 'A6 combining-heavy id missing'; end if;
  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- B. billing_entitlements (service_role upsert; FK to profiles)
-- ---------------------------------------------------------------------------
-- B1 wrong types are typed rejections, never rows.
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('../../etc/passwd', true)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('__proto__', true)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000a10', true)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000a1 ', true)$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000a1', 'maybe')$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000a1', '2')$q$, '22P02');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000a1', null)$q$, '23502');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium, expires_at) values ('00000000-0000-4000-8000-0000000000a1', true, '2030')$q$, '22007');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium, expires_at) values ('00000000-0000-4000-8000-0000000000a1', true, '1735689600')$q$, '22008');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium, expires_at) values ('00000000-0000-4000-8000-0000000000a1', true, '294277-01-01T00:00:00Z')$q$, '22008');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium, expires_at) values ('00000000-0000-4000-8000-0000000000a1', true, '2030-01-01T00:00:00+99:00')$q$, '22009');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium, expires_at) values ('00000000-0000-4000-8000-0000000000a1', true, 'NaN')$q$, '22007');
-- B2 a uuid with no profiles row is a FK rejection (the edge fn logs this and
--    acknowledges; the state is written on first billing sync).
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-0000-0000-000000000000', true)$q$, '23503');
select pg_temp.expect_error('service_role', $q$insert into public.billing_entitlements (user_id, premium) values (gen_random_uuid(), true)$q$, '23503');
-- B3 Postgres-accepted spellings collapse to the same key: braces, upper-case
--    and dash-less uuids upsert the SAME row; 'yes'/'1'/'  TRUE  ' are true;
--    'infinity'/'-infinity' are valid timestamptz; 64 KiB product_key stored.
do $$
declare
  n int;
begin
  set local role service_role;
  insert into public.billing_entitlements (user_id, premium, expires_at) values ('{00000000-0000-4000-8000-0000000000a1}', 'yes', 'infinity')
  on conflict (user_id) do update set premium = excluded.premium, expires_at = excluded.expires_at;
  insert into public.billing_entitlements (user_id, premium, expires_at) values ('000000000000400080000000000000A1', '  TRUE  ', '-infinity')
  on conflict (user_id) do update set premium = excluded.premium, expires_at = excluded.expires_at;
  insert into public.billing_entitlements (user_id, premium, product_key) values ('00000000-0000-4000-8000-0000000000a1', '1', pg_temp.randhex(65536))
  on conflict (user_id) do update set premium = excluded.premium, product_key = excluded.product_key;
  select count(*) into n from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000a1';
  if n <> 1 then raise exception 'B3 expected one row for user A, got %', n; end if;
  if (select octet_length(product_key) from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000a1') <> 65536 then raise exception 'B3 product_key truncated'; end if;
  reset role;
end $$;

-- ---------------------------------------------------------------------------
-- C. Client roles: authenticated sees only its own billing row; every write
--    to billing_entitlements and every statement on webhook_events is 42501,
--    whatever the payload. Malformed JWT subjects fail the uuid cast (22P02)
--    and therefore match no row.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  set local role service_role;
  insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000b2', false) on conflict (user_id) do nothing;
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
  select count(*) into n from public.billing_entitlements;
  if n <> 1 then raise exception 'C user A should see exactly its own row, saw %', n; end if;
  if exists (select 1 from public.billing_entitlements where user_id <> '00000000-0000-4000-8000-0000000000a1') then raise exception 'C user A saw another user''s row'; end if;
  perform set_config('request.jwt.claim.sub', '{00000000-0000-4000-8000-0000000000b2}', true);
  if (select count(*) from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000b2') <> 1 then raise exception 'C braces spelling of B should resolve to B'; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  if (select count(*) from public.billing_entitlements) <> 0 then raise exception 'C empty sub must see nothing'; end if;
  reset role;
end $$;
select pg_temp.expect_error('authenticated', $q$select set_config('request.jwt.claim.sub', '../../etc/passwd', true); select * from public.billing_entitlements$q$, '22P02');
select pg_temp.expect_error('authenticated', $q$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true); insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000a1', true)$q$, '42501');
select pg_temp.expect_error('authenticated', $q$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true); update public.billing_entitlements set premium = true, expires_at = 'infinity'$q$, '42501');
select pg_temp.expect_error('authenticated', $q$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true); delete from public.billing_entitlements$q$, '42501');
select pg_temp.expect_error('authenticated', $q$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true); select * from public.webhook_events$q$, '42501');
select pg_temp.expect_error('authenticated', $q$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true); insert into public.webhook_events (id, payload) values ('c-auth', '{}'::jsonb)$q$, '42501');
select pg_temp.expect_error('authenticated', $q$select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', true); truncate public.webhook_events$q$, '42501');
select pg_temp.expect_error('anon', $q$select * from public.billing_entitlements$q$, '42501');
select pg_temp.expect_error('anon', $q$insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000a1', true)$q$, '42501');
select pg_temp.expect_error('anon', $q$select * from public.webhook_events$q$, '42501');
select pg_temp.expect_error('anon', $q$insert into public.webhook_events (id, payload) values ('c-anon', '{}'::jsonb)$q$, '42501');

-- ---------------------------------------------------------------------------
-- D. Sweep body from 20260831000000 (pg_cron is unavailable locally, so the
--    scheduled statement is executed verbatim): exactly the rows older than
--    90 days go, boundaries included.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  set local role service_role;
  insert into public.webhook_events (id, payload, received_at) values
    ('d-89d', '{}', now() - interval '89 days 23 hours 59 minutes'),
    ('d-90d-1s', '{}', now() - interval '90 days' + interval '1 second'),
    ('d-90d+1s', '{}', now() - interval '90 days' - interval '1 second'),
    ('d-epoch', '{}', 'epoch'),
    ('d-neginf', '{}', '-infinity'),
    ('d-inf', '{}', 'infinity'),
    ('d-max', '{}', '294276-12-31 23:59:59+00');
  delete from public.webhook_events where received_at < now() - interval '90 days';
  get diagnostics n = row_count;
  if n <> 3 then raise exception 'D sweep deleted % rows, expected 3', n; end if;
  if exists (select 1 from public.webhook_events where id in ('d-90d+1s', 'd-epoch', 'd-neginf')) then raise exception 'D stale rows survived the sweep'; end if;
  if (select count(*) from public.webhook_events where id in ('d-89d', 'd-90d-1s', 'd-inf', 'd-max')) <> 4 then raise exception 'D fresh rows were swept'; end if;
  reset role;
end $$;

rollback;
\o
\echo BOUNDARY-MALFORMED SQL REPROS: ALL ASSERTIONS HELD
