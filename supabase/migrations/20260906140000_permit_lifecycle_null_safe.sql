-- ============================================================================
-- Pickle Sensei — permit backing is decided NULL-safe and default-deny, the
-- permit lifecycle is closed at the table, and the sync gate never falls back
-- to a permit the shot did not name (OFF-24H-02; follows 20260906130000).
--
-- THE BREAK (adversary round 6, security_regression.sql section O). A permit
-- row in state status='released', outcome=NULL is client-reachable:
-- `authenticated` holds UPDATE(status, outcome) on its own analysis_permits
-- rows (20260831160000) and nothing constrained the transition, so
-- `PATCH /rest/v1/analysis_permits?id=eq.<own>` with
-- {"status":"released","outcome":null} produced it. The round-6 backing rule
--     not (status = 'reserved' or (status = 'released' and outcome = 'expired'))
-- is three-valued: with outcome NULL the whole predicate is NULL, `IF NULL`
-- does not fire, and the permit fell through as acceptable backing.
-- Observed on real Postgres:
--   * released/NULL, no other permit → the RPC's INSERT reached the shots
--     gate, which found no backing and raised 42501 → shot.write_failed:42501,
--     a TRANSIENT code for the mobile outbox (retried until exhausted);
--   * released/NULL beside an unrelated LIVE reservation → the gate's
--     fallback ("some reserved permit younger than 24h") let the INSERT
--     through, the finalize UPDATE (same 3VL predicate) matched nothing, the
--     permit stayed released/NULL and backed a SECOND shot: two scored rows
--     on one permit (one-permit-one-shot invariant N7 broken).
--
-- THE FIX — four layers, each sufficient on its own for the reported break:
--   1. permit_backs_sync(status, outcome) is THE backing predicate, wrapped in
--      coalesce(…, false): NULL/unknown outcome → false → refused. Every
--      status/outcome comparison in apply_synced_shot() and
--      enforce_scored_shot_permit() goes through it (the validation IF, the
--      free_limit_exceeded release, the finalize UPDATE, the gate's vouch
--      check). Audit of the other decision points: reserve_analysis_permit(),
--      access_state() and the pg_cron sweep expire-stale-analysis-permits
--      compare only `status = 'reserved'` — status is NOT NULL with a CHECK
--      vocabulary, so no 3VL hole exists there and they are left untouched.
--   2. The permit lifecycle is a table invariant (BEFORE INSERT OR UPDATE
--      trigger analysis_permits_guard_lifecycle, every role):
--        shape   reserved ⇔ outcome IS NULL; a settled row carries one of the
--                known outcomes (scored, low_confidence, cancelled, failed,
--                unsupported, incorrect_recognition, expired,
--                free_limit_exceeded)
--        moves   reserved         → finalized/{scored, low_confidence, cancelled,
--                                    failed, unsupported, incorrect_recognition}
--                                    (edge POST …/finalize and the sync RPC)
--                reserved         → released/{expired (pg_cron sweep),
--                                    low_confidence (abstention sync),
--                                    free_limit_exceeded (backstop)}
--                released/expired → finalized/scored, released/low_confidence,
--                                    released/free_limit_exceeded (late sync)
--                everything else is terminal; a no-op UPDATE is allowed.
--      A rejected move raises check_violation (23514, hint
--      access.permit_transition_rejected): PostgREST answers 400, and the
--      edge finalize route maps it to 409 — never a 503.
--   3. The shots gate has NO fallback when the sync RPC vouches: with
--      pickle.sync_permit_id set, the vouched permit alone decides (owned by
--      the caller AND permit_backs_sync). Only a direct client INSERT (no
--      vouch) uses the unchanged live-permit rule (reserved, < 24h). The RPC
--      also asserts its finalize UPDATE consumed exactly one row.
--   4. A gate refusal inside the RPC is a contract verdict, never a grant
--      error: when the RPC vouches, the gate raises the verdict-specific
--      SQLSTATEs PKP01 (access.permit_not_reserved) / PKP02
--      (access.paywall_required) and the RPC's handler returns the verdict by
--      SQLSTATE alone (no message/hint text is ever read — error-hygiene pin).
--      A direct client INSERT (no vouch) keeps 42501 → PostgREST 403. Any
--      other 42501 stays shot.write_failed:42501 (a real grant regression must
--      keep the rating on the device).
--
-- Round-6 behaviour is preserved: reserved at any age and swept
-- released/expired permits back their shot; the free-limit backstop still
-- caps free accounts at two lifetime scored ratings; access.permit_expired
-- stays retired. Rows already in a settled/NULL state are not rewritten —
-- they are terminal under the trigger and refused by permit_backs_sync().
--
-- Pinned by: security_regression.sql sections O + P (live, disposable
-- Postgres), __wf__/db_migrations_rls_indexes.test.ts (static), edge
-- __wf__ finalize route test. New file only — applied migrations are never
-- edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The one backing predicate. IMMUTABLE + inlinable; NULL-safe by
--    construction (coalesce → false). Callable by authenticated because the
--    SECURITY INVOKER RPC and gate evaluate it in the caller's session.
-- ---------------------------------------------------------------------------
create or replace function public.permit_backs_sync(p_status text, p_outcome text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    p_status = 'reserved'
    or (p_status = 'released' and p_outcome = 'expired'),
    false)
