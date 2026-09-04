-- Stress-only additions on top of supabase/tests/shim_auth.sql. Applied AFTER
-- every migration by pg_up.sh; never part of run_rls_tests.sh.
--
-- auth.uid() in the base shim reads only `request.jwt.claim.sub`. Hosted
-- Supabase's definition also reads the `sub` member of the JSON GUC
-- `request.jwt.claims` (the form PostgREST sets). The harness drives both
-- claim styles, so mirror the hosted shape here (INFERRED from the
-- supabase/postgres auth schema migration 20211115181400; both branches are
-- exercised by the harness).
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
