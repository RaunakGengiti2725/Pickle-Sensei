-- Product decision 2026-09-10: ONE lifetime free rating per sign-in identity
-- (previously two). "We were giving out too much for free."
--
-- The allowance used to be a literal 2 written into every decision point.
-- This migration gives it ONE definition — public.free_rating_limit(), an
-- immutable constant function — and recreates the four decision points that
-- embedded the literal so they read it instead:
--
--   * reserve_analysis_permit()   — remaining = limit - min(scored, limit);
--                                   refused once live online reservations +
--                                   outstanding offline holds reach it
--   * apply_synced_shot()         — the scored-settlement backstop:
--                                   lifetime scored + offline holds >= limit
--                                   → access.paywall_required, permit released
--                                   free_limit_exceeded
--   * enforce_scored_shot_permit() — the shots BEFORE INSERT gate: the same
--                                   arithmetic under the permit vouch (PKP02)
--                                   and for a direct client INSERT (42501)
--   * issue_offline_grant()       — free tickets come only out of what
--                                   lifetime scored + live online reservations
--                                   + outstanding offline holds leave of the
--                                   limit
--
-- Every body below is the 20260908160000 / 20260910140000 / 20260910150000
-- body VERBATIM except for the constant (and the comments that named it):
-- same locks (access_lock_key(uid)), same counters (lifetime_scored_count(),
-- online_reservation_count(), offline_hold_count()), same verdict vocabulary,
-- same SECURITY mode, same grants re-applied. access_state() is unchanged —
-- it reports counts, and the Edge Function derives used/remaining/limit from
-- its own FREE_RATING_LIMIT constant, which MUST equal free_rating_limit()
-- (the static pin in __wf__/db_migrations_rls_indexes.test.ts ties them).
--
-- Not changed on purpose:
--   * the request-shape caps of issue_offline_grant() (p_requested_tickets
--     0..2) and POST /v1/offline/grants (requestedTickets 0..2): apps in the
--     field ask for two tickets; the allowance clamps what is ISSUED, and a
--     request for more than the allowance is clamped, never refused.
--   * public.free_rating_ledger and identity_scored_count(): the ledger
--     records scored analyses per sign-in identity, not the allowance; an
--     identity that already scored one rating under the old allowance is
--     therefore at its limit now, and one that scored two stays there.
--
-- Rollout: `supabase db push` BEFORE `supabase functions deploy api` (AGENTS.md
-- deploy order). A server on the old constant beside this migration is safe
-- in both orders: the database refuses what the API would have offered.
--
-- Live matrix: security_regression.sql exercises the mechanism at the
-- historical allowance (a test-only override of free_rating_limit()) and pins
-- the shipping value in its final section.

-- 1. The allowance. Callable by authenticated because the SECURITY INVOKER
--    decision points (reserve_analysis_permit(), apply_synced_shot(), the
--    shots gate for a direct client INSERT) evaluate it as the caller; it
--    reads nothing, so there is nothing to scope or leak.
create or replace function public.free_rating_limit()
returns integer
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select 1
$$;

comment on function public.free_rating_limit() is
  'The lifetime free-rating allowance per sign-in identity (one, since 2026-09-10; two before). The ONE definition every free-rating decision point reads — reserve_analysis_permit(), apply_synced_shot()''s backstop, the shots write gate, issue_offline_grant(). The Edge Function''s FREE_RATING_LIMIT must equal it. Change it here, in a NEW migration, and nowhere else.';

revoke all on function public.free_rating_limit() from public, anon, service_role;
grant execute on function public.free_rating_limit() to authenticated;

-- 2. reserve_analysis_permit() — 20260908160000 body, constant replaced.
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
  v_held int;
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

  -- Serialize the check-then-insert for this user — the same lock
  -- issue_offline_grant() holds while it allocates.
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

  -- IDENTITY LEDGER: the scored count is the identity-aware
  -- lifetime_scored_count(), never the raw shots count of this account row.
  -- Reservations are the live online permits (online_reservation_count —
  -- the pre-existing "reserved AND < 24h" rule) plus every outstanding
  -- offline ticket (offline_hold_count) — the same three terms
  -- issue_offline_grant() adds.
  select
    coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false),
    public.lifetime_scored_count(),
    public.online_reservation_count(),
    public.offline_hold_count()
  into v_premium, v_scored, v_reserved, v_held;

  v_remaining := public.free_rating_limit() - least(v_scored, public.free_rating_limit());

  if not v_premium and v_remaining <= v_reserved + v_held then
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

