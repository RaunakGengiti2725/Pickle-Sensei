-- ============================================================================
-- Pickle Sensei — error hygiene + capture-evidence hardening (XC-SEC-4/5).
--
-- 1. apply_synced_shot(jsonb): the WHEN OTHERS handler returned
--    'shot.write_failed:' || sqlerrm. sqlerrm echoes the offending INPUT for
--    cast/parse failures (e.g. invalid input syntax for type timestamp with
--    time zone: "<client string>"), so a client that bypasses the edge parser
--    and calls the RPC directly (public anon key + user JWT) could inject
--    arbitrary text — newlines included — into the edge function's
--    console.error line. The result is now 'shot.write_failed:' || SQLSTATE
--    (five characters, [0-9A-Z]); operators keep the error CLASS, the log
--    stays categorical, and the edge still maps every write_failed:* to its
--    stable client code.
--
-- 2. captured_at range: timestamptz accepts 'infinity' / '-infinity' and any
--    year up to 294276. Neither is a capture instant. shots.captured_at and
--    captures.captured_at are bounded to [2000-01-01, 2100-01-01) — NOT VALID
--    so existing rows are never re-checked by the deploy, but every INSERT and
--    UPDATE from now on is. The edge parser enforces the same window.
--
-- 3. captures text bounds: 20260831160000_defense_in_depth.sql capped every
--    client-authored text column EXCEPT those on public.captures, which
--    authenticated could INSERT into directly via PostgREST (multi-MiB
--    declared_stroke / recognized_shot_type reproduced). captures_text_bounds
--    caps every text column on the table (64 chars, like shots_text_bounds).
--
-- 4. captures grants sized to the writes: no edge route writes public.captures
--    today (the table is read by practice_days / progress cards only), so the
--    authenticated INSERT/UPDATE/DELETE grants from 20260829120000 were pure
--    attack surface. Revoked; SELECT stays. If a route ever writes captures,
--    re-grant exactly the columns it writes in a NEW migration.
--
-- New file only — applied migrations are never edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. captured_at bounds (shots, captures)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shots_captured_at_bounds') then
    alter table public.shots add constraint shots_captured_at_bounds check (
      captured_at >= '2000-01-01' and captured_at < '2100-01-01'
    ) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'captures_captured_at_bounds') then
    alter table public.captures add constraint captures_captured_at_bounds check (
      captured_at >= '2000-01-01' and captured_at < '2100-01-01'
    ) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. captures text bounds (every text column on the table)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'captures_text_bounds') then
    alter table public.captures add constraint captures_text_bounds check (
      length(capture_mode) <= 64
      and coalesce(length(declared_stroke), 0) <= 64
      and coalesce(length(recognized_shot_type), 0) <= 64
      and length(evidence_status) <= 64
      and length(status) <= 64
    ) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. captures is read-only for clients (grants sized to the writes: none)
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.captures from anon, authenticated;
drop policy if exists "captures_insert_own" on public.captures;
drop policy if exists "captures_update_own" on public.captures;
drop policy if exists "captures_delete_own" on public.captures;

-- ---------------------------------------------------------------------------
-- 4. apply_synced_shot(shot jsonb) — identical to 20260902150000 except the
--    WHEN OTHERS handler (marked SQLSTATE ONLY below). Recreated in full.
-- ---------------------------------------------------------------------------
create or replace function public.apply_synced_shot(shot jsonb)
returns text
language plpgsql
security invoker
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
      -- The shot id settled concurrently. Ours → replay-accept; a different
      -- user's id (invisible under RLS) → permanent conflict.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      return 'shot.id_conflict';
    when others then
      -- SQLSTATE ONLY: sqlerrm echoes the client's input for cast failures
      -- and would carry it into the edge function's logs. The five-char class
      -- is enough for operators; the edge maps every write_failed:* to the
      -- stable client code.
      return 'shot.write_failed:' || sqlstate;
  end;
end;
$$;

comment on function public.apply_synced_shot(jsonb) is
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Also enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(), so neither an over-issued permit nor a deleted-and-recreated account can become an extra free rating. Write failures return shot.write_failed:<SQLSTATE> only — never sqlerrm, which echoes client input.';
