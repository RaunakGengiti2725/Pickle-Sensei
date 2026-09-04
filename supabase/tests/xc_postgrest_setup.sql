-- Test-only wiring so a real PostgREST can attach to the throwaway database
-- AFTER xc_cross_user_isolation.sql has seeded it. Never applied anywhere else.
--
-- * `authenticator` is PostgREST's login role; it switches to the JWT `role`
--   claim exactly like the hosted platform (anon / authenticated / service_role).
-- * PostgREST ≥ v9 publishes claims as the JSON GUC `request.jwt.claims`; the
--   shim's auth.uid() reads the legacy `request.jwt.claim.sub`. Replace it
--   with the hosted definition, which reads both, so the SQL harness and the
--   HTTP plane resolve the same identity.
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'xc-postgrest-throwaway';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

-- Snapshot every seeded owner so the runner can prove the HTTP plane changed
-- nothing it was not allowed to.
create table if not exists xc.http_before as
select name, id, xc.snapshot(id) as snap from xc.ids
where name in ('alice', 'bob', 'dave') or name like 'pool_%';
