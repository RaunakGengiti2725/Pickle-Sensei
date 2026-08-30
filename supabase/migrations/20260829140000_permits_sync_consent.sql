-- ============================================================================
-- Pickle Sensei — analysis permits, sync intake, consent ledger, feedback,
-- saved drills.
--
-- Backing tables for the remaining mobile API contracts served by the Edge
-- Function (supabase/functions/api/index.ts):
--
--   analysis_permits   reserve-before-inference rating permits
--                      (apps/mobile/src/data/api.ts createAnalysisPermitClient)
--   consent_records    append-only first-party consent ledger
--                      (apps/mobile/src/account/consentApi.ts; status is a
--                      FOLD of this ledger — latest action per scope wins)
--   evaluation_trials  consent-gated evaluation-trial evidence, stored
--                      verbatim (apps/mobile/src/evaluation/trialCapture.ts)
--   analysis_feedback  "was this analysis accurate?" failure-mining signal
--                      (apps/mobile/src/data/api.ts submitAnalysisFeedback)
--   user_saved_drills  saved-drill bookmarks by catalog slug
--                      (apps/mobile/src/training/api.ts save/unsave/list)
--
-- Principles carried over from the app and services/api:
--   * The consent ledger is APPEND-ONLY: withdrawal appends a state change;
--     no policy (and no grant) permits update or delete, so the audit trail
--     can never be rewritten from a client session.
--   * Evaluation trials and analysis feedback are append-only claims too:
--     they are evidence, never edited after the fact.
--   * Owner-only RLS on every table; clients cannot touch other users' rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Analysis permits — reserved BEFORE inference, one per rating attempt.
--    idempotency_key lets the client retry a reserve without minting a second
--    permit. Lifecycle: reserved → finalized (explicit finalize, or a scored
--    shot consuming it during sync) | released (abstention during sync).
-- ---------------------------------------------------------------------------
create table if not exists public.analysis_permits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'finalized', 'released')),
  outcome text,                              -- scored|low_confidence|cancelled|failed|unsupported|incorrect_recognition|expired
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

-- Access math counts a user's still-reserved permits (free-rating holds).
create index if not exists analysis_permits_user_status_idx
  on public.analysis_permits (user_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Consent records — append-only ledger. Status is DERIVED by folding rows
--    in order (the latest action per scope wins); it is never stored, so it
--    can never drift from the ledger. The DB stores 'grant'/'withdraw'; the
--    API maps to the client's 'granted'/'withdrawn' vocabulary.
-- ---------------------------------------------------------------------------
create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  scope text not null,                       -- video_analysis|model_training|evaluation_telemetry
  consent_version text,                      -- version granted; carried forward on withdraw rows
  action text not null check (action in ('grant', 'withdraw')),
  source text,                               -- e.g. mobile_settings
  device jsonb,                              -- client-reported device string, stored verbatim
  capture_mode text,                         -- e.g. all_captures (grant requests only)
  created_at timestamptz not null default now()
);

-- The fold reads a user's ledger in insertion order.
create index if not exists consent_records_user_created_idx
  on public.consent_records (user_id, created_at, id);

-- ---------------------------------------------------------------------------
-- 3. Evaluation trials — device-built trial records stored VERBATIM as jsonb.
--    id is the client-generated trialId (idempotent re-upload). The server
--    never derives or stores a correctness verdict; labeling happens offline.
-- ---------------------------------------------------------------------------
create table if not exists public.evaluation_trials (
  id uuid primary key,                       -- client trialId (offline-first)
  user_id uuid references public.profiles (id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists evaluation_trials_user_created_idx
  on public.evaluation_trials (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Analysis feedback — "was this analysis accurate?", a failure-mining
--    signal, never gold. analysis_id is the synced shot id the user was
--    looking at. One feedback row per analysis per user (the app treats a
--    duplicate submit as already-done via 409 analysis.feedback_exists).
-- ---------------------------------------------------------------------------
create table if not exists public.analysis_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  analysis_id uuid not null,
  rating text not null,                      -- accurate|not_quite
  category text,                             -- required exactly when rating='not_quite'
  created_at timestamptz not null default now(),
  unique (analysis_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 5. Saved drills — bookmark by catalog slug. Drill CONTENT is not stored
--    here: titles/descriptions come from the published drill catalog (none
--    exists yet — the Edge Function serves honest placeholders until then).
-- ---------------------------------------------------------------------------
create table if not exists public.user_saved_drills (
  user_id uuid references public.profiles (id) on delete cascade,
  slug text not null,
  saved_at timestamptz not null default now(),
  primary key (user_id, slug)
);

-- ---------------------------------------------------------------------------
-- 6. updated_at bookkeeping (reuses set_updated_at() from the auth migration)
-- ---------------------------------------------------------------------------
drop trigger if exists analysis_permits_set_updated_at on public.analysis_permits;
create trigger analysis_permits_set_updated_at
  before update on public.analysis_permits
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Row Level Security — owner-only everywhere.
--    * analysis_permits, user_saved_drills: full owner CRUD.
--    * consent_records, evaluation_trials, analysis_feedback: select+insert
--      ONLY — append-only ledgers get no update/delete policies (and no
--      grants), so history cannot be rewritten even by its owner.
-- ---------------------------------------------------------------------------
alter table public.analysis_permits enable row level security;
alter table public.consent_records enable row level security;
alter table public.evaluation_trials enable row level security;
alter table public.analysis_feedback enable row level security;
alter table public.user_saved_drills enable row level security;

do $$
declare
  t text;
begin
  -- Full owner CRUD.
  foreach t in array array['analysis_permits', 'user_saved_drills'] loop
    execute format(
      'drop policy if exists "%1$s_select_own" on public.%1$s;
       create policy "%1$s_select_own" on public.%1$s
         for select to authenticated using ((select auth.uid()) = user_id);
       drop policy if exists "%1$s_insert_own" on public.%1$s;
       create policy "%1$s_insert_own" on public.%1$s
         for insert to authenticated with check ((select auth.uid()) = user_id);
       drop policy if exists "%1$s_update_own" on public.%1$s;
       create policy "%1$s_update_own" on public.%1$s
         for update to authenticated
         using ((select auth.uid()) = user_id)
         with check ((select auth.uid()) = user_id);
       drop policy if exists "%1$s_delete_own" on public.%1$s;
       create policy "%1$s_delete_own" on public.%1$s
         for delete to authenticated using ((select auth.uid()) = user_id);',
      t
    );
  end loop;

  -- Append-only: owners may read and append, never rewrite.
  foreach t in array array[
    'consent_records', 'evaluation_trials', 'analysis_feedback'
  ] loop
    execute format(
      'drop policy if exists "%1$s_select_own" on public.%1$s;
       create policy "%1$s_select_own" on public.%1$s
         for select to authenticated using ((select auth.uid()) = user_id);
       drop policy if exists "%1$s_insert_own" on public.%1$s;
       create policy "%1$s_insert_own" on public.%1$s
         for insert to authenticated with check ((select auth.uid()) = user_id);',
      t
    );
  end loop;
end $$;

revoke all on public.analysis_permits, public.consent_records,
  public.evaluation_trials, public.analysis_feedback, public.user_saved_drills
  from anon;
grant select, insert, update, delete
  on public.analysis_permits, public.user_saved_drills to authenticated;
-- Append-only tables: no update/delete privilege at all (defense in depth
-- behind the missing policies).
grant select, insert
  on public.consent_records, public.evaluation_trials, public.analysis_feedback
  to authenticated;
