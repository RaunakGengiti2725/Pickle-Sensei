-- W08-06: post-Auth recovery has a SHIPPING caller that needs no owner session.
--
-- Before (20260909180000): the post-Auth certification phase could be
-- re-acquired (claim_account_deletion_work answered `claimed` with
-- authDeleted = true), but the only caller of that claim was the owner's own
-- retried POST /v1/me/delete-confirm — which the Edge fences behind
-- public.is_api_session_active(). The Auth delete cascades auth.sessions, so
-- the deleting session is gone the moment recovery is needed: a worker that
-- died after deleteUser, or whose deleteUser response was lost, left a clean
-- deletion permanently uncertifiable, and /delete-status reported an orphaned
-- phase whose identity had been recreated as `in_progress`.
--
-- Now:
--   * api_private.account_deletion_owner_residue(owner) counts, as the
--     definer, every row still owned by the account: each owner namespace the
--     Edge worker pages (ACCOUNT_OWNER_NAMESPACES in
--     supabase/functions/api/accountDeletionOperations.ts) plus the
--     cascade-only and RPC-owned bookkeeping tables the owner cannot read;
--     the retained-by-policy ledgers (free-rating identity ledger, billing
--     audit, offline allocation ledger, the deletion record itself) are never
--     residue. The static pin in __wf__/account_deletion_complete.test.ts keeps
--     this list and the Edge registry in step.
--   * public.certify_account_deletion_completion refuses to seal a receipt
--     while any owner namespace still holds rows: it answers
--     {outcome: 'residue', namespaces: [{table, rows}, …]} and leaves the row
--     and the lease untouched so the caller records the verdict. The receipt
--     is therefore gated by the database itself, whichever worker asks.
--   * public.sweep_account_deletion_operations(limit) is the service-owned
--     recovery worker: it re-acquires every post-Auth phase whose lease has
--     expired or was released (identity absent and not recreated, ready
--     intent, no receipt, status window open, attempt budget left) through the
--     same claim RPC the Edge uses, certifies a clean sweep exactly once and
--     records completion_unverified against the lease when residue remains.
--     Nothing external (Apple, RevenueCat, Auth) is ever repeated: only
--     claims carrying authDeleted = true are acted on. Service-only.
--   * pg_cron runs the sweep every minute (`sweep-account-deletion-operations`),
--     the same way the other maintenance sweeps are scheduled. Where pg_cron is
--     absent the migration warns: the sweep must then be scheduled externally.
--   * api_private.account_deletion_view reports a post-Auth phase whose
--     identity exists again as `blocked`: nothing can ever certify it (the
--     claim RPC answers blocked, certification answers stale_lease), so it is
--     not in progress.
-- The free-rating identity ledger is untouched by every path here.

create function api_private.account_deletion_owner_residue(p_owner_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('table', r.table_name, 'rows', r.rows) order by r.table_name), '[]'::jsonb)
  from (values
    ('profiles', (select count(*) from public.profiles where id = p_owner_id)),
    ('sessions', (select count(*) from public.sessions where user_id = p_owner_id)),
    ('shots', (select count(*) from public.shots where user_id = p_owner_id)),
    ('shot_phases', (select count(*) from public.shot_phases where user_id = p_owner_id)),
    ('shot_measurements', (select count(*) from public.shot_measurements where user_id = p_owner_id)),
    ('shot_checkpoints', (select count(*) from public.shot_checkpoints where user_id = p_owner_id)),
    ('captures', (select count(*) from public.captures where user_id = p_owner_id)),
    ('analysis_permits', (select count(*) from public.analysis_permits where user_id = p_owner_id)),
    ('consent_records', (select count(*) from public.consent_records where user_id = p_owner_id)),
    ('evaluation_trials', (select count(*) from public.evaluation_trials where user_id = p_owner_id)),
    ('analysis_feedback', (select count(*) from public.analysis_feedback where user_id = p_owner_id)),
    ('user_saved_drills', (select count(*) from public.user_saved_drills where user_id = p_owner_id)),
    ('player_rank_state', (select count(*) from public.player_rank_state where user_id = p_owner_id)),
    ('billing_entitlements', (select count(*) from public.billing_entitlements where user_id = p_owner_id)),
    ('settlement_receipts', (select count(*) from public.settlement_receipts where user_id = p_owner_id)),
    ('offline_devices', (select count(*) from public.offline_devices where user_id = p_owner_id)),
    ('offline_grants', (select count(*) from public.offline_grants where user_id = p_owner_id)),
    ('account_deletion_requests', (select count(*) from public.account_deletion_requests where user_id = p_owner_id)),
    ('account_external_credentials', (select count(*) from public.account_external_credentials where user_id = p_owner_id)),
    ('analysis_permit_tombstones', (select count(*) from public.analysis_permit_tombstones where user_id = p_owner_id)),
    ('account_deletion_feedback', (select count(*) from public.account_deletion_feedback where user_id = p_owner_id)),
    ('api_private.billing_verification_tickets', (select count(*) from api_private.billing_verification_tickets where user_id = p_owner_id))
  ) as r (table_name, rows)
  where p_owner_id is not null and r.rows > 0
