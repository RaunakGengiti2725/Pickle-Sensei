-- W04-04 (round 7): a Pro (no-ticket) receipt answered result_recorded has its
-- rated shot durably written for the owner, in the same transaction as the
-- settlement row — exactly as the ticket branch writes it through
-- consume_offline_ticket().
--
-- The receipt is the ONLY channel that carries an offline-rated shot to the
-- server (the court-offline shipping path writes no shot.sync outbox row and
-- marks the local shot synced on result_recorded). Until now the lease branch
-- of settle_offline_receipt() judged the output beside the receipt and then
-- recorded the result WITHOUT writing the output anywhere: the server claimed
-- the rating was recorded while it existed only on the device — absent from
-- history, rank and progress, gone on reinstall or a second device.
--
-- Three pieces, none of which widens what a client can do:
--
--   * the shots BEFORE INSERT gate learns a third vouch, the twin of
--     pickle.sync_permit_id / pickle.offline_ticket_id:
--     pickle.offline_lease_grant_id names the verified-store lease
--     settle_offline_receipt() located for the caller. Under it a scored row
--     is admitted when THAT grant is a verified_store grant of the caller —
--     the entitlement was verified when the lease was issued and bounds the
--     offline work done under it; the free-rating allowance is not consulted
--     (a lease is never issued to a free identity) — and refused otherwise
--     (check_violation, hint offline.shot_not_chargeable). Never beside a
--     permit or a ticket vouch. A client cannot set the vouch (PostgREST
--     exposes no set_config; no schema-exposed RPC takes it from input), so
--     the direct-INSERT path is exactly as closed as before.
--
--   * api_private.record_offline_lease_shot(grant, shot) writes the shot
--     (+ phases / checkpoints) in the caller's name under that vouch, with the
--     same identity, session and existing-row checks consume_offline_ticket()
--     makes and the same verdict vocabulary (offline.shot_not_chargeable /
--     shot.id_conflict for a rating the server already holds,
--     shot.session_not_found while the session has not synced,
--     shot.write_failed:<SQLSTATE> for a row the table refuses). Not callable
--     by any client role: settle_offline_receipt() is its one caller.
--
--   * settle_offline_receipt()'s lease branch first binds the receipt to its
--     lineage — the grant it names must be a verified_store lease of the
--     caller for the installation the receipt names (the ticket branch's
--     lineage rule, applied where it was missing: a null ticket under a FREE
--     grant is evidence about some other authorization and is HELD
--     evidence_ambiguous, never recorded, whatever the billing disposition) —
--     and then, for a chargeable receipt with its scored output, writes the
--     shot before the settlement row. Replay / conflict / HOLD ordering,
--     the freeze deferral (pending, nothing written) and
--     financial_disposition = not_applicable are unchanged. A rating the
--     server already holds is a conflicting_receipt HOLD; an output the table
--     refuses is an evidence_ambiguous HOLD; a server-side failure raises and
--     nothing durable is written.
--
-- Same signature as 20260910130000 (create or replace); the exact
-- grants/revokes are re-applied. The applied migrations are not edited.

-- 1. The shots gate: a third vouch for the lease settlement path.
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
    -- renders offline and will settle — the two together may not exceed the
    -- lifetime allowance.
    if not v_premium
       and public.lifetime_scored_count() + public.offline_hold_count() >= 2 then
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
  -- permit, so a free identity kept an outstanding ticket beside two scored
  -- ratings).
  if not v_premium
     and public.lifetime_scored_count()
       + (public.online_reservation_count() - 1)
       + public.offline_hold_count() >= 2 then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)',
      hint = 'access.paywall_required';
  end if;

  return new;
end;
$$;

comment on function public.enforce_scored_shot_permit() is
  'BEFORE INSERT gate on public.shots. analysis_permit_id may only be the permit apply_synced_shot() vouches for (pickle.sync_permit_id) and offline_ticket_id only the ticket consume_offline_ticket() vouches for (pickle.offline_ticket_id); a direct client INSERT must leave both NULL (42501 otherwise), and no row carries more than one vouch (permit, ticket, or the lease record_offline_lease_shot() vouches for through pickle.offline_lease_grant_id). A scored row written from a client session must be backed by: under the lease vouch, THAT verified_store grant of the caller (check_violation otherwise — the entitlement was verified at issuance, the allowance does not apply); under the ticket vouch, THAT outstanding ticket of the caller (check_violation otherwise — the budget was decided at allocation); under the permit vouch, THAT permit alone (permit_backs_sync; PKP01) and lifetime scored + outstanding offline tickets < 2 (PKP02); as a direct INSERT, a live reserved permit (< 24h) and lifetime scored + other live online reservations + outstanding offline tickets < 2 (42501). Premium bypasses the allowance, never a permit, a ticket or a lease. Runs under the same per-user advisory lock as every other free-rating decision point.';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