$$;

comment on function public.permit_backs_sync(text, text) is
  'The single permit-backing rule for a synced shot: reserved (any age) or released/expired. NULL-safe and default-deny — a NULL or unknown outcome is never acceptable backing. Used by apply_synced_shot() and enforce_scored_shot_permit(); never write the rule inline again.';

revoke all on function public.permit_backs_sync(text, text) from public, anon;
grant execute on function public.permit_backs_sync(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The permit lifecycle as a table invariant.
-- ---------------------------------------------------------------------------
create or replace function public.guard_analysis_permit_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_from text := case
    when tg_op = 'UPDATE' then old.status || '/' || coalesce(old.outcome, 'NULL')
    else 'INSERT'
  end;
  v_to text := new.status || '/' || coalesce(new.outcome, 'NULL');
begin
  -- Shape: a reservation has no outcome yet; a settled permit always names
  -- one of the known outcomes. released/NULL and finalized/NULL cannot be
  -- written by any role from here on.
  if (new.status = 'reserved') <> (new.outcome is null)
     or (new.status <> 'reserved' and new.outcome not in (
       'scored', 'low_confidence', 'cancelled', 'failed', 'unsupported',
       'incorrect_recognition', 'expired', 'free_limit_exceeded')) then
    raise exception using
      errcode = 'check_violation',
      message = format('analysis_permits: illegal permit state %s (%s)', v_to, v_from),
      hint = 'access.permit_transition_rejected';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  -- Bookkeeping updates that leave the lifecycle alone.
  if new.status = old.status and new.outcome is not distinct from old.outcome then
    return new;
  end if;

  -- reserved → any settled state (the edge finalize route, the sync RPC, the
  -- pg_cron sweep). Shape above already pins the outcome vocabulary.
  if old.status = 'reserved' then
    return new;
  end if;

  -- released/expired (swept while the device was offline) → exactly the
  -- states apply_synced_shot() settles a late permit into.
  if old.status = 'released' and old.outcome = 'expired'
     and (new.status, new.outcome) in (
       ('finalized', 'scored'),
       ('released', 'low_confidence'),
       ('released', 'free_limit_exceeded')) then
    return new;
  end if;

  -- Every other settled state is terminal: consumed permits are never
  -- revived, a refused permit is never re-labelled into acceptable backing.
  raise exception using
    errcode = 'check_violation',
    message = format('analysis_permits: illegal permit transition %s -> %s', v_from, v_to),
    hint = 'access.permit_transition_rejected';
end;
$$;

comment on function public.guard_analysis_permit_lifecycle() is
  'BEFORE INSERT OR UPDATE guard on public.analysis_permits: reserved ⇔ outcome IS NULL, settled rows carry a known outcome, and the only lifecycle moves are reserved → any settled state and released/expired → finalized/scored | released/low_confidence | released/free_limit_exceeded. Every other transition raises check_violation (23514, hint access.permit_transition_rejected) — PostgREST 400, edge 409, never a 503. Applies to every role; clients cannot disable triggers (no TRIGGER privilege).';

revoke execute on function public.guard_analysis_permit_lifecycle()
  from public, anon, authenticated;

drop trigger if exists analysis_permits_guard_lifecycle on public.analysis_permits;
create trigger analysis_permits_guard_lifecycle
  before insert or update on public.analysis_permits
  for each row execute function public.guard_analysis_permit_lifecycle();

-- ---------------------------------------------------------------------------
-- 3. The shots gate: the vouched permit alone decides for the sync RPC; the
--    unchanged live-permit rule applies only to direct client INSERTs.
--    Refusals inside a vouched (RPC) insert raise the verdict SQLSTATEs
--    PKP01/PKP02; direct INSERTs keep 42501 (layer 4).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_scored_shot_permit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
  v_vouched uuid;
begin
  if new.result_kind <> 'scored' or v_uid is null then
    return new;
  end if;

  -- Same key as reserve_analysis_permit() / apply_synced_shot(): a direct
  -- writer racing itself (or a sync) serializes here. Re-entrant inside the
  -- RPC, which already holds it for this transaction.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- apply_synced_shot() names the permit it locked and validated for this
  -- insert. Nothing else can set it (PostgREST exposes no set_config and the
  -- schema-exposed RPCs never take it from input).
  v_vouched := nullif(pg_catalog.current_setting('pickle.sync_permit_id', true), '')::uuid;

  if v_vouched is not null then
    -- Sync path: the ONE permit the shot names must back it. No fallback to
    -- any other reservation the caller may hold.
    if not exists (
      select 1 from public.analysis_permits p
      where p.user_id = v_uid
        and p.id = v_vouched
        and public.permit_backs_sync(p.status, p.outcome)
    ) then
      raise exception using
        errcode = 'PKP01',
        message = 'shots: the permit named for this synced shot is not acceptable backing',
        hint = 'access.permit_not_reserved';
    end if;
  elsif not exists (
    -- Direct client INSERT: byte-for-byte the pre-fix rule — a live reserved
    -- permit younger than 24h.
    select 1 from public.analysis_permits p
    where p.user_id = v_uid
      and p.status = 'reserved'
      and p.created_at > now() - interval '24 hours'
  ) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: a scored shot requires a live reserved analysis permit (use apply_synced_shot)',
      hint = 'access.permit_not_reserved';
  end if;

  select coalesce((
    select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b
    where b.user_id = v_uid
  ), false) into v_premium;

  if not v_premium and public.lifetime_scored_count() >= 2 then
    raise exception using
      errcode = case when v_vouched is not null then 'PKP02' else 'insufficient_privilege' end,
      message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)',
      hint = 'access.paywall_required';
  end if;

  return new;