revoke all on function public.reserve_analysis_permit(text) from public, anon;
grant execute on function public.reserve_analysis_permit(text) to authenticated;

-- 3. apply_synced_shot() — 20260908160000 body, constant replaced.
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
  v_transport jsonb;
  v_canonical text;
  v_receipt jsonb;
  v_binding jsonb;
  v_claim jsonb;
  v_stored public.settlement_receipts%rowtype;
  v_attempt integer;
begin
  if v_uid is null then
    return 'auth.required';
  end if;

  v_id := (shot ->> 'id')::uuid;
  v_permit_id := (shot ->> 'analysisPermitId')::uuid;
  v_session_id := nullif(shot ->> 'sessionId', '')::uuid;
  v_result_kind := shot ->> 'resultKind';

  -- The settlement receipt (optional for callers that predate it). When
  -- present it must be exactly the receipt of THIS settlement, or nothing
  -- happens. Verified before any lock, lookup or write.
  v_transport := shot -> 'settlementReceipt';
  if v_transport is not null and jsonb_typeof(v_transport) = 'null' then
    v_transport := null;
  end if;
  if v_transport is not null then
    if jsonb_typeof(v_transport) <> 'object'
       or jsonb_typeof(v_transport -> 'canonical') <> 'string'
       or jsonb_typeof(v_transport -> 'sha256') <> 'string' then
      return 'shot.receipt_invalid';
    end if;
    v_canonical := v_transport ->> 'canonical';
    if length(v_canonical) < 2 or length(v_canonical) > 65536
       or (v_transport ->> 'sha256') !~ '^[0-9a-f]{64}$'
       or encode(pg_catalog.sha256(convert_to(v_canonical, 'UTF8')), 'hex')
          <> (v_transport ->> 'sha256') then
      return 'shot.receipt_invalid';
    end if;
    begin
      v_receipt := v_canonical::jsonb;
    exception
      when others then
        return 'shot.receipt_invalid';
    end;
    if jsonb_typeof(v_receipt) <> 'object'
       or (v_receipt -> 'schemaVersion') is distinct from '1'::jsonb
       or (v_receipt ->> 'kind') is distinct from 'settlement_receipt'
       or coalesce(jsonb_typeof(v_receipt -> 'binding'), 'missing') <> 'object'
       or coalesce(v_receipt ->> 'bindingSha256', '') !~ '^[0-9a-f]{64}$' then
      return 'shot.receipt_invalid';
    end if;
    v_binding := v_receipt -> 'binding';
    if (v_binding ->> 'ownerId') is distinct from v_uid::text
       or (v_binding ->> 'shotId') is distinct from v_id::text
       or (v_binding ->> 'analysisPermitId') is distinct from v_permit_id::text
       or (v_binding ->> 'resultKind') is distinct from v_result_kind
       or coalesce(v_binding ->> 'payloadSha256', '') !~ '^[0-9a-f]{64}$' then
      return 'shot.receipt_invalid';
    end if;
    -- Claims: each is null (recorded as absent) or exactly its shape.
    if coalesce(jsonb_typeof(v_binding -> 'installationKeyId'), 'missing') not in ('null', 'string')
       or (jsonb_typeof(v_binding -> 'installationKeyId') = 'string'
           and (v_binding ->> 'installationKeyId') !~ '^[A-Za-z0-9._:/+=-]{1,128}$')
       or coalesce(jsonb_typeof(v_binding -> 'operationId'), 'missing') not in ('null', 'string')
       or (jsonb_typeof(v_binding -> 'operationId') = 'string'
           and (v_binding ->> 'operationId') !~ '^[A-Za-z0-9._:/+=-]{1,128}$') then
      return 'shot.receipt_invalid';
    end if;
    v_claim := v_binding -> 'grant';
    if coalesce(jsonb_typeof(v_claim), 'missing') not in ('null', 'object')
       or (jsonb_typeof(v_claim) = 'object' and (
             coalesce(v_claim ->> 'grantId', '') !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
             or coalesce(v_claim ->> 'grantJwsSha256', '') !~ '^[0-9a-f]{64}$'
           )) then
      return 'shot.receipt_invalid';
    end if;
    v_claim := v_binding -> 'ticket';
    if coalesce(jsonb_typeof(v_claim), 'missing') not in ('null', 'object')
       or (jsonb_typeof(v_claim) = 'object' and (
             coalesce(v_claim ->> 'allocationId', '') !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
             or coalesce(v_claim ->> 'ticketId', '') !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
             or coalesce(jsonb_typeof(v_claim -> 'generation'), 'missing') <> 'number'
             or (v_claim ->> 'generation') !~ '^[1-9][0-9]{0,8}$'
           )) then
      return 'shot.receipt_invalid';
    end if;
    -- Policy lineage: a scored settlement is admitted under a verified
    -- release policy and must say which; an abstention carries none.
    v_claim := v_receipt -> 'policy';
    if coalesce(jsonb_typeof(v_claim), 'missing') not in ('null', 'object')
       or (v_result_kind = 'scored' and jsonb_typeof(v_claim) <> 'object')
       or (jsonb_typeof(v_claim) = 'object' and (
             length(coalesce(v_claim ->> 'version', '')) not between 1 and 128
             or coalesce(v_claim ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
           )) then
      return 'shot.receipt_invalid';
    end if;
  end if;

  -- Replay is decided on the binding and the policy lineage — once before
  -- the per-user lock (a settled shot never contends) and once under it (the
  -- racing settlement of the same id). Both run before the permit is touched.
  for v_attempt in 1..2 loop
    if exists (
      select 1
      from public.shots s
      where s.id = v_id
        and s.user_id = v_uid
    ) then
      select * into v_stored
      from public.settlement_receipts r
      where r.shot_id = v_id
        and r.user_id = v_uid;
      if not found then
        -- Settled before receipts existed: the ownership verdict stands.
        return 'accepted';
      end if;
      if v_receipt is not null
         and v_stored.binding_sha256 = (v_receipt ->> 'bindingSha256')
         and v_stored.receipt -> 'binding' = v_binding
         and (v_stored.receipt -> 'policy') is not distinct from (v_receipt -> 'policy') then
        return 'accepted';
      end if;
      return 'shot.receipt_mismatch';
    end if;
    if v_attempt = 1 then
      perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));
    end if;
  end loop;

  select * into v_permit
  from public.analysis_permits p
  where p.id = v_permit_id
    and p.user_id = v_uid
  for update;

  if not found then
    if public.permit_tombstoned(v_permit_id) then
      return 'access.permit_not_reserved';
    end if;
    return 'access.permit_not_found';
  end if;

  if not public.permit_backs_sync(v_permit.status, v_permit.outcome) then
    return 'access.permit_not_reserved';
  end if;

  if exists (
    select 1
    from public.shots s
    where s.analysis_permit_id = v_permit_id
  ) then
    return 'access.permit_not_reserved';
  end if;

  if v_result_kind = 'scored' then
    select coalesce((
      select b.premium
        and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false)
    into v_premium;

    -- OFFLINE HOLDS: a ticket handed to a device is a rating that device
    -- renders offline and will settle; it is never reclaimed, so the online
    -- rating fits only beside it.
    if not v_premium
       and public.lifetime_scored_count() + public.offline_hold_count() >= public.free_rating_limit() then
      update public.analysis_permits
         set status = 'released',
             outcome = 'free_limit_exceeded'
       where id = v_permit_id
         and user_id = v_uid
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

  -- Atomic write block: any failure rolls back the shot, its details, the
  -- receipt, AND leaves the permit untouched (still backing a clean retry).
  -- The vouch and the receipt bytes are set inside the block so a failure
  -- reverts them with everything else.
  begin
    perform pg_catalog.set_config('pickle.sync_permit_id', v_permit_id::text, true);
    perform pg_catalog.set_config('pickle.sync_settlement_receipt', coalesce(v_canonical, ''), true);

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
    perform pg_catalog.set_config('pickle.sync_settlement_receipt', '', true);

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
    -- SAME transaction as the shot write. ONE-PERMIT-ONE-SHOT: the row locked
    -- above must be the row consumed here; anything else rolls the whole
    -- write back.
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
      -- The shot id settled concurrently. Ours → the binding decides (the
      -- same rule as above); the permit already backs another row
      -- (shots_analysis_permit_unique) → the permit verdict; a different
      -- user's id (invisible under RLS) → permanent conflict.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        select * into v_stored
        from public.settlement_receipts r
        where r.shot_id = v_id
          and r.user_id = v_uid;
        if not found
           or (v_receipt is not null
               and v_stored.binding_sha256 = (v_receipt ->> 'bindingSha256')
               and v_stored.receipt -> 'binding' = v_binding) then
          return 'accepted';
        end if;
        return 'shot.receipt_mismatch';
      end if;
      if exists (select 1 from public.shots s where s.analysis_permit_id = v_permit_id) then
        return 'access.permit_not_reserved';
      end if;
      return 'shot.id_conflict';
    when sqlstate 'PKP01' then
      -- The shots gate refused THIS permit under the vouch: a contract
      -- verdict the outbox settles, never a transient grant error.
      return 'access.permit_not_reserved';
    when sqlstate 'PKP02' then
      return 'access.paywall_required';
    when others then
      -- SQLSTATE ONLY: the five-char class is enough for operators; the edge
      -- maps every write_failed:* to the stable client code.
      return 'shot.write_failed:' || sqlstate;
  end;
end;
$$;

comment on function public.apply_synced_shot(jsonb) is
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Idempotent on the client-generated shot id: ownership is checked before AND after the per-user advisory lock, so a duplicate copy that lost the race replays as accepted instead of seeing its already-consumed permit. Backing is decided by permit_backs_sync() — reserved at any age, or swept to released/expired — NULL-safe and default-deny, so a released/NULL or any other settled permit is refused (access.permit_not_reserved) and the shot is never written; a permit id already recorded on a shot (shots.analysis_permit_id, unique) is refused the same way, as is a permit id of this user that was deleted while settled (analysis_permit_tombstones via permit_tombstoned()); the finalize UPDATE must consume exactly that one permit. Enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count() plus the caller''s outstanding offline tickets (offline_hold_count()) — a ticket handed to a device is never reclaimed, so an online rating fits only beside it. A shots-gate refusal surfaces as its verdict (hint), never as shot.write_failed:42501. Other write failures return shot.write_failed:<SQLSTATE> only — never sqlerrm, which echoes client input.';

revoke all on function public.apply_synced_shot(jsonb) from public, anon;
grant execute on function public.apply_synced_shot(jsonb) to authenticated;

-- 4. The shots gate — 20260910150000 body, constant replaced (both the
--    permit-vouch backstop and the direct-INSERT budget).
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
  v_ticket uuid;
  v_lease uuid;
begin
  if v_uid is null then
    return new;
  end if;

  -- apply_synced_shot() names the permit, consume_offline_ticket() the
  -- ticket, record_offline_lease_shot() the lease, each locked and validated
  -- for this insert. Nothing else can set any of them (PostgREST exposes no
  -- set_config and the schema-exposed RPCs never take them from input).
  v_vouched := nullif(pg_catalog.current_setting('pickle.sync_permit_id', true), '')::uuid;
  v_ticket := nullif(pg_catalog.current_setting('pickle.offline_ticket_id', true), '')::uuid;
  v_lease := nullif(pg_catalog.current_setting('pickle.offline_lease_grant_id', true), '')::uuid;

  -- The settlement links are the vouches' to write: a direct INSERT may not
  -- claim a permit or a ticket, a vouched insert records exactly its vouch.
  if new.analysis_permit_id is not null
     and (v_vouched is null or new.analysis_permit_id <> v_vouched) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: analysis_permit_id is written only by apply_synced_shot for the permit it consumed',
      hint = 'access.permit_not_reserved';
  end if;
  if new.offline_ticket_id is not null
     and (v_ticket is null or new.offline_ticket_id <> v_ticket) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: offline_ticket_id is written only by consume_offline_ticket for the ticket it settled',
      hint = 'offline.shot_not_chargeable';
  end if;
  if (v_vouched is not null and v_ticket is not null)
     or (v_lease is not null and (v_vouched is not null or v_ticket is not null)) then
    raise exception using
      errcode = 'check_violation',
      message = 'shots: a rating is settled by one permit, one ticket or one lease, never more than one',
      hint = 'offline.shot_not_chargeable';
  end if;
  new.analysis_permit_id := v_vouched;
  new.offline_ticket_id := v_ticket;

  if new.result_kind <> 'scored' then
    return new;
  end if;

  -- Same key as reserve_analysis_permit() / apply_synced_shot() /
  -- issue_offline_grant() / consume_offline_ticket() /
  -- settle_offline_receipt(): a direct writer racing itself (or a sync, or
  -- an allocation) serializes here. Re-entrant inside the RPCs, which
  -- already hold it for this transaction.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  select coalesce((
    select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b
    where b.user_id = v_uid
  ), false) into v_premium;

  if v_lease is not null then
    -- Lease settlement path: the ONE grant the vouch names must be a
    -- verified-store lease issued to the caller. The entitlement was verified
    -- when the lease was issued and bounds the offline work rendered under
    -- it; the free-rating allowance does not apply to a lease (none is ever
    -- issued to a free identity) and the caller's entitlement NOW is not
    -- re-judged (the work was authorized when it was done).
    if not exists (
      select 1 from public.offline_grants g
      where g.id = v_lease
        and g.user_id = v_uid
        and g.entitlement_source = 'verified_store'
    ) then
      raise exception using
        errcode = 'check_violation',
        message = 'shots: the lease named for this settled shot is not a verified-store grant of the caller',
        hint = 'offline.shot_not_chargeable';
    end if;
    return new;
  end if;

  if v_ticket is not null then
    -- Settlement path: the ONE ticket the row names must be an outstanding
    -- allocation owned by the caller's account or sign-in identities. The
    -- budget was decided when the ticket was allocated; consuming it turns
    -- a hold into a rating and moves the identity's total by zero.
    if not exists (
      select 1 from public.offline_allocation_ledger a
      where a.ticket_id = v_ticket
        and a.event = 'allocated'
        and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid)
        and not exists (
          select 1 from public.offline_allocation_ledger t
          where t.ticket_id = a.ticket_id and t.event in ('consumed', 'released')
        )
    ) then
      raise exception using
        errcode = 'check_violation',
        message = 'shots: the ticket named for this settled shot is not an outstanding allocation of the caller',
        hint = 'offline.shot_not_chargeable';
    end if;
    return new;
  end if;

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
    -- FREE-LIMIT BACKSTOP: the permit being consumed is this rating's
    -- reservation; every outstanding offline ticket is a rating the device
    -- renders offline and will settle — together they may not exceed the
    -- lifetime allowance (free_rating_limit()).
    if not v_premium
       and public.lifetime_scored_count() + public.offline_hold_count() >= public.free_rating_limit() then
      raise exception using
        errcode = 'PKP02',
        message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)',
        hint = 'access.paywall_required';
    end if;
    return new;
  end if;

  -- Direct client INSERT: a live reserved permit younger than 24h, as before.
  if not exists (
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

  -- The live permit that admits this row is the slot the row spends; every
  -- OTHER live reservation and every outstanding offline ticket is a rating
  -- already promised elsewhere. The row fits only if scored + those + this
  -- one stay within the allowance — so one live permit backs one direct
  -- rating, and never one beside a ticket that already holds the last unit
  -- (round-5 A01: this gate used to see only the lifetime count and a live
  -- permit, so a free identity kept an outstanding ticket beside a fully
  -- spent allowance).
  if not v_premium
     and public.lifetime_scored_count()
       + (public.online_reservation_count() - 1)
       + public.offline_hold_count() >= public.free_rating_limit() then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)',
      hint = 'access.paywall_required';
  end if;

  return new;
