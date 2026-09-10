-- W04-04 (round 6): the reversible release freeze is decided INSIDE
-- settle_offline_receipt(), after the durable verdicts, never before them.
--
-- The edge function used to read the release authority's
-- deny_new_authorizations flag and answer `pending` for every receipt under a
-- frozen (not withdrawn) release BEFORE calling this function. That masked the
-- ledger: a receipt already SETTLED (ticket consumed) was answered
-- pending / reserved, a durably HELD receipt lost its hold, and a different
-- receipt reusing a settled receipt id was answered pending instead of
-- offline.receipt_conflict — the wire verdict contradicted the database for
-- the whole freeze. The freeze is now a parameter of the settlement:
--
--   p_defer_new boolean default false — true while the release the grant was
--   issued under denies new authorizations but is NOT withdrawn (the operator
--   may lift the freeze or turn it into a withdrawal). Under the owner lock
--   the function first replays a receipt it already holds (same id and
--   digest → the durable status, settled or held), reports a conflict (same
--   id, other body) and records every HOLD exactly as without a freeze; only
--   a genuinely NEW chargeable receipt whose evidence is complete — the one
--   that would consume a ticket or record a chargeable lease result right
--   now — is answered pending with nothing written and its ticket still
--   reserved, so the identical redelivery settles once the freeze lifts under
--   the SAME operation id.
--
-- Carried forward from the round-4 candidate (never applied): the Pro
-- (no-ticket) lease branch judges the delivered output against the billing
-- disposition the way the ticket branch does (chargeable + no output → HOLD
-- evidence_missing; chargeable + an output that is not this scored result,
-- or not_chargeable + a scored output / another result → HOLD
-- evidence_ambiguous; otherwise result_recorded), financial_disposition
-- staying not_applicable on every lease path; and a ticket the ledger already
-- CONSUMED or RELEASED is a durable conflicting_receipt HOLD for every
-- disposition, not_chargeable included, read under the ticket lock before
-- any evidence is judged.
--
-- The previous signature (jsonb, text, jsonb, text) is dropped and the
-- function re-created with the defaulted parameter so the four-argument call
-- keeps resolving; the exact grants/revokes are re-applied to the new
-- signature. The applied migrations are not edited.

drop function if exists public.settle_offline_receipt(jsonb, text, jsonb, text);

create function public.settle_offline_receipt(
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
     or p_defer_new is null
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
  -- no freeze is consulted for what is already decided.
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
    -- Pro lease: no ticket to consume, but the receipt and the output beside
    -- it must still tell one story before the result is recorded as
    -- delivered. Judged exactly as the ticket branch judges evidence:
    -- not_chargeable + no output / a non-scored output naming this result
    -- → recorded; chargeable + a scored output naming this result →
    -- recorded (deferred, nothing written, while the release is frozen);
    -- chargeable + no output → HOLD evidence_missing; anything else (a
    -- scored output the receipt says was not chargeable, an abstention the
    -- receipt says to charge, an output naming another result) → HOLD
    -- evidence_ambiguous. Nothing financial either way.
    if v_billing = 'not_chargeable' then
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
          or p_output ->> 'resultKind' is distinct from 'scored' then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    elsif p_defer_new then
      return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
        v_financial, null::text;
      return;
    else
      v_recorded_result := v_result_id;
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
      -- or the device returned it): any receipt claimed under it — a charge
      -- or an abstention — tells another story than the ledger. Held,
      -- durably, ticket left exactly as it is; no freeze defers this.
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
    elsif p_defer_new then
      -- A genuinely new, fully evidenced chargeable receipt under a release
      -- that is frozen but not withdrawn: the charge is deferred, not
      -- refused — nothing durable is written, the ticket stays reserved,
      -- and the identical redelivery settles under the same operation once
      -- the freeze lifts (or is held grant_revoked once it is withdrawn).
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
  'Settles one delayed offline consumption receipt for the caller (live API session required) under access_lock_key(uid) then offline_ticket_lock_key(ticket): a receipt already held is replayed (same canonical digest) or reported as offline.receipt_conflict (same id, other body) — never settled twice and never deferred; a new receipt is held as reconciliation_required (edge hold reason, owner mismatch, second receipt for the operation or result, grant outside the ticket''s allocation lineage — a grant of the caller for the allocating installation issued at or after the allocation at the claimed generation — ticket already consumed or released for any billing disposition, output contradicting the billing disposition) with its ticket left exactly as it was, answered pending with nothing recorded while the session it names has not synced or while p_defer_new (the release the grant names denies new authorizations but is not withdrawn) defers a genuinely new fully evidenced chargeable receipt, or settled through consume_offline_ticket() in the same transaction. Pro (no-ticket) lease receipts keep financial_disposition not_applicable. lifecycleSequence and generation are positive safe integers (bigint). Returns (result accepted | offline.invalid_input | offline.receipt_conflict, delivery settled | replayed | held | pending, status, reason_code, financial_disposition consumed | reserved | not_applicable, result_id).';

revoke all on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) from public, anon, service_role;
grant execute on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) to authenticated;
