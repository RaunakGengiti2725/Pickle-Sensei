-- W08 local, unapplied migration. The 24-hour capability and 7-day operation
-- retention are DRAFT policy, not legal approval or authorization to deploy.
-- Coordinate a cutover: drain legacy deletion/Apple credential writers, apply
-- schema, reload PostgREST, deploy matching Edge, then resume traffic. Never
-- restore retired service credential DML grants to make an old Edge work.

create table api_private.account_deletion_operations (
  id uuid primary key,
  owner_id uuid not null,
  challenge_hash bytea not null check (octet_length(challenge_hash) = 32),
  status_capability_hash bytea check (octet_length(status_capability_hash) = 32),
  created_at timestamptz not null,
  challenge_expires_at timestamptz not null,
  status_expires_at timestamptz not null,
  retain_until timestamptz not null,
  phase text not null default 'requested'
    check (phase in ('requested', 'confirmed', 'external_complete', 'auth_delete_intent', 'completed', 'superseded')),
  confirmed_at timestamptz,
  superseded_at timestamptz,
  apple_required boolean not null default false,
  apple_outcome text check (apple_outcome in ('revoked', 'not_applicable', 'manual_action_required')),
  apple_completed_at timestamptz,
  revenuecat_completed_at timestamptz,
  external_completed_at timestamptz,
  auth_delete_intent_at timestamptz,
  auth_deleted_at timestamptz,
  completed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 8),
  last_error_code text check (last_error_code in (
    'apple_cleanup_unavailable', 'revenuecat_cleanup_unavailable', 'checkpoint_unavailable',
    'auth_delete_unavailable', 'completion_unverified', 'auth_absent_without_ready_intent'
  )),
  unique (owner_id, challenge_hash),
  check (isfinite(created_at) and isfinite(challenge_expires_at)),
  check (challenge_expires_at > created_at and challenge_expires_at <= created_at + interval '15 minutes'),
  check (status_expires_at = created_at + interval '24 hours'),
  check (retain_until = created_at + interval '7 days'),
  check ((lease_token is null) = (lease_expires_at is null)),
  check (lease_expires_at is null or (confirmed_at is not null and lease_expires_at <= status_expires_at)),
  check ((apple_completed_at is null) = (apple_outcome is null)),
  check (apple_completed_at is null or confirmed_at is not null),
  check (revenuecat_completed_at is null or apple_completed_at is not null),
  check (external_completed_at is null or (apple_completed_at is not null and revenuecat_completed_at is not null)),
  check (auth_delete_intent_at is null or external_completed_at is not null),
  check ((completed_at is null) = (phase <> 'completed')),
  check (completed_at is null or (confirmed_at is not null and external_completed_at is not null
    and auth_delete_intent_at is not null and auth_deleted_at is not null)),
  check ((superseded_at is null) = (phase <> 'superseded')),
  check (superseded_at is null or confirmed_at is null),
  check (phase not in ('confirmed', 'external_complete', 'auth_delete_intent', 'completed') or confirmed_at is not null),
  check (phase not in ('external_complete', 'auth_delete_intent', 'completed') or external_completed_at is not null),
  check (phase not in ('auth_delete_intent', 'completed') or auth_delete_intent_at is not null)
);

create unique index account_deletion_one_current_owner
  on api_private.account_deletion_operations (owner_id) where phase <> 'superseded';
create index account_deletion_retention_idx
  on api_private.account_deletion_operations (retain_until);
alter table api_private.account_deletion_operations enable row level security;
revoke all on api_private.account_deletion_operations from public, anon, authenticated, service_role;

create function api_private.account_deletion_view(p_operation api_private.account_deletion_operations)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'state', case
      when p_operation.completed_at is not null then 'completed'
      when p_operation.phase = 'superseded' then 'superseded'
      when p_operation.auth_deleted_at is not null then 'blocked'
      when p_operation.confirmed_at is null and p_operation.challenge_expires_at <= clock_timestamp() then 'expired'
      when p_operation.confirmed_at is null then 'pending'
      when p_operation.status_expires_at <= clock_timestamp()
        or (p_operation.attempts >= 8 and coalesce(p_operation.lease_expires_at, '-infinity') <= clock_timestamp()) then 'blocked'
      else 'in_progress'
    end,
    'completionReceipt', case when p_operation.completed_at is not null
      then jsonb_build_object('completedAt', p_operation.completed_at) else null end,
    'appleAuthorizationRevocation', case when p_operation.completed_at is not null
      then p_operation.apple_outcome else null end
  )
