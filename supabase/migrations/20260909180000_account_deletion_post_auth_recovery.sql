-- W08-06: a CLEAN deletion stays certifiable after the Auth delete.
--
-- Before (20260909120000): the Auth-delete trigger retained the sweeping
-- worker's lease so that exactly one verdict could be recorded against it.
-- But nothing could ever re-acquire that phase: acquire_account_deletion_lease
-- answered `blocked` as soon as auth_deleted_at was set, the certification lock
-- rejected an expired lease, and fail_account_deletion_operation released the
-- lease on `completion_unverified`. One transient failure between the Auth
-- delete and certification (a lost receipt read, a paced 429 page, a worker
-- that died, a deleteUser response that never arrived) therefore left an
-- account that no longer exists permanently uncertifiable, while the status
-- view reported the live, in-flight sweep as `blocked`.
--
-- Now:
--   * api_private.account_deletion_view reports an operation whose Auth
--     identity is gone as `in_progress` while its ready certification phase is
--     still recoverable (no recorded verdict, retention and attempt budget
--     intact) and `blocked` only once a verdict was recorded, the attempt
--     budget is spent or the status window closed. The receipt still appears
--     only with completed_at.
--   * api_private.acquire_account_deletion_lease re-issues a lease for the
--     certification phase after the Auth delete: exact owner + operation
--     binding, Auth identity absent (a recreated identity under the same id
--     is refused), confirmed, every external checkpoint and the deletion
--     intent recorded, not completed/superseded, status window open, attempt
--     budget left, no live lease (`busy` while one is held). The claim carries
--     `authDeleted: true` so the worker runs only the sweep + certification;
--     nothing external is repeated.
--   * public.fail_account_deletion_operation may record
--     `auth_delete_unavailable` as well as `completion_unverified` against a
--     retained post-Auth lease (the deleteUser call landed but its response
--     was lost), so the worker fails closed and the phase is re-acquirable.
-- Certification is unchanged: service-only, serialized under the owner
-- advisory lock, spends the matching unexpired lease exactly once, refuses
-- forged/stale/cross-owner/cross-operation leases and a recreated identity.
-- The free-rating identity ledger is untouched by every path here.

create or replace function api_private.account_deletion_view(p_operation api_private.account_deletion_operations)
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
      when p_operation.auth_deleted_at is not null then
        case when p_operation.phase = 'auth_delete_intent' and p_operation.last_error_code is null
            and p_operation.status_expires_at > clock_timestamp()
            and (p_operation.attempts < 8 or coalesce(p_operation.lease_expires_at, '-infinity') > clock_timestamp())
          then 'in_progress' else 'blocked' end
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

create or replace function api_private.acquire_account_deletion_lease(p_owner_id uuid, p_operation_id uuid)
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
  v_auth_present boolean;
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
  v_auth_present := exists (select 1 from auth.users where id = p_owner_id);
  if v_operation.auth_deleted_at is not null or not v_auth_present then
    -- Only the certification phase survives the Auth delete: the identity is
    -- gone (and has not been recreated), every external step and the deletion
    -- intent were recorded, and no verdict has sealed the row.
    if v_auth_present or v_operation.auth_deleted_at is null
      or v_operation.phase <> 'auth_delete_intent' or v_operation.apple_completed_at is null
      or v_operation.revenuecat_completed_at is null or v_operation.external_completed_at is null
      or v_operation.auth_delete_intent_at is null then
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
    return jsonb_build_object('outcome', 'claimed', 'operationId', v_operation.id,
      'leaseToken', v_operation.lease_token, 'leaseExpiresAt', v_operation.lease_expires_at,
      'confirmedAt', v_operation.confirmed_at,
      'appleCompleted', true, 'appleAction', v_operation.apple_outcome,
      'appleRefreshTokenEncrypted', null,
      'revenueCatCompleted', true, 'revenueCatAlreadyDeleted', true,
      'authDeleted', true);
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
    'revenueCatAlreadyDeleted', v_external.revenuecat_deleted_at is not null,
    'authDeleted', false);
end;
$$;
revoke all on function api_private.acquire_account_deletion_lease(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.fail_account_deletion_operation(
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
  if v_operation.id is null and p_error_code in ('completion_unverified', 'auth_delete_unavailable') then
    v_operation := api_private.lock_account_deletion_certification(p_owner_id, p_operation_id, p_lease_token);
  end if;
  if v_operation.id is null then return jsonb_build_object('outcome', 'stale_lease'); end if;
  update api_private.account_deletion_operations
    set last_error_code = p_error_code, lease_token = null, lease_expires_at = null where id = v_operation.id;
  return jsonb_build_object('outcome', 'released');
end;
$$;
revoke all on function public.fail_account_deletion_operation(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_account_deletion_operation(uuid, uuid, uuid, text) to service_role;
