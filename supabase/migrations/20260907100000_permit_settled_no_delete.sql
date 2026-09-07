-- ============================================================================
-- Settled analysis permits are terminal for EVERY role — including the table
-- owner / service role — across DELETE (round 9, sync-permit-durability;
-- ADV-11-PREFIX-RESURRECTION + ADV-17-SETTLED-UNRESTORABLE, follow-up to
-- 20260907000000_permit_terminal_client_role).
--
-- What 20260907000000 left open (owner / service role only; every client path
-- was closed there and is pinned by ADV-12..16 / security_regression Q):
--
--   ADV-11  Every production shot written before 20260907000000 has
--           shots.analysis_permit_id NULL (the column did not exist), so the
--           BEFORE INSERT resurrection guard cannot see the permit that backed
--           it. `DELETE FROM analysis_permits WHERE id = $P` of that
--           finalized/scored permit, then `INSERT ... (id = $P)` as reserved,
--           is accepted, and apply_synced_shot() backs a SECOND scored shot
--           with $P (a premium account is capped by nothing else).
--   ADV-17  DELETE of a permit that backs a linked shot is allowed (there is
--           no FK), the shot's link dangles, and the same id can never be
--           re-INSERTed (23514 for every role) — a `pg_dump --data-only`
--           reload of analysis_permits cannot run while its shots exist and
--           the orphan cannot be repaired by anyone.
--
-- Nothing in the product deletes a permit by design (audit, this tree):
--   * supabase/functions/api/index.ts reads analysis_permits and UPDATEs
--     status/outcome (finalize / release); its only deletes are saved drills,
--     webhook rows and Auth admin deleteUser (account deletion). No statement
--     deletes from analysis_permits.
--   * pg_cron 'expire-stale-analysis-permits' (20260831000000) is an UPDATE:
--     reserved rows older than 24h become released/expired. It never deletes.
--   * Account deletion is auth.users → public.profiles → analysis_permits
--     ON DELETE CASCADE (20260829140000: user_id references profiles(id) on
--     delete cascade) and the same cascade removes the user's shots.
--   * 20260907000000 revoked DELETE from public/anon/authenticated.
-- So the only DELETE paths left are the account cascade and owner-role ops
-- tooling (support, pg_restore, a psql session). The cascade must keep
-- working byte-for-byte; the ops path must stop being able to (a) recycle a
-- consumed id and (b) strand a linked shot.
--
-- Why NOT "raise on DELETE of a settled row": the ops path has a legitimate
-- inverse — restoring the identical settled row (ADV-17 asserts the exact
-- restore is `allowed 1` and the permit ends finalized/scored again). Refusing
-- the DELETE would also refuse a data-only reload (which deletes nothing but
-- inserts everything) and leaves the ADV-17 orphan unrepairable. Refusing the
-- DELETE while the shot exists is exactly the state ADV-17 breaks on.
--
-- THE FIX — a tombstone the id can only be restored INTO, never reopened:
--
--   1. public.analysis_permit_tombstones (service-only: RLS on, no policies,
--      no client grants; user_id cascades from profiles so account deletion
--      leaves nothing behind).
--   2. BEFORE DELETE guard on analysis_permits (definer, revoked from
--      clients): a permit that is settled (status <> 'reserved' — outcome
--      known) OR referenced by shots.analysis_permit_id is written to the
--      tombstone table as it leaves — id, user, key, status, outcome,
--      created_at — UNLESS the delete is the account cascade, detected as
--      `not exists (select 1 from public.profiles p where p.id =
--      old.user_id)`: inside the cascade the profile row is already gone
--      within the same statement (proved by the harness: `delete from
--      auth.users` and `delete from public.profiles` both still remove every
--      permit and shot and leave no tombstone). A reserved, unlinked permit
--      is deleted with no memory (ops hygiene, unchanged).
--   3. The BEFORE INSERT resurrection guard learns the tombstone: an id with
--      a tombstone may be created again ONLY as the identical settled row
--      (same user_id, idempotency_key, status, outcome) — the restore — which
--      consumes the tombstone; any other shape (reserved, another outcome,
--      another user) is 23514 + access.permit_transition_rejected for every
--      role. The pre-existing "an id already on a shot is never re-created"
--      rule stays for ids WITHOUT a tombstone (a pre-migration deletion whose
--      shot still names it), and yields to the exact restore.
--   4. apply_synced_shot(): a permit id that is gone but tombstoned for the
--      caller answers access.permit_not_reserved (the id was consumed; the
--      outbox settles it), never access.permit_not_found, and never backs a
--      shot. Everything else in the RPC is byte-for-byte 20260907000000.
--
-- Result: ADV-11 — the DELETE goes through, the reserved re-INSERT is 23514,
-- the second sync is access.permit_not_reserved, one scored shot. ADV-17 —
-- the DELETE goes through, the byte-identical restore is `allowed 1`, the
-- row is finalized/scored again, a further sync is access.permit_not_reserved.
--
-- UPDATE is already closed for every role: guard_analysis_permit_lifecycle()
-- (20260906140000) is a BEFORE INSERT OR UPDATE row trigger; PostgreSQL fires
-- row triggers for the table owner and the service role exactly as for
-- clients (only DDL — ALTER TABLE ... DISABLE TRIGGER / session_replication_
-- role = replica — could bypass it, and neither is a DML path), so settled →
-- reserved is 23514 + access.permit_transition_rejected for the owner too
-- (live: xc_pg_permit_terminal_adversary ADV-12/15, security_regression P4,
-- and section R below). No further UPDATE closure is needed.
--
-- No FK from shots.analysis_permit_id: NO ACTION would refuse the restore
-- order a data-only reload needs on shots-first tables and turns ADV-17's
-- repair into a constraint violation; ON DELETE SET NULL recreates ADV-11.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The tombstone table. One row per deleted settled/linked permit id.
-- ---------------------------------------------------------------------------
create table if not exists public.analysis_permit_tombstones (
  permit_id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  idempotency_key text not null,
  status text not null
    check (status in ('reserved', 'finalized', 'released')),
  outcome text,
  created_at timestamptz not null,
  deleted_at timestamptz not null default now()
);