$$;
revoke all on function api_private.account_deletion_view(api_private.account_deletion_operations)
  from public, anon, authenticated, service_role;

create function public.begin_account_deletion_operation(
  p_owner_id uuid, p_operation_id uuid, p_challenge_hash bytea, p_status_capability_hash bytea
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_now timestamptz;
begin
  if p_owner_id is null or p_operation_id is null or p_challenge_hash is null
     or octet_length(p_challenge_hash) <> 32 or p_status_capability_hash is null
     or octet_length(p_status_capability_hash) <> 32 then
    raise exception 'Invalid deletion operation request' using errcode = '22023';
  end if;
  perform 1 from auth.users where id = p_owner_id for key share;
  if not found then return jsonb_build_object('outcome', 'user_missing'); end if;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || p_owner_id::text, 0));
  if exists (select 1 from api_private.account_deletion_operations
    where owner_id = p_owner_id and confirmed_at is not null) then
    return jsonb_build_object('outcome', 'confirmation_in_progress');
  end if;
  v_now := clock_timestamp();
  update api_private.account_deletion_operations set phase = 'superseded', superseded_at = v_now
    where owner_id = p_owner_id and phase = 'requested' and confirmed_at is null;
  insert into api_private.account_deletion_operations (
    id, owner_id, challenge_hash, status_capability_hash, created_at,
    challenge_expires_at, status_expires_at, retain_until
  ) values (
    p_operation_id, p_owner_id, p_challenge_hash, p_status_capability_hash, v_now,
    v_now + interval '15 minutes', v_now + interval '24 hours', v_now + interval '7 days'
  );
  return jsonb_build_object('outcome', 'requested', 'operationId', p_operation_id,
    'expiresAt', v_now + interval '15 minutes', 'statusExpiresAt', v_now + interval '24 hours');
end;
$$;
revoke all on function public.begin_account_deletion_operation(uuid, uuid, bytea, bytea)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_account_deletion_operation(uuid, uuid, bytea, bytea) to service_role;

