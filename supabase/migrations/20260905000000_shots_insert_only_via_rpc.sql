-- Shots are INSERT-only via apply_synced_shot(): the client role holds no
-- INSERT on the sync-written tables at all (2026-09-05, ADJ-C).
--
-- Defect: 20260829120000_progress_data.sql granted INSERT on public.shots,
-- shot_phases, shot_checkpoints and shot_measurements to `authenticated` so
-- the SECURITY INVOKER sync RPC could write them. The same grant is directly
-- usable through PostgREST (`POST /rest/v1/shots` with the user's own JWT):
-- the only check on that path was the RLS policy `auth.uid() = user_id`, so a
-- client could record a 'scored' shot with no analysis permit, past the two
-- lifetime free ratings, with any overall_score / *_version it chose —
-- contradicting AGENTS.md ("sync is INSERT-only via the RPC") and the
-- certification ("score/version columns not client-writable").
--
-- Fix — privilege separation at the ACL layer (no guard trigger, no
-- transaction-local flag). The INSERT authority is removed from the client
-- role entirely and lives in exactly one place: apply_synced_shot() is
-- recreated as SECURITY DEFINER (owned by the migration role, which owns
-- the tables) with `search_path = ''`, EXECUTE granted to `authenticated`
-- only. Every read and write in the body is already scoped to
-- `v_uid := auth.uid()` (the caller — auth.uid() reads the request JWT
-- claims, not the executing role), so the RPC still validates permit
-- ownership + status, the identity-aware lifetime free limit, session
-- ownership and idempotent replay before it writes anything, and it still
-- terminalizes the permit in the same transaction. Direct client INSERT
-- into any of the four tables is now 42501 (insufficient_privilege) before
-- RLS is even consulted, and the shots_*_insert_own policies are dropped
-- as dead grants (same shape as 20260902130000_shots_delete_revoke.sql).
--
-- Unchanged: SELECT on all four tables (owner-only via RLS), the
-- shots_record_free_rating_ledger and shots_player_rank_refresh triggers,
-- and every other RPC (access_state, reserve_analysis_permit stay INVOKER).
--
-- Pins: __wf__/db_migrations_rls_indexes.test.ts (static: the revoke, the
-- definer + pinned search_path, no later re-grant / INSERT policy) and
-- security_regression.sql E0/E3 (live: direct INSERT denied, RPC accepted,
-- lifetime_scored_count() and access_state().scored_count unchanged).

-- ---------------------------------------------------------------------------
-- 1. The client role holds no INSERT on the sync-written tables.
-- ---------------------------------------------------------------------------
revoke insert on public.shots from authenticated;
revoke insert on public.shot_phases from authenticated;
revoke insert on public.shot_checkpoints from authenticated;
revoke insert on public.shot_measurements from authenticated;

drop policy if exists "shots_insert_own" on public.shots;
drop policy if exists "shot_phases_insert_own" on public.shot_phases;
drop policy if exists "shot_checkpoints_insert_own" on public.shot_checkpoints;
drop policy if exists "shot_measurements_insert_own" on public.shot_measurements;

-- ---------------------------------------------------------------------------
-- 2. apply_synced_shot(shot jsonb) — the ONLY writer. Body unchanged from
--    20260902150000_free_rating_identity_ledger.sql; the header moves to
--    SECURITY DEFINER so the write block runs with the owner's table
--    privileges while every statement stays auth.uid()-scoped.
-- ---------------------------------------------------------------------------
create or replace function public.apply_synced_shot(shot jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_permit_id uuid;
  v_session_id uuid;
  v_result_kind text;
  v_permit public.analysis_permits%rowtype;
  v_premium boolean;
  entry jsonb;
begin
  if v_uid is null then
    return 'auth.required';
  end if;

  v_id := (shot ->> 'id')::uuid;
  v_permit_id := (shot ->> 'analysisPermitId')::uuid;
  v_session_id := nullif(shot ->> 'sessionId', '')::uuid;
  v_result_kind := shot ->> 'resultKind';

  -- Idempotent replay: this user already owns the row. Checked before the
  -- lock so replays never contend.
  if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
    return 'accepted';
  end if;

  -- FREE-LIMIT BACKSTOP (1/2): take the same per-user lock reserve_analysis_
  -- permit uses, so the scored-shot count below cannot change under us and
  -- two concurrent syncs holding DIFFERENT permits cannot both pass it.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Lock the permit so a concurrent retry of the same sync serializes here.
  -- Ownership is asserted explicitly: this function runs as the table owner,
  -- so the caller's RLS policies do not filter for it.
  select * into v_permit
  from public.analysis_permits p
  where p.id = v_permit_id and p.user_id = v_uid
  for update;
  if not found then
    return 'access.permit_not_found';
  end if;
  if v_permit.status <> 'reserved' then
    return 'access.permit_not_reserved';
  end if;
  if v_permit.created_at <= now() - interval '24 hours' then
    update public.analysis_permits
       set status = 'released', outcome = 'expired'
     where id = v_permit_id and user_id = v_uid and status = 'reserved';
    return 'access.permit_expired';
  end if;

  -- FREE-LIMIT BACKSTOP (2/2): holding a reserved permit is not by itself
  -- authority to record a scored shot. If an extra permit was ever issued
  -- (every build before reserve_analysis_permit could do this), a non-premium
  -- account still may not exceed two lifetime scored ratings. The permit is
  -- released rather than left reserved so it stops occupying an allowance
  -- slot and the sweep has nothing to collect.
  -- IDENTITY LEDGER: the count is lifetime_scored_count(), so a re-created
  -- account whose identity already spent both ratings is refused here too.
  if v_result_kind = 'scored' then
    select coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false) into v_premium;

    if not v_premium and public.lifetime_scored_count() >= 2 then
      update public.analysis_permits
         set status = 'released', outcome = 'free_limit_exceeded'
       where id = v_permit_id and user_id = v_uid and status = 'reserved';
      return 'access.paywall_required';
    end if;
  end if;

  if v_session_id is not null and not exists (
    select 1 from public.sessions se
    where se.id = v_session_id and se.user_id = v_uid
  ) then
    return 'shot.session_not_found';
  end if;

  -- Atomic write block: any failure rolls back the shot, its details, AND
  -- leaves the permit untouched (still reserved for a clean retry).
  begin
    insert into public.shots (
      id, user_id, session_id, shot_type, camera_view, captured_at,
      start_ms, contact_ms, end_ms, overall_score, analysis_confidence,
      result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version, source
    ) values (
      v_id,
      v_uid,
      v_session_id,
      shot ->> 'shotType',
      shot ->> 'cameraView',
      (shot ->> 'capturedAt')::timestamptz,
      (shot ->> 'startMs')::int,
      (shot ->> 'contactMs')::int,
      (shot ->> 'endMs')::int,
      (shot ->> 'overallScore')::numeric,
      (shot ->> 'confidence')::numeric,
      v_result_kind,
      shot -> 'versionVector' ->> 'appVersion',
      shot -> 'versionVector' ->> 'modelBundleVersion',
      shot -> 'versionVector' ->> 'poseModelVersion',
      shot -> 'versionVector' ->> 'paddleModelVersion',
      shot -> 'versionVector' ->> 'strokeDetectorVersion',
      shot -> 'versionVector' ->> 'phaseModelVersion',
      shot -> 'versionVector' ->> 'scoringModelVersion',
      shot -> 'versionVector' ->> 'shotConfigVersion',
      'real'
    );

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'phases', '[]'::jsonb))
    loop
      insert into public.shot_phases (
        shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'startMs')::int,
        (entry ->> 'representativeMs')::int,
        (entry ->> 'endMs')::int,
        (entry ->> 'confidence')::numeric
      )
      on conflict (shot_id, phase_key) do nothing;
    end loop;

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'checkpoints', '[]'::jsonb))
    loop
      insert into public.shot_checkpoints (
        shot_id, user_id, checkpoint_key, score, confidence, band,
        direction, severity, applicable
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'score')::numeric,
        (entry ->> 'confidence')::numeric,
        entry ->> 'band',
        entry ->> 'direction',
        (entry ->> 'severity')::numeric,
        (entry ->> 'applicable')::boolean
      )
      on conflict (shot_id, checkpoint_key) do nothing;
    end loop;

    -- A scored shot finalizes its permit; an abstention releases it — in the
    -- SAME transaction as the shot write (the atomicity services/api had).
    update public.analysis_permits
       set status = case when v_result_kind = 'scored' then 'finalized' else 'released' end,
           outcome = v_result_kind
     where id = v_permit_id and user_id = v_uid and status = 'reserved';

    return 'accepted';
  exception
    when unique_violation then
      -- The shot id settled concurrently. Ours → replay-accept; another
      -- user's id → permanent conflict (the row is never touched).
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      return 'shot.id_conflict';
    when others then
      return 'shot.write_failed:' || sqlerrm;
  end;
end;
$$;

revoke all on function public.apply_synced_shot(jsonb) from public, anon;
grant execute on function public.apply_synced_shot(jsonb) to authenticated;

comment on function public.apply_synced_shot(jsonb) is
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction. SECURITY DEFINER (2026-09-05): the client role holds no INSERT on shots/shot_phases/shot_checkpoints/shot_measurements, so this function is the only path that records a shot; every statement is scoped to auth.uid() (the caller). Also enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(), so neither an over-issued permit nor a deleted-and-recreated account can become an extra free rating.';
