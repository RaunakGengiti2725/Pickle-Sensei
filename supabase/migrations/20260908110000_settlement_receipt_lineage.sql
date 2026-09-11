-- ============================================================================
-- Pickle Sensei — settlement receipts bound to owner / device / grant / ticket /
-- operation / canonical payload digest / release-policy lineage (W01-03;
-- follows 20260908100000).
--
-- THE GAP. apply_synced_shot(jsonb) decided "replay" on ONE fact: a shot row
-- with this id already belongs to the caller. Nothing recorded WHAT was
-- settled — which device presented it, under which offline grant and ticket,
-- for which operation, with which exact payload, admitted under which release
-- policy. A second sync of the same id with a different payload (a different
-- score, a different permit, another device's claims) was acknowledged as a
-- replay, and there was no original receipt to hand back.
--
-- THE FIX.
--   1. public.settlement_receipts — one row per settled shot, written in the
--      SAME transaction as the shot / details / permit consumption. It keeps
--      the receipt the edge function built (RFC 8785 canonical bytes + their
--      SHA-256) and the binding it rests on, denormalised for comparison and
--      audit: owner, permit, result kind, installation key, grant id + grant
--      bytes digest, ticket (allocation / generation / id), operation id, the
--      digest of the persisted payload, the digest of the binding, and the
--      release-policy version + digest. Service-only for writes (RLS on, no
--      client INSERT / UPDATE / DELETE, append-only trigger); the OWNER may
--      read its own receipts through the API gate so the edge function can
--      answer a replay from the stored row.
--   2. apply_synced_shot(jsonb) accepts an optional `settlementReceipt`
--      {canonical, sha256} beside the shot. When present it must verify
--      (bytes match their digest, the binding names THIS caller / shot /
--      permit / result kind, every claim well-formed, a scored settlement
--      carries policy lineage) or the call is `shot.receipt_invalid` — nothing
--      is written, the permit stays reserved. Replay is now decided on the
--      BINDING: an owned shot row with a stored receipt is `accepted` only
--      when the presented binding is identical (the edge returns the stored
--      receipt); anything else — a different payload digest, permit, device,
--      grant, ticket, operation, or no receipt at all — is
--      `shot.receipt_mismatch`. Both verdicts are reached before the permit
--      is locked, before lifetime_scored_count() is consulted and before any
--      row moves, so a mismatch consumes neither a credit nor a sequence.
--      Rows settled before this migration have no receipt; their replay
--      verdict is unchanged (`accepted`).
--   3. The receipt row is written by a definer AFTER INSERT trigger on
--      public.shots from a transaction-local setting the RPC populates inside
--      its atomic block (the same pattern as pickle.sync_permit_id and
--      shots_record_free_rating_ledger): the client role needs no INSERT on
--      the receipt table, and a failed write rolls the receipt back with the
--      shot.
--
-- UNCHANGED: security invoker, search_path = '', access_lock_key(uid),
-- permit_backs_sync(), one-permit-one-shot, lifetime_scored_count() >= 2 for
-- the free-limit backstop, the transaction-local vouch, SQLSTATE-only write
-- failures, and the fixed authenticated RPC allowlist (no new public RPC).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The receipt table.
-- ---------------------------------------------------------------------------
create table if not exists public.settlement_receipts (
  shot_id uuid primary key references public.shots (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  analysis_permit_id uuid not null,
  result_kind text not null
    check (result_kind in ('scored', 'low_confidence', 'partial')),
  installation_key_id text
    check (installation_key_id is null or installation_key_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  grant_id text
    check (grant_id is null or grant_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  grant_jws_sha256 text
    check (grant_jws_sha256 is null or grant_jws_sha256 ~ '^[0-9a-f]{64}$'),
  ticket_allocation_id text
    check (ticket_allocation_id is null or ticket_allocation_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  ticket_generation integer
    check (ticket_generation is null or ticket_generation > 0),
  ticket_id text
    check (ticket_id is null or ticket_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  operation_id text
    check (operation_id is null or operation_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  binding_sha256 text not null check (binding_sha256 ~ '^[0-9a-f]{64}$'),
  policy_version text
    check (policy_version is null or length(policy_version) between 1 and 128),
  policy_sha256 text
    check (policy_sha256 is null or policy_sha256 ~ '^[0-9a-f]{64}$'),
  receipt jsonb not null,
  receipt_canonical text not null check (length(receipt_canonical) between 2 and 65536),
  receipt_sha256 text not null check (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint settlement_receipts_grant_shape check (
    (grant_id is null) = (grant_jws_sha256 is null)
  ),
  constraint settlement_receipts_ticket_shape check (
    (ticket_allocation_id is null) = (ticket_generation is null)
    and (ticket_allocation_id is null) = (ticket_id is null)
  ),
  constraint settlement_receipts_policy_shape check (
    (policy_version is null) = (policy_sha256 is null)
    and (result_kind <> 'scored' or policy_version is not null)
  )
);

comment on table public.settlement_receipts is
  'The receipt of every shot settled through apply_synced_shot() with a settlementReceipt: the canonical receipt bytes the edge function built and returns to the client, plus the binding (owner, permit, result kind, installation key, grant, ticket, operation id, payload digest, binding digest, release-policy version/digest) replay is decided on. Written only by shots_record_settlement_receipt (definer AFTER INSERT) in the settlement transaction; append-only; owner-readable through the API gate; removed only by the shot/account cascade.';

create index if not exists settlement_receipts_user_idx
  on public.settlement_receipts (user_id);

alter table public.settlement_receipts enable row level security;
revoke all on public.settlement_receipts from public, anon, authenticated;
grant select on public.settlement_receipts to authenticated;

drop policy if exists settlement_receipts_select_own on public.settlement_receipts;
create policy settlement_receipts_select_own on public.settlement_receipts
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists api_requests_only on public.settlement_receipts;
create policy api_requests_only on public.settlement_receipts as restrictive for all to authenticated
  using ((select api_private.is_api_request()))
  with check ((select api_private.is_api_request()));

-- Append-only for EVERY role: a receipt is evidence. The only removal is the
-- cascade that already removed the shot it describes.
create or replace function public.guard_settlement_receipt_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using
      errcode = 'check_violation',
      message = 'settlement_receipts: receipts are append-only';
  end if;
  if exists (select 1 from public.shots s where s.id = old.shot_id) then
    raise exception using
      errcode = 'check_violation',
      message = 'settlement_receipts: a receipt outlives every path but the shot cascade';
  end if;
  return old;
end;
$$;

revoke all on function public.guard_settlement_receipt_lifecycle()
  from public, anon, authenticated;

drop trigger if exists settlement_receipts_guard_lifecycle on public.settlement_receipts;
create trigger settlement_receipts_guard_lifecycle
  before update or delete on public.settlement_receipts
  for each row execute function public.guard_settlement_receipt_lifecycle();

-- ---------------------------------------------------------------------------
-- 2. AFTER INSERT on shots: persist the receipt the RPC verified for THIS row.
--    Definer so the client role needs no INSERT on the receipt table; the
--    canonical bytes travel in a transaction-local setting the RPC populates
--    only inside its atomic block and clears right after the shot insert.
-- ---------------------------------------------------------------------------
create or replace function public.record_settlement_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_canonical text := pg_catalog.current_setting('pickle.sync_settlement_receipt', true);
  v_receipt jsonb;
  v_binding jsonb;
begin
  if coalesce(v_canonical, '') = '' then
    return new;
  end if;

  v_receipt := v_canonical::jsonb;
  v_binding := v_receipt -> 'binding';

  -- The RPC verified the receipt against the shot it is settling; refuse a
  -- receipt that reaches this row describing anything else.
  if jsonb_typeof(v_binding) <> 'object'
     or (v_binding ->> 'shotId') is distinct from new.id::text
     or (v_binding ->> 'ownerId') is distinct from new.user_id::text
     or (v_binding ->> 'analysisPermitId') is distinct from new.analysis_permit_id::text
     or (v_binding ->> 'resultKind') is distinct from new.result_kind then
    raise exception using
      errcode = 'check_violation',
      message = 'settlement_receipts: the receipt does not describe the shot being written';
  end if;

  insert into public.settlement_receipts (
    shot_id, user_id, analysis_permit_id, result_kind,
    installation_key_id, grant_id, grant_jws_sha256,
    ticket_allocation_id, ticket_generation, ticket_id, operation_id,
    payload_sha256, binding_sha256, policy_version, policy_sha256,
    receipt, receipt_canonical, receipt_sha256
  ) values (
    new.id,
    new.user_id,
    new.analysis_permit_id,
    new.result_kind,
    v_binding ->> 'installationKeyId',
    v_binding -> 'grant' ->> 'grantId',
    v_binding -> 'grant' ->> 'grantJwsSha256',
    v_binding -> 'ticket' ->> 'allocationId',
    (v_binding -> 'ticket' ->> 'generation')::integer,
    v_binding -> 'ticket' ->> 'ticketId',
    v_binding ->> 'operationId',
    v_binding ->> 'payloadSha256',
    v_receipt ->> 'bindingSha256',
    v_receipt -> 'policy' ->> 'version',
    v_receipt -> 'policy' ->> 'sha256',
    v_receipt,
    v_canonical,
    encode(pg_catalog.sha256(convert_to(v_canonical, 'UTF8')), 'hex')
  );
  return new;
end;
$$;

revoke all on function public.record_settlement_receipt()
  from public, anon, authenticated;

drop trigger if exists shots_record_settlement_receipt on public.shots;
create trigger shots_record_settlement_receipt
  after insert on public.shots
  for each row execute function public.record_settlement_receipt();

-- ---------------------------------------------------------------------------
-- 3. apply_synced_shot: verify the presented receipt, decide replay on the
--    binding, persist the receipt with the shot. Everything else is the
--    20260907100000 definition verbatim.
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

    if not v_premium and public.lifetime_scored_count() >= 2 then
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

revoke all on function public.apply_synced_shot(jsonb) from public, anon;
grant execute on function public.apply_synced_shot(jsonb) to authenticated;