comment on table public.analysis_permit_tombstones is
  'Settled (or shot-linked) analysis permits removed by an owner-role DELETE, remembered by id so the id can only ever be restored as the identical settled row — never reopened as reserved. Written by analysis_permits_guard_delete (definer BEFORE DELETE); consumed by the exact restore in analysis_permits_guard_resurrection; read by apply_synced_shot() through permit_tombstoned(). The account cascade (auth.users → profiles → analysis_permits) writes no tombstone and removes any that exist. Service-only: RLS on, no policies, no client grants.';

create index if not exists analysis_permit_tombstones_user_idx
  on public.analysis_permit_tombstones (user_id);

alter table public.analysis_permit_tombstones enable row level security;
revoke all on public.analysis_permit_tombstones from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. BEFORE DELETE: remember every settled or linked permit that leaves
--    outside the account cascade. Definer so the shots/profiles lookups and
--    the tombstone write are not narrowed by the caller's RLS.
-- ---------------------------------------------------------------------------
create or replace function public.guard_analysis_permit_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- The account cascade: auth.users → profiles → analysis_permits. The
  -- profile row is already gone within this statement, the user's shots go
  -- with it, and nothing may outlive the account.
  if not exists (select 1 from public.profiles p where p.id = old.user_id) then
    return old;
  end if;

  -- A live reservation nothing points at: plain delete (ops hygiene).
  if old.status = 'reserved'
     and not exists (select 1 from public.shots s where s.analysis_permit_id = old.id) then
    return old;
  end if;

  -- Settled (outcome known) or backing a shot: the id is consumed for good.
  insert into public.analysis_permit_tombstones
    (permit_id, user_id, idempotency_key, status, outcome, created_at, deleted_at)
  values
    (old.id, old.user_id, old.idempotency_key, old.status, old.outcome, old.created_at, now())
  on conflict (permit_id) do update
    set user_id = excluded.user_id,
        idempotency_key = excluded.idempotency_key,
        status = excluded.status,
        outcome = excluded.outcome,
        created_at = excluded.created_at,
        deleted_at = excluded.deleted_at;
  return old;
end;
$$;

comment on function public.guard_analysis_permit_delete() is
  'BEFORE DELETE guard on public.analysis_permits: a permit that is settled (status <> reserved) or referenced by public.shots.analysis_permit_id is written to analysis_permit_tombstones as it is deleted, so its id can only be restored as the identical settled row and never reopened (see guard_analysis_permit_resurrection). Skipped for the account cascade — detected as the profile row being gone within the same statement — and for reserved, unlinked permits. SECURITY DEFINER so the lookups and the tombstone write see every row; revoked from clients (triggers do not need EXECUTE).';

