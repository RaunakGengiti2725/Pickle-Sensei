-- PostgREST >= 9 publishes the verified JWT as the JSON GUC
-- `request.jwt.claims`; the RLS shim's auth.uid() (shim_auth.sql) reads only
-- the legacy per-claim GUC `request.jwt.claim.sub`. Hosted Supabase defines
-- auth.uid() to read BOTH (supabase/postgres `auth.uid()`), so the harness
-- installs that definition on top of the shim before PostgREST is used.
-- Purely additive: psql-driven tests that `set local request.jwt.claim.sub`
-- keep working.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
