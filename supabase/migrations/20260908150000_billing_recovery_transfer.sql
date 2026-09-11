-- W07-03: durable billing transfer queue + source/destination verification
-- barrier. A RevenueCat TRANSFER moves a store account's purchases from one
-- app user id to another. The Edge webhook re-verifies both sides against the
-- provider; this migration makes that reconciliation durable and ordered:
--   * the transfer is queued (api_private.billing_transfers) under the webhook
--     delivery lease before any side is verified, so a crash mid-flight leaves
--     a recoverable record instead of a half-applied transfer;
--   * a SOURCE verdict is applied as soon as the provider reports it (the
--     source loses entitlement immediately), independently of whether any
--     destination can be applied yet;
--   * a DESTINATION is barred from GAINING premium through ANY verdict path
--     (its own sync, another webhook, the transfer's own ticket) while it is
--     an unapplied destination of any unsettled transfer whose sources are not
--     yet provider-confirmed or authoritatively absent from Auth. The verdict
--     is recorded on every such side and released by the barrier once the
--     last source is confirmed: a source confirmed inactive lets the transfer
--     confirm; a source the provider still reports entitled parks the
--     transfer as `held` (the event is stale or the store account was moved
--     back), and both accounts then mirror exactly what the provider
--     confirmed for each of them. Only the provider's answer per account is
--     ever applied, so a held transfer never withholds a destination's own
--     purchase, an applied destination side is never barred again, and two
--     accounts that transfer to each other are never both locked out. Nothing
--     is fabricated in either direction and the webhook stays retryable;
--   * every transition is written to an append-only audit ledger;
--   * all three tables are reachable only through the service-role RPCs the
--     Edge API calls (RLS enabled, zero grants, zero client policies).
-- Existing verification/audit RPCs keep their signatures:
-- public.begin_billing_verification queues TRANSFER events and
-- public.persist_billing_verdict reconciles against the queue, so the
-- shipping Edge path (begin -> persist -> complete) needs no new call.
begin;

create table api_private.billing_transfers (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  payload_hash bytea not null,
  source_user_ids uuid[] not null,
  destination_user_ids uuid[] not null,
  state text not null default 'pending' check (state in ('pending', 'held', 'confirmed')),
  enqueued_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  check (cardinality(source_user_ids) + cardinality(destination_user_ids) between 1 and 16),
  check ((settled_at is null) = (state <> 'confirmed'))
);
create table api_private.billing_transfer_sides (
  transfer_id uuid not null references api_private.billing_transfers (id),
  user_id uuid not null,
  role text not null check (role in ('source', 'destination')),
  ticket_id uuid,
  verification_order bigint,
  verdict jsonb,
  verified_at timestamptz,
  applied_at timestamptz,
  user_missing_at timestamptz,
  primary key (transfer_id, user_id),
  check ((verdict is null) = (ticket_id is null) and (verdict is null) = (verification_order is null)
    and (verdict is null) = (verified_at is null)),
  check (applied_at is null or verdict is not null)
);
create index billing_transfer_sides_user_idx on api_private.billing_transfer_sides (user_id);
create table api_private.billing_transfer_audit (
  id bigint generated always as identity primary key,
  transfer_id uuid not null references api_private.billing_transfers (id),
  event_id text not null,
  user_id uuid,
  action text not null check (action in (
    'enqueued', 'source_missing', 'destination_missing', 'source_verified', 'destination_verified',
    'destination_withheld', 'destination_deferred', 'destination_applied', 'held', 'confirmed')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  recorded_at timestamptz not null default clock_timestamp()
);
create index billing_transfer_audit_transfer_idx on api_private.billing_transfer_audit (transfer_id, id);
alter table api_private.billing_transfers enable row level security;
alter table api_private.billing_transfer_sides enable row level security;
alter table api_private.billing_transfer_audit enable row level security;
revoke all on api_private.billing_transfers, api_private.billing_transfer_sides, api_private.billing_transfer_audit
  from public, anon, authenticated, service_role;
revoke all on sequence api_private.billing_transfer_audit_id_seq from public, anon, authenticated, service_role;

create function api_private.guard_billing_transfer_history()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') or tg_table_name = 'billing_transfer_audit' then
    raise exception 'Billing transfer history is append-only' using errcode = 'insufficient_privilege';
  end if;
  if tg_table_name = 'billing_transfers' then
    if (new.id, new.event_id, new.payload_hash, new.source_user_ids, new.destination_user_ids, new.enqueued_at)
         is distinct from (old.id, old.event_id, old.payload_hash, old.source_user_ids, old.destination_user_ids, old.enqueued_at)
       or (old.state = 'confirmed' and (new.state, new.settled_at) is distinct from (old.state, old.settled_at)) then
      raise exception 'Invalid billing transfer transition' using errcode = 'check_violation';
    end if;
  else
    if (new.transfer_id, new.user_id, new.role) is distinct from (old.transfer_id, old.user_id, old.role)
       or (old.user_missing_at is not null and new.user_missing_at is distinct from old.user_missing_at)
       or (old.applied_at is not null
           and (new.applied_at, new.ticket_id, new.verification_order, new.verdict, new.verified_at)
             is distinct from (old.applied_at, old.ticket_id, old.verification_order, old.verdict, old.verified_at))
       or (old.verification_order is not null
           and (new.verification_order is null or new.verification_order < old.verification_order)) then
      raise exception 'Invalid billing transfer side transition' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function api_private.guard_billing_transfer_history()
  from public, anon, authenticated, service_role;
create trigger billing_transfers_guard_history
  before update or delete on api_private.billing_transfers
  for each row execute function api_private.guard_billing_transfer_history();
create trigger billing_transfer_sides_guard_history
  before update or delete on api_private.billing_transfer_sides
  for each row execute function api_private.guard_billing_transfer_history();
create trigger billing_transfer_audit_append_only
  before update or delete on api_private.billing_transfer_audit
  for each row execute function api_private.guard_billing_transfer_history();
create trigger billing_transfers_guard_truncate
  before truncate on api_private.billing_transfers
  for each statement execute function api_private.guard_billing_transfer_history();
create trigger billing_transfer_sides_guard_truncate
  before truncate on api_private.billing_transfer_sides
  for each statement execute function api_private.guard_billing_transfer_history();
create trigger billing_transfer_audit_guard_truncate
  before truncate on api_private.billing_transfer_audit
  for each statement execute function api_private.guard_billing_transfer_history();

create function api_private.billing_transfer_party_ids(p_payload jsonb, p_field text)
returns uuid[]
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_value jsonb;
  v_ids uuid[] := '{}';
  v_uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_payload->'event'->p_field) = 'array' then
    for v_value in select value from jsonb_array_elements(p_payload->'event'->p_field) loop
      if jsonb_typeof(v_value) = 'string' and v_value #>> '{}' ~* v_uuid_pattern
         and not (v_value #>> '{}')::uuid = any(v_ids) then
        v_ids := array_append(v_ids, (v_value #>> '{}')::uuid);
      end if;
    end loop;
  end if;
  return v_ids;
end;
$$;
revoke all on function api_private.billing_transfer_party_ids(jsonb, text)
  from public, anon, authenticated, service_role;

create function api_private.billing_verdict_active(p_verdict jsonb, p_at timestamptz)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select (p_verdict->>'premium')::boolean
    and (p_verdict->>'expiresAt' is null or (p_verdict->>'expiresAt')::timestamptz > p_at)
$$;
revoke all on function api_private.billing_verdict_active(jsonb, timestamptz)
  from public, anon, authenticated, service_role;

create function api_private.note_billing_transfer(
  p_transfer api_private.billing_transfers, p_user_id uuid, p_action text, p_detail jsonb default '{}'::jsonb
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into api_private.billing_transfer_audit (transfer_id, event_id, user_id, action, detail)
  values ((p_transfer).id, (p_transfer).event_id, p_user_id, p_action, coalesce(p_detail, '{}'::jsonb))
$$;
revoke all on function api_private.note_billing_transfer(api_private.billing_transfers, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create function api_private.billing_transfer_summary(p_transfer api_private.billing_transfers)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'transfer_id', (p_transfer).id,
    'event_id', (p_transfer).event_id,
    'state', (p_transfer).state,
    'enqueued_at', (p_transfer).enqueued_at,
    'settled_at', (p_transfer).settled_at,
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', s.user_id, 'verified', s.verdict is not null,
        'active', s.verdict is not null and api_private.billing_verdict_active(s.verdict, clock_timestamp()),
        'missing', s.user_missing_at is not null) order by s.user_id)
      from api_private.billing_transfer_sides s
      where s.transfer_id = (p_transfer).id and s.role = 'source'), '[]'::jsonb),
    'destinations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', s.user_id, 'verified', s.verdict is not null, 'applied', s.applied_at is not null,
        'missing', s.user_missing_at is not null) order by s.user_id)
      from api_private.billing_transfer_sides s
      where s.transfer_id = (p_transfer).id and s.role = 'destination'), '[]'::jsonb)
  )
