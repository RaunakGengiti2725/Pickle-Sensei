-- W08-06 (round 6): the post-Auth certification phase is reachable from the
-- one shipping surface that outlives the deleting session.
--
-- Before (20260909180000): a clean deletion whose worker died after the Auth
-- delete — or whose deleteUser response never arrived — could be re-acquired
-- through api_private.acquire_account_deletion_lease, but every shipping
-- caller of that path ran as the deleting user: POST /v1/me/delete-confirm
-- re-checks the live session, and auth.sessions cascades away with auth.users,
-- so the retry answered `session_invalid`; POST /v1/me/delete-status only read
-- the row. The phase stayed uncertified for good and the app never received a
-- receipt for an account that was already gone. The status view also reported
-- `in_progress` for a post-Auth phase whose identity had been recreated under
-- the same id, although acquisition and certification both refuse it.
--
-- Now:
--   * public.claim_account_deletion_status_work(operation, capability hash)
--     acquires the post-Auth certification phase for the holder of the status
--     capability minted with the deletion request — the credential the app
--     polls with, bound to exactly one operation and its original owner; no
--     session is involved and no new operation id is minted. It refuses to
--     move anything while the Auth identity exists (the pre-Auth phases stay
--     with the confirm route, so the status capability can never trigger an
--     external or irreversible step) and otherwise answers exactly like
--     acquire_account_deletion_lease (`claimed` with authDeleted, `busy`,
--     `blocked`, `completed`, `invalid`), adding `ownerId` to a claim so the
--     Edge sweep is bound to the durable owner.
--   * public.read_account_deletion_owner_residue(owner, operation, lease)
--     counts, under the matching unexpired post-Auth lease, the rows that
--     still reference the owner in every table whose owner column cascades
--     from auth.users / public.profiles (api_private.account_deletion_owner_
--     namespaces enumerates them from the catalog, so a namespace added later
--     is swept without a code change). The deleting user's session no longer
--     exists to page the tables through RLS; the counts are read by a definer
--     bound to the lease, expose no row contents, and never certify anything
--     themselves — the Edge records the verdict through the existing
--     certify/fail RPCs, which spend the lease exactly once.
--   * api_private.account_deletion_view answers `blocked` for a post-Auth
--     phase whose Auth identity is present again: nothing can ever certify
--     it, so `in_progress` was not honest.
-- Certification itself is unchanged: service-only, serialized under the owner
-- advisory lock, spends the matching unexpired lease exactly once, refuses
-- forged/stale/cross-owner/cross-operation leases and a recreated identity.
-- Residue never yields a receipt. The free-rating identity ledger is not a
-- namespace here (no FK, retained by design) and is untouched.

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
            and not exists (select 1 from auth.users where id = p_operation.owner_id)
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

-- Every (schema, table, column) in public / api_private whose single-column
-- foreign key references auth.users(id) or public.profiles(id): the rows the
-- identity delete is expected to cascade away (or detach, for ON DELETE SET
-- NULL). Read from the catalog at call time, ordered deterministically.
create function api_private.account_deletion_owner_namespaces()
returns table (table_schema text, table_name text, owner_column text)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct n.nspname::text, c.relname::text, a.attname::text
  from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
  where con.contype = 'f'
    and array_length(con.conkey, 1) = 1
    and con.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
    and n.nspname in ('public', 'api_private')
    and c.relkind in ('r', 'p')
    and not a.attisdropped
  order by 1, 2, 3
$$;
revoke all on function api_private.account_deletion_owner_namespaces()
  from public, anon, authenticated, service_role;

create function public.read_account_deletion_owner_residue(
  p_owner_id uuid, p_operation_id uuid, p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation api_private.account_deletion_operations%rowtype;
  v_namespace record;
  v_rows bigint;
  v_namespaces jsonb := '[]'::jsonb;
begin
  v_operation := api_private.lock_account_deletion_certification(p_owner_id, p_operation_id, p_lease_token);
  if v_operation.id is null then return jsonb_build_object('outcome', 'stale_lease'); end if;
  for v_namespace in select * from api_private.account_deletion_owner_namespaces() loop
    execute format('select count(*) from %I.%I where %I = $1',
      v_namespace.table_schema, v_namespace.table_name, v_namespace.owner_column)
      into strict v_rows using v_operation.owner_id;
    v_namespaces := v_namespaces || jsonb_build_object(
      'schema', v_namespace.table_schema, 'table', v_namespace.table_name,
      'column', v_namespace.owner_column, 'rows', v_rows);
  end loop;
  return jsonb_build_object('outcome', 'counted', 'namespaces', v_namespaces);
end;
$$;
revoke all on function public.read_account_deletion_owner_residue(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_account_deletion_owner_residue(uuid, uuid, uuid) to service_role;

create function public.claim_account_deletion_status_work(p_operation_id uuid, p_status_capability_hash bytea)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation api_private.account_deletion_operations%rowtype;
  v_claim jsonb;
begin
  if p_operation_id is null or p_status_capability_hash is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into v_operation from api_private.account_deletion_operations o
    where o.id = p_operation_id and o.status_capability_hash = p_status_capability_hash
      and o.status_expires_at > clock_timestamp() and o.retain_until > clock_timestamp();
  if not found then return jsonb_build_object('outcome', 'invalid'); end if;
  perform pg_advisory_xact_lock(hashtextextended('account-deletion:' || v_operation.owner_id::text, 0));
  -- The status capability moves nothing while the identity exists: the
  -- pre-Auth phases (Apple, RevenueCat, the Auth delete itself) belong to the
  -- confirm route and its live session.
  if v_operation.auth_deleted_at is null
    or exists (select 1 from auth.users where id = v_operation.owner_id) then
    return jsonb_build_object('outcome', 'blocked');
  end if;
  v_claim := api_private.acquire_account_deletion_lease(v_operation.owner_id, v_operation.id);
  if v_claim->>'outcome' = 'claimed' then
    return v_claim || jsonb_build_object('ownerId', v_operation.owner_id);
  end if;
  return v_claim;
end;
$$;
revoke all on function public.claim_account_deletion_status_work(uuid, bytea)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_account_deletion_status_work(uuid, bytea) to service_role;
