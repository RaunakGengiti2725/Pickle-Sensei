-- ============================================================================
-- Pickle Sensei — exit survey for account deletion.
--
-- The app asks "What's making you leave?" (one reason + optional free text)
-- before the two-step deletion confirmation. The answer travels in the body
-- of POST /v1/me/delete-request and lands here AS THE USER (RLS), always
-- before the account is destroyed.
--
-- Unlike every other user table this one MUST outlive the account — the row
-- is the point. So the profiles FK is ON DELETE SET NULL, not CASCADE: the
-- auth.users → profiles cascade anonymizes the row instead of removing it.
-- After deletion the row carries no identifier at all; `user_id is null`
-- therefore also reads as "this person really did delete" (a non-null
-- user_id is someone who requested deletion and then kept the account).
--
-- Posture: insert-only from a client session (no SELECT — the app never
-- reads it back; no UPDATE/DELETE — grant AND trigger layers). The trigger
-- lets the FK's SET NULL update through (it runs at trigger depth > 1)
-- while rejecting every direct rewrite for every role.
-- ============================================================================

create table if not exists public.account_deletion_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  -- Vocabulary is enforced by the Edge Function (mirrors
  -- apps/mobile/src/account/deletion.ts ACCOUNT_DELETION_REASONS); the
  -- database bounds the length only, so a new reason needs no migration.
  reason text not null,
  details text,
  -- Churn context stamped server-side at request time (never trusted from
  -- the client except platform/app_version, which are bounded + sanitized).
  provider text,
  platform text,
  app_version text,
  account_age_days integer,
  was_premium boolean,
  scored_count integer,
  created_at timestamptz not null default now(),
  constraint account_deletion_feedback_bounds check (
    length(reason) <= 50
    and coalesce(length(details), 0) <= 1000
    and coalesce(length(provider), 0) <= 50
    and coalesce(length(platform), 0) <= 20
    and coalesce(length(app_version), 0) <= 64
    and (account_age_days is null or account_age_days >= 0)
    and (scored_count is null or scored_count >= 0)
  )
);

comment on table public.account_deletion_feedback is
  'Exit survey answered before account deletion (POST /v1/me/delete-request body.survey). Written once as the user; the profiles FK is ON DELETE SET NULL so the row survives deletion anonymized — user_id is null means the account was actually deleted.';

create index if not exists account_deletion_feedback_created_idx
  on public.account_deletion_feedback (created_at desc);

alter table public.account_deletion_feedback enable row level security;

-- Insert-only, owner-pinned. WITH CHECK also rules out a client writing an
-- anonymous (null user_id) row: auth.uid() = null is never true.
drop policy if exists "deletion_feedback_insert_own" on public.account_deletion_feedback;
create policy "deletion_feedback_insert_own"
  on public.account_deletion_feedback for insert
  to authenticated with check ((select auth.uid()) = user_id);

revoke all on public.account_deletion_feedback from anon, public, authenticated;
grant insert on public.account_deletion_feedback to authenticated;

-- Append-only at the trigger layer for every role. reject_ledger_mutation()
-- (20260831160000) only waves through cascaded DELETEs; this table's
-- deletion path is the FK's SET NULL *update*, so it needs its own guard.
create or replace function public.reject_deletion_feedback_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if pg_trigger_depth() > 1 then
    -- The profiles FK action anonymizing the row during account deletion.
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'account_deletion_feedback rows are append-only (% blocked)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

revoke execute on function public.reject_deletion_feedback_mutation()
  from public, anon, authenticated;

drop trigger if exists account_deletion_feedback_append_only
  on public.account_deletion_feedback;
create trigger account_deletion_feedback_append_only
  before update or delete on public.account_deletion_feedback
  for each row execute function public.reject_deletion_feedback_mutation();
