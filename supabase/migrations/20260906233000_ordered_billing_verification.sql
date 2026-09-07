-- W07: deploy only in an approved coordinated billing cutover. Drain legacy
-- Edge writers before applying this migration, then deploy the ticket-aware
-- Edge code and reload PostgREST before resuming traffic. Legacy direct writes
-- intentionally fail closed; re-granting them would bypass verification order.
-- Existing billing values, lifetime spent counts and audit markers are untouched.
-- Historically poisoned audit markers require approved operational reconciliation.

create table api_private.billing_webhook_claims (
  event_id text primary key,
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  claimed_at timestamptz not null default clock_timestamp()
);
alter table api_private.billing_webhook_claims enable row level security;
revoke all on api_private.billing_webhook_claims
  from public, anon, authenticated, service_role;

create sequence api_private.billing_verification_order_seq as bigint;
revoke all on sequence api_private.billing_verification_order_seq
  from public, anon, authenticated, service_role;

create table api_private.billing_verification_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  verification_order bigint not null check (verification_order > 0),
  issued_at timestamptz not null default clock_timestamp(),
  event_id text,
  payload_hash bytea,
  verdict jsonb,
  verified_at timestamptz,
  unique (user_id, verification_order),
  check ((event_id is null) = (payload_hash is null)),
  check (payload_hash is null or octet_length(payload_hash) = 32),
  check ((verdict is null) = (verified_at is null))
);
alter table api_private.billing_verification_tickets enable row level security;
revoke all on api_private.billing_verification_tickets
  from public, anon, authenticated, service_role;

alter table public.billing_entitlements
  add column verification_order bigint not null default 0 check (verification_order >= 0),
  add column active_entitlements text[] not null default '{}';

revoke all on public.billing_entitlements, public.webhook_events
  from public, anon, service_role;
revoke insert, update, delete, truncate, references, trigger on public.billing_entitlements
  from authenticated;
revoke all on public.webhook_events from authenticated;
grant select on public.billing_entitlements, public.webhook_events to service_role;

