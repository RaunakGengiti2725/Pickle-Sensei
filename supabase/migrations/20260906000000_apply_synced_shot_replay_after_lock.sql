-- ============================================================================
-- Pickle Sensei — duplicate-sync losers replay as accepted (XC edge S5b / PG3).
--
-- THE DEFECT. apply_synced_shot() checks "this user already owns the row"
-- BEFORE taking the per-user advisory lock (so replays never contend), then
-- refuses a permit whose status is not 'reserved'. With N in-flight copies of
-- the SAME shot (same permit — the mobile outbox retrying while an earlier
-- attempt is still on the wire, or two syncs kicked off by foreground +
-- timer), every copy passes the pre-lock check because no row exists yet, the
-- winner commits and finalizes the permit, and each loser that was queued on
-- the lock then observes status = 'finalized' and is told
-- access.permit_not_reserved. That code is a contract verdict for the mobile
-- sync layer (not in TRANSIENT_SYNC_REJECTION_CODES): it burns one of the
-- outbox row's bounded attempts and surfaces as a rejection for a shot the
-- server actually holds. Reproduced on real Postgres by
-- __wf__/xc_pg_rpc_concurrency.test.ts PG3 (15 of 16 lanes per round) and on
-- the edge model by xc_edge_concurrency_matrix.test.ts S5b.
--
-- THE FIX. Re-run the ownership check once the lock is held. The winner's
-- transaction commits before it releases the advisory lock, so under READ
-- COMMITTED the loser's post-lock SELECT sees the committed row and returns
-- 'accepted' — the same replay verdict a later retry would have received.
-- Everything else (permit checks, free-limit backstop, atomic write block,
-- unique_violation replay-accept, SQLSTATE-only error hygiene) is unchanged;
-- the function is recreated in full because CREATE OR REPLACE needs the body.
--
-- Also (hosted-like privilege probe, PG matrix F2): the client roles held
-- TRUNCATE, TRIGGER and REFERENCES on every public table through the
-- platform's default privileges. None of the edge function's writes need
-- them, PostgREST never issues them, and the least-privilege migrations
-- only revoked the DML they had to. Revoke them for good.
--
-- Pinned by: xc_pg_rpc_concurrency.test.ts PG3 (every lane accepted),
-- xc_edge_concurrency_matrix.test.ts S5b, security_regression.sql section M.
-- New file only — applied migrations are never edited.
-- ============================================================================

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

  -- Idempotent replay, again, now that we hold the lock: a concurrent copy of
  -- this very sync may have committed while we waited. Its permit is already
  -- finalized/released, so the permit checks below would hand us a permanent
  -- verdict for a row the server holds. Ownership decides first.
  if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
    return 'accepted';
  end if;

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
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Idempotent on the client-generated shot id: ownership is checked before AND after the per-user advisory lock, so a duplicate copy that lost the race replays as accepted instead of seeing its already-consumed permit. Also enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(), so neither an over-issued permit nor a deleted-and-recreated account can become an extra free rating. Write failures return shot.write_failed:<SQLSTATE> only — never sqlerrm, which echoes client input.';

-- ---------------------------------------------------------------------------
-- Client roles never TRUNCATE, create TRIGGERs on, or REFERENCE public tables.
-- (Hosted default privileges grant ALL; the DML grants stay exactly as sized
-- by the earlier migrations.)
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format(
      'revoke truncate, trigger, references on public.%I from anon, authenticated',
      t.relname
    );
  end loop;
end $$;

-- Future tables too: the platform's default-privilege grant is what handed
-- these out in the first place.
alter default privileges in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;
