-- ============================================================================
-- Pickle Sensei — a settled permit is terminal for the CLIENT ROLE too, and
-- one-permit-one-shot is a data-layer invariant (OFF-24H-02 follow-up,
-- ADV7-PERMIT-REUSE-DELETE-REINSERT; follows 20260906140000).
--
-- THE BREAK (adversary round 7, ADV-10, real Postgres 16). The round-7
-- lifecycle guard closes every UPDATE path out of a settled permit, but
-- `authenticated` still held the full owner CRUD from 20260829140000:
-- policy analysis_permits_delete_own + the table-level DELETE grant, and a
-- table-level INSERT grant that lets the client choose `id`. So, after a
-- permit is finalized/scored and backs a shot:
--     DELETE FROM analysis_permits WHERE id = $P;                 -- allowed 1
--     INSERT INTO analysis_permits (id, user_id, idempotency_key)
--       VALUES ($P, auth.uid(), 'again');                          -- allowed 1
--     apply_synced_shot({... analysisPermitId: $P ...})           -- accepted
-- → two scored shot rows on one permit id, the permit "finalized/scored"
-- twice. No UPDATE happened, so the lifecycle guard never fired. The free
-- allowance is still capped by lifetime_scored_count() (identity ledger), so
-- this is an invariant escape (one-permit-one-shot N7, settled-permit
-- terminality), not a third free rating — but the shots table then carries
-- duplicate scored rows backed by a resurrected permit.
--
-- WHY THE CLIENT EVER HAD THESE: nothing in the product uses them. The mobile
-- app never touches analysis_permits (zero references under apps/mobile/src);
-- the edge function reserves through reserve_analysis_permit() (SECURITY
-- INVOKER — it INSERTs (user_id, idempotency_key) as the caller) and settles
-- through UPDATE(status, outcome); account deletion removes permits through
-- the auth.users → profiles → analysis_permits ON DELETE CASCADE, which runs
-- as the table owner. No client path DELETEs a permit or names an id.
--
-- THE FIX — three independent layers, each sufficient for ADV-10:
--   1. Client DELETE is gone: analysis_permits_delete_own is dropped and the
--      DELETE grant revoked from public/anon/authenticated. A permit row now
--      leaves the table only through the owner cascade (account deletion).
--   2. Client INSERT is sized to the columns the product writes:
--      (user_id, idempotency_key, status, outcome). `id`, `created_at` and
--      `updated_at` are server-assigned — a client cannot name a permit id
--      (no resurrection by construction) nor back-date a reservation.
--      INSERT is NOT revoked outright: reserve_analysis_permit() is SECURITY
--      INVOKER and performs the INSERT as `authenticated`; converting it to
--      DEFINER would change the trust model of the reservation path for no
--      gain once the id/created_at columns are closed. The lifecycle guard
--      (BEFORE INSERT OR UPDATE) still pins the inserted shape: reserved ⇔
--      outcome IS NULL, settled rows carry a known outcome. A client-written
--      settled permit grants nothing downstream — access_state() and
--      reserve_analysis_permit() count only `reserved` rows, the free
--      allowance is lifetime_scored_count(), and permit_backs_sync() refuses
--      every settled state except released/expired (which backs one shot
--      under the same allowance a reservation would).
--   3. One-permit-one-shot lives in the data: public.shots.analysis_permit_id
--      records the permit apply_synced_shot() consumed for the row, and the
--      partial UNIQUE index shots_analysis_permit_unique (WHERE NOT NULL)
--      makes a second row on the same permit id impossible for every role,
--      whatever the permit row says — or whether it still exists. Rows synced
--      before this migration keep NULL (no link was recorded; their permits
--      are finalized and now undeletable, so they cannot be reused either).
--      Direct client INSERTs into shots may not set the column (the gate
--      refuses 42501 unless the RPC vouched for exactly that permit), and a
--      permit id that already backs a shot can never be INSERTed again
--      (definer BEFORE INSERT trigger analysis_permits_guard_resurrection,
--      23514 + access.permit_transition_rejected) nor accepted as fresh
--      backing by apply_synced_shot() (access.permit_not_reserved).
--
-- Legitimate writers, unchanged and re-proven live (security_regression.sql
-- section Q): reserve_analysis_permit(); edge finalize UPDATE reserved →
-- finalized/*; edge release reserved → released/*; pg_cron sweep reserved →
-- released/expired; apply_synced_shot() from reserved or released/expired;
-- the auth.users cascade (permits removed, free_rating_ledger survives).
-- Same-shot replay stays idempotent (ownership is checked before the permit).
-- A shot with no permit link (direct INSERT under the live-permit rule) is
-- unaffected by the partial index.
--
-- Pinned by: __wf__/xc_pg_permit_lifecycle_adversary.test.ts ADV-10 (live),
-- security_regression.sql section Q (live), __wf__/db_migrations_rls_indexes
-- .test.ts (static). New file only — applied migrations are never edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. No client DELETE on analysis_permits.
-- ---------------------------------------------------------------------------
drop policy if exists "analysis_permits_delete_own" on public.analysis_permits;
revoke delete on public.analysis_permits from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Client INSERT sized to the product's columns: never id / created_at /
--    updated_at. The owner policy analysis_permits_insert_own
--    (auth.uid() = user_id) stays as the row filter.
-- ---------------------------------------------------------------------------
revoke insert on public.analysis_permits from public, anon, authenticated;
grant insert (user_id, idempotency_key, status, outcome)
  on public.analysis_permits to authenticated;

-- ---------------------------------------------------------------------------
-- 3a. The permit a synced shot consumed, unique across the table.
-- ---------------------------------------------------------------------------
alter table public.shots add column if not exists analysis_permit_id uuid;

comment on column public.shots.analysis_permit_id is
  'The analysis permit apply_synced_shot() consumed for this row (finalized/scored or released/low_confidence in the same transaction). NULL for rows synced before 20260907000000 and for direct INSERTs under the live-permit rule. Unique when set (shots_analysis_permit_unique): one permit backs at most one shot, for every role, regardless of the permit row''s state or existence. Written only through the RPC vouch — a client INSERT naming it is refused by the shots gate.';

create unique index if not exists shots_analysis_permit_unique
  on public.shots (analysis_permit_id)
  where analysis_permit_id is not null;

-- ---------------------------------------------------------------------------
-- 3b. A permit id that already backs a shot can never be (re-)created. Runs
--     as definer so the shots lookup is not narrowed by the caller's RLS.
-- ---------------------------------------------------------------------------
create or replace function public.guard_analysis_permit_resurrection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.shots s where s.analysis_permit_id = new.id) then
    raise exception using
      errcode = 'check_violation',
      message = format('analysis_permits: permit %s already backs a shot and cannot be created again', new.id),
      hint = 'access.permit_transition_rejected';
  end if;
  return new;
end;
$$;

comment on function public.guard_analysis_permit_resurrection() is
  'BEFORE INSERT guard on public.analysis_permits: an id already recorded in public.shots.analysis_permit_id is a consumed permit and is never re-created (check_violation 23514, hint access.permit_transition_rejected), by any role. SECURITY DEFINER so the lookup sees every shot row; revoked from clients (triggers do not need EXECUTE).';

revoke execute on function public.guard_analysis_permit_resurrection()
  from public, anon, authenticated;

drop trigger if exists analysis_permits_guard_resurrection on public.analysis_permits;
create trigger analysis_permits_guard_resurrection
  before insert on public.analysis_permits
  for each row execute function public.guard_analysis_permit_resurrection();

-- ---------------------------------------------------------------------------
-- 3c. The shots gate: the permit link is written only under the RPC's vouch.
--     A client session may not set analysis_permit_id on its own, and a
--     vouched insert must link exactly the vouched permit. Everything else is
--     byte-for-byte 20260906140000 (vouch-only backing, PKP01/PKP02 verdicts,
--     24h live-permit rule for direct INSERTs, lifetime allowance).
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
  if v_uid is null then
    return new;
  end if;

  -- apply_synced_shot() names the permit it locked and validated for this
  -- insert. Nothing else can set it (PostgREST exposes no set_config and the
  -- schema-exposed RPCs never take it from input).
  v_vouched := nullif(pg_catalog.current_setting('pickle.sync_permit_id', true), '')::uuid;

  -- The permit link is the vouch's to write: a direct INSERT may not claim a
  -- permit, and a vouched insert records the vouched permit and no other.
  if new.analysis_permit_id is not null
     and (v_vouched is null or new.analysis_permit_id <> v_vouched) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: analysis_permit_id is written only by apply_synced_shot for the permit it consumed',
      hint = 'access.permit_not_reserved';
  end if;
  new.analysis_permit_id := v_vouched;

  if new.result_kind <> 'scored' then
    return new;
  end if;

  -- Same key as reserve_analysis_permit() / apply_synced_shot(): a direct
  -- writer racing itself (or a sync) serializes here. Re-entrant inside the
  -- RPC, which already holds it for this transaction.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

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
  'BEFORE INSERT gate on public.shots: analysis_permit_id may only be the permit apply_synced_shot() vouches for through the transaction-local pickle.sync_permit_id setting (a direct client INSERT must leave it NULL — 42501 otherwise). A scored row written from a client session must be backed by a live reserved permit (direct INSERT, < 24h) — or, under the vouch, by THAT permit alone (permit_backs_sync: reserved at any age, or released/expired; no fallback) — and fit the lifetime free-rating allowance (premium bypasses the allowance, never the permit). A refusal inside a vouched insert raises SQLSTATE PKP01 (permit) / PKP02 (allowance) so apply_synced_shot() returns the contract verdict, not a grant error; a direct INSERT refusal stays 42501 (PostgREST 403). Runs under the same per-user advisory lock as reserve_analysis_permit()/apply_synced_shot().';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. apply_synced_shot(): records the consumed permit on the shot, refuses a
--    permit id that already backs a shot, and maps the unique-index refusal
--    to the contract verdict. Everything else is byte-for-byte 20260906140000.
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

  -- ONE-PERMIT-ONE-SHOT, data layer: a permit id already linked to a shot is
  -- consumed whatever its row says (or however it came to exist again).
  if exists (select 1 from public.shots s where s.analysis_permit_id = v_permit_id) then
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
    -- permit alone, and the row records it (shots_analysis_permit_unique).
    perform pg_catalog.set_config('pickle.sync_permit_id', v_permit_id::text, true);

    insert into public.shots (
      id, user_id, session_id, analysis_permit_id, shot_type, camera_view,
      captured_at, start_ms, contact_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version, source
    ) values (
      v_id,
      v_uid,
      v_session_id,
      v_permit_id,
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
      -- The shot id settled concurrently. Ours → replay-accept; the permit
      -- already backs another row (shots_analysis_permit_unique) → the permit
      -- verdict; a different user's id (invisible under RLS) → permanent
      -- conflict.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      if exists (select 1 from public.shots s where s.analysis_permit_id = v_permit_id) then
        return 'access.permit_not_reserved';
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
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Idempotent on the client-generated shot id: ownership is checked before AND after the per-user advisory lock, so a duplicate copy that lost the race replays as accepted instead of seeing its already-consumed permit. Backing is decided by permit_backs_sync() — reserved at any age, or swept to released/expired — NULL-safe and default-deny, so a released/NULL or any other settled permit is refused (access.permit_not_reserved) and the shot is never written; a permit id already recorded on a shot (shots.analysis_permit_id, unique) is refused the same way; the finalize UPDATE must consume exactly that one permit. Enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(). A shots-gate refusal surfaces as its verdict (hint), never as shot.write_failed:42501. Other write failures return shot.write_failed:<SQLSTATE> only — never sqlerrm, which echoes client input.';