-- 2. The lease shot writer: the twin of consume_offline_ticket() for a rating
--    rendered under a Pro lease. No ledger event (a lease allocates nothing).
create or replace function api_private.record_offline_lease_shot(p_grant_id uuid, p_shot jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_session_id uuid;
  v_result_kind text;
  entry jsonb;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_grant_id is null or p_shot is null or jsonb_typeof(p_shot) <> 'object' then
    return 'offline.invalid_input';
  end if;
  begin
    v_id := (p_shot ->> 'id')::uuid;
    v_session_id := nullif(p_shot ->> 'sessionId', '')::uuid;
  exception when others then
    return 'offline.invalid_input';
  end;
  v_result_kind := p_shot ->> 'resultKind';
  if v_id is null then
    return 'offline.invalid_input';
  end if;
  -- Only a scored rating is written; an abstention is recorded by the
  -- settlement alone.
  if v_result_kind is distinct from 'scored' then
    return 'offline.shot_not_chargeable';
  end if;

  -- Caller lock: the one key every rating decision point holds. Re-entrant
  -- for settle_offline_receipt(), which already holds it.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- The lease must be a verified-store grant issued to the caller — the
  -- gate re-verifies the same fact for the row.
  if not exists (
    select 1 from public.offline_grants g
    where g.id = p_grant_id
      and g.user_id = v_uid
      and g.entitlement_source = 'verified_store'
  ) then
    return 'offline.grant_not_found';
  end if;

  -- A rating the server already holds was written by whatever wrote it — an
  -- online permit, a live-permit direct write, or an earlier settlement — and
  -- is not this receipt's rating.
  if exists (select 1 from public.shots s where s.id = v_id) then
    return case
      when exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid)
        then 'offline.shot_not_chargeable'
      else 'shot.id_conflict'
    end;
  end if;

  if v_session_id is not null and not exists (
    select 1 from public.sessions se
    where se.id = v_session_id and se.user_id = v_uid
  ) then
    return 'shot.session_not_found';
  end if;

  -- Atomic write block: any failure rolls back the shot and its details. The
  -- vouch is set inside the block so a failure reverts it with everything
  -- else.
  begin
    perform pg_catalog.set_config('pickle.offline_lease_grant_id', p_grant_id::text, true);

    insert into public.shots (
      id, user_id, session_id, shot_type, camera_view,
      captured_at, start_ms, contact_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version, source
    ) values (
      v_id,
      v_uid,
      v_session_id,
      p_shot ->> 'shotType',
      p_shot ->> 'cameraView',
      (p_shot ->> 'capturedAt')::timestamptz,
      (p_shot ->> 'startMs')::int,
      (p_shot ->> 'contactMs')::int,
      (p_shot ->> 'endMs')::int,
      (p_shot ->> 'overallScore')::numeric,
      (p_shot ->> 'confidence')::numeric,
      v_result_kind,
      p_shot -> 'versionVector' ->> 'appVersion',
      p_shot -> 'versionVector' ->> 'modelBundleVersion',
      p_shot -> 'versionVector' ->> 'poseModelVersion',
      p_shot -> 'versionVector' ->> 'paddleModelVersion',
      p_shot -> 'versionVector' ->> 'strokeDetectorVersion',
      p_shot -> 'versionVector' ->> 'phaseModelVersion',
      p_shot -> 'versionVector' ->> 'scoringModelVersion',
      p_shot -> 'versionVector' ->> 'shotConfigVersion',
      'real'
    );

    perform pg_catalog.set_config('pickle.offline_lease_grant_id', '', true);

    for entry in select * from jsonb_array_elements(coalesce(p_shot -> 'phases', '[]'::jsonb))
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

    for entry in select * from jsonb_array_elements(coalesce(p_shot -> 'checkpoints', '[]'::jsonb))
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

    return 'accepted';
  exception
    when unique_violation then
      -- The shot id landed concurrently despite the lock (a writer that did
      -- not hold it): the row that committed decides.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'offline.shot_not_chargeable';
      end if;
      return 'shot.id_conflict';
    when others then
      -- SQLSTATE ONLY: sqlerrm echoes the client's input for cast failures
      -- and would carry it into the edge function's logs.
      return 'shot.write_failed:' || sqlstate;
  end;
