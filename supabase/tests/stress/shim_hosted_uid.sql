-- Stress-harness overlay for supabase/tests/shim_auth.sql.
--
-- Hosted Supabase defines auth.uid() over the JSON claims setting
-- (`request.jwt.claims` ->> 'sub'), falling back to the legacy scalar
-- `request.jwt.claim.sub`. The base shim only reads the legacy scalar, so a
-- client that follows the hosted contract (`set local request.jwt.claims`)
-- would run with auth.uid() = NULL there. This overlay installs the hosted
-- definition so the stress lanes can set `request.jwt.claims` exactly like
-- PostgREST does, while every existing test that sets the scalar keeps
-- working (coalesce order matches the hosted function). The inner nullif
-- matters: a GUC that was SET LOCAL and then rolled back reads back as ''
-- (not NULL), and ''::jsonb raises 22P02 — hosted auth.uid() guards it too.
--
-- Applied AFTER shim_auth.sql and BEFORE the migrations by pg_up.sh.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    ),
    ''
  )::text
$$;