end;
$$;

comment on function public.enforce_scored_shot_permit() is
  'BEFORE INSERT gate on public.shots: a scored row written from a client session must be backed by a live reserved permit (direct INSERT, < 24h) — or, when apply_synced_shot() vouches through the transaction-local pickle.sync_permit_id setting, by THAT permit alone (permit_backs_sync: reserved at any age, or released/expired; no fallback to other reservations) — and fit the lifetime free-rating allowance (premium bypasses the allowance, never the permit). A refusal inside a vouched insert raises SQLSTATE PKP01 (permit) / PKP02 (allowance) so apply_synced_shot() returns the contract verdict, not a grant error; a direct INSERT refusal stays 42501 (PostgREST 403). Runs under the same per-user advisory lock as reserve_analysis_permit()/apply_synced_shot().';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. apply_synced_shot(): NULL-safe backing, one-permit-one-shot asserted,
--    gate refusals surface as verdicts.
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
  v_consumed integer;
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

  -- A permit this user reserved backs the shot at ANY age: still 'reserved'
  -- (the stale-permit sweep has not run), or already swept to
  -- released/expired while the device was offline. Every other state —
  -- consumed (finalized), released for the free limit, cancelled, any other
  -- abstention outcome, or a NULL/unknown outcome — cannot back a new shot
  -- (permit_backs_sync is NULL-safe: unknown → false → refused). The free
  -- allowance is decided by the lifetime count below, never by permit age.
  if not public.permit_backs_sync(v_permit.status, v_permit.outcome) then
    return 'access.permit_not_reserved';
  end if;

  -- FREE-LIMIT BACKSTOP (2/2): holding a permit is not by itself authority to
  -- record a scored shot. If an extra permit was ever issued (every build
  -- before reserve_analysis_permit could do this), or a swept permit's slot
  -- was re-spent while the device was offline, a non-premium account still
  -- may not exceed two lifetime scored ratings. The permit is released rather
  -- than left reserved so it stops occupying an allowance slot and the sweep
  -- has nothing to collect.
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
       where id = v_permit_id and user_id = v_uid
         and public.permit_backs_sync(status, outcome);
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
  -- leaves the permit untouched (still backing a clean retry). The vouch is
  -- set inside the block so a failure reverts it with everything else.
  begin
    -- Tell the shots BEFORE INSERT gate which permit backs this row: the one
    -- locked and validated above, whatever its age. The gate decides on this
    -- permit alone.
    perform pg_catalog.set_config('pickle.sync_permit_id', v_permit_id::text, true);

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

    perform pg_catalog.set_config('pickle.sync_permit_id', '', true);

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
    -- SAME transaction as the shot write. A late or swept permit ends in
    -- exactly the state a fresh one does, so it can never back a second shot.
    -- ONE-PERMIT-ONE-SHOT: the row locked above must be the row consumed
    -- here; anything else rolls the whole write back.
    update public.analysis_permits
       set status = case when v_result_kind = 'scored' then 'finalized' else 'released' end,
           outcome = v_result_kind
     where id = v_permit_id and user_id = v_uid
       and public.permit_backs_sync(status, outcome);
    get diagnostics v_consumed = row_count;
    if v_consumed <> 1 then
      raise exception using
        errcode = 'check_violation',
        message = format('shots: permit %s was not consumed exactly once (%s rows)', v_permit_id, v_consumed);
    end if;

    return 'accepted';
  exception
    when unique_violation then
      -- The shot id settled concurrently. Ours → replay-accept; a different
      -- user's id (invisible under RLS) → permanent conflict.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      return 'shot.id_conflict';
    when sqlstate 'PKP01' then
      -- The shots gate refused THIS permit under the vouch: a contract
      -- verdict the outbox settles, never a transient grant error. (Any real
      -- 42501 falls through to write_failed and keeps the rating on-device.)
      return 'access.permit_not_reserved';
    when sqlstate 'PKP02' then
      return 'access.paywall_required';
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
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Idempotent on the client-generated shot id: ownership is checked before AND after the per-user advisory lock, so a duplicate copy that lost the race replays as accepted instead of seeing its already-consumed permit. Backing is decided by permit_backs_sync() — reserved at any age, or swept to released/expired — NULL-safe and default-deny, so a released/NULL or any other settled permit is refused (access.permit_not_reserved) and the shot is never written; the finalize UPDATE must consume exactly that one permit. Enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(). A shots-gate refusal surfaces as its verdict (hint), never as shot.write_failed:42501. Other write failures return shot.write_failed:<SQLSTATE> only — never sqlerrm, which echoes client input.';
