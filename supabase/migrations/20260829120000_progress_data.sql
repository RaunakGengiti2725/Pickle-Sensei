-- ============================================================================
-- Pickle Sensei — full user progress data on Supabase.
--
-- Everything the app tracks per user, mirrored from the app's real domain
-- types (packages/shared-types/src/domain.ts + apps/mobile/src/data/
-- repository.ts), keyed to auth.users via public.profiles:
--
--   profiles          + skill/focus/handedness columns (onboarding profile)
--   sessions            practice / game sessions
--   shots               one row per analyzed stroke (ShotAnalysis)
--   shot_phases         PhaseSpan[]        (ready→prepare→…→recover)
--   shot_measurements   Measurement[]      (biomechanical scalars)
--   shot_checkpoints    CheckpointScore[]  (technique checkpoints, 0..100)
--   captures            verified camera-capture history (practice evidence)
--   progress_daily      VIEW — daily aggregates (CanonicalProgressSeriesPoint)
--   practice_days       VIEW — distinct capture days (streak inputs)
--
-- Principles carried over from the app:
--   * Scores are NEVER comparable across scoring_model_version — every score
--     row carries its full version vector verbatim; the daily view groups by
--     scoring_model_version so version breaks can render honestly.
--   * declared stroke (user's own statement) stays separate from any model
--     prediction; neither is ever overwritten by the other.
--   * source='real' only — fixture output must never enter user history.
--   * Owner-only RLS on every table; clients cannot touch other users' rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Profile columns the app's onboarding + Home screen track
-- ---------------------------------------------------------------------------
-- skill_level is a free-form self-rating string (onboarding sends values like
-- '3.0' as well as words) — deliberately unconstrained.
alter table public.profiles
  add column if not exists skill_level text,
  add column if not exists focus_checkpoint text,
  add column if not exists handedness text
    check (handedness in ('right', 'left'));

-- ---------------------------------------------------------------------------
-- 1. Sessions (Stroke Analysis attempts group here too when part of a set;
--    Game/Session Analysis creates one row per live session)
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id uuid primary key,                       -- client-generated (offline-first)
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null default 'practice'
    check (kind in ('practice', 'game')),
  started_at timestamptz not null,
  ended_at timestamptz,
  event_count int not null default 0 check (event_count >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sessions_user_started_idx
  on public.sessions (user_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 2. Shots — one row per analyzed stroke (mirrors ShotAnalysis verbatim)
-- ---------------------------------------------------------------------------
create table if not exists public.shots (
  id uuid primary key,                       -- client-generated (offline-first)
  user_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid references public.sessions (id) on delete set null,

  shot_type text not null,                   -- ShotTypeSlug
  declared_stroke text,                      -- user's own statement (nullable)
  camera_view text check (camera_view in ('side', 'rear_oblique')),
  handedness text check (handedness in ('right', 'left')),
  captured_at timestamptz not null,

  -- timestamps: { startMs, contactMs|null, endMs } — contact may be an
  -- honest abstention and stays null then.
  start_ms int not null,
  contact_ms int,
  end_ms int not null,

  -- 0..10 one-decimal score; null exactly when result_kind='low_confidence'.
  overall_score numeric(4, 2)
    check (overall_score is null or (overall_score >= 0 and overall_score <= 10)),
  analysis_confidence numeric(5, 4) not null
    check (analysis_confidence >= 0 and analysis_confidence <= 1),
  result_kind text not null
    check (result_kind in ('scored', 'low_confidence')),
  constraint scored_shots_have_scores
    check (result_kind <> 'scored' or overall_score is not null),

  guidance text,                             -- setup guidance when low confidence
  priority_fix_checkpoint text,              -- PriorityFix (flattened; nullable)
  priority_fix_reason text,
  priority_fix_severity numeric(5, 4)
    check (priority_fix_severity is null
           or (priority_fix_severity >= 0 and priority_fix_severity <= 1)),
  priority_fix_confidence numeric(5, 4),

  favorite boolean not null default false,

  -- VersionVector persisted VERBATIM — scores are never reinterpreted under
  -- a different model, and progress lines may only join rows whose
  -- scoring_model_version matches.
  app_version text not null,
  model_bundle_version text not null,
  pose_model_version text not null,
  paddle_model_version text not null,
  stroke_detector_version text not null,
  phase_model_version text not null,
  scoring_model_version text not null,
  shot_config_version text not null,

  -- Fixture output must never be presented as real user history.
  source text not null default 'real' check (source = 'real'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shots_user_captured_idx
  on public.shots (user_id, captured_at desc);
create index if not exists shots_user_type_version_idx
  on public.shots (user_id, shot_type, scoring_model_version, captured_at desc);
create index if not exists shots_session_idx on public.shots (session_id);

-- ---------------------------------------------------------------------------
-- 3. Per-shot detail rows (PhaseSpan / Measurement / CheckpointScore)
-- ---------------------------------------------------------------------------
create table if not exists public.shot_phases (
  shot_id uuid not null references public.shots (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  phase_key text not null,                   -- ready|prepare|accelerate|contact|follow_through|recover
  start_ms int not null,
  representative_ms int not null,
  end_ms int not null,
  confidence numeric(5, 4) not null,
  primary key (shot_id, phase_key)
);

create table if not exists public.shot_measurements (
  shot_id uuid not null references public.shots (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  metric_key text not null,
  value double precision not null,
  confidence numeric(5, 4) not null,
  unit text not null
    check (unit in ('normalized', 'ratio', 'degrees', 'ms', 'count')),
  primary key (shot_id, metric_key)
);

create table if not exists public.shot_checkpoints (
  shot_id uuid not null references public.shots (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  checkpoint_key text not null,
  score numeric(6, 3)                        -- 0..100; null when unobservable
    check (score is null or (score >= 0 and score <= 100)),
  confidence numeric(5, 4) not null,
  band text not null check (band in ('green', 'yellow', 'red', 'unscored')),
  direction text not null,
  severity numeric(5, 4) not null check (severity >= 0 and severity <= 1),
  applicable boolean not null,
  primary key (shot_id, checkpoint_key)
);

create index if not exists shot_checkpoints_user_key_idx
  on public.shot_checkpoints (user_id, checkpoint_key);

-- ---------------------------------------------------------------------------
-- 4. Captures — verified automatic camera captures (practice evidence;
--    "camera practice still counts" even when no score exists)
-- ---------------------------------------------------------------------------
create table if not exists public.captures (
  id uuid primary key,                       -- client-generated
  user_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid references public.sessions (id) on delete set null,
  shot_id uuid references public.shots (id) on delete set null,

  captured_at timestamptz not null,
  duration_ms int not null check (duration_ms >= 0),
  fps numeric(6, 2) not null check (fps >= 0),
  width int,
  height int,

  capture_mode text not null
    check (capture_mode in ('automatic_pose_trigger', 'imported_video')),
  declared_stroke text,                      -- separate from any recognition
  recognized_shot_type text,                 -- model prediction (nullable)
  evidence_status text not null
    check (evidence_status in ('valid', 'legacy', 'corrupt', 'metadata_mismatch')),
  status text not null default 'awaiting_model'
    check (status in ('awaiting_model', 'analyzed')),

  -- Capture-evidence metrics the Progress screen charts.
  pose_availability numeric(5, 4)
    check (pose_availability is null
           or (pose_availability >= 0 and pose_availability <= 1)),
  joint_coverage numeric(5, 4)
    check (joint_coverage is null
           or (joint_coverage >= 0 and joint_coverage <= 1)),
  pose_tracked_ms int check (pose_tracked_ms is null or pose_tracked_ms >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists captures_user_captured_idx
  on public.captures (user_id, captured_at desc);

-- ---------------------------------------------------------------------------
-- 5. Derived views — aggregates are COMPUTED, never stored, so they can
--    never drift from the underlying evidence.
-- ---------------------------------------------------------------------------

-- CanonicalProgressSeriesPoint: day × shot_type × scoring_model_version.
-- security_invoker: the view reads through the caller's RLS — each user only
-- ever aggregates their own shots.
create or replace view public.progress_daily
with (security_invoker = true) as
select
  user_id,
  (captured_at at time zone 'UTC')::date as day,
  shot_type,
  scoring_model_version,
  count(*)::int as shot_count,
  round(avg(overall_score), 2) as avg_score,
  max(overall_score) as best_score
from public.shots
where result_kind = 'scored' and overall_score is not null
group by user_id, day, shot_type, scoring_model_version;

-- Distinct practice days from verified automatic captures (streak input).
-- Day boundaries are UTC here; the app keeps computing streaks in the
-- device's timezone from raw rows — this view is a server-side summary,
-- not a replacement for that logic.
create or replace view public.practice_days
with (security_invoker = true) as
select distinct
  user_id,
  (captured_at at time zone 'UTC')::date as day
from public.captures
where evidence_status = 'valid' and capture_mode = 'automatic_pose_trigger';

-- ---------------------------------------------------------------------------
-- 6. updated_at bookkeeping (reuses set_updated_at() from the auth migration)
-- ---------------------------------------------------------------------------
drop trigger if exists sessions_set_updated_at on public.sessions;
create trigger sessions_set_updated_at
  before update on public.sessions
  for each row execute function public.set_updated_at();

drop trigger if exists shots_set_updated_at on public.shots;
create trigger shots_set_updated_at
  before update on public.shots
  for each row execute function public.set_updated_at();

drop trigger if exists captures_set_updated_at on public.captures;
create trigger captures_set_updated_at
  before update on public.captures
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Row Level Security — owner-only on every table. The detail tables
--    carry user_id redundantly so their policies never need joins, and a
--    CHECK-by-policy guarantees a user can only attach details to their
--    own shot (the FK plus shots RLS closes the loop).
-- ---------------------------------------------------------------------------
alter table public.sessions enable row level security;
alter table public.shots enable row level security;
alter table public.shot_phases enable row level security;
alter table public.shot_measurements enable row level security;
alter table public.shot_checkpoints enable row level security;
alter table public.captures enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'sessions', 'shots', 'shot_phases', 'shot_measurements',
    'shot_checkpoints', 'captures'
  ] loop
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
end $$;

revoke all on public.sessions, public.shots, public.shot_phases,
  public.shot_measurements, public.shot_checkpoints, public.captures
  from anon;
grant select, insert, update, delete on public.sessions, public.shots,
  public.shot_phases, public.shot_measurements, public.shot_checkpoints,
  public.captures to authenticated;
grant select on public.progress_daily, public.practice_days to authenticated;