$$;
revoke all on function api_private.account_deletion_owner_residue(uuid)
  from public, anon, authenticated, service_role;

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
            and not exists (select 1 from auth.users u where u.id = p_operation.owner_id)
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

create or replace function public.certify_account_deletion_completion(
  p_owner_id uuid, p_operation_id uuid, p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation api_private.account_deletion_operations%rowtype;
  v_residue jsonb;
begin
  v_operation := api_private.lock_account_deletion_certification(p_owner_id, p_operation_id, p_lease_token);
  if v_operation.id is null then return jsonb_build_object('outcome', 'stale_lease'); end if;
  v_residue := api_private.account_deletion_owner_residue(p_owner_id);
  if jsonb_array_length(v_residue) > 0 then
    return jsonb_build_object('outcome', 'residue', 'namespaces', v_residue);
  end if;
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

create function public.sweep_account_deletion_operations(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_claim jsonb;
  v_lease uuid;
  v_verdict jsonb;
  v_scanned integer := 0;
  v_claimed integer := 0;
  v_certified integer := 0;
  v_residue integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
  v_operations jsonb := '[]'::jsonb;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Invalid deletion sweep batch' using errcode = '22023';
  end if;
  for v_candidate in
    select o.owner_id, o.id
    from api_private.account_deletion_operations o
    where o.auth_deleted_at is not null and o.completed_at is null
      and o.phase = 'auth_delete_intent' and o.confirmed_at is not null
      and o.apple_completed_at is not null and o.revenuecat_completed_at is not null
      and o.external_completed_at is not null and o.auth_delete_intent_at is not null
      and o.status_expires_at > clock_timestamp()
      and coalesce(o.lease_expires_at, '-infinity') <= clock_timestamp()
      and o.attempts < 8
      and not exists (select 1 from auth.users u where u.id = o.owner_id)
    order by o.auth_deleted_at, o.id
    limit p_limit
  loop
    v_scanned := v_scanned + 1;
    -- Each candidate is its own subtransaction: one operation the database
    -- refuses (a lock it cannot take, a table it cannot count) never stops the
    -- rest of the batch, and never leaves a half-applied verdict behind.
    begin
      v_claim := public.claim_account_deletion_work(v_candidate.owner_id, v_candidate.id);
      if v_claim->>'outcome' is distinct from 'claimed'
        or (v_claim->>'authDeleted')::boolean is distinct from true
        or (v_claim->>'operationId')::uuid is distinct from v_candidate.id then
        v_skipped := v_skipped + 1;
        v_operations := v_operations || jsonb_build_object(
          'operationId', v_candidate.id, 'outcome', 'skipped',
          'claim', coalesce(v_claim->>'outcome', 'unavailable'));
        continue;
      end if;
      v_claimed := v_claimed + 1;
      v_lease := (v_claim->>'leaseToken')::uuid;
      v_verdict := public.certify_account_deletion_completion(v_candidate.owner_id, v_candidate.id, v_lease);
      if v_verdict->>'state' = 'completed' and v_verdict->'completionReceipt'->>'completedAt' is not null then
        v_certified := v_certified + 1;
        v_operations := v_operations || jsonb_build_object(
          'operationId', v_candidate.id, 'outcome', 'certified',
          'completedAt', v_verdict->'completionReceipt'->'completedAt');
      else
        -- Residue (or a lease the database stopped honouring meanwhile) is a
        -- recorded verdict, never a receipt: the row stays uncertified and the
        -- next sweep re-acquires it once the residue is gone.
        perform public.fail_account_deletion_operation(v_candidate.owner_id, v_candidate.id, v_lease, 'completion_unverified');
        v_residue := v_residue + 1;
        v_operations := v_operations || jsonb_build_object(
          'operationId', v_candidate.id, 'outcome', 'residue',
          'namespaces', coalesce(v_verdict->'namespaces', '[]'::jsonb));
      end if;
    exception when others then
      v_failed := v_failed + 1;
      v_operations := v_operations || jsonb_build_object(
        'operationId', v_candidate.id, 'outcome', 'error', 'sqlstate', sqlstate);
    end;
  end loop;
  return jsonb_build_object('scanned', v_scanned, 'claimed', v_claimed, 'certified', v_certified,
    'residue', v_residue, 'skipped', v_skipped, 'failed', v_failed, 'operations', v_operations);
end;
$$;
revoke all on function public.sweep_account_deletion_operations(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.sweep_account_deletion_operations(integer)
  to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('sweep-account-deletion-operations', '* * * * *',
      'select public.sweep_account_deletion_operations(50)');
  else
    raise warning 'pg_cron unavailable: schedule select public.sweep_account_deletion_operations(50) externally — post-Auth account deletions are certified only by this sweep.';
  end if;
end;
$$;

notify pgrst, 'reload schema';
