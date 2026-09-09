-- W08-06: the account-deletion receipt is CERTIFIED by the worker that verified
-- the post-Auth sweep, never sealed by the identity delete itself.
--
-- Before: the auth.users AFTER DELETE trigger set completed_at / phase =
-- 'completed' and cleared the worker's lease in the same transaction as the
-- identity delete. A receipt therefore existed before a single owner table had
-- been inspected, a worker that then found residue could not record it
-- (fail_account_deletion_operation answered stale_lease once auth_deleted_at
-- was set) and /delete-status handed out the receipt regardless.
--
-- Now: the trigger records only auth_deleted_at. When the operation carried a
-- ready deletion intent the worker's lease is left in place so that ONE of two
-- verdicts can be recorded against it under the same advisory lock:
--   * public.certify_account_deletion_completion(owner, operation, lease)
--     seals completed_at / phase = 'completed' — only when Auth is absent,
--     the intent was ready and the retained lease matches;
--   * public.fail_account_deletion_operation(owner, operation, lease,
--     'completion_unverified') records residue and releases the lease.
-- Either verdict spends the lease, so certification happens at most once and
-- a residue verdict can never be followed by a receipt. Until a verdict lands
-- the existing status view already reports auth_deleted_at set + completed_at
-- null as `blocked` with no receipt, and lease acquisition answers `blocked`.
-- An Auth delete without a ready intent still records
-- auth_absent_without_ready_intent and clears the lease.

create or replace function api_private.record_account_deletion_auth_absence()
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
      last_error_code = case when confirmed_at is not null and apple_completed_at is not null
        and revenuecat_completed_at is not null and external_completed_at is not null
        and auth_delete_intent_at is not null and phase = 'auth_delete_intent'
        then last_error_code else 'auth_absent_without_ready_intent' end,
      lease_token = case when confirmed_at is not null and apple_completed_at is not null
        and revenuecat_completed_at is not null and external_completed_at is not null
        and auth_delete_intent_at is not null and phase = 'auth_delete_intent'
        then lease_token else null end,
      lease_expires_at = case when confirmed_at is not null and apple_completed_at is not null
        and revenuecat_completed_at is not null and external_completed_at is not null
        and auth_delete_intent_at is not null and phase = 'auth_delete_intent'
        then lease_expires_at else null end
    where owner_id = old.id and auth_deleted_at is null;
  return old;
end;
$$;
revoke all on function api_private.record_account_deletion_auth_absence()
  from public, anon, authenticated, service_role;

-- The post-Auth counterpart of lock_account_deletion_lease: the identity must
-- be ABSENT, the operation must carry a ready intent that is not yet certified,
-- and the caller must hold the lease the trigger retained. Private: reached only
-- through the two verdict RPCs below.
create function api_private.lock_account_deletion_certification(
  p_owner_id uuid, p_operation_id uuid, p_lease_token uuid
)
returns api_private.account_deletion_operations
language plpgsql
security invoker
set search_path = ''
as $$
declare v_operation api_private.account_deletion_operations%rowtype;
begin
  if p_owner_id is null or p_operation_id is null or p_lease_token is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || p_owner_id::text, 0));
  if exists (select 1 from auth.users where id = p_owner_id) then return null; end if;
  select * into v_operation from api_private.account_deletion_operations
    where id = p_operation_id and owner_id = p_owner_id for update;
  if not found or v_operation.auth_deleted_at is null or v_operation.completed_at is not null
    or v_operation.phase <> 'auth_delete_intent' or v_operation.confirmed_at is null
    or v_operation.apple_completed_at is null or v_operation.revenuecat_completed_at is null
    or v_operation.external_completed_at is null or v_operation.auth_delete_intent_at is null
    or v_operation.lease_token is distinct from p_lease_token
    or v_operation.lease_expires_at <= clock_timestamp() then
    return null;
  end if;
  return v_operation;
end;
$$;
revoke all on function api_private.lock_account_deletion_certification(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.certify_account_deletion_completion(
  p_owner_id uuid, p_operation_id uuid, p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_operation api_private.account_deletion_operations%rowtype;
begin
  v_operation := api_private.lock_account_deletion_certification(p_owner_id, p_operation_id, p_lease_token);
  if v_operation.id is null then return jsonb_build_object('outcome', 'stale_lease'); end if;
  update api_private.account_deletion_operations
    set completed_at = clock_timestamp(), phase = 'completed', last_error_code = null,
      lease_token = null, lease_expires_at = null
    where id = v_operation.id returning * into v_operation;
  return api_private.account_deletion_view(v_operation);
end;
$$;
revoke all on function public.certify_account_deletion_completion(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.certify_account_deletion_completion(uuid, uuid, uuid) to service_role;

-- completion_unverified is the one verdict a worker may record AFTER the Auth
-- delete, against the retained lease; every other error code still requires a
-- live pre-Auth lease exactly as before.
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
  if v_operation.id is null and p_error_code = 'completion_unverified' then
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