$$;
revoke all on function api_private.billing_transfer_summary(api_private.billing_transfers)
  from public, anon, authenticated, service_role;

-- Locks every unsettled transfer a verdict for this user can touch, in id
-- order: the user's own transfers plus the transfers of every destination
-- they share one with (a source verdict releases those destinations, whose
-- barrier spans all of their transfers). Concurrent persistence for any two
-- parties therefore takes the same rows in the same order.
create function api_private.lock_billing_transfers(p_user_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from api_private.billing_transfers t
    where t.state <> 'confirmed' and (
      exists (select 1 from api_private.billing_transfer_sides s
        where s.transfer_id = t.id and s.user_id = p_user_id)
      or exists (
        select 1 from api_private.billing_transfer_sides d
        join api_private.billing_transfer_sides o on o.user_id = d.user_id and o.role = 'destination'
        join api_private.billing_transfers ot on ot.id = o.transfer_id and ot.state <> 'confirmed'
        join api_private.billing_transfer_sides me on me.transfer_id = ot.id and me.user_id = p_user_id
        where d.transfer_id = t.id and d.role = 'destination'))
    order by t.id for update;
end;
$$;
revoke all on function api_private.lock_billing_transfers(uuid)
  from public, anon, authenticated, service_role;

-- Re-examines every source side of one transfer against the provider verdict
-- it holds AND against Auth (a source deleted after its verdict was recorded
-- is authoritatively absent, whatever the stale verdict says). Returns
-- 'pending' while a source lacks a verdict, 'held' when a present source still
-- holds the entitlement, otherwise 'clear'; the transfer state follows.
create function api_private.reconcile_billing_transfer_sources(p_transfer_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_transfer api_private.billing_transfers%rowtype;
  v_side api_private.billing_transfer_sides%rowtype;
  v_now timestamptz := clock_timestamp();
  v_unresolved boolean := false;
  v_retained boolean := false;
begin
  select * into strict v_transfer from api_private.billing_transfers where id = p_transfer_id for update;
  if v_transfer.state = 'confirmed' then
    return 'clear';
  end if;
  for v_side in
    select * from api_private.billing_transfer_sides
    where transfer_id = p_transfer_id and role = 'source' and user_missing_at is null
    order by user_id for update
  loop
    perform 1 from auth.users where id = v_side.user_id for key share;
    if not found then
      update api_private.billing_transfer_sides set user_missing_at = v_now
        where transfer_id = p_transfer_id and user_id = v_side.user_id;
      perform api_private.note_billing_transfer(v_transfer, v_side.user_id, 'source_missing',
        jsonb_build_object('verified', v_side.verdict is not null));
    elsif v_side.verdict is null then
      v_unresolved := true;
    elsif api_private.billing_verdict_active(v_side.verdict, v_now) then
      v_retained := true;
    end if;
  end loop;
  if v_unresolved then
    if v_transfer.state <> 'pending' then
      update api_private.billing_transfers set state = 'pending' where id = p_transfer_id;
    end if;
    return 'pending';
  end if;
  if v_retained then
    if v_transfer.state <> 'held' then
      update api_private.billing_transfers set state = 'held' where id = p_transfer_id returning * into v_transfer;
      perform api_private.note_billing_transfer(v_transfer, null, 'held');
    end if;
    return 'held';
  end if;
  return 'clear';
end;
$$;
revoke all on function api_private.reconcile_billing_transfer_sources(uuid)
  from public, anon, authenticated, service_role;

-- The user-wide barrier: the oldest unsettled transfer in which the user is a
-- not-yet-applied destination and some present source has no provider verdict
-- yet. Null when nothing bars the destination from gaining: every source is
-- provider-confirmed (entitled or not) or absent, or the user's side of every
-- open transfer has already been applied.
create function api_private.billing_destination_blocker(p_user_id uuid)
returns api_private.billing_transfers
language sql
stable
security invoker
set search_path = ''
as $$
  select t.* from api_private.billing_transfers t
  join api_private.billing_transfer_sides d on d.transfer_id = t.id and d.user_id = p_user_id and d.role = 'destination'
  where t.state <> 'confirmed' and d.applied_at is null and exists (
    select 1 from api_private.billing_transfer_sides s
    where s.transfer_id = t.id and s.role = 'source' and s.user_missing_at is null and s.verdict is null)
  order by t.enqueued_at, t.id
  limit 1
$$;
revoke all on function api_private.billing_destination_blocker(uuid)
  from public, anon, authenticated, service_role;

-- Applies a destination side's recorded provider verdict through the same
-- ordered upsert every verdict uses; a newer stored verdict wins as usual.
-- Returns the number of entitlement rows changed, or null when the side could
-- not be applied: the destination is authoritatively absent from Auth (the
-- side is marked missing) or its profile row is unavailable (the side stays
-- open and is retried by the next reconciliation). Never raises for the
-- destination's state, so a source loss settling in the same transaction is
-- never rolled back by it.
create function api_private.apply_billing_transfer_side(
  p_transfer api_private.billing_transfers, p_side api_private.billing_transfer_sides
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_entitlements text[];
  v_changed integer;
  v_now timestamptz := clock_timestamp();
begin
  perform 1 from auth.users where id = (p_side).user_id for key share;
  if not found then
    update api_private.billing_transfer_sides set user_missing_at = v_now
      where transfer_id = (p_side).transfer_id and user_id = (p_side).user_id;
    perform api_private.note_billing_transfer(p_transfer, (p_side).user_id, 'destination_missing');
    return null;
  end if;
  perform 1 from public.profiles where id = (p_side).user_id for key share;
  if not found then
    perform api_private.note_billing_transfer(p_transfer, (p_side).user_id, 'destination_deferred',
      jsonb_build_object('reason', 'profile_unavailable', 'verification_order', (p_side).verification_order));
    return null;
  end if;
  select coalesce(array_agg(distinct value order by value), '{}'::text[]) into v_entitlements
    from jsonb_array_elements_text((p_side).verdict->'activeEntitlements');
  insert into public.billing_entitlements
    (user_id, premium, product_key, expires_at, verified_at, verification_order, active_entitlements)
  values
    ((p_side).user_id, ((p_side).verdict->>'premium')::boolean, (p_side).verdict->>'productKey',
     ((p_side).verdict->>'expiresAt')::timestamptz, (p_side).verified_at, (p_side).verification_order,
     v_entitlements)
  on conflict (user_id) do update set
    premium = excluded.premium,
    product_key = excluded.product_key,
    expires_at = excluded.expires_at,
    verified_at = greatest(public.billing_entitlements.verified_at, excluded.verified_at),
    verification_order = excluded.verification_order,
    active_entitlements = excluded.active_entitlements
  where public.billing_entitlements.verification_order < excluded.verification_order;
  get diagnostics v_changed = row_count;
  update api_private.billing_transfer_sides set applied_at = v_now
    where transfer_id = (p_side).transfer_id and user_id = (p_side).user_id;
  perform api_private.note_billing_transfer(p_transfer, (p_side).user_id, 'destination_applied',
    jsonb_build_object('applied', v_changed > 0, 'verification_order', (p_side).verification_order,
      'active', api_private.billing_verdict_active((p_side).verdict, v_now)));
  return v_changed;
end;
$$;
revoke all on function api_private.apply_billing_transfer_side(api_private.billing_transfers, api_private.billing_transfer_sides)
  from public, anon, authenticated, service_role;

-- The barrier for one transfer. Destinations are released only once every
-- source of THIS transfer is provider-confirmed or authoritatively absent from
-- Auth AND no other unsettled transfer still bars the destination; each
-- released destination then mirrors its own provider verdict. When every
-- source is confirmed as no longer entitled the transfer confirms once all
-- destinations are applied; a source that still holds the entitlement parks
-- the transfer as `held` until a later verdict says otherwise. A destination
-- released here may complete other transfers it belongs to, so those are
-- reconciled in turn.
create function api_private.settle_billing_transfer(p_transfer_id uuid)
returns api_private.billing_transfers
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_transfer api_private.billing_transfers%rowtype;
  v_side api_private.billing_transfer_sides%rowtype;
  v_now timestamptz := clock_timestamp();
  v_sources text;
  v_unresolved boolean := false;
  v_released uuid[] := '{}';
  v_user_id uuid;
begin
  select * into strict v_transfer from api_private.billing_transfers where id = p_transfer_id for update;
  if v_transfer.state = 'confirmed' then
    return v_transfer;
  end if;
  v_sources := api_private.reconcile_billing_transfer_sources(p_transfer_id);
  if v_sources = 'pending' then
    select * into strict v_transfer from api_private.billing_transfers where id = p_transfer_id;
    return v_transfer;
  end if;
  select * into strict v_transfer from api_private.billing_transfers where id = p_transfer_id;
  for v_side in
    select * from api_private.billing_transfer_sides
    where transfer_id = p_transfer_id and role = 'destination'
      and user_missing_at is null and applied_at is null
    order by user_id for update
  loop
    if v_side.verdict is null then
      perform 1 from auth.users where id = v_side.user_id for key share;
      if found then
        v_unresolved := true;
      else
        update api_private.billing_transfer_sides set user_missing_at = v_now
          where transfer_id = p_transfer_id and user_id = v_side.user_id;
        perform api_private.note_billing_transfer(v_transfer, v_side.user_id, 'destination_missing');
      end if;
    elsif (api_private.billing_destination_blocker(v_side.user_id)).id is not null then
      v_unresolved := true;
    else
      perform api_private.apply_billing_transfer_side(v_transfer, v_side);
      select * into strict v_side from api_private.billing_transfer_sides
        where transfer_id = p_transfer_id and user_id = v_side.user_id;
      if v_side.applied_at is not null then
        v_released := array_append(v_released, v_side.user_id);
      elsif v_side.user_missing_at is null then
        v_unresolved := true;
      end if;
    end if;
  end loop;
  if v_sources = 'clear' then
    if not v_unresolved then
      update api_private.billing_transfers set state = 'confirmed', settled_at = v_now
        where id = p_transfer_id returning * into v_transfer;
      perform api_private.note_billing_transfer(v_transfer, null, 'confirmed');
    elsif v_transfer.state <> 'pending' then
      update api_private.billing_transfers set state = 'pending' where id = p_transfer_id;
    end if;
  end if;
  foreach v_user_id in array v_released loop
    perform api_private.reconcile_billing_destination(v_user_id);
  end loop;
  select * into strict v_transfer from api_private.billing_transfers where id = p_transfer_id;
  return v_transfer;
end;
$$;
revoke all on function api_private.settle_billing_transfer(uuid)
  from public, anon, authenticated, service_role;

-- Reconciles every unsettled transfer in which the user is a destination:
-- first every source side of every such transfer is re-examined (so the
-- user-wide barrier judges fresh Auth/provider state), then each transfer is
-- settled. Idempotent; re-entered safely from settle_billing_transfer.
create function api_private.reconcile_billing_destination(p_user_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_transfer_id uuid;
  v_transfer_ids uuid[];
begin
  select coalesce(array_agg(t.id order by t.enqueued_at, t.id), '{}'::uuid[]) into v_transfer_ids
    from api_private.billing_transfers t
    join api_private.billing_transfer_sides d on d.transfer_id = t.id and d.user_id = p_user_id and d.role = 'destination'
    where t.state <> 'confirmed';
  foreach v_transfer_id in array v_transfer_ids loop
    perform api_private.reconcile_billing_transfer_sources(v_transfer_id);
  end loop;
  foreach v_transfer_id in array v_transfer_ids loop
    perform api_private.settle_billing_transfer(v_transfer_id);
  end loop;
end;
$$;
revoke all on function api_private.reconcile_billing_destination(uuid)
  from public, anon, authenticated, service_role;

-- Queues a TRANSFER webhook under its delivery lease. Idempotent per event;
-- the payload is bound through the same claim hash the verification tickets
-- use, so a different payload for the same event id cannot re-scope it.
-- Party lists that are not arrays, anonymous ids and ids listed on both sides
-- contribute no queued side (those subjects verify directly, exactly as the
-- webhook verified them before the queue existed); a delivery is never
-- poisoned by its shape.
create function public.enqueue_billing_transfer(p_event_id text, p_payload jsonb, p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event jsonb := p_payload->'event';
  v_sources uuid[];
  v_destinations uuid[];
  v_both uuid[];
  v_claim api_private.billing_webhook_claims%rowtype;
  v_transfer api_private.billing_transfers%rowtype;
  v_user_id uuid;
  v_user_exists boolean;
  v_now timestamptz;
begin
  if p_event_id is null or jsonb_typeof(p_payload) is distinct from 'object'
     or jsonb_typeof(v_event) is distinct from 'object'
     or v_event->>'type' is distinct from 'TRANSFER'
     or (jsonb_typeof(v_event->'id') = 'string' and v_event->>'id' <> p_event_id) then
    raise exception 'Invalid billing transfer event' using errcode = '22023';
  end if;
  v_sources := api_private.billing_transfer_party_ids(p_payload, 'transferred_from');
  v_destinations := api_private.billing_transfer_party_ids(p_payload, 'transferred_to');
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_both
    from unnest(v_sources) id where id = any(v_destinations);
  select coalesce(array_agg(id order by ordinality), '{}'::uuid[]) into v_sources
    from unnest(v_sources) with ordinality as parties(id, ordinality) where not id = any(v_both);
  select coalesce(array_agg(id order by ordinality), '{}'::uuid[]) into v_destinations
    from unnest(v_destinations) with ordinality as parties(id, ordinality) where not id = any(v_both);
  if cardinality(v_sources) + cardinality(v_destinations) > 16 then
    raise exception 'Too many webhook subjects' using errcode = '22023';
  end if;
  if api_private.claim_billing_webhook(p_event_id, p_payload) then
    return jsonb_build_object('outcome', 'duplicate', 'event_id', p_event_id);
  end if;
  select * into v_claim from api_private.billing_webhook_claims where event_id = p_event_id for update;
  if not found or p_lease_token is null or v_claim.lease_token is distinct from p_lease_token
     or v_claim.lease_expires_at is null or v_claim.lease_expires_at <= clock_timestamp() then
    raise exception 'Stale webhook transfer lease' using errcode = '55000';
  end if;
  if cardinality(v_sources) + cardinality(v_destinations) = 0 then
    return jsonb_build_object('outcome', 'no_subjects', 'event_id', p_event_id);
  end if;
  select * into v_transfer from api_private.billing_transfers where event_id = p_event_id for update;
  if found then
    if v_transfer.payload_hash <> v_claim.payload_hash then
      raise exception 'Conflicting billing transfer payload' using errcode = '22023';
    end if;
  else
    v_now := clock_timestamp();
    insert into api_private.billing_transfers (event_id, payload_hash, source_user_ids, destination_user_ids)
      values (p_event_id, v_claim.payload_hash, v_sources, v_destinations) returning * into v_transfer;
    perform api_private.note_billing_transfer(v_transfer, null, 'enqueued',
      jsonb_build_object('sources', to_jsonb(v_sources), 'destinations', to_jsonb(v_destinations),
        'direct', to_jsonb(v_both)));
    foreach v_user_id in array v_sources || v_destinations loop
      perform 1 from auth.users where id = v_user_id for key share;
      v_user_exists := found;
      insert into api_private.billing_transfer_sides (transfer_id, user_id, role, user_missing_at)
        values (v_transfer.id, v_user_id,
          case when v_user_id = any(v_sources) then 'source' else 'destination' end,
          case when v_user_exists then null else v_now end);
      if not v_user_exists then
        perform api_private.note_billing_transfer(v_transfer, v_user_id,
          case when v_user_id = any(v_sources) then 'source_missing' else 'destination_missing' end);
      end if;
    end loop;
  end if;
  foreach v_user_id in array v_transfer.destination_user_ids loop
    perform api_private.lock_billing_transfers(v_user_id);
  end loop;
  v_transfer := api_private.settle_billing_transfer(v_transfer.id);
  foreach v_user_id in array v_transfer.destination_user_ids loop
    perform api_private.reconcile_billing_destination(v_user_id);
  end loop;
  select * into strict v_transfer from api_private.billing_transfers where id = v_transfer.id;
  return api_private.billing_transfer_summary(v_transfer) || jsonb_build_object('outcome', 'queued');
end;
$$;
revoke all on function public.enqueue_billing_transfer(text, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_billing_transfer(text, jsonb, uuid) to service_role;

-- Recovery queue view for the reconciliation routes: every transfer that has
-- not settled and involves the user, oldest first.
create function public.billing_transfer_recovery(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'Invalid billing transfer subject' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(api_private.billing_transfer_summary(t) order by t.enqueued_at, t.id)
    from api_private.billing_transfers t
    where t.state <> 'confirmed' and exists (
      select 1 from api_private.billing_transfer_sides s
      where s.transfer_id = t.id and s.user_id = p_user_id)
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.billing_transfer_recovery(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.billing_transfer_recovery(uuid) to service_role;

-- Same contract as before; issuing verification for a TRANSFER webhook event
-- also queues the transfer under the same lease, so the shipping edge path
-- (begin -> persist -> complete) reconciles both sides with no extra call.
create or replace function public.begin_billing_verification(
  p_user_ids uuid[], p_event_id text default null, p_payload jsonb default null,
  p_lease_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_claim api_private.billing_webhook_claims%rowtype;
begin
  if p_event_id is null and p_lease_token is not null then
    raise exception 'Invalid sync verification lease' using errcode = '22023';
  end if;
  v_result := api_private.begin_billing_verification(p_user_ids, p_event_id, p_payload);
  if p_event_id is not null and v_result->>'outcome' is distinct from 'duplicate' then
    select * into v_claim from api_private.billing_webhook_claims where event_id = p_event_id for update;
    if not found or p_lease_token is null or v_claim.lease_token is distinct from p_lease_token
      or v_claim.lease_expires_at is null or v_claim.lease_expires_at <= clock_timestamp() then
      raise exception 'Stale webhook verification lease' using errcode = '55000';
    end if;
    update api_private.billing_verification_tickets set webhook_lease_token = p_lease_token
      where id in (select (item->>'ticket_id')::uuid from jsonb_array_elements(v_result) item
        where item->>'outcome' = 'issued');
    if p_payload->'event'->>'type' = 'TRANSFER' then
      perform public.enqueue_billing_transfer(p_event_id, p_payload, p_lease_token);
    end if;
  end if;
  return v_result;
end;
$$;
revoke all on function public.begin_billing_verification(uuid[], text, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_billing_verification(uuid[], text, jsonb, uuid) to service_role;

-- Same contract as before; additionally reconciles queued transfers. Every
-- verdict is recorded on the user's open queue sides. A source verdict is
-- applied immediately and settles its transfers (destination application is
-- best effort and never rolls the source loss back). A destination that any
-- unsettled transfer still bars from gaining (an unapplied side whose source
-- is not yet provider-confirmed) has an ACTIVE verdict recorded but not
-- applied, whatever ticket carried it: the response then says applied=false,
-- withheld=true with the stored (non-premium) snapshot, so the webhook cannot
-- complete and the provider redelivers; the barrier applies the recorded
-- verdict once the last source is confirmed. An inactive verdict has nothing
-- to gain and applies as usual.
create or replace function public.persist_billing_verdict(p_user_id uuid, p_ticket_id uuid, p_verdict jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket api_private.billing_verification_tickets%rowtype;
  v_billing public.billing_entitlements%rowtype;
  v_transfer api_private.billing_transfers%rowtype;
  v_side api_private.billing_transfer_sides%rowtype;
  v_expires_at timestamptz;
  v_reported_at timestamptz;
  v_entitlements text[];
  v_premium boolean;
  v_now timestamptz;
  v_changed integer := 0;
  v_withheld boolean := false;
  v_recorded boolean := false;
  v_is_destination boolean := false;
  v_source_transfers uuid[] := '{}';
  v_transfer_id uuid;
  v_snapshot jsonb;
begin
  if p_user_id is null or p_ticket_id is null
     or jsonb_typeof(p_verdict) is distinct from 'object'
     or p_verdict - array['premium','productKey','expiresAt','activeEntitlements','verifiedAt'] <> '{}'::jsonb
     or jsonb_typeof(p_verdict->'premium') is distinct from 'boolean'
     or coalesce(jsonb_typeof(p_verdict->'productKey'), '') not in ('string','null')
     or coalesce(jsonb_typeof(p_verdict->'expiresAt'), '') not in ('string','null')
     or jsonb_typeof(p_verdict->'activeEntitlements') is distinct from 'array'
     or (p_verdict ? 'verifiedAt' and jsonb_typeof(p_verdict->'verifiedAt') is distinct from 'string') then
    raise exception 'Invalid verified billing verdict' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_verdict->'activeEntitlements') item
    where jsonb_typeof(item) <> 'string' or item #>> '{}' not in ('pickle_sensei_pro','premium')) then
    raise exception 'Invalid verified entitlements' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct value order by value), '{}'::text[]) into v_entitlements
    from jsonb_array_elements_text(p_verdict->'activeEntitlements');
  v_premium := (p_verdict->>'premium')::boolean;
  v_expires_at := (p_verdict->>'expiresAt')::timestamptz;
  v_reported_at := (p_verdict->>'verifiedAt')::timestamptz;
  if v_premium <> (cardinality(v_entitlements) > 0)
     or (v_expires_at is not null and not isfinite(v_expires_at))
     or (v_reported_at is not null and not isfinite(v_reported_at))
     or (not v_premium and (v_expires_at is not null or p_verdict->>'productKey' is not null)) then
    raise exception 'Inconsistent verified billing verdict' using errcode = '22023';
  end if;
  select * into v_ticket from api_private.billing_verification_tickets
    where id = p_ticket_id and user_id = p_user_id;
  if found and v_ticket.event_id is not null then
    perform 1 from api_private.billing_webhook_claims
      where event_id = v_ticket.event_id and lease_token = v_ticket.webhook_lease_token
        and lease_expires_at > clock_timestamp() for share;
    if not found then
      raise exception 'Stale webhook verification lease' using errcode = '55000';
    end if;
  end if;
  perform 1 from auth.users where id = p_user_id for key share;
  if not found then
    return jsonb_build_object('outcome', 'user_missing', 'user_id', p_user_id);
  end if;
  select * into v_ticket from api_private.billing_verification_tickets
    where id = p_ticket_id and user_id = p_user_id for update;
  if not found then
    raise exception 'Invalid verification ticket binding' using errcode = '22023';
  end if;
  if v_ticket.verdict is not null and v_ticket.verdict <> p_verdict then
    raise exception 'Conflicting verification ticket verdict' using errcode = '22023';
  end if;
  perform 1 from public.profiles where id = p_user_id for key share;
  if not found then
    raise exception 'Billing profile is unavailable' using errcode = '23503';
  end if;
  if v_reported_at < v_ticket.issued_at - interval '24 hours'
    or v_reported_at > v_ticket.issued_at + interval '5 minutes' then
    v_reported_at := v_ticket.issued_at;
  end if;
  if v_ticket.verdict is null then
    update api_private.billing_verification_tickets
      set verdict = p_verdict, verified_at = coalesce(v_reported_at, clock_timestamp())
      where id = p_ticket_id returning * into v_ticket;
  end if;
  v_now := clock_timestamp();
  -- Queued transfers this verdict can reach are locked in a fixed order before
  -- any entitlement write so concurrent source/destination persistence cannot
  -- deadlock.
  perform api_private.lock_billing_transfers(p_user_id);
  for v_side in
    select s.* from api_private.billing_transfer_sides s
    join api_private.billing_transfers t on t.id = s.transfer_id
    where s.user_id = p_user_id and t.state <> 'confirmed' and s.applied_at is null
      and (s.verification_order is null or s.verification_order < v_ticket.verification_order)
    order by t.enqueued_at, t.id for update of s
  loop
    select * into strict v_transfer from api_private.billing_transfers where id = v_side.transfer_id;
    update api_private.billing_transfer_sides
      set ticket_id = v_ticket.id, verification_order = v_ticket.verification_order,
          verdict = p_verdict, verified_at = v_ticket.verified_at
      where transfer_id = v_side.transfer_id and user_id = p_user_id;
    perform api_private.note_billing_transfer(v_transfer, p_user_id,
      case when v_side.role = 'source' then 'source_verified' else 'destination_verified' end,
      jsonb_build_object('verification_order', v_ticket.verification_order,
        'direct', v_ticket.event_id is distinct from v_transfer.event_id
          or v_ticket.payload_hash is distinct from v_transfer.payload_hash,
        'active', api_private.billing_verdict_active(p_verdict, v_now)));
    if v_side.role = 'destination' then
      v_recorded := true;
    end if;
  end loop;
  select coalesce(array_agg(t.id order by t.enqueued_at, t.id), '{}'::uuid[]) into v_source_transfers
    from api_private.billing_transfers t
    join api_private.billing_transfer_sides s on s.transfer_id = t.id and s.user_id = p_user_id and s.role = 'source'
    where t.state <> 'confirmed';
  v_is_destination := exists (
    select 1 from api_private.billing_transfer_sides s
    join api_private.billing_transfers t on t.id = s.transfer_id
    where s.user_id = p_user_id and s.role = 'destination' and t.state <> 'confirmed');
  if v_is_destination then
    perform api_private.reconcile_billing_destination(p_user_id);
    v_transfer := api_private.billing_destination_blocker(p_user_id);
    if v_transfer.id is not null and api_private.billing_verdict_active(p_verdict, v_now) then
      v_withheld := true;
      if v_recorded then
        for v_side in
          select s.* from api_private.billing_transfer_sides s
          join api_private.billing_transfers t on t.id = s.transfer_id
          where s.user_id = p_user_id and s.role = 'destination' and t.state <> 'confirmed'
            and s.applied_at is null and s.verification_order = v_ticket.verification_order
          order by t.enqueued_at, t.id
        loop
          perform api_private.note_billing_transfer(
            (select t from api_private.billing_transfers t where t.id = v_side.transfer_id), p_user_id,
            'destination_withheld',
            jsonb_build_object('verification_order', v_ticket.verification_order, 'state', v_transfer.state,
              'blocked_by', v_transfer.id));
        end loop;
      end if;
    end if;
  end if;
  if not v_withheld then
    insert into public.billing_entitlements
      (user_id, premium, product_key, expires_at, verified_at, verification_order, active_entitlements)
    values
      (p_user_id, v_premium, p_verdict->>'productKey', v_expires_at, v_ticket.verified_at,
       v_ticket.verification_order, v_entitlements)
    on conflict (user_id) do update set
      premium = excluded.premium,
      product_key = excluded.product_key,
      expires_at = excluded.expires_at,
      verified_at = greatest(public.billing_entitlements.verified_at, excluded.verified_at),
      verification_order = excluded.verification_order,
      active_entitlements = excluded.active_entitlements
    where public.billing_entitlements.verification_order < excluded.verification_order;
    get diagnostics v_changed = row_count;
    if v_changed = 0 and v_recorded and exists (select 1 from public.billing_entitlements
        where user_id = p_user_id and verification_order = v_ticket.verification_order) then
      v_changed := 1;
    end if;
  end if;
  -- The source's loss above is durable regardless of what follows: settling
  -- its transfers releases destinations where possible and otherwise leaves
  -- them recoverable.
  foreach v_transfer_id in array v_source_transfers loop
    perform api_private.settle_billing_transfer(v_transfer_id);
  end loop;
  select * into v_billing from public.billing_entitlements where user_id = p_user_id for share;
  if not found then
    if not v_withheld then
      raise exception 'Billing entitlement row is unavailable' using errcode = 'no_data_found';
    end if;
    v_snapshot := jsonb_build_object(
      'premium', false, 'productKey', null, 'expiresAt', null,
      'verifiedAt', v_ticket.verified_at, 'activeEntitlements', '[]'::jsonb);
  else
    v_premium := v_billing.premium and (v_billing.expires_at is null or v_billing.expires_at > clock_timestamp());
    v_snapshot := jsonb_build_object(
      'premium', v_premium,
      'productKey', case when v_premium then v_billing.product_key else null end,
      'expiresAt', case when v_premium then v_billing.expires_at else null end,
      'verifiedAt', v_billing.verified_at,
      'activeEntitlements', case when v_premium then v_billing.active_entitlements else '{}'::text[] end);
  end if;
  return jsonb_build_object(
    'outcome', 'persisted', 'user_id', p_user_id, 'applied', v_changed > 0 and not v_withheld,
    'withheld', v_withheld, 'billing', v_snapshot
  ) || case when v_withheld
    then jsonb_build_object('transfer', jsonb_build_object(
      'transfer_id', v_transfer.id, 'event_id', v_transfer.event_id, 'state', v_transfer.state))
    else '{}'::jsonb end;
end;
$$;
revoke all on function public.persist_billing_verdict(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.persist_billing_verdict(uuid, uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
