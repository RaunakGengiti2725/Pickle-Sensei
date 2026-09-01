-- ============================================================================
-- Pickle Sensei — user_id indexes on the profiles-cascade child tables.
--
-- shot_phases, shot_measurements and analysis_feedback all declare
-- `user_id references public.profiles (id) on delete cascade` and are read
-- owner-scoped by RLS (`(select auth.uid()) = user_id`), but their only
-- indexes are shot_id- / analysis_id-leading, so both the account-deletion
-- cascade (auth.users → profiles → child rows) and any owner-scoped read had
-- to scan the whole table. Every other cascade child already carries a
-- user_id-leading index (sessions, shots, shot_checkpoints, captures,
-- analysis_permits, consent_records, evaluation_trials). Idempotent-safe.
-- ============================================================================

create index if not exists shot_phases_user_idx
  on public.shot_phases (user_id);

create index if not exists shot_measurements_user_idx
  on public.shot_measurements (user_id);

create index if not exists analysis_feedback_user_created_idx
  on public.analysis_feedback (user_id, created_at desc);