end;
$$;

comment on function public.enforce_scored_shot_permit() is
  'BEFORE INSERT gate on public.shots. analysis_permit_id may only be the permit apply_synced_shot() vouches for (pickle.sync_permit_id) and offline_ticket_id only the ticket consume_offline_ticket() vouches for (pickle.offline_ticket_id); a direct client INSERT must leave both NULL (42501 otherwise), and no row carries more than one vouch (permit, ticket, or the lease record_offline_lease_shot() vouches for through pickle.offline_lease_grant_id). A scored row written from a client session must be backed by: under the lease vouch, THAT verified_store grant of the caller (check_violation otherwise — the entitlement was verified at issuance, the allowance does not apply); under the ticket vouch, THAT outstanding ticket of the caller (check_violation otherwise — the budget was decided at allocation); under the permit vouch, THAT permit alone (permit_backs_sync; PKP01) and lifetime scored + outstanding offline tickets < free_rating_limit() (PKP02); as a direct INSERT, a live reserved permit (< 24h) and lifetime scored + other live online reservations + outstanding offline tickets < free_rating_limit() (42501). Premium bypasses the allowance, never a permit, a ticket or a lease. Runs under the same per-user advisory lock as every other free-rating decision point.';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

-- 5. issue_offline_grant() — 20260910140000 body, constant replaced. The
--    0..2 request-shape cap stays (see the header). Same signature and return
--    type, so create or replace (no drop: the EXECUTE grant is re-applied
--    below regardless).
create or replace function public.issue_offline_grant(
  p_installation_key_id text,
  p_requested_tickets integer
)
returns table (
  result text,
  grant_id uuid,
  generation integer,
  entitlement_source text,
  issued_at timestamptz,
  expires_at timestamptz,
  entitlement_expires_at timestamptz,
  ticket_ids uuid[],
  attestation_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_device public.offline_devices%rowtype;
  v_grant public.offline_grants%rowtype;
  v_premium boolean;
  v_entitlement_expires_at timestamptz;
  v_scored int;
  v_reserved int;
  v_held int;
  v_remaining int;
  v_capacity int;
  v_outstanding uuid[];
  v_new_count int;
  v_new uuid[];
  v_identity_hashes text[];
  v_now timestamptz := now();
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_installation_key_id is null
     or p_installation_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_requested_tickets is null
     or p_requested_tickets < 0
     or p_requested_tickets > 2 then
    result := 'offline.invalid_input';
    return next;
    return;
  end if;

  select * into v_device
  from public.offline_devices d
  where d.user_id = v_uid and d.installation_key_id = p_installation_key_id;
  if not found then
    result := 'offline.device_not_registered';
    return next;
    return;
  end if;
  if v_device.revoked_at is not null then
    result := 'offline.device_revoked';
    return next;
    return;
  end if;

  -- The same lock the online reservation path holds: allocation and online
  -- reservation are serialized per identity.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  select
    coalesce(b.premium and (b.expires_at is null or b.expires_at > now()), false),
    b.expires_at
  into v_premium, v_entitlement_expires_at
  from public.billing_entitlements b
  where b.user_id = v_uid;
  v_premium := coalesce(v_premium, false);

  if v_premium then
    -- Pro lease: min(issued + 7 days, verified entitlement expiry); no tickets.
    insert into public.offline_grants (
      user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at,
      attestation_state
    ) values (
      v_uid, v_device.id, 'verified_store',
      coalesce((select max(g.generation) from public.offline_grants g where g.device_id = v_device.id), 0) + 1,
      v_now,
      least(v_now + interval '7 days', coalesce(v_entitlement_expires_at, v_now + interval '7 days')),
      v_entitlement_expires_at,
      v_device.attestation_state
    )
    returning * into v_grant;

    result := 'accepted';
    grant_id := v_grant.id;
    generation := v_grant.generation;
    entitlement_source := v_grant.entitlement_source;
    issued_at := v_grant.issued_at;
    expires_at := v_grant.expires_at;
    entitlement_expires_at := v_grant.entitlement_expires_at;
    ticket_ids := '{}'::uuid[];
    attestation_state := v_grant.attestation_state;
    return next;
    return;
  end if;

  -- Free identity: tickets this installation already holds for this account
  -- or one of its sign-in identities are re-issued (the original installation
  -- of a deleted-and-re-created account recovers its ticket here — the
  -- device row is gone, the ledger's installation key is not); new tickets
  -- come only out of what lifetime scored + live online reservations + every
  -- outstanding offline hold leave of the lifetime allowance
  -- (free_rating_limit()), read
  -- through the SAME online_reservation_count() the online path uses — a
  -- stale or swept permit is a reservation to neither, and its late sync is
  -- then refused by apply_synced_shot()'s backstop beside the tickets issued
  -- here (never a rating past the allowance).
  select coalesce(array_agg(a.ticket_id order by a.created_at, a.id), '{}'::uuid[])
  into v_outstanding
  from public.offline_allocation_ledger a
  where a.installation_key_id = v_device.installation_key_id
    and a.event = 'allocated'
    and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid)
    and not exists (
      select 1 from public.offline_allocation_ledger t
      where t.ticket_id = a.ticket_id and t.event in ('consumed', 'released')
    );

  select
    public.lifetime_scored_count(),
    public.online_reservation_count(),
    public.offline_hold_count()
  into v_scored, v_reserved, v_held;

  v_remaining := public.free_rating_limit() - least(v_scored, public.free_rating_limit());
  v_capacity := greatest(v_remaining - v_reserved - v_held, 0);
  v_new_count := least(greatest(p_requested_tickets - coalesce(array_length(v_outstanding, 1), 0), 0), v_capacity);

  if coalesce(array_length(v_outstanding, 1), 0) + v_new_count = 0 then
    result := case when v_capacity = 0 then 'access.paywall_required' else 'offline.invalid_input' end;
    return next;
    return;
  end if;

  insert into public.offline_grants (
    user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at,
    attestation_state
  ) values (
    v_uid, v_device.id, 'identity_lifetime_free',
    coalesce((select max(g.generation) from public.offline_grants g where g.device_id = v_device.id), 0) + 1,
    v_now, v_now + interval '7 days', null,
    v_device.attestation_state
  )
  returning * into v_grant;

  if v_new_count > 0 then
    v_identity_hashes := api_private.offline_identity_hashes(v_uid);
    select array_agg(gen_random_uuid()) into v_new from generate_series(1, v_new_count);
    insert into public.offline_allocation_ledger (
      user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id
    )
    select v_uid, v_device.id, v_grant.id, v_grant.generation, t, 'allocated', v_identity_hashes,
           v_device.installation_key_id
    from unnest(v_new) t;
  else
    v_new := '{}'::uuid[];
  end if;

  result := 'accepted';
  grant_id := v_grant.id;
  generation := v_grant.generation;
  entitlement_source := v_grant.entitlement_source;
  issued_at := v_grant.issued_at;
  expires_at := v_grant.expires_at;
  entitlement_expires_at := v_grant.entitlement_expires_at;
  ticket_ids := v_outstanding || v_new;
  attestation_state := v_grant.attestation_state;
  return next;
  return;
end;
$$;

comment on function public.issue_offline_grant(text, integer) is
  'Issues the next-generation offline grant for one registered, non-revoked device of the caller (live API session required), under access_lock_key(uid); the device may be attested or unattested and the grant records which. Pro: a lease ending at min(now + 7 days, verified entitlement expiry), no tickets. Free: re-issues the installation''s outstanding tickets owned by the caller''s account or sign-in identities (original-installation recovery across account re-creation) and allocates new ones only within lifetime_scored_count() + live online reservations (online_reservation_count(): reserved, < 24h, not yet settled by a shot — the same reader the online path uses) + offline holds ≤ free_rating_limit(). Returns accepted | access.paywall_required | offline.device_not_registered | offline.device_revoked | offline.invalid_input.';

revoke all on function public.issue_offline_grant(text, integer) from public, anon, service_role;
grant execute on function public.issue_offline_grant(text, integer) to authenticated;