create function api_private.acquire_account_deletion_lease(p_owner_id uuid, p_operation_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_operation api_private.account_deletion_operations%rowtype;
  v_external public.account_external_credentials%rowtype;
  v_now timestamptz := clock_timestamp();
  v_apple_action text;
begin
  select * into v_operation from api_private.account_deletion_operations
    where id = p_operation_id and owner_id = p_owner_id for update;
  if not found or v_operation.confirmed_at is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if v_operation.completed_at is not null then
    return jsonb_build_object('outcome', 'completed', 'operationId', v_operation.id,
      'status', api_private.account_deletion_view(v_operation));
  end if;
  if v_operation.auth_deleted_at is not null or not exists (select 1 from auth.users where id = p_owner_id) then
    return jsonb_build_object('outcome', 'blocked');
  end if;
  if v_operation.lease_expires_at > v_now then
    return jsonb_build_object('outcome', 'busy', 'operationId', v_operation.id);
  end if;
  if v_operation.attempts >= 8 or v_operation.status_expires_at <= v_now then
    return jsonb_build_object('outcome', 'blocked');
  end if;
  update api_private.account_deletion_operations
    set lease_token = gen_random_uuid(),
      lease_expires_at = least(v_now + interval '120 seconds', status_expires_at),
      attempts = attempts + 1, last_error_code = null
    where id = v_operation.id returning * into v_operation;
  select * into v_external from public.account_external_credentials where user_id = p_owner_id;
  v_apple_action := case
    when v_operation.apple_outcome is not null then v_operation.apple_outcome
    when v_external.apple_revoked_at is not null then 'revoked'
    when v_external.apple_refresh_token_encrypted is not null then 'revoke'
    when v_operation.apple_required then 'manual_action_required'
    else 'not_applicable'
  end;
  return jsonb_build_object('outcome', 'claimed', 'operationId', v_operation.id,
    'leaseToken', v_operation.lease_token, 'leaseExpiresAt', v_operation.lease_expires_at,
    'confirmedAt', v_operation.confirmed_at,
    'appleCompleted', v_operation.apple_completed_at is not null,
    'appleAction', v_apple_action,
    'appleRefreshTokenEncrypted', case when v_apple_action = 'revoke'
      then v_external.apple_refresh_token_encrypted else null end,
    'revenueCatCompleted', v_operation.revenuecat_completed_at is not null,
    'revenueCatAlreadyDeleted', v_external.revenuecat_deleted_at is not null);
end;
$$;
revoke all on function api_private.acquire_account_deletion_lease(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.confirm_account_deletion_operation(
  p_owner_id uuid, p_challenge_hash bytea, p_operation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation api_private.account_deletion_operations%rowtype;
  v_legacy public.account_deletion_requests%rowtype;
  v_now timestamptz;
  v_user_exists boolean;
  v_apple_required boolean;
begin
  if p_owner_id is null or p_challenge_hash is null or octet_length(p_challenge_hash) <> 32 then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  perform 1 from auth.users where id = p_owner_id for key share;
  v_user_exists := found;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || p_owner_id::text, 0));
  select * into v_operation from api_private.account_deletion_operations
    where owner_id = p_owner_id and challenge_hash = p_challenge_hash
      and (p_operation_id is null or id = p_operation_id) for update;
  if not found then
    if p_operation_id is not null or not v_user_exists or exists (
      select 1 from api_private.account_deletion_operations
      where owner_id = p_owner_id and phase <> 'superseded'
    ) then
      return jsonb_build_object('outcome', 'invalid');
    end if;
    select * into v_legacy from public.account_deletion_requests
      where user_id = p_owner_id and sha256(convert_to(
        'pickle-sensei/account-deletion/challenge/v1/' || p_owner_id::text || '/' || challenge::text, 'UTF8'
      )) = p_challenge_hash for update;
    if not found then return jsonb_build_object('outcome', 'invalid'); end if;
    v_now := clock_timestamp();
    if not isfinite(v_legacy.created_at) or not isfinite(v_legacy.expires_at)
       or least(v_legacy.expires_at, v_legacy.created_at + interval '15 minutes') <= v_now then
      return jsonb_build_object('outcome', 'expired');
    end if;
    if v_legacy.created_at > v_now - interval '3 seconds' then
      return jsonb_build_object('outcome', 'too_fast');
    end if;
    insert into api_private.account_deletion_operations (
      id, owner_id, challenge_hash, created_at, challenge_expires_at, status_expires_at, retain_until
    ) values (
      gen_random_uuid(), p_owner_id, p_challenge_hash, v_legacy.created_at,
      least(v_legacy.expires_at, v_legacy.created_at + interval '15 minutes'),
      v_legacy.created_at + interval '24 hours', v_legacy.created_at + interval '7 days'
    ) returning * into v_operation;
  end if;
  if v_operation.phase = 'superseded' then return jsonb_build_object('outcome', 'invalid'); end if;
  if v_operation.confirmed_at is null then
    if not v_user_exists or v_operation.auth_deleted_at is not null then
      return jsonb_build_object('outcome', 'invalid');
    end if;
    v_now := clock_timestamp();
    if v_operation.challenge_expires_at <= v_now then return jsonb_build_object('outcome', 'expired'); end if;
    if v_operation.created_at > v_now - interval '3 seconds' then return jsonb_build_object('outcome', 'too_fast'); end if;
    select exists (select 1 from auth.identities where user_id = p_owner_id and provider = 'apple')
      or exists (select 1 from public.profiles where id = p_owner_id and provider = 'apple')
      or exists (select 1 from auth.users where id = p_owner_id and raw_app_meta_data->>'provider' = 'apple')
      or exists (select 1 from public.account_external_credentials where user_id = p_owner_id
        and (apple_refresh_token_encrypted is not null or apple_revoked_at is not null))
      into v_apple_required;
    update api_private.account_deletion_operations
      set phase = 'confirmed', confirmed_at = v_now, apple_required = v_apple_required
      where id = v_operation.id;
  end if;
  return api_private.acquire_account_deletion_lease(p_owner_id, v_operation.id);
end;
$$;
revoke all on function public.confirm_account_deletion_operation(uuid, bytea, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_account_deletion_operation(uuid, bytea, uuid) to service_role;

create function public.claim_account_deletion_work(p_owner_id uuid, p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null or p_operation_id is null then return jsonb_build_object('outcome', 'invalid'); end if;
  perform 1 from auth.users where id = p_owner_id for key share;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || p_owner_id::text, 0));
  return api_private.acquire_account_deletion_lease(p_owner_id, p_operation_id);
end;
$$;
revoke all on function public.claim_account_deletion_work(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_account_deletion_work(uuid, uuid) to service_role;

create function api_private.lock_account_deletion_lease(p_owner_id uuid, p_operation_id uuid, p_lease_token uuid)
returns api_private.account_deletion_operations
language plpgsql
security invoker
set search_path = ''
as $$
declare v_operation api_private.account_deletion_operations%rowtype;
begin
  perform 1 from auth.users where id = p_owner_id for key share;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || p_owner_id::text, 0));
  select * into v_operation from api_private.account_deletion_operations
    where id = p_operation_id and owner_id = p_owner_id for update;
  if not found or p_lease_token is null or v_operation.lease_token is distinct from p_lease_token
    or v_operation.lease_expires_at <= clock_timestamp() or v_operation.confirmed_at is null
    or v_operation.completed_at is not null or v_operation.auth_deleted_at is not null then
    return null;
  end if;
  return v_operation;