revoke execute on function public.guard_analysis_permit_delete()
  from public, anon, authenticated;

drop trigger if exists analysis_permits_guard_delete on public.analysis_permits;
create trigger analysis_permits_guard_delete
  before delete on public.analysis_permits
  for each row execute function public.guard_analysis_permit_delete();

-- ---------------------------------------------------------------------------
-- 3. BEFORE INSERT: a tombstoned id is restorable ONLY as the identical
--    settled row; an id on a shot without a tombstone is never re-created
--    (20260907000000 rule, kept). Same trigger name, body replaced.
-- ---------------------------------------------------------------------------
create or replace function public.guard_analysis_permit_resurrection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.analysis_permit_tombstones%rowtype;
begin
  select * into t
  from public.analysis_permit_tombstones x
  where x.permit_id = new.id
  for update;
  if found then
    if new.user_id = t.user_id
       and new.idempotency_key = t.idempotency_key
       and new.status = t.status
       and new.outcome is not distinct from t.outcome then
      -- The exact restore (pg_dump --data-only, support repair): the row is
      -- back, the memory is the row again.
      delete from public.analysis_permit_tombstones x where x.permit_id = new.id;
      return new;
    end if;
    raise exception using
      errcode = 'check_violation',
      message = format(
        'analysis_permits: permit %s was %s/%s when it was deleted and can only be restored as that row',
        new.id, t.status, coalesce(t.outcome, 'NULL')),
      hint = 'access.permit_transition_rejected';
  end if;

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
  'BEFORE INSERT guard on public.analysis_permits, every role: an id with a tombstone (deleted while settled or shot-linked — analysis_permits_guard_delete) may only be re-created as the identical settled row (same user_id, idempotency_key, status, outcome), which consumes the tombstone; any other shape is check_violation 23514 + access.permit_transition_rejected. An id already recorded in public.shots.analysis_permit_id with no tombstone is never re-created (23514). SECURITY DEFINER so the lookups see every row; revoked from clients (triggers do not need EXECUTE).';

revoke execute on function public.guard_analysis_permit_resurrection()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Caller-scoped tombstone reader for the SECURITY INVOKER RPC (the table
--    itself has no client grant). Mirrors identity_scored_count(): definer,
--    auth.uid()-scoped, no way to probe another user's ids.
-- ---------------------------------------------------------------------------
create or replace function public.permit_tombstoned(p_permit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.analysis_permit_tombstones t
    where t.permit_id = p_permit_id
      and t.user_id = (select auth.uid())
  );
$$;

comment on function public.permit_tombstoned(uuid) is
  'True when the caller (auth.uid()) owned a settled/linked permit with this id that has since been deleted by the owner role (analysis_permit_tombstones). apply_synced_shot() answers access.permit_not_reserved for such an id — the permit was consumed — instead of access.permit_not_found. Never true for another user''s id.';

revoke all on function public.permit_tombstoned(uuid) from public, anon;
grant execute on function public.permit_tombstoned(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. apply_synced_shot(): the not-found branch consults the tombstone.
--    Everything else is byte-for-byte 20260907000000.
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
    -- A settled permit of this user that the owner role deleted is consumed,
    -- not unknown: the same permanent verdict its row would have given.
    if public.permit_tombstoned(v_permit_id) then
      return 'access.permit_not_reserved';
    end if;
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
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Idempotent on the client-generated shot id: ownership is checked before AND after the per-user advisory lock, so a duplicate copy that lost the race replays as accepted instead of seeing its already-consumed permit. Backing is decided by permit_backs_sync() — reserved at any age, or swept to released/expired — NULL-safe and default-deny, so a released/NULL or any other settled permit is refused (access.permit_not_reserved) and the shot is never written; a permit id already recorded on a shot (shots.analysis_permit_id, unique) is refused the same way, as is a permit id of this user that was deleted while settled (analysis_permit_tombstones via permit_tombstoned()); the finalize UPDATE must consume exactly that one permit. Enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(). A shots-gate refusal surfaces as its verdict (hint), never as shot.write_failed:42501. Other write failures return shot.write_failed:<SQLSTATE> only — never sqlerrm, which echoes client input.';
