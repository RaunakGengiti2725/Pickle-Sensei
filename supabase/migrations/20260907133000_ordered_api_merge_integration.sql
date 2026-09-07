revoke all on public.billing_entitlements, public.webhook_events, public.account_external_credentials
  from public, anon, service_role;
revoke insert, update, delete, truncate, references, trigger
  on public.billing_entitlements, public.webhook_events, public.account_external_credentials from authenticated;
revoke update (claimed_at, processed_at) on public.webhook_events from public, anon, authenticated, service_role;
revoke update (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at,
  revenuecat_deleted_at, created_at, updated_at)
  on public.account_external_credentials from public, anon, authenticated, service_role;
grant select on public.billing_entitlements, public.webhook_events, public.account_external_credentials to service_role;

alter table api_private.billing_webhook_claims
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add constraint billing_webhook_claim_lease_pair check ((lease_token is null) = (lease_expires_at is null));
revoke all on api_private.billing_webhook_claims from public, anon, authenticated, service_role;
alter table api_private.billing_verification_tickets add column webhook_lease_token uuid;
revoke all on api_private.billing_verification_tickets from public, anon, authenticated, service_role;

create or replace function public.billing_entitlements_keep_newest_verdict()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.verification_order < old.verification_order
    or (new.verification_order = old.verification_order and new.verified_at < old.verified_at) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.billing_entitlements_keep_newest_verdict()
  from public, anon, authenticated, service_role;

