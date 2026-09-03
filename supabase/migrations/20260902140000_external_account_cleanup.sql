-- ============================================================================
-- Pickle Sensei — server-only state for external account cleanup.
--
-- Sign in with Apple requires a refresh/access token to revoke the user's
-- authorization during account deletion. The Edge Function exchanges the
-- one-use native authorization code at bootstrap, encrypts Apple's refresh
-- token with AES-256-GCM, and stores only the ciphertext here. RevenueCat
-- deletion is also checkpointed so a retry after a later provider failure
-- does not lose track of work already completed.
--
-- This table is SERVICE-ROLE ONLY: RLS has no policies and every client grant
-- is revoked. Its row cascades with the profile after all external providers
-- have been cleaned up and auth.admin.deleteUser commits.
-- ============================================================================

create table if not exists public.account_external_credentials (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  apple_refresh_token_encrypted text,
  apple_token_captured_at timestamptz,
  apple_revoked_at timestamptz,
  revenuecat_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_external_credentials_apple_token_size check (
    apple_refresh_token_encrypted is null
    or length(apple_refresh_token_encrypted) between 20 and 8192
  ),
  constraint account_external_credentials_apple_capture_pair check (
    (apple_refresh_token_encrypted is null) = (apple_token_captured_at is null)
  )
);

comment on table public.account_external_credentials is
  'Service-role-only, retry-safe external cleanup state. Apple refresh tokens are AES-256-GCM ciphertext bound to user_id; no plaintext provider credential is stored.';

comment on column public.account_external_credentials.apple_refresh_token_encrypted is
  'v1.<base64url iv>.<base64url AES-GCM ciphertext+tag>; AAD includes the canonical user_id. Decrypted only immediately before Apple token revocation.';

alter table public.account_external_credentials enable row level security;
revoke all on public.account_external_credentials from public, anon, authenticated;