end;
$$;
revoke all on function api_private.lock_account_deletion_lease(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

revoke insert, update, delete on public.account_external_credentials from public, anon, authenticated, service_role;
revoke update (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at,
  revenuecat_deleted_at, created_at, updated_at)
  on public.account_external_credentials from public, anon, authenticated, service_role;
grant select on public.account_external_credentials to service_role;

create function public.checkpoint_account_deletion_operation(
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

create function public.set_account_deletion_auth_intent(p_owner_id uuid, p_operation_id uuid, p_lease_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_operation api_private.account_deletion_operations%rowtype;
begin
  v_operation := api_private.lock_account_deletion_lease(p_owner_id, p_operation_id, p_lease_token);
  if v_operation.id is null then return jsonb_build_object('outcome', 'stale_lease'); end if;
  if v_operation.external_completed_at is null or v_operation.apple_completed_at is null
    or v_operation.revenuecat_completed_at is null then
    raise exception 'External cleanup must precede Auth deletion' using errcode = '55000';
  end if;
  update api_private.account_deletion_operations
    set phase = 'auth_delete_intent', auth_delete_intent_at = coalesce(auth_delete_intent_at, clock_timestamp())
    where id = p_operation_id;
  return jsonb_build_object('outcome', 'intent_recorded');
end;
$$;
revoke all on function public.set_account_deletion_auth_intent(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_account_deletion_auth_intent(uuid, uuid, uuid) to service_role;

create function public.fail_account_deletion_operation(
  p_owner_id uuid, p_operation_id uuid, p_lease_token uuid, p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_operation api_private.account_deletion_operations%rowtype;
begin
  if p_error_code is null or p_error_code not in (
    'apple_cleanup_unavailable', 'revenuecat_cleanup_unavailable', 'checkpoint_unavailable',
    'auth_delete_unavailable', 'completion_unverified'
  ) then raise exception 'Invalid deletion error code' using errcode = '22023'; end if;
  v_operation := api_private.lock_account_deletion_lease(p_owner_id, p_operation_id, p_lease_token);
  if v_operation.id is null then return jsonb_build_object('outcome', 'stale_lease'); end if;
  update api_private.account_deletion_operations
    set last_error_code = p_error_code, lease_token = null, lease_expires_at = null where id = p_operation_id;
  return jsonb_build_object('outcome', 'released');
end;
$$;
revoke all on function public.fail_account_deletion_operation(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_account_deletion_operation(uuid, uuid, uuid, text) to service_role;

create function api_private.record_account_deletion_auth_absence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_now timestamptz := clock_timestamp();
begin
  if tg_table_schema <> 'auth' or tg_table_name <> 'users' or tg_op <> 'DELETE'
    or tg_when <> 'AFTER' or tg_level <> 'ROW' then
    raise exception 'Invalid deletion receipt trigger context' using errcode = '42501';
  end if;
  if exists (select 1 from auth.users where id = old.id) then
    raise exception 'Auth user absence is required' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || old.id::text, 0));
  update api_private.account_deletion_operations
    set auth_deleted_at = v_now,
      completed_at = case when confirmed_at is not null and apple_completed_at is not null
        and revenuecat_completed_at is not null and external_completed_at is not null
        and auth_delete_intent_at is not null and phase = 'auth_delete_intent' then v_now else null end,
      phase = case when confirmed_at is not null and apple_completed_at is not null
        and revenuecat_completed_at is not null and external_completed_at is not null
        and auth_delete_intent_at is not null and phase = 'auth_delete_intent' then 'completed' else phase end,
      last_error_code = case when confirmed_at is not null and apple_completed_at is not null
        and revenuecat_completed_at is not null and external_completed_at is not null
        and auth_delete_intent_at is not null and phase = 'auth_delete_intent'
        then null else 'auth_absent_without_ready_intent' end,
      lease_token = null, lease_expires_at = null
    where owner_id = old.id and auth_deleted_at is null;
  return old;
end;
$$;
revoke all on function api_private.record_account_deletion_auth_absence()
  from public, anon, authenticated, service_role;
create trigger account_deletion_auth_absence
  after delete on auth.users for each row execute function api_private.record_account_deletion_auth_absence();

create function public.read_account_deletion_status(p_operation_id uuid, p_status_capability_hash bytea)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select api_private.account_deletion_view(o) from api_private.account_deletion_operations o
    where o.id = p_operation_id and o.status_capability_hash = p_status_capability_hash
      and o.status_expires_at > clock_timestamp() and o.retain_until > clock_timestamp()
$$;
revoke all on function public.read_account_deletion_status(uuid, bytea)
  from public, anon, authenticated, service_role;
grant execute on function public.read_account_deletion_status(uuid, bytea) to service_role;

create function public.read_account_deletion_receipt(p_owner_id uuid, p_operation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select api_private.account_deletion_view(o) from api_private.account_deletion_operations o
    where o.id = p_operation_id and o.owner_id = p_owner_id and o.retain_until > clock_timestamp()
$$;
revoke all on function public.read_account_deletion_receipt(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_account_deletion_receipt(uuid, uuid) to service_role;

create function public.account_deletion_allows_apple_bootstrap(p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users where id = p_owner_id)
    and not exists (select 1 from api_private.account_deletion_operations
      where owner_id = p_owner_id and confirmed_at is not null)
$$;
revoke all on function public.account_deletion_allows_apple_bootstrap(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.account_deletion_allows_apple_bootstrap(uuid) to service_role;

create function public.store_account_apple_credential(p_owner_id uuid, p_encrypted_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_now timestamptz;
begin
  if p_owner_id is null or p_encrypted_token is null or length(p_encrypted_token) not between 20 and 8192
    or p_encrypted_token !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then
    raise exception 'Invalid encrypted credential' using errcode = '22023';
  end if;
  perform 1 from auth.users where id = p_owner_id for key share;
  if not found then return jsonb_build_object('outcome', 'user_missing'); end if;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || p_owner_id::text, 0));
  if exists (select 1 from api_private.account_deletion_operations
    where owner_id = p_owner_id and confirmed_at is not null) then
    return jsonb_build_object('outcome', 'confirmation_in_progress');
  end if;
  v_now := clock_timestamp();
  insert into public.account_external_credentials (
    user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at
  ) values (p_owner_id, p_encrypted_token, v_now, null, v_now)
    on conflict (user_id) do update set
      apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
      apple_token_captured_at = excluded.apple_token_captured_at,
      apple_revoked_at = null, updated_at = excluded.updated_at;
  return jsonb_build_object('outcome', 'stored');
end;
$$;
revoke all on function public.store_account_apple_credential(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.store_account_apple_credential(uuid, text) to service_role;

create function public.purge_account_deletion_operations(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid deletion retention batch' using errcode = '22023';
  end if;
  delete from api_private.account_deletion_operations where id in (
    select id from api_private.account_deletion_operations
      where retain_until <= clock_timestamp()
        and coalesce(lease_expires_at, '-infinity') <= clock_timestamp()
      order by retain_until, id limit p_limit for update skip locked
  );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.purge_account_deletion_operations(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.purge_account_deletion_operations(integer) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-account-deletion-operations', '*/15 * * * *',
      'select public.purge_account_deletion_operations(500)');
  end if;
end;
$$;

notify pgrst, 'reload schema';