create or replace function api_private.claim_billing_webhook(p_event_id text, p_payload jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_hash bytea := sha256(convert_to(p_payload::text, 'UTF8'));
  v_claimed_hash bytea;
  v_seen public.webhook_events%rowtype;
begin
  if p_event_id is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Invalid webhook payload' using errcode = '22023';
  end if;
  insert into api_private.billing_webhook_claims (event_id, payload_hash)
    values (p_event_id, v_hash) on conflict (event_id) do nothing;
  select payload_hash into strict v_claimed_hash from api_private.billing_webhook_claims
    where event_id = p_event_id for update;
  if v_claimed_hash is distinct from v_hash then
    raise exception 'Conflicting webhook verification payload' using errcode = '22023';
  end if;
  select * into v_seen from public.webhook_events where id = p_event_id for update;
  if found then
    if v_seen.payload is distinct from p_payload or v_seen.provider <> 'revenuecat' then
      raise exception 'Conflicting webhook completion payload' using errcode = '22023';
    end if;
    return v_seen.processed_at is not null;
  end if;
  return false;
end;
$$;
revoke all on function api_private.claim_billing_webhook(text, jsonb)
  from public, anon, authenticated, service_role;

create function public.claim_billing_webhook_delivery(p_event_id text, p_payload jsonb, p_waiting boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subjects uuid[] := api_private.billing_webhook_subjects(p_payload);
  v_claim api_private.billing_webhook_claims%rowtype;
  v_seen public.webhook_events%rowtype;
  v_now timestamptz;
  v_token uuid;
begin
  if p_event_id is null or (jsonb_typeof(p_payload->'event'->'id') = 'string'
    and p_payload->'event'->>'id' <> p_event_id) then
    raise exception 'Invalid webhook delivery binding' using errcode = '22023';
  end if;
  if api_private.claim_billing_webhook(p_event_id, p_payload) then
    return jsonb_build_object('outcome', 'duplicate', 'event_id', p_event_id);
  end if;
  select * into strict v_claim from api_private.billing_webhook_claims
    where event_id = p_event_id for update;
  v_now := clock_timestamp();
  select * into v_seen from public.webhook_events where id = p_event_id for update;
  if v_claim.lease_expires_at > v_now or (found and v_claim.lease_token is null
    and v_seen.claimed_at > v_now - interval '5 minutes') then
    return jsonb_build_object('outcome', 'in_progress', 'event_id', p_event_id);
  end if;
  if p_waiting is distinct from false then
    return jsonb_build_object('outcome', 'released', 'event_id', p_event_id);
  end if;
  v_token := gen_random_uuid();
  insert into public.webhook_events (id, provider, event_type, app_user_id, payload, claimed_at, processed_at)
    values (p_event_id, 'revenuecat',
      case when jsonb_typeof(p_payload->'event'->'type') = 'string' then p_payload->'event'->>'type' else 'unknown' end,
      v_subjects[1]::text, p_payload, v_now, null)
    on conflict (id) do update set claimed_at = excluded.claimed_at
      where public.webhook_events.processed_at is null;
  update api_private.billing_webhook_claims
    set lease_token = v_token, lease_expires_at = v_now + interval '5 minutes'
    where event_id = p_event_id;
  return jsonb_build_object('outcome', 'claimed', 'event_id', p_event_id, 'lease_token', v_token);
end;
$$;
revoke all on function public.claim_billing_webhook_delivery(text, jsonb, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_billing_webhook_delivery(text, jsonb, boolean) to service_role;

create function public.release_billing_webhook_delivery(p_event_id text, p_payload jsonb, p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_claim api_private.billing_webhook_claims%rowtype;
begin
  select * into v_claim from api_private.billing_webhook_claims
    where event_id = p_event_id and payload_hash = sha256(convert_to(p_payload::text, 'UTF8')) for update;
  if not found or p_lease_token is null or v_claim.lease_token is distinct from p_lease_token then
    return jsonb_build_object('outcome', 'stale_lease');
  end if;
  update public.webhook_events set claimed_at = least(claimed_at, clock_timestamp() - interval '5 minutes')
    where id = p_event_id and processed_at is null;
  update api_private.billing_webhook_claims set lease_token = null, lease_expires_at = null
    where event_id = p_event_id;
  return jsonb_build_object('outcome', 'released');
end;
$$;
revoke all on function public.release_billing_webhook_delivery(text, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.release_billing_webhook_delivery(text, jsonb, uuid) to service_role;

alter function public.begin_billing_verification(uuid[], text, jsonb) set schema api_private;
revoke all on function api_private.begin_billing_verification(uuid[], text, jsonb)
  from public, anon, authenticated, service_role;

create function public.begin_billing_verification(
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
  end if;
  return v_result;
end;
$$;
revoke all on function public.begin_billing_verification(uuid[], text, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_billing_verification(uuid[], text, jsonb, uuid) to service_role;

create or replace function public.persist_billing_verdict(p_user_id uuid, p_ticket_id uuid, p_verdict jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket api_private.billing_verification_tickets%rowtype;
  v_billing public.billing_entitlements%rowtype;
  v_expires_at timestamptz;
  v_reported_at timestamptz;
  v_entitlements text[];
  v_premium boolean;
  v_changed integer;
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
  from public, anon, authenticated, service_role;
grant execute on function public.persist_billing_verdict(uuid, uuid, jsonb) to service_role;

create or replace function public.complete_billing_webhook(p_event_id text, p_payload jsonb, p_tickets jsonb)
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
  insert into public.webhook_events (id, provider, event_type, app_user_id, payload, processed_at)
  values (
    p_event_id, 'revenuecat',
    case when jsonb_typeof(p_payload->'event'->'type') = 'string' then p_payload->'event'->>'type' else 'unknown' end,
    v_subjects[1]::text, p_payload, clock_timestamp()
  ) on conflict (id) do update set processed_at = coalesce(public.webhook_events.processed_at, excluded.processed_at);
  select payload into strict v_seen from public.webhook_events where id = p_event_id;
  if v_seen <> p_payload then
    raise exception 'Conflicting webhook completion payload' using errcode = '22023';
  end if;
  update api_private.billing_webhook_claims set lease_token = null, lease_expires_at = null
    where event_id = p_event_id;
  return jsonb_build_object('received', true, 'verified', v_verified);
end;
$$;
revoke all on function public.complete_billing_webhook(text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
alter function public.complete_billing_webhook(text, jsonb, jsonb) set schema api_private;
revoke all on function api_private.complete_billing_webhook(text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create function public.complete_billing_webhook(
  p_event_id text, p_payload jsonb, p_tickets jsonb, p_lease_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_claim api_private.billing_webhook_claims%rowtype;
begin
  if api_private.claim_billing_webhook(p_event_id, p_payload) then
    return api_private.complete_billing_webhook(p_event_id, p_payload, p_tickets);
  end if;
  select * into v_claim from api_private.billing_webhook_claims where event_id = p_event_id for update;
  if not found or p_lease_token is null or v_claim.lease_token is distinct from p_lease_token
    or v_claim.lease_expires_at is null or v_claim.lease_expires_at <= clock_timestamp() then
    raise exception 'Stale webhook completion lease' using errcode = '55000';
  end if;
  if jsonb_typeof(p_tickets) is distinct from 'object' or exists (
    select 1 from jsonb_each_text(p_tickets) proof where not exists (
      select 1 from api_private.billing_verification_tickets ticket
      where ticket.id = proof.value::uuid and ticket.webhook_lease_token = p_lease_token
        and ticket.event_id = p_event_id
    )
  ) then
    raise exception 'Invalid webhook ticket lease' using errcode = '22023';
  end if;
  return api_private.complete_billing_webhook(p_event_id, p_payload, p_tickets);
end;
$$;
revoke all on function public.complete_billing_webhook(text, jsonb, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_billing_webhook(text, jsonb, jsonb, uuid) to service_role;

create or replace function public.checkpoint_account_deletion_operation(
  p_owner_id uuid, p_operation_id uuid, p_lease_token uuid, p_checkpoint text, p_apple_outcome text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation api_private.account_deletion_operations%rowtype;
  v_external public.account_external_credentials%rowtype;
  v_now timestamptz;
  v_expected_apple text;
begin
  v_operation := api_private.lock_account_deletion_lease(p_owner_id, p_operation_id, p_lease_token);
  if v_operation.id is null then return jsonb_build_object('outcome', 'stale_lease'); end if;
  v_now := clock_timestamp();
  if p_checkpoint = 'lease_check' and p_apple_outcome is null then
    return jsonb_build_object('outcome', 'checkpointed');
  elsif p_checkpoint = 'apple_unrevocable' and p_apple_outcome = 'manual_action_required' then
    select * into v_external from public.account_external_credentials where user_id = p_owner_id for update;
    if v_operation.apple_completed_at is not null or v_external.apple_refresh_token_encrypted is null
      or v_external.apple_revoked_at is not null then
      raise exception 'Invalid unrevocable Apple credential checkpoint' using errcode = '22023';
    end if;
    update public.account_external_credentials
      set apple_refresh_token_encrypted = null, apple_token_captured_at = null, updated_at = v_now
      where user_id = p_owner_id;
    update api_private.account_deletion_operations
      set apple_outcome = 'manual_action_required', apple_completed_at = v_now
      where id = p_operation_id;
  elsif p_checkpoint = 'apple' then
    select * into v_external from public.account_external_credentials where user_id = p_owner_id;
    v_expected_apple := coalesce(v_operation.apple_outcome, case
      when v_external.apple_revoked_at is not null or v_external.apple_refresh_token_encrypted is not null then 'revoked'
      when v_operation.apple_required then 'manual_action_required' else 'not_applicable' end);
    if p_apple_outcome is distinct from v_expected_apple then
      raise exception 'Invalid Apple cleanup checkpoint' using errcode = '22023';
    end if;
    if v_operation.apple_completed_at is null then
      if p_apple_outcome = 'revoked' then
        update public.account_external_credentials set apple_revoked_at = coalesce(apple_revoked_at, v_now), updated_at = v_now
          where user_id = p_owner_id;
      end if;
      update api_private.account_deletion_operations set apple_outcome = p_apple_outcome, apple_completed_at = v_now
        where id = p_operation_id;
    end if;
  elsif p_checkpoint = 'revenuecat' and p_apple_outcome is null then
    if v_operation.apple_completed_at is null then
      raise exception 'Apple cleanup checkpoint is required' using errcode = '55000';
    end if;
    if v_operation.revenuecat_completed_at is null then
      insert into public.account_external_credentials (user_id, revenuecat_deleted_at, updated_at)
        values (p_owner_id, v_now, v_now)
        on conflict (user_id) do update set
          revenuecat_deleted_at = coalesce(public.account_external_credentials.revenuecat_deleted_at, excluded.revenuecat_deleted_at),
          updated_at = excluded.updated_at;
      update api_private.account_deletion_operations set revenuecat_completed_at = v_now where id = p_operation_id;
    end if;
  elsif p_checkpoint = 'external_complete' and p_apple_outcome is null then
    if v_operation.apple_completed_at is null or v_operation.revenuecat_completed_at is null then
      raise exception 'External cleanup checkpoints are required' using errcode = '55000';
    end if;
    update api_private.account_deletion_operations
      set external_completed_at = coalesce(external_completed_at, v_now),
        phase = case when phase = 'confirmed' then 'external_complete' else phase end
      where id = p_operation_id;
  else
    raise exception 'Invalid deletion checkpoint' using errcode = '22023';
  end if;
  return jsonb_build_object('outcome', 'checkpointed');
end;
$$;
revoke all on function public.checkpoint_account_deletion_operation(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.checkpoint_account_deletion_operation(uuid, uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
