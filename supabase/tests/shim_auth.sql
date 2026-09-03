-- Minimal Supabase shim for running the migrations + RLS tests against a
-- plain Postgres (supabase/tests/run_rls_tests.sh). Mirrors the pieces the
-- migrations depend on: the auth schema/users table, auth.uid(), and the
-- anon / authenticated / service_role roles.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb
);

-- One row per provider identity (the columns the migrations read; hosted
-- shape as of GoTrue 2.x). provider_id is the provider's stable subject —
-- Apple team-scoped `sub` / Google account `sub` — and cascades away with the
-- user exactly like production, which is what the identity ledger cases in
-- security_regression.sql rely on.
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null default '{}'::jsonb,
  provider text not null,
  email text generated always as (lower(identity_data ->> 'email')) stored,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint identities_provider_id_provider_unique unique (provider_id, provider)
);
create index if not exists identities_user_id_idx on auth.identities (user_id);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Hosted Supabase configures default privileges that grant broad table
-- rights to the client roles for every new object; migrations must REVOKE
-- their way to least privilege. Mirror that here so a missing revoke fails
-- the matrix instead of passing vacuously.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
