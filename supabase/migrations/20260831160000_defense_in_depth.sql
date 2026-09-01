-- ============================================================================
-- Pickle Sensei — defense-in-depth hardening (re-landed for the launch schema).
--
-- Adapts the never-applied 20260830000000_security_hardening.sql from the
-- security-certification branch (PR #3) to the schema that actually shipped
-- (20260830120000_production_launch + 20260831000000_scale_and_security +
-- 20260831130000_form_weighted_rank). RLS remains the primary boundary;
-- everything here narrows what a compromised or modified client can do WITHIN
-- its own row-space, and closes privilege paths policies alone do not cover.
-- On hosted Supabase, default privileges grant broad table rights to client
-- roles; the explicit REVOKEs below are therefore real controls, not
-- formalities.
--
--   1. Column-level UPDATE grants — a client session can edit only the fields
--      the Edge Function actually edits (it is the only PostgREST client).
--      Synced score history is now fully immutable from a client session:
--      shot sync goes through apply_synced_shot() (INSERT-only on shots) and
--      favorites live on-device, so shots keep NO client UPDATE grant at all.
--   2. Append-only ledgers enforced by triggers — consent_records,
--      evaluation_trials and analysis_feedback reject UPDATE/DELETE at the
--      trigger layer too, so history survives even a future accidental grant
--      or policy mistake. Account-deletion cascades still pass.
--   3. user_id becomes NOT NULL on the ledgers — no orphan rows invisible to
--      every owner-scoped policy.
--   4. Payload size caps — CHECK constraints bound the free-text columns a
--      client can write. All NOT VALID (they bind every NEW write without
--      scanning or aborting on legacy rows — same posture as
--      20260831000000). evaluation_trials keeps its existing 256 KiB cap
--      from 20260831000000; this migration deliberately does not tighten it.
--   5. Explicit anon/public revokes on derived views, service-only tables,
--      and EXECUTE revokes for trigger-only functions.
--
-- Verified against every client write the Edge Function performs
-- (supabase/functions/api/index.ts as of this commit); the regression matrix
-- in supabase/tests/security_regression.sql exercises both the allowed and
-- the denied paths. Idempotent-safe: guarded creates throughout.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Column-level UPDATE grants (least privilege inside the owner's own rows)
-- ---------------------------------------------------------------------------

-- profiles: owners edit their own statements and finish onboarding
-- (PUT /v1/me/onboarding patch + provider stamp + complete_onboarding()).
-- Identity and bookkeeping columns (id, email, created_at, updated_at) and
-- the signup-provisioned display fields (display_name, avatar_url — written
-- only by the definer trigger today) are not client-writable. Creation and
-- deletion stay trigger/cascade-only.
revoke insert, update, delete on public.profiles from authenticated;
grant update (
  provider, onboarding_state, skill_level, focus_checkpoint,
  handedness, primary_goal, biggest_problem, first_name, gender
) on public.profiles to authenticated;

-- shots: synced score history is immutable from a client session. The sync
-- path is apply_synced_shot() (SECURITY INVOKER, INSERT-only on this table)
-- and favorites/declared strokes are device-local — no route updates shots.
revoke update on public.shots from authenticated;

-- sessions: id/user_id/started_at are fixed at creation (the sync upsert is
-- insert-or-ignore); the only client update is the finalize stamp.
revoke update on public.sessions from authenticated;
grant update (ended_at) on public.sessions to authenticated;

-- analysis_permits: the client-facing lifecycle only moves status/outcome
-- (finalize/release — route and RPC). id, user_id, idempotency_key and
-- created_at are fixed.
revoke update on public.analysis_permits from authenticated;
grant update (status, outcome) on public.analysis_permits to authenticated;

-- account_deletion_requests: the two-step flow re-arms the challenge via
-- PostgREST upsert, whose ON CONFLICT DO UPDATE sets EVERY payload column —
-- including user_id — so user_id must stay in the grant; the RLS WITH CHECK
-- (user_id = auth.uid()) is what pins its value. The table has no other
-- columns, so this narrows nothing today; it documents the contract.
revoke update on public.account_deletion_requests from authenticated;
grant update (user_id, challenge, created_at, expires_at)
  on public.account_deletion_requests to authenticated;

-- Shot detail rows are write-once evidence: insert + select only (the sync
-- inserts use ON CONFLICT DO NOTHING, which needs no UPDATE privilege;
-- deletes happen only via the shots FK cascade, which runs as table owner).
revoke update, delete on public.shot_phases from authenticated;
revoke update, delete on public.shot_measurements from authenticated;
revoke update, delete on public.shot_checkpoints from authenticated;

-- Ledgers: no client rewrite privilege at all (RLS already has no
-- update/delete policies; this closes the hosted default-privilege grant).
revoke update, delete on public.consent_records from authenticated;
revoke update, delete on public.evaluation_trials from authenticated;
revoke update, delete on public.analysis_feedback from authenticated;

-- Service-role-only tables: clients never write billing state (App Review /
-- entitlement integrity) and never touch the webhook audit log.
revoke insert, update, delete on public.billing_entitlements from authenticated;
revoke all on public.webhook_events from anon, authenticated;

-- player_rank_state is derived state maintained by the definer trigger
-- (handle_shot_rank_refresh → recompute_player_rank); clients only read it.
revoke insert, update, delete on public.player_rank_state from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Append-only ledgers enforced at the trigger layer (defense in depth
--    behind the missing UPDATE/DELETE policies and grants). Account-deletion
--    FK cascades (profiles → ledger rows) run at trigger depth > 1 and are
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
--    Every writer already sets it (RLS WITH CHECK forces auth.uid() for
--    clients; the Edge Function always stamps it), so this cannot fail on
--    healthy data — and if it ever does, the push aborts loudly instead of
--    hiding an orphan-row problem.
-- ---------------------------------------------------------------------------
alter table public.consent_records alter column user_id set not null;
alter table public.evaluation_trials alter column user_id set not null;
alter table public.analysis_feedback alter column user_id set not null;

-- ---------------------------------------------------------------------------
-- 4. Size caps on client-writable payloads (anti storage-abuse). Bounds are
--    generous for real app payloads and hostile to blob smuggling. NOT VALID:
--    enforced for every NEW write, no history scan. first_name (≤80) and
--    gender (enum CHECK) are already bounded; evaluation_trials keeps its
--    256 KiB cap from 20260831000000.
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
  end if;

  if not exists (select 1 from pg_constraint where conname = 'sessions_text_bounds') then
    alter table public.sessions add constraint sessions_text_bounds check (
      coalesce(length(notes), 0) <= 4000
    ) not valid;
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
  end if;

  if not exists (select 1 from pg_constraint where conname = 'shot_detail_key_bounds') then
    alter table public.shot_phases add constraint shot_detail_key_bounds
      check (length(phase_key) <= 64) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shot_measurement_key_bounds') then
    alter table public.shot_measurements add constraint shot_measurement_key_bounds
      check (length(metric_key) <= 64) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shot_checkpoint_key_bounds') then
    alter table public.shot_checkpoints add constraint shot_checkpoint_key_bounds
      check (length(checkpoint_key) <= 64 and length(direction) <= 64) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'analysis_permits_key_bounds') then
    alter table public.analysis_permits add constraint analysis_permits_key_bounds
      check (length(idempotency_key) <= 128
             and coalesce(length(outcome), 0) <= 50) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'consent_records_bounds') then
    alter table public.consent_records add constraint consent_records_bounds check (
      length(scope) <= 50
      and coalesce(length(consent_version), 0) <= 50
      and coalesce(length(source), 0) <= 100
      and coalesce(length(capture_mode), 0) <= 50
      and coalesce(pg_column_size(device), 0) <= 4096
    ) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'analysis_feedback_bounds') then
    alter table public.analysis_feedback add constraint analysis_feedback_bounds
      check (length(rating) <= 50 and coalesce(length(category), 0) <= 50) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'user_saved_drills_slug_bounds') then
    alter table public.user_saved_drills add constraint user_saved_drills_slug_bounds
      check (slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$') not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Explicit anon/public lockdown on derived views + trigger-only functions.
--    (security_invoker views already fail closed via base-table privileges;
--    these revokes make the deny explicit rather than incidental. access_state
--    and apply_synced_shot keep their authenticated EXECUTE from 20260831000000;
--    complete_onboarding keeps its authenticated EXECUTE from 20260829000000.)
-- ---------------------------------------------------------------------------
revoke all on public.progress_daily from anon, public;
revoke all on public.practice_days from anon, public;
revoke all on public.player_technique_rating from anon, public;
revoke all on public.player_rank_state from public;
revoke all on public.billing_entitlements from anon, public;
revoke all on public.account_deletion_requests from anon, public;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_user_email_updated() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.handle_shot_rank_refresh() from public, anon, authenticated;
revoke execute on function public.player_rank_tier(numeric) from anon;
revoke execute on function public.complete_onboarding() from public, anon;