end;
$$;

comment on function api_private.record_offline_lease_shot(uuid, jsonb) is
  'Writes the scored rating a device rendered offline under a verified-store lease of the caller (live API session required) in the caller''s name — shot + phases + checkpoints under the gate''s lease vouch (pickle.offline_lease_grant_id), under access_lock_key(uid). No ledger event: a lease allocates nothing. A rating the server already holds is never written again. Called only by settle_offline_receipt() in the settlement''s transaction; not callable by any client role. Returns accepted | offline.grant_not_found | offline.shot_not_chargeable | offline.invalid_input | shot.session_not_found | shot.id_conflict | shot.write_failed:<SQLSTATE>.';

revoke all on function api_private.record_offline_lease_shot(uuid, jsonb) from public, anon, authenticated, service_role;

-- 3. settle_offline_receipt(): the lease branch binds its lineage and writes
--    the shot before the settlement row.
create or replace function public.settle_offline_receipt(
  p_receipt jsonb,
  p_receipt_sha256 text,
  p_output jsonb,
  p_hold_reason text,
  p_defer_new boolean default false
)
returns table (
  result text,
  delivery text,
  status text,
  reason_code text,
  financial_disposition text,
  result_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_defer boolean := coalesce(p_defer_new, false);
  v_receipt_id text;
  v_owner_id uuid;
  v_installation_key_id text;
  v_grant_id uuid;
  v_grant_jws_sha256 text;
  v_allocation_id uuid;
  v_generation bigint;
  v_ticket_id uuid;
  v_operation_id text;
  v_result_id text;
  v_output_sha256 text;
  v_billing text;
  v_sequence bigint;
  v_ticket jsonb;
  v_known public.offline_receipt_settlements%rowtype;
  v_allocation public.offline_allocation_ledger%rowtype;
  v_status text := 'result_recorded';
  v_reason text := null;
  v_financial text;
  v_recorded_result text := null;
  v_verdict text;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;

  -- Shape: every identity the settlement rests on must be present and well
  -- formed, or nothing is recorded (a malformed receipt is a client defect,
  -- not evidence to hold).
  if p_receipt is null or jsonb_typeof(p_receipt) <> 'object'
     or p_receipt_sha256 is null or p_receipt_sha256 !~ '^[0-9a-f]{64}$'
     or (p_output is not null and jsonb_typeof(p_output) <> 'object')
     or (p_hold_reason is not null and p_hold_reason not in (
       'evidence_missing', 'evidence_ambiguous', 'conflicting_receipt',
       'owner_mismatch', 'account_deleted', 'grant_revoked')) then
    return query select 'offline.invalid_input'::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  begin
    v_receipt_id := p_receipt ->> 'receiptId';
    v_owner_id := (p_receipt ->> 'ownerId')::uuid;
    v_installation_key_id := p_receipt ->> 'installationKeyId';
    v_grant_id := (p_receipt ->> 'grantId')::uuid;
    v_grant_jws_sha256 := p_receipt ->> 'grantJwsSha256';
    v_operation_id := p_receipt ->> 'operationId';
    v_result_id := p_receipt ->> 'resultId';
    v_output_sha256 := p_receipt ->> 'fullOutputSha256';
    v_billing := p_receipt ->> 'billingDisposition';
    v_sequence := (p_receipt ->> 'lifecycleSequence')::bigint;
    v_ticket := p_receipt -> 'ticket';
    if v_ticket is not null and jsonb_typeof(v_ticket) = 'object' then
      v_allocation_id := (v_ticket ->> 'allocationId')::uuid;
      v_generation := (v_ticket ->> 'generation')::bigint;
      v_ticket_id := (v_ticket ->> 'ticketId')::uuid;
    end if;
  exception when others then
    return query select 'offline.invalid_input'::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end;
  if v_receipt_id is null or v_receipt_id !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
     or v_owner_id is null
     or v_installation_key_id is null or v_installation_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or v_grant_id is null
     or v_grant_jws_sha256 is null or v_grant_jws_sha256 !~ '^[0-9a-f]{64}$'
     or v_operation_id is null or v_operation_id !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
     or v_result_id is null or v_result_id !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
     or v_output_sha256 is null or v_output_sha256 !~ '^[0-9a-f]{64}$'
     or v_billing is null or v_billing not in ('joint_verification_required', 'not_chargeable')
     or v_sequence is null or v_sequence < 1 or v_sequence > 9007199254740991
     or jsonb_typeof(p_receipt -> 'lifecycleSequence') <> 'number'
     or v_ticket is null
     or (jsonb_typeof(v_ticket) <> 'null' and (
       jsonb_typeof(v_ticket) <> 'object'
       or v_allocation_id is null or v_ticket_id is null
       or v_generation is null or v_generation < 1 or v_generation > 9007199254740991
       or jsonb_typeof(v_ticket -> 'generation') <> 'number')) then
    return query select 'offline.invalid_input'::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if jsonb_typeof(v_ticket) = 'null' then
    v_allocation_id := null;
    v_generation := null;
    v_ticket_id := null;
  end if;
  v_financial := case when v_ticket_id is null then 'not_applicable' else 'reserved' end;

  -- Caller lock first (the receipt namespace and the budget), ticket lock
  -- second — the one order every offline path uses.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));
  if v_ticket_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(api_private.offline_ticket_lock_key(v_ticket_id));
  end if;

  -- A receipt this caller already delivered: replay its verdict (same body)
  -- or report the conflict (same id, other body). Nothing settles twice, and
  -- nothing about a freeze is consulted before this — the durable verdict is
  -- the verdict.
  select * into v_known
  from public.offline_receipt_settlements s
  where s.user_id = v_uid and s.receipt_id = v_receipt_id;
  if found then
    if v_known.receipt_sha256 = p_receipt_sha256 then
      return query select 'accepted'::text, 'replayed'::text, v_known.status, v_known.reason_code,
        v_known.financial_disposition,
        case when v_known.status = 'result_recorded' then v_known.result_id end;
    else
      return query select 'offline.receipt_conflict'::text, null::text, null::text, null::text, null::text, null::text;
    end if;
    return;
  end if;

  if p_hold_reason is not null then
    -- The edge could not verify the evidence (signature, binding, digest,
    -- output): hold with its reason, ticket untouched.
    v_status := 'reconciliation_required';
    v_reason := p_hold_reason;
  elsif v_owner_id <> v_uid then
    v_status := 'reconciliation_required';
    v_reason := 'owner_mismatch';
  elsif exists (
    select 1 from public.offline_receipt_settlements s
    where s.user_id = v_uid and (s.operation_id = v_operation_id or s.result_id = v_result_id)
  ) then
    -- One operation, one result, one receipt: a second receipt for the same
    -- operation or the same result is a conflict to reconcile, never a
    -- second result.
    v_status := 'reconciliation_required';
    v_reason := 'conflicting_receipt';
  elsif v_ticket_id is null then
    -- Pro lease: no ticket to consume, but the receipt must name a lease the
    -- caller holds and the output beside it must tell one story with the
    -- receipt before the result is recorded as delivered. Lineage first, as
    -- the ticket branch reads it: the grant must be a verified-store lease
    -- of the caller for the installation the receipt names — a null ticket
    -- under any other grant (a FREE grant of the caller included) is
    -- evidence about some other authorization. Then the evidence, judged
    -- exactly as the ticket branch judges it: not_chargeable + no output /
    -- a non-scored output naming this result → recorded; chargeable + a
    -- scored output naming this result → the shot is WRITTEN for the owner
    -- (pending under a reversible freeze, nothing written); chargeable + no
    -- output → HOLD evidence_missing; anything else → HOLD
    -- evidence_ambiguous. Nothing financial either way.
    if not exists (
      select 1
      from public.offline_grants g
      join public.offline_devices d on d.id = g.device_id
      where g.id = v_grant_id
        and g.user_id = v_uid
        and g.entitlement_source = 'verified_store'
        and d.installation_key_id = v_installation_key_id
    ) then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    elsif v_billing = 'not_chargeable' then
      if p_output is null
         or (p_output ->> 'id' is not distinct from v_result_id
             and p_output ->> 'resultKind' is distinct from 'scored') then
        v_recorded_result := v_result_id;
      else
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      end if;
    elsif p_output is null then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_missing';
    elsif p_output ->> 'id' is distinct from v_result_id
          or v_result_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or p_output ->> 'resultKind' is distinct from 'scored' then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    elsif v_defer then
      -- Complete, bound chargeable evidence under a release the operator has
      -- frozen but not withdrawn: nothing durable is decided (the freeze may
      -- lift, or become a withdrawal) — the identical redelivery is judged
      -- then.
      return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
        v_financial, null::text;
      return;
    else
      v_verdict := api_private.record_offline_lease_shot(v_grant_id, p_output);
      if v_verdict = 'accepted' then
        v_recorded_result := v_result_id;
      elsif v_verdict in ('shot.id_conflict', 'offline.shot_not_chargeable') then
        -- The shots table already tells another story about this rating:
        -- hold, nothing written.
        v_status := 'reconciliation_required';
        v_reason := 'conflicting_receipt';
      elsif v_verdict = 'shot.session_not_found' then
        -- The session the rating belongs to has not synced yet: transient,
        -- so no verdict is recorded — the identical redelivery settles once
        -- the session exists.
        return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
          v_financial, null::text;
        return;
      elsif v_verdict in ('offline.grant_not_found', 'offline.invalid_input')
            or v_verdict ~ '^shot\.write_failed:2[23]' then
        -- Unparseable output or an output the shots table refuses (SQLSTATE
        -- class 22 data / 23 integrity): the evidence cannot be settled as
        -- delivered, and redelivering it would not change that.
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      else
        -- Any other shot.write_failed:<SQLSTATE> is a server-side failure,
        -- not evidence: nothing durable is written and the device
        -- redelivers the same receipt.
        raise exception 'offline receipt settlement failed: %', v_verdict
          using errcode = 'internal_error';
      end if;
    end if;
  else
    -- The ticket's allocation must be owned by the caller and made to the
    -- installation the receipt names, and the grant the receipt claims must
    -- belong to that ticket's lineage: a grant of the caller for that same
    -- installation, issued at or after the allocation, at the generation the
    -- receipt claims — the allocating grant itself or a later one that
    -- restated the outstanding ticket (lease refresh, original-owner
    -- recovery). Anything else is evidence about some other allocation.
    select * into v_allocation
    from public.offline_allocation_ledger a
    where a.ticket_id = v_ticket_id
      and a.event = 'allocated'
      and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid);
    if not found
       or v_allocation.installation_key_id <> v_installation_key_id
       or v_allocation_id <> v_grant_id
       or not exists (
         select 1
         from public.offline_grants g
         join public.offline_devices d on d.id = g.device_id
         where g.id = v_grant_id
           and g.user_id = v_uid
           and g.entitlement_source = 'identity_lifetime_free'
           and g.generation = v_generation
           and g.issued_at >= v_allocation.created_at
           and d.installation_key_id = v_allocation.installation_key_id
       ) then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    elsif exists (
      select 1 from public.offline_allocation_ledger t
      where t.ticket_id = v_ticket_id and t.event in ('consumed', 'released')
    ) then
      -- The ledger already closed this ticket (another rating consumed it,
      -- or the device returned it): whatever the receipt claims under it —
      -- a charge or an abstention — tells another story than the ledger.
      -- Held, ticket left as it is. Decided before any freeze: the ledger
      -- does not change when a freeze lifts.
      v_status := 'reconciliation_required';
      v_reason := 'conflicting_receipt';
    elsif v_billing = 'not_chargeable' then
      if p_output is null
         or (p_output ->> 'id' is not distinct from v_result_id
             and p_output ->> 'resultKind' is distinct from 'scored') then
        -- An abstention: the result is recorded, the ticket stays outstanding
        -- (the device returns it explicitly; nothing here releases it).
        v_recorded_result := v_result_id;
      else
        -- The output names another result, or claims a scored rating the
        -- receipt says was not chargeable: the evidence contradicts the
        -- receipt. Held, ticket reserved — never recorded as reconciled.
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      end if;
    elsif p_output is null then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_missing';
    elsif p_output ->> 'id' is distinct from v_result_id
          or v_result_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or p_output ->> 'resultKind' is distinct from 'scored' then
      -- The output does not name this result, or claims a charge for an
      -- abstention: the evidence contradicts the receipt.
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    elsif v_defer then
      -- Complete, bound chargeable evidence for an outstanding ticket under a
      -- release the operator has frozen but not withdrawn: nothing durable
      -- is decided and nothing is consumed — the ticket stays reserved and
      -- the identical redelivery is judged once the freeze lifts (settles)
      -- or the release is withdrawn (grant_revoked HOLD).
      return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
        v_financial, null::text;
      return;
    else
      v_verdict := public.consume_offline_ticket(v_ticket_id, p_output);
      if v_verdict = 'accepted' then
        v_financial := 'consumed';
        v_recorded_result := v_result_id;
      elsif v_verdict in ('offline.ticket_consumed', 'offline.ticket_released', 'shot.id_conflict',
                          'offline.shot_not_chargeable') then
        -- The ledger or the shots table already tells another story about
        -- this ticket or this rating: hold, leave the ticket as it is.
        v_status := 'reconciliation_required';
        v_reason := 'conflicting_receipt';
      elsif v_verdict = 'shot.session_not_found' then
        -- The session the rating belongs to has not synced yet (the app's
        -- session outbox may land after the receipt): transient, so no
        -- verdict is recorded — the ticket stays reserved and the identical
        -- redelivery settles once the session exists.
        return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
          v_financial, null::text;
        return;
      elsif v_verdict in ('offline.ticket_not_found', 'offline.invalid_input')
            or v_verdict ~ '^shot\.write_failed:2[23]' then
        -- Unknown ticket, unparseable output or an output the shots table
        -- refuses (SQLSTATE class 22 data / 23 integrity): the evidence
        -- cannot be settled as delivered, and redelivering it would not
        -- change that.
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      else
        -- Any other shot.write_failed:<SQLSTATE> is a server-side failure,
        -- not evidence: nothing durable is written and the device
        -- redelivers the same receipt.
        raise exception 'offline receipt settlement failed: %', v_verdict
          using errcode = 'internal_error';
      end if;
    end if;
  end if;

  insert into public.offline_receipt_settlements (
    user_id, receipt_id, receipt_sha256, owner_id, installation_key_id, grant_id, grant_jws_sha256,
    allocation_id, generation, ticket_id, operation_id, result_id, full_output_sha256,
    billing_disposition, lifecycle_sequence, status, reason_code, financial_disposition, receipt
  ) values (
    v_uid, v_receipt_id, p_receipt_sha256, v_owner_id, v_installation_key_id, v_grant_id, v_grant_jws_sha256,
    v_allocation_id, v_generation, v_ticket_id, v_operation_id, v_result_id, v_output_sha256,
    v_billing, v_sequence, v_status, v_reason, v_financial, p_receipt
  );

  return query select 'accepted'::text,
    case when v_status = 'result_recorded' then 'settled'::text else 'held'::text end,
    v_status, v_reason, v_financial, v_recorded_result;
