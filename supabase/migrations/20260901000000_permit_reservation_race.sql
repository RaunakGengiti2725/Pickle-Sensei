-- ============================================================================
-- Free-rating reservation race — atomic check-then-insert + a sync backstop.
--
-- THE BUG. reserveAnalysisPermit (functions/api/index.ts) read access state
-- and then inserted a permit as two separate statements with nothing
-- serializing them:
--
--     const access = await accessPayload(authed);        -- reads shots+permits
--     if (!access.canStartRating) return 402;            -- decision
--     await authed.db.from("analysis_permits").insert(…); -- write
--
-- Two concurrent requests carrying DIFFERENT idempotency keys could each
-- observe availableToReserve >= 1 and both insert, so an account could hold
-- more reserved permits than it has free ratings and ultimately record more
-- than the two lifetime scored ratings the product promises. The existing
-- 23505 handler only covers the SAME-key retry, which is a different race.
-- unique(user_id, idempotency_key) cannot express the limit, and neither can
-- any single-table CHECK: the count spans public.shots and
-- public.analysis_permits.
--
-- (services/api, the superseded Fastify backend, did not have this hole — it
-- took SELECT … FOR UPDATE on analysis_access_account before deciding, and
-- carried CHECK (free_successful_ratings BETWEEN 0 AND 2). The Supabase port
-- kept the arithmetic and dropped both guards.)
--
-- THE FIX, in two layers:
--   1. reserve_analysis_permit() — moves the whole check-then-insert into one
--      statement under a per-user transaction-scoped advisory lock, so the
--      decision and the write cannot interleave.
--   2. apply_synced_shot() — takes the SAME lock and re-checks the lifetime
--      limit before recording a scored shot, so a permit that was somehow
--      over-issued still cannot become a third free rating.
--
-- Both are SECURITY INVOKER: every statement runs under the caller's RLS, so
-- they can only ever see and write that user's own rows. Additive only — no
-- table, policy, or grant changes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Shared lock key. Both functions MUST derive the key identically or they do
-- not serialize against each other. Transaction-scoped: released when the
-- statement's implicit transaction ends, so no explicit unlock is needed and
-- a failed call cannot strand the lock.
-- ---------------------------------------------------------------------------
create or replace function public.access_lock_key(p_uid uuid)
returns bigint
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.hashtextextended('pickle.access:' || p_uid::text, 0)
$$;

comment on function public.access_lock_key(uuid) is
  'Advisory-lock key serializing free-rating accounting per user. Shared by reserve_analysis_permit and apply_synced_shot; changing it in one place without the other silently removes the serialization.';

revoke all on function public.access_lock_key(uuid) from public, anon;
grant execute on function public.access_lock_key(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. reserve_analysis_permit(idempotency_key) — atomic reserve.
--
--    Returns one row. `result` is a status string the API maps verbatim:
--      accepted | auth.required | access.paywall_required
--    On 'accepted' the permit columns are populated (a fresh insert and an
--    idempotent replay are indistinguishable to the caller, by contract).
--
--    The limit arithmetic is deliberately byte-identical to accessPayload():
--      used      = least(scored, 2)
--      remaining = 2 - used
--      reject   ⟺ remaining <= reserved_count   (non-premium only)
--    accessPayload clamps reserved to remaining and rejects when
--    availableToReserve = remaining - min(reserved, remaining) is 0, which is
--    exactly remaining <= reserved. Keep the two in step.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_analysis_permit(p_idempotency_key text)
returns table (
  result text,
  permit_id uuid,
  permit_status text,
  permit_outcome text,
  permit_created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
  v_scored int;
  v_reserved int;
  v_remaining int;
  v_row public.analysis_permits%rowtype;
begin
  if v_uid is null then
    result := 'auth.required';
    return next;
    return;
  end if;

  -- Fast path: an idempotent replay of a key we already hold never contends
  -- for the lock. This is the overwhelmingly common retry shape.
  select * into v_row
  from public.analysis_permits p
  where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
  if found then
    result := 'accepted';
    permit_id := v_row.id;
    permit_status := v_row.status;
    permit_outcome := v_row.outcome;
    permit_created_at := v_row.created_at;
    return next;
    return;
  end if;

  -- Serialize the check-then-insert for this user. This is the fix.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Re-check under the lock: a concurrent request with the SAME key may have
  -- inserted between the fast-path read above and acquiring the lock.
  select * into v_row
  from public.analysis_permits p
  where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
  if found then
    result := 'accepted';
    permit_id := v_row.id;
    permit_status := v_row.status;
    permit_outcome := v_row.outcome;
    permit_created_at := v_row.created_at;
    return next;
    return;
  end if;

  select
    coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false),
    (
      select count(*)::int from public.shots s
      where s.user_id = v_uid and s.result_kind = 'scored'
    ),
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = v_uid
        and p.status = 'reserved'
        and p.created_at > now() - interval '24 hours'
    )
  into v_premium, v_scored, v_reserved;

  v_remaining := 2 - least(v_scored, 2);

  if not v_premium and v_remaining <= v_reserved then
    result := 'access.paywall_required';
    return next;
    return;
  end if;

  insert into public.analysis_permits (user_id, idempotency_key)
  values (v_uid, p_idempotency_key)
  returning * into v_row;

  result := 'accepted';
  permit_id := v_row.id;
  permit_status := v_row.status;
  permit_outcome := v_row.outcome;
  permit_created_at := v_row.created_at;
  return next;
  return;
exception
  when unique_violation then
    -- Same-key insert settled concurrently despite the lock (possible only if
    -- a caller bypasses this function). Return the winner — idempotent by
    -- contract, never a spurious 402.
    select * into v_row
    from public.analysis_permits p
    where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
    if found then
      result := 'accepted';
      permit_id := v_row.id;
      permit_status := v_row.status;
      permit_outcome := v_row.outcome;
      permit_created_at := v_row.created_at;
      return next;
      return;
    end if;
    raise;
end;
$$;

comment on function public.reserve_analysis_permit(text) is
  'Atomic POST /v1/analysis-permits reserve: idempotent lookup, lifetime free-rating check, and insert in one statement under a per-user advisory lock. Replaces the Edge Function''s unserialized check-then-insert, which allowed concurrent reserves with distinct idempotency keys to exceed the two-rating limit.';

revoke all on function public.reserve_analysis_permit(text) from public, anon;
grant execute on function public.reserve_analysis_permit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. apply_synced_shot(shot jsonb) — unchanged except for two additions,
--    marked FREE-LIMIT BACKSTOP below. Recreated in full because Postgres has
--    no partial function replace.
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
  if v_result_kind = 'scored' then
    select coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false) into v_premium;

    if not v_premium and (
      select count(*) from public.shots s
      where s.user_id = v_uid and s.result_kind = 'scored'
    ) >= 2 then
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
      return 'shot.write_failed:' || sqlerrm;
  end;
end;
$$;

comment on function public.apply_synced_shot(jsonb) is
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Also enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock, so an over-issued permit cannot become an extra free rating.';

revoke all on function public.apply_synced_shot(jsonb) from public, anon;
grant execute on function public.apply_synced_shot(jsonb) to authenticated;
