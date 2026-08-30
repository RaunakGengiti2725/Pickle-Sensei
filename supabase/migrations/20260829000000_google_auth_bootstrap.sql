-- ============================================================================
-- Pickle Sensei — Supabase auth backing for Google (and Apple) sign-in.
--
-- Paste this whole file into the Supabase SQL editor (or run
-- `supabase db push` from the repo root). It is idempotent-safe on a fresh
-- project and additive-only: it never touches the managed `auth` schema
-- beyond a trigger on `auth.users` (the supported extension point).
--
-- What it creates:
--   1. public.profiles           — one row per auth.users row (canonical
--                                  account the app's bootstrap contract
--                                  returns; id IS the auth.users uuid).
--   2. auto-provisioning trigger — inserts the profile at signup, capturing
--                                  email / name / avatar from the provider.
--   3. updated_at trigger        — bookkeeping.
--   4. Row Level Security        — owners read/update ONLY their row;
--                                  clients can never insert/delete profiles
--                                  (the definer trigger owns creation).
--
-- NOTE (honest limits of SQL): enabling the Google provider itself is a
-- Dashboard step, not SQL — see supabase/README.md section 2. Nothing in
-- SQL can turn a provider on.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Canonical profile table (the app's CanonicalAccount)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  -- Last identity provider that authenticated this account.
  provider text not null default 'unknown',
  -- The app's bootstrap contract: 'pending' until onboarding completes.
  onboarding_state text not null default 'pending'
    check (onboarding_state in ('pending', 'complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Canonical Pickle Sensei account row, 1:1 with auth.users. id doubles as the canonicalAppUserId the mobile app receives from /v1/account/bootstrap.';

create index if not exists profiles_email_idx on public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- 2. Auto-provision a profile whenever Supabase Auth creates a user
--    (first Google/Apple sign-in). SECURITY DEFINER with a pinned
--    search_path — the standard hardened Supabase pattern.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url, provider)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    coalesce(new.raw_app_meta_data ->> 'provider', 'unknown')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep profile email in sync when the identity provider updates it.
create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set email = new.email,
         updated_at = now()
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.handle_user_email_updated();

-- ---------------------------------------------------------------------------
-- 3. updated_at bookkeeping
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Row Level Security — owner-only read/update; no client insert/delete.
--    The service_role key (Edge Function) bypasses RLS by design.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check (
    (select auth.uid()) = id
    -- Owners may edit display fields and finish onboarding, but can never
    -- reassign the row: id is covered by the USING clause above.
  );

-- No insert/delete policies on purpose: creation happens only through the
-- definer trigger; deletion only via auth.users cascade (account deletion).

-- Lock the table down for anon; authenticated relies purely on the policies.
revoke all on public.profiles from anon;
grant select, update on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Onboarding completion helper (optional RPC the app can call later
--    with the user's own Supabase JWT; RLS keeps it owner-scoped).
-- ---------------------------------------------------------------------------
create or replace function public.complete_onboarding()
returns void
language sql
security invoker
as $$
  update public.profiles
     set onboarding_state = 'complete'
   where id = (select auth.uid());
$$;

grant execute on function public.complete_onboarding() to authenticated;