create function api_private.billing_webhook_subjects(p_payload jsonb)
returns uuid[]
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_event jsonb := p_payload->'event';
  v_value jsonb;
  v_field text;
  v_subjects uuid[] := '{}';
  v_uuid_pattern text := '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_payload) is distinct from 'object'
     or jsonb_typeof(v_event) is distinct from 'object' then
    raise exception 'Invalid webhook payload' using errcode = '22023';
  end if;
  if jsonb_typeof(v_event->'app_user_id') = 'string'
     and v_event->>'app_user_id' ~* v_uuid_pattern then
    v_subjects := array_append(v_subjects, (v_event->>'app_user_id')::uuid);
  elsif jsonb_typeof(v_event->'aliases') = 'array' then
    for v_value in select value from jsonb_array_elements(v_event->'aliases') loop
      if jsonb_typeof(v_value) = 'string' and v_value #>> '{}' ~* v_uuid_pattern then
        v_subjects := array_append(v_subjects, (v_value #>> '{}')::uuid);
        exit;
      end if;
    end loop;
  end if;
  foreach v_field in array array['transferred_from','transferred_to'] loop
    if jsonb_typeof(v_event->v_field) = 'array' then
      for v_value in select value from jsonb_array_elements(v_event->v_field) loop
        if jsonb_typeof(v_value) = 'string' and v_value #>> '{}' ~* v_uuid_pattern
           and not (v_value #>> '{}')::uuid = any(v_subjects) then
          v_subjects := array_append(v_subjects, (v_value #>> '{}')::uuid);
        end if;
      end loop;
    end if;
  end loop;
  if cardinality(v_subjects) > 16 then
    raise exception 'Too many webhook subjects' using errcode = '22023';
  end if;
  return v_subjects;
end;
$$;
revoke all on function api_private.billing_webhook_subjects(jsonb)
  from public, anon, authenticated, service_role;

-- Serialize admission with completion, without holding a DB transaction open
-- across provider I/O. Identical in-flight deliveries may obtain fresh tickets;
-- a different payload/scope for the same event cannot reach provider verification.
-- A claim is NOT a completion marker and never suppresses a retry on its own.
create function api_private.claim_billing_webhook(p_event_id text, p_payload jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_hash bytea := sha256(convert_to(p_payload::text, 'UTF8'));
  v_claimed_hash bytea;
  v_seen jsonb;
begin
  insert into api_private.billing_webhook_claims (event_id, payload_hash)
    values (p_event_id, v_hash) on conflict (event_id) do nothing;
  select payload_hash into strict v_claimed_hash from api_private.billing_webhook_claims
    where event_id = p_event_id for update;
  if v_claimed_hash is distinct from v_hash then
    raise exception 'Conflicting webhook verification payload' using errcode = '22023';
  end if;
  select payload into v_seen from public.webhook_events where id = p_event_id;
  if found then
    if v_seen is distinct from p_payload then
      raise exception 'Conflicting webhook completion payload' using errcode = '22023';
    end if;
    return true;
  end if;
  return false;
end;
$$;
revoke all on function api_private.claim_billing_webhook(text, jsonb)
  from public, anon, authenticated, service_role;

create function public.begin_billing_verification(
  p_user_ids uuid[], p_event_id text default null, p_payload jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subjects uuid[];
  v_expected uuid[];
  v_user_id uuid;
  v_ticket_id uuid;
  v_order bigint;
  v_hash bytea;
  v_result jsonb := '[]';
begin
  select coalesce(array_agg(distinct id order by id), '{}'::uuid[]) into v_subjects
    from unnest(p_user_ids) id;
  if p_user_ids is null or array_position(p_user_ids, null) is not null
     or cardinality(p_user_ids) <> cardinality(v_subjects) or cardinality(v_subjects) > 16 then
    raise exception 'Invalid verification subjects' using errcode = '22023';
  end if;
  if p_event_id is null then
    if p_payload is not null or cardinality(v_subjects) <> 1 then
      raise exception 'Invalid sync verification request' using errcode = '22023';
    end if;
  else
    select coalesce(array_agg(id order by id), '{}'::uuid[]) into v_expected
      from unnest(api_private.billing_webhook_subjects(p_payload)) id;
    if v_subjects <> v_expected
       or (jsonb_typeof(p_payload->'event'->'id') = 'string'
           and p_payload->'event'->>'id' <> p_event_id) then
      raise exception 'Webhook verification binding mismatch' using errcode = '22023';
    end if;
    if api_private.claim_billing_webhook(p_event_id, p_payload) then
      return jsonb_build_object('outcome', 'duplicate', 'event_id', p_event_id);
    end if;
    v_hash := sha256(convert_to(p_payload::text, 'UTF8'));
  end if;
  v_order := nextval('api_private.billing_verification_order_seq'::regclass);
  foreach v_user_id in array v_subjects loop
    perform 1 from auth.users where id = v_user_id for key share;
    if not found then
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'user_id', v_user_id, 'outcome', 'user_missing'
      ));
      continue;
    end if;
    insert into api_private.billing_verification_tickets
      (user_id, verification_order, event_id, payload_hash)
    values (v_user_id, v_order, p_event_id, v_hash)
    returning id into v_ticket_id;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'user_id', v_user_id, 'outcome', 'issued', 'ticket_id', v_ticket_id
    ));
  end loop;
  return v_result;
end;
$$;
revoke all on function public.begin_billing_verification(uuid[], text, jsonb)
  from public, anon, authenticated;
grant execute on function public.begin_billing_verification(uuid[], text, jsonb) to service_role;

create function public.persist_billing_verdict(p_user_id uuid, p_ticket_id uuid, p_verdict jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket api_private.billing_verification_tickets%rowtype;
  v_billing public.billing_entitlements%rowtype;
  v_expires_at timestamptz;
  v_entitlements text[];
  v_premium boolean;
  v_changed integer;
begin
  if p_user_id is null or p_ticket_id is null
     or jsonb_typeof(p_verdict) is distinct from 'object'
     or p_verdict - array['premium','productKey','expiresAt','activeEntitlements'] <> '{}'::jsonb
     or jsonb_typeof(p_verdict->'premium') is distinct from 'boolean'
     or coalesce(jsonb_typeof(p_verdict->'productKey'), '') not in ('string','null')
     or coalesce(jsonb_typeof(p_verdict->'expiresAt'), '') not in ('string','null')
     or jsonb_typeof(p_verdict->'activeEntitlements') is distinct from 'array' then
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
  if v_premium <> (cardinality(v_entitlements) > 0)
     or (v_expires_at is not null and not isfinite(v_expires_at))
     or (not v_premium and (v_expires_at is not null or p_verdict->>'productKey' is not null)) then
    raise exception 'Inconsistent verified billing verdict' using errcode = '22023';
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
  if v_ticket.verdict is null then
    update api_private.billing_verification_tickets
      set verdict = p_verdict, verified_at = clock_timestamp()
      where id = p_ticket_id returning * into v_ticket;
  end if;
  insert into public.billing_entitlements
    (user_id, premium, product_key, expires_at, verified_at, verification_order, active_entitlements)
  values
    (p_user_id, v_premium, p_verdict->>'productKey', v_expires_at, v_ticket.verified_at,
     v_ticket.verification_order, v_entitlements)
  on conflict (user_id) do update set
    premium = excluded.premium,
    product_key = excluded.product_key,
    expires_at = excluded.expires_at,
    verified_at = excluded.verified_at,
    verification_order = excluded.verification_order,
    active_entitlements = excluded.active_entitlements
  where public.billing_entitlements.verification_order < excluded.verification_order;
  get diagnostics v_changed = row_count;
  select * into strict v_billing from public.billing_entitlements where user_id = p_user_id for share;
  v_premium := v_billing.premium and (v_billing.expires_at is null or v_billing.expires_at > clock_timestamp());
  return jsonb_build_object(
    'outcome', 'persisted', 'user_id', p_user_id, 'applied', v_changed > 0,
    'billing', jsonb_build_object(
      'premium', v_premium,
      'productKey', case when v_premium then v_billing.product_key else null end,
      'expiresAt', case when v_premium then v_billing.expires_at else null end,
      'verifiedAt', v_billing.verified_at,
      'activeEntitlements', case when v_premium then v_billing.active_entitlements else '{}'::text[] end
    )
  );
end;
$$;
revoke all on function public.persist_billing_verdict(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.persist_billing_verdict(uuid, uuid, jsonb) to service_role;

create function public.complete_billing_webhook(p_event_id text, p_payload jsonb, p_tickets jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subjects uuid[] := api_private.billing_webhook_subjects(p_payload);
  v_user_id uuid;
  v_ticket api_private.billing_verification_tickets%rowtype;
  v_hash bytea := sha256(convert_to(p_payload::text, 'UTF8'));
  v_seen jsonb;
  v_verified boolean := cardinality(v_subjects) > 0;
begin
  if p_event_id is null or jsonb_typeof(p_tickets) is distinct from 'object'
     or (jsonb_typeof(p_payload->'event'->'id') = 'string'
         and p_payload->'event'->>'id' <> p_event_id)
     or exists (select 1 from jsonb_object_keys(p_tickets) key where not key = any(v_subjects::text[])) then
    raise exception 'Invalid webhook completion binding' using errcode = '22023';
  end if;
  if api_private.claim_billing_webhook(p_event_id, p_payload) then
    return jsonb_build_object('received', true, 'duplicate', true);
  end if;
  for v_user_id in select id from unnest(v_subjects) id order by id loop
    perform 1 from auth.users where id = v_user_id for key share;
    if not found then
      v_verified := false;
      continue;
    end if;
    select * into v_ticket from api_private.billing_verification_tickets
      where id = (p_tickets->>v_user_id::text)::uuid and user_id = v_user_id
        and event_id = p_event_id and payload_hash = v_hash for share;
    if not found or v_ticket.verdict is null then
      raise exception 'Webhook verification is incomplete' using errcode = '55000';
    end if;
    perform 1 from public.billing_entitlements
      where user_id = v_user_id and verification_order >= v_ticket.verification_order for share;
    if not found then
      raise exception 'Webhook persistence is incomplete' using errcode = '55000';
    end if;
  end loop;
  insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
  values (
    p_event_id, 'revenuecat',
    case when jsonb_typeof(p_payload->'event'->'type') = 'string' then p_payload->'event'->>'type' else 'unknown' end,
    v_subjects[1]::text, p_payload
  ) on conflict (id) do nothing;
  select payload into strict v_seen from public.webhook_events where id = p_event_id;
  if v_seen <> p_payload then
    raise exception 'Conflicting webhook completion payload' using errcode = '22023';
  end if;
  return jsonb_build_object('received', true, 'verified', v_verified);
end;
$$;
revoke all on function public.complete_billing_webhook(text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_billing_webhook(text, jsonb, jsonb) to service_role;

notify pgrst, 'reload schema';
