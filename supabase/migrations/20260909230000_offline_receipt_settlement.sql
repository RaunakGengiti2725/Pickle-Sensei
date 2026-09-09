-- W04-04: delayed reconciliation of offline consumption receipts.
--
-- A device that rendered ratings under an offline grant (20260908160000)
-- reports them later, in batches, possibly out of order and more than once.
-- consume_offline_ticket() settles ONE (ticket, shot) and is idempotent for
-- that pair, but nothing durable remembered the RECEIPT the device signed —
-- its id, its operation, the digest of the output it vouches for — so a
-- redelivery could not be told apart from a second claim, and a receipt whose
-- evidence the edge could not verify had nowhere to be held: it was either
-- refused (and the device retried, possibly under a new operation) or written.
--
-- Now:
--   * public.offline_receipt_settlements is the durable receipt identity:
--     one row per (caller, receiptId) with the receipt's canonical digest,
--     every identity the settlement rests on (owner, installation, grant +
--     compact-JWS digest, allocation/generation/ticket, operation, result,
--     output digest, billing disposition, lifecycle sequence) and the verdict
--     (result_recorded | reconciliation_required + reason). RLS on with no
--     policies and no client or service-role grants: the settlement RPC is
--     its only reader and writer (the verdict reaches the device in the
--     route's answer); append-only; cascades with the account.
--   * public.settle_offline_receipt(receipt, receipt digest, output, hold
--     reason) is the one writer (live API session required). Under
--     access_lock_key(uid) — then the ticket lock, the order every offline
--     path uses — it answers a receipt it already holds by REPLAYING the
--     stored verdict (same digest) or reporting a conflict (same id, other
--     body), never settling twice; a new receipt is HELD when the edge could
--     not verify its evidence (hold reason), when it names another owner,
--     when its operation already has a receipt, when the ticket's allocation
--     LINEAGE does not admit the grant it claims (see below), or when
--     the delivered output contradicts it (names another result, or its
--     resultKind disagrees with the billing disposition — a scored output
--     beside a not_chargeable receipt as much as an abstention beside a
--     chargeable one), or
--     consume_offline_ticket() reports the ticket consumed by another rating,
--     released, unknown or the rating not chargeable under it; otherwise it
--     settles through consume_offline_ticket() in the same transaction, so
--     the shot, the consumed ledger event and the receipt row commit together
--     or not at all. A held receipt leaves its ticket exactly as it was
--     (reserved — never released, never re-executed): recovery is a
--     reconciliation decision, not a refund.
--   * Lineage: issue_offline_grant() re-issues an installation's outstanding
--     tickets under the NEXT generation (a new grant id) and writes no new
--     allocation row, so a receipt rendered after a lease refresh — or by the
--     original installation of a deleted-and-re-created account — names the
--     ticket exactly as the refreshed grant lists it. The ticket is bound to
--     its allocation lineage: the receipt's grant must be a grant of the
--     caller for the allocating installation, issued at or after the
--     allocation, at the generation the receipt claims. Foreign
--     installations, grants and generations the lineage never had stay HELD.
--   * A receipt that names a session the account has not synced yet
--     (consume_offline_ticket() = shot.session_not_found) is answered
--     `pending` with NOTHING durable: the ticket stays reserved and the very
--     same receipt settles once the session exists — a transient condition
--     is not evidence against the receipt.
--   * lifecycleSequence and generation are the shared contract's positive
--     safe integers (≤ 2^53-1), parsed and stored as bigint, so a
--     contract-valid receipt always receives a durable verdict.
--   * public.read_analysis_release_policy_lineage(sha256) lets the edge
--     (service role only) read the release policy a delayed receipt's grant
--     was issued under — approvals, withdrawal and validity included — so
--     routine policy rotation does not strand outstanding grants while a
--     WITHDRAWN release still holds every receipt rendered under it.
-- Nothing here reclaims an allocation, widens a grant or bypasses the shots
-- gate: the only rating write is the existing consume_offline_ticket().

-- ---------------------------------------------------------------------------
-- 1. Durable receipt identity + verdict
-- ---------------------------------------------------------------------------
create table if not exists public.offline_receipt_settlements (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  receipt_id text not null,
  receipt_sha256 text not null,
  owner_id uuid not null,
  installation_key_id text not null,
  grant_id uuid not null,
  grant_jws_sha256 text not null,
  allocation_id uuid,
  generation bigint,
  ticket_id uuid,
  operation_id text not null,
  result_id text not null,
  full_output_sha256 text not null,
  billing_disposition text not null,
  lifecycle_sequence bigint not null,
  status text not null,
  reason_code text,
  financial_disposition text not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  constraint offline_receipt_settlements_receipt_id_bounds
    check (receipt_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  constraint offline_receipt_settlements_operation_id_bounds
    check (operation_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  constraint offline_receipt_settlements_result_id_bounds
    check (result_id ~ '^[A-Za-z0-9._:/+=-]{1,128}$'),
  constraint offline_receipt_settlements_installation_key_bounds
    check (installation_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint offline_receipt_settlements_receipt_sha256
    check (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  constraint offline_receipt_settlements_grant_jws_sha256
    check (grant_jws_sha256 ~ '^[0-9a-f]{64}$'),
  constraint offline_receipt_settlements_output_sha256
    check (full_output_sha256 ~ '^[0-9a-f]{64}$'),
  constraint offline_receipt_settlements_billing_disposition
    check (billing_disposition in ('joint_verification_required', 'not_chargeable')),
  constraint offline_receipt_settlements_lifecycle_sequence
    check (lifecycle_sequence between 1 and 9007199254740991),
  constraint offline_receipt_settlements_generation
    check (generation is null or generation between 1 and 9007199254740991),
  constraint offline_receipt_settlements_ticket_complete
    check ((allocation_id is null) = (ticket_id is null) and (generation is null) = (ticket_id is null)),
  constraint offline_receipt_settlements_status
    check (status in ('result_recorded', 'reconciliation_required')),
  constraint offline_receipt_settlements_reason
    check (
      (status = 'reconciliation_required') = (reason_code is not null)
      and (reason_code is null or reason_code in (
        'evidence_missing', 'evidence_ambiguous', 'conflicting_receipt',
        'owner_mismatch', 'account_deleted', 'grant_revoked'))
    ),
  constraint offline_receipt_settlements_financial_disposition
    check (financial_disposition in ('consumed', 'reserved', 'not_applicable')),
  constraint offline_receipt_settlements_hold_never_settles
    check (status <> 'reconciliation_required' or financial_disposition in ('reserved', 'not_applicable')),
  constraint offline_receipt_settlements_consumed_names_ticket
    check (financial_disposition <> 'consumed' or ticket_id is not null),
  constraint offline_receipt_settlements_receipt_object
    check (jsonb_typeof(receipt) = 'object'),
  unique (user_id, receipt_id)
);

comment on table public.offline_receipt_settlements is
  'One row per (caller, receipt id): the durable identity of a delayed offline consumption receipt — its canonical digest, every identity the settlement rests on and the verdict. result_recorded = the rating is the server''s (consumed under its ticket, or no ticket to consume); reconciliation_required = the evidence could not be verified or conflicts, the ticket is left exactly as it was (never released, never re-executed) and recovery is a reconciliation decision. Read and written only by settle_offline_receipt(); append-only; no client or service-role grants.';

create index if not exists offline_receipt_settlements_operation_idx
  on public.offline_receipt_settlements (user_id, operation_id);
create index if not exists offline_receipt_settlements_ticket_idx
  on public.offline_receipt_settlements (ticket_id) where ticket_id is not null;
create index if not exists offline_receipt_settlements_hold_idx
  on public.offline_receipt_settlements (user_id, created_at) where status = 'reconciliation_required';

alter table public.offline_receipt_settlements enable row level security;
revoke all on public.offline_receipt_settlements from public, anon, authenticated, service_role;
revoke all on sequence public.offline_receipt_settlements_id_seq from public, anon, authenticated, service_role;

-- Append-only for every role; the one admitted DELETE is the account cascade
-- (auth.users -> profiles -> offline_receipt_settlements), recognised by the
-- owning profile being gone within the same statement.
create or replace function public.guard_offline_receipt_settlement_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'offline_receipt_settlements is append-only'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.profiles p where p.id = old.user_id) then
    return old;
  end if;
  raise exception 'offline_receipt_settlements: a settlement outlives every path but the account cascade'
    using errcode = 'check_violation';
end;
$$;

revoke all on function public.guard_offline_receipt_settlement_lifecycle()
  from public, anon, authenticated, service_role;

drop trigger if exists offline_receipt_settlements_append_only on public.offline_receipt_settlements;
create trigger offline_receipt_settlements_append_only
  before update or delete on public.offline_receipt_settlements
  for each row execute function public.guard_offline_receipt_settlement_lifecycle();

-- ---------------------------------------------------------------------------
-- 2. The one writer
-- ---------------------------------------------------------------------------
create or replace function public.settle_offline_receipt(
  p_receipt jsonb,
  p_receipt_sha256 text,
  p_output jsonb,
  p_hold_reason text
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
  -- or report the conflict (same id, other body). Nothing settles twice.
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
  elsif p_output is not null
        and (p_output ->> 'id' is distinct from v_result_id
             or (v_billing = 'not_chargeable') = (coalesce(p_output ->> 'resultKind', '') = 'scored')) then
    -- The output does not name this result, or its kind contradicts the
    -- receipt's billing disposition (a scored rating beside "nothing to
    -- charge", an abstention beside a charge): the evidence contradicts the
    -- receipt, whichever way — hold, ticket untouched.
    v_status := 'reconciliation_required';
    v_reason := 'evidence_ambiguous';
  elsif v_ticket_id is null then
    -- Pro lease: no ticket to consume; the result is recorded as delivered.
    v_recorded_result := v_result_id;
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
    elsif v_billing = 'not_chargeable' then
      -- An abstention: the result is recorded, the ticket stays outstanding
      -- (the device returns it explicitly; nothing here releases it).
      v_recorded_result := v_result_id;
    elsif p_output is null then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_missing';
    elsif v_result_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      -- A chargeable result must be a shot id the shots table can hold.
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
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

comment on function public.settle_offline_receipt(jsonb, text, jsonb, text) is
  'Settles one delayed offline consumption receipt for the caller (live API session required) under access_lock_key(uid) then offline_ticket_lock_key(ticket): a receipt already held is replayed (same canonical digest) or reported as offline.receipt_conflict (same id, other body) — never settled twice; a new receipt is held as reconciliation_required (edge hold reason, owner mismatch, second receipt for the operation, output contradicting the receipt (other result id, or resultKind disagreeing with the billing disposition), grant outside the ticket''s allocation lineage — a grant of the caller for the allocating installation issued at or after the allocation at the claimed generation — ticket consumed by another rating or released, rating not chargeable) with its ticket left exactly as it was, answered pending with nothing recorded while the session it names has not synced, or settled through consume_offline_ticket() in the same transaction. lifecycleSequence and generation are positive safe integers (bigint). Returns (result accepted | offline.invalid_input | offline.receipt_conflict, delivery settled | replayed | held | pending, status, reason_code, financial_disposition consumed | reserved | not_applicable, result_id).';

revoke all on function public.settle_offline_receipt(jsonb, text, jsonb, text) from public, anon, service_role;
grant execute on function public.settle_offline_receipt(jsonb, text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The release a delayed receipt's grant was issued under
-- ---------------------------------------------------------------------------
-- read_analysis_release_policy() exposes the ACTIVE policy only. A grant is
-- signed over the release it was issued under, and a receipt can arrive days
-- after that release stopped being the active one, so the edge needs to read
-- an installed policy BY DIGEST to verify the grant's release binding. Same
-- shape as the active reader (document, canonical bytes, approval with
-- withdrawal) so the same integrity verifier applies; a withdrawn release
-- reports denyNewAuthorizations = true exactly as the active reader would
-- once withdraw_analysis_release_policy() ran; an unknown digest answers the
-- "nothing installed" row (document null, approval null, deny = true). Read
-- only — nothing here activates, approves or withdraws — and, like the active
-- reader, callable by the service role alone.
create or replace function public.read_analysis_release_policy_lineage(p_policy_sha256 text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'document', p.document,
        'canonicalDocument', p.canonical_document,
        'denyNewAuthorizations',
          case when p.sha256 = c.active_policy_sha256 then c.deny_new_authorizations
               else p.withdrawn_at is not null end,
        'approval', jsonb_build_object(
          'policy', jsonb_build_object('version', p.version, 'sha256', p.sha256),
          'mechanicsApprovedAt', floor(extract(epoch from p.mechanics_approved_at)),
          'benchmarkApprovedAt', floor(extract(epoch from p.benchmark_approved_at)),
          'withdrawnAt', floor(extract(epoch from p.withdrawn_at)),
          'denyNewAuthorizations',
            case when p.sha256 = c.active_policy_sha256 then c.deny_new_authorizations
                 else p.withdrawn_at is not null end))
      from api_private.analysis_release_policies p
      cross join api_private.analysis_release_control c
      where c.singleton
        and p_policy_sha256 ~ '^[0-9a-f]{64}$'
        and p.sha256 = p_policy_sha256
    ),
    jsonb_build_object(
      'document', null, 'canonicalDocument', null,
      'denyNewAuthorizations', true, 'approval', null)
  )
$$;

comment on function public.read_analysis_release_policy_lineage(text) is
  'The installed analysis release policy with this digest — active or superseded — in the shape of read_analysis_release_policy() (document, canonicalDocument, denyNewAuthorizations, approval incl. withdrawnAt), so the edge can verify the release binding of a grant whose receipt arrives after the active policy rotated. Unknown digest: the nothing-installed row. Service role only; read only.';

revoke all on function public.read_analysis_release_policy_lineage(text) from public, anon, authenticated, service_role;
grant execute on function public.read_analysis_release_policy_lineage(text) to service_role;
notify pgrst, 'reload schema';
