-- ============================================================================
-- Pickle Sensei — defense-in-depth hardening for the Supabase deployment.
--
-- Layered on top of the existing owner-only RLS. RLS remains the primary
-- boundary; everything here narrows what a compromised or modified client can
-- do WITHIN its own row-space, and closes privilege paths that policies alone
-- do not cover:
--
--   1. Column-level UPDATE grants — a client session can edit only the fields
--      the app legitimately edits. Synced score history, identity columns,
--      and bookkeeping timestamps become unwritable from any client session.
--   2. Append-only ledgers enforced by triggers — consent_records,
--      evaluation_trials and analysis_feedback reject UPDATE/DELETE at the
--      trigger layer too, so history survives even a future accidental grant
--      or policy mistake. Account-deletion cascades still pass.
--   3. user_id becomes NOT NULL on the ledgers — no orphan rows invisible to
--      every owner-scoped policy.
--   4. Payload size caps — CHECK constraints bound every free-text column and
--      jsonb payload a client can write, so one account cannot turn tables
--      into unbounded blob storage.
--   5. Explicit anon/public revokes on the derived views and function EXECUTE
--      revokes for trigger-only functions.
--
-- Idempotent-safe: guarded drops/creates throughout, safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Column-level UPDATE grants (least privilege inside the owner's own rows)
-- ---------------------------------------------------------------------------

-- profiles: owners edit display/onboarding fields; identity + bookkeeping
-- columns (id, email, created_at, updated_at) are not client-writable. email
-- is synced from auth.users by the definer trigger only.
revoke update on public.profiles from authenticated;
grant update (
  display_name, avatar_url, provider, onboarding_state,
  skill_level, focus_checkpoint, handedness, primary_goal, biggest_problem
) on public.profiles to authenticated;

-- shots: synced score history is immutable from a client session. Owners may
-- still curate their library (favorite / their own declared stroke / session
-- attachment); every scoring, timing and version-vector column is locked.
revoke update on public.shots from authenticated;
grant update (favorite, declared_stroke, session_id)
  on public.shots to authenticated;

-- sessions: id/user_id/started_at are fixed at creation; owners may finalize
-- and annotate.
revoke update on public.sessions from authenticated;
grant update (ended_at, event_count, notes, kind)
  on public.sessions to authenticated;

-- analysis_permits: the client-facing lifecycle only moves status/outcome
-- (finalize/release). id, user_id, idempotency_key and created_at are fixed.
revoke update on public.analysis_permits from authenticated;
grant update (status, outcome) on public.analysis_permits to authenticated;

-- Shot detail rows are write-once evidence: insert + select only (the sync
-- upsert uses ON CONFLICT DO NOTHING, which needs no UPDATE privilege;
-- deletes happen only via the shots FK cascade, which runs as table owner).
revoke update, delete on public.shot_phases from authenticated;
revoke update, delete on public.shot_measurements from authenticated;
revoke update, delete on public.shot_checkpoints from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Append-only ledgers enforced at the trigger layer (defense in depth
--    behind the missing UPDATE/DELETE policies and grants). Account-deletion
--    FK cascades (profiles → ledger rows) run at trigger depth > 0 and are
--    allowed through; every direct UPDATE/DELETE — whatever the role — is
--    rejected.
-- ---------------------------------------------------------------------------
create or replace function public.reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    -- FK cascade from an account deletion; the parent delete is the audit event.
    return old;
  end if;
  raise exception '% rows are append-only (% blocked)', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

revoke execute on function public.reject_ledger_mutation() from public;
revoke execute on function public.reject_ledger_mutation()
  from anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'consent_records', 'evaluation_trials', 'analysis_feedback'
  ] loop
    execute format(
      'drop trigger if exists %1$s_append_only on public.%1$s;
       create trigger %1$s_append_only
         before update or delete on public.%1$s
         for each row execute function public.reject_ledger_mutation();',
      t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Ledger rows must always have an owner — a NULL user_id row would be
--    invisible to every owner-scoped policy (and unreachable for deletion).
-- ---------------------------------------------------------------------------
alter table public.consent_records alter column user_id set not null;
alter table public.evaluation_trials alter column user_id set not null;
alter table public.analysis_feedback alter column user_id set not null;
alter table public.user_saved_drills alter column user_id set not null;

-- ---------------------------------------------------------------------------
-- 4. Size caps on client-writable payloads (anti storage-abuse). Bounds are
--    generous for real app payloads and hostile to blob smuggling.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_text_bounds') then
    alter table public.profiles add constraint profiles_text_bounds check (
      coalesce(length(email), 0) <= 320
      and coalesce(length(display_name), 0) <= 200
      and coalesce(length(avatar_url), 0) <= 2048
      and length(provider) <= 50
      and coalesce(length(skill_level), 0) <= 100
      and coalesce(length(focus_checkpoint), 0) <= 100
      and coalesce(length(primary_goal), 0) <= 200
      and coalesce(length(biggest_problem), 0) <= 500
    ) not valid;
    alter table public.profiles validate constraint profiles_text_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'sessions_text_bounds') then
    alter table public.sessions add constraint sessions_text_bounds check (
      coalesce(length(notes), 0) <= 4000
    ) not valid;
    alter table public.sessions validate constraint sessions_text_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'shots_text_bounds') then
    alter table public.shots add constraint shots_text_bounds check (
      length(shot_type) <= 64
      and coalesce(length(declared_stroke), 0) <= 64
      and coalesce(length(guidance), 0) <= 2000
      and coalesce(length(priority_fix_checkpoint), 0) <= 100
      and coalesce(length(priority_fix_reason), 0) <= 1000
      and length(app_version) <= 64
      and length(model_bundle_version) <= 64
      and length(pose_model_version) <= 64
      and length(paddle_model_version) <= 64
      and length(stroke_detector_version) <= 64
      and length(phase_model_version) <= 64
      and length(scoring_model_version) <= 64
      and length(shot_config_version) <= 64
    ) not valid;
    alter table public.shots validate constraint shots_text_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'shot_detail_key_bounds') then
    alter table public.shot_phases add constraint shot_detail_key_bounds
      check (length(phase_key) <= 64) not valid;
    alter table public.shot_phases validate constraint shot_detail_key_bounds;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shot_measurement_key_bounds') then
    alter table public.shot_measurements add constraint shot_measurement_key_bounds
      check (length(metric_key) <= 64) not valid;
    alter table public.shot_measurements validate constraint shot_measurement_key_bounds;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shot_checkpoint_key_bounds') then
    alter table public.shot_checkpoints add constraint shot_checkpoint_key_bounds
      check (length(checkpoint_key) <= 64 and length(direction) <= 64) not valid;
    alter table public.shot_checkpoints validate constraint shot_checkpoint_key_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'analysis_permits_key_bounds') then
    alter table public.analysis_permits add constraint analysis_permits_key_bounds
      check (length(idempotency_key) <= 128
             and coalesce(length(outcome), 0) <= 50) not valid;
    alter table public.analysis_permits validate constraint analysis_permits_key_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'consent_records_bounds') then
    alter table public.consent_records add constraint consent_records_bounds check (
      length(scope) <= 50
      and coalesce(length(consent_version), 0) <= 50
      and coalesce(length(source), 0) <= 100
      and coalesce(length(capture_mode), 0) <= 50
      and coalesce(pg_column_size(device), 0) <= 4096
    ) not valid;
    alter table public.consent_records validate constraint consent_records_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'evaluation_trials_payload_bounds') then
    alter table public.evaluation_trials add constraint evaluation_trials_payload_bounds
      check (pg_column_size(payload) <= 65536) not valid;
    alter table public.evaluation_trials validate constraint evaluation_trials_payload_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'analysis_feedback_bounds') then
    alter table public.analysis_feedback add constraint analysis_feedback_bounds
      check (length(rating) <= 50 and coalesce(length(category), 0) <= 50) not valid;
    alter table public.analysis_feedback validate constraint analysis_feedback_bounds;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'user_saved_drills_slug_bounds') then
    alter table public.user_saved_drills add constraint user_saved_drills_slug_bounds
      check (slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$') not valid;
    alter table public.user_saved_drills validate constraint user_saved_drills_slug_bounds;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Explicit anon/public lockdown on derived views + trigger-only functions.
--    (security_invoker views already fail closed via base-table privileges;
--    these revokes make the deny explicit rather than incidental.)
-- ---------------------------------------------------------------------------
revoke all on public.progress_daily from anon, public;
revoke all on public.practice_days from anon, public;
revoke all on public.player_technique_rating from anon, public;
revoke all on public.player_rank_state from public;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_user_email_updated() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_shot_rank_refresh() from public, anon, authenticated;
revoke execute on function public.player_rank_tier(numeric) from anon;