end;
$$;

comment on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) is
  'Settles one delayed offline consumption receipt for the caller (live API session required) under access_lock_key(uid) then offline_ticket_lock_key(ticket): a receipt already held is replayed (same canonical digest) or reported as offline.receipt_conflict (same id, other body) — never settled twice, and decided before anything else; a new receipt is held as reconciliation_required (edge hold reason, owner mismatch, second receipt for the operation or result, grant outside the ticket''s allocation lineage — a grant of the caller for the allocating installation issued at or after the allocation at the claimed generation — or, for a null ticket, a grant that is not a verified-store lease of the caller for the receipt''s installation, a ticket the ledger already consumed or released, output contradicting the billing disposition on a ticket or a lease, a rating the server already holds) with its ticket left exactly as it was, answered pending with nothing recorded while the session it names has not synced or while p_defer_new (a reversible deny-new freeze on the release) defers a genuinely new chargeable receipt, or settled in the same transaction — through consume_offline_ticket() for a ticket, through api_private.record_offline_lease_shot() for a lease (the scored rating is written for the owner before result_recorded is answered; financial_disposition stays not_applicable). lifecycleSequence and generation are positive safe integers (bigint). Returns (result accepted | offline.invalid_input | offline.receipt_conflict, delivery settled | replayed | held | pending, status, reason_code, financial_disposition consumed | reserved | not_applicable, result_id).';

revoke all on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) from public, anon, service_role;
grant execute on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) to authenticated;
