-- W04-06: the 1.0 app registers its installation through
-- POST /v1/devices/register with p_attested = false (App Attest is not wired
-- yet), so every real phone sits in attestation_state 'unattested' — and
-- 20260908160000 lets issue_offline_grant() and guard_offline_grant() hand a
-- grant only to an 'attested' device. No shipping installation could ever hold
-- an offline grant.
--
-- Forward migration (the applied migration is not edited):
--   * public.offline_devices.revoked_at — an owner/support-set revocation
--     marker. A revoked installation is refused every new grant (RPC and
--     table); re-registration never clears it; the client role holds no
--     UPDATE on the table, so no caller can un-revoke itself. Deletion keeps
--     refusing as before (offline.device_not_registered; grants cascade).
--   * public.offline_grants.attestation_state — the attestation state the
--     device held when the grant was issued, recorded truthfully. Every grant
--     that exists today was issued while the guard demanded 'attested', so
--     the backfill is 'attested' (the default is dropped again: new rows are
--     stamped by the guard from the device row, never by the caller).
--   * guard_offline_grant(): the device must still exist and belong to the
--     grant owner; a revoked device is refused; the device may be 'attested'
--     or 'unattested' (any other state fails closed); the grant records
--     exactly the device's current state — a row that claims a state the
--     device does not hold is refused, so no grant ever claims an attestation
--     the server did not verify. The Pro branch (effective verified
--     entitlement, recorded expiry) and immutability are unchanged.
--   * issue_offline_grant(): 'unattested' is no longer a refusal;
--     offline.device_revoked is. Everything else — owner+installation lookup,
--     access_lock_key(uid), Pro lease = min(now + 7d, verified expiry), free
--     tickets within lifetime_scored_count() + online_reservation_count() +
--     offline_hold_count() ≤ 2, original-installation recovery — is the
--     20260908160000 body verbatim. The result row gains attestation_state
--     (the return type changes, so the function is dropped and recreated
--     with the same EXECUTE grants: authenticated only).
-- App Attest, when wired, keeps writing attestation_state = 'attested' through
-- register_offline_device(p_attested => true); grants issued to such a device
-- record 'attested'. Live matrix: security_regression.sql section W.

alter table public.offline_devices
  add column if not exists revoked_at timestamptz;

comment on column public.offline_devices.revoked_at is
  'Set by the owner/support to revoke an installation: issue_offline_grant() answers offline.device_revoked and guard_offline_grant() refuses any grant row for it. Never cleared by register_offline_device(); no client role can write it.';

comment on table public.offline_devices is
  'One row per (owner, installation key). attestation_state is explicit and truthful: ''attested'' only after the server verified an App Attest assertion, otherwise ''unattested''. Either state receives offline grants (the grant records the state it was issued under); a revoked (revoked_at) or deleted device receives none. Written only by register_offline_device(); clients read their own rows through the API.';

alter table public.offline_grants
  add column if not exists attestation_state text not null default 'attested';
alter table public.offline_grants
  alter column attestation_state drop default;
alter table public.offline_grants
  drop constraint if exists offline_grants_attestation_state;
alter table public.offline_grants
  add constraint offline_grants_attestation_state
    check (attestation_state in ('attested', 'unattested'));

comment on column public.offline_grants.attestation_state is
  'The attestation state (attested | unattested) the device held when this grant was issued — stamped by guard_offline_grant() from public.offline_devices, never from the caller.';

comment on table public.offline_grants is
  'One offline execution grant per (device, generation). expires_at ≤ issued_at + 7 days always; a verified_store lease also ≤ the verified entitlement expiry it records. attestation_state records the device state the grant was issued under. Immutable once issued (guard_offline_grant). Written only by issue_offline_grant().';

create or replace function public.guard_offline_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.offline_devices%rowtype;
  v_premium boolean;
  v_entitlement_expires_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    raise exception 'offline grants are immutable once issued'
      using errcode = 'check_violation';
  end if;
  select * into v_device
  from public.offline_devices d
  where d.id = new.device_id and d.user_id = new.user_id;
  if not found then
    raise exception 'offline grant device must belong to the grant owner'
      using errcode = 'check_violation';
  end if;
  if v_device.revoked_at is not null then
    raise exception 'offline grants are refused for a revoked device'
      using errcode = 'check_violation';
  end if;
  if v_device.attestation_state not in ('attested', 'unattested') then
    raise exception 'offline grant device attestation state is unknown'
      using errcode = 'check_violation';
  end if;
  if new.attestation_state is null then
    new.attestation_state := v_device.attestation_state;
  elsif new.attestation_state is distinct from v_device.attestation_state then
    raise exception 'an offline grant records the attestation state it was issued under'
      using errcode = 'check_violation';
  end if;
  if new.entitlement_source = 'verified_store' then
    select
      coalesce(b.premium and (b.expires_at is null or b.expires_at > now()), false),
      b.expires_at
    into v_premium, v_entitlement_expires_at
    from public.billing_entitlements b
    where b.user_id = new.user_id;
    if not coalesce(v_premium, false) then
      raise exception 'a Pro lease requires an effective verified entitlement'
        using errcode = 'check_violation';
    end if;
    if new.entitlement_expires_at is distinct from v_entitlement_expires_at then
      raise exception 'a Pro lease must record the verified entitlement expiry'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_offline_grant() from public, anon, authenticated;

drop function if exists public.issue_offline_grant(text, integer);

create function public.issue_offline_grant(
  p_installation_key_id text,
  p_requested_tickets integer
)
returns table (
  result text,
  grant_id uuid,
  generation integer,
  entitlement_source text,
  issued_at timestamptz,
  expires_at timestamptz,
  entitlement_expires_at timestamptz,
  ticket_ids uuid[],
  attestation_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_device public.offline_devices%rowtype;
  v_grant public.offline_grants%rowtype;
  v_premium boolean;
  v_entitlement_expires_at timestamptz;
  v_scored int;
  v_reserved int;
  v_held int;
  v_remaining int;
  v_capacity int;
  v_outstanding uuid[];
  v_new_count int;
  v_new uuid[];
  v_identity_hashes text[];
  v_now timestamptz := now();
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_installation_key_id is null
     or p_installation_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_requested_tickets is null
     or p_requested_tickets < 0
     or p_requested_tickets > 2 then
    result := 'offline.invalid_input';
    return next;
    return;
  end if;

  select * into v_device
  from public.offline_devices d
  where d.user_id = v_uid and d.installation_key_id = p_installation_key_id;
  if not found then
    result := 'offline.device_not_registered';
    return next;
    return;
  end if;
  if v_device.revoked_at is not null then
    result := 'offline.device_revoked';
    return next;
    return;
  end if;

  -- The same lock the online reservation path holds: allocation and online
  -- reservation are serialized per identity.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  select
    coalesce(b.premium and (b.expires_at is null or b.expires_at > now()), false),
    b.expires_at
  into v_premium, v_entitlement_expires_at
  from public.billing_entitlements b
  where b.user_id = v_uid;
  v_premium := coalesce(v_premium, false);

  if v_premium then
    -- Pro lease: min(issued + 7 days, verified entitlement expiry); no tickets.
    insert into public.offline_grants (
      user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at,
      attestation_state
    ) values (
      v_uid, v_device.id, 'verified_store',
      coalesce((select max(g.generation) from public.offline_grants g where g.device_id = v_device.id), 0) + 1,
      v_now,
      least(v_now + interval '7 days', coalesce(v_entitlement_expires_at, v_now + interval '7 days')),
      v_entitlement_expires_at,
      v_device.attestation_state
    )
    returning * into v_grant;

    result := 'accepted';
    grant_id := v_grant.id;
    generation := v_grant.generation;
    entitlement_source := v_grant.entitlement_source;
    issued_at := v_grant.issued_at;
    expires_at := v_grant.expires_at;
    entitlement_expires_at := v_grant.entitlement_expires_at;
    ticket_ids := '{}'::uuid[];
    attestation_state := v_grant.attestation_state;
    return next;
    return;
  end if;

  -- Free identity: tickets this installation already holds for this account
  -- or one of its sign-in identities are re-issued (the original installation
  -- of a deleted-and-re-created account recovers its ticket here — the
  -- device row is gone, the ledger's installation key is not); new tickets
  -- come only out of what lifetime scored + live online reservations + every
  -- outstanding offline hold leave of the 2 lifetime free ratings, read
  -- through the SAME online_reservation_count() the online path uses — a
  -- stale or swept permit is a reservation to neither, and its late sync is
  -- then refused by apply_synced_shot()'s backstop beside the tickets issued
  -- here (never a third rating).
  select coalesce(array_agg(a.ticket_id order by a.created_at, a.id), '{}'::uuid[])
  into v_outstanding
  from public.offline_allocation_ledger a
  where a.installation_key_id = v_device.installation_key_id
    and a.event = 'allocated'
    and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid)
    and not exists (
      select 1 from public.offline_allocation_ledger t
      where t.ticket_id = a.ticket_id and t.event in ('consumed', 'released')
    );

  select
    public.lifetime_scored_count(),
    public.online_reservation_count(),
    public.offline_hold_count()
  into v_scored, v_reserved, v_held;

  v_remaining := 2 - least(v_scored, 2);
  v_capacity := greatest(v_remaining - v_reserved - v_held, 0);
  v_new_count := least(greatest(p_requested_tickets - coalesce(array_length(v_outstanding, 1), 0), 0), v_capacity);

  if coalesce(array_length(v_outstanding, 1), 0) + v_new_count = 0 then
    result := case when v_capacity = 0 then 'access.paywall_required' else 'offline.invalid_input' end;
    return next;
    return;
  end if;

  insert into public.offline_grants (
    user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at,
    attestation_state
  ) values (
    v_uid, v_device.id, 'identity_lifetime_free',
    coalesce((select max(g.generation) from public.offline_grants g where g.device_id = v_device.id), 0) + 1,
    v_now, v_now + interval '7 days', null,
    v_device.attestation_state
  )
  returning * into v_grant;

  if v_new_count > 0 then
    v_identity_hashes := api_private.offline_identity_hashes(v_uid);
    select array_agg(gen_random_uuid()) into v_new from generate_series(1, v_new_count);
    insert into public.offline_allocation_ledger (
      user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes, installation_key_id
    )
    select v_uid, v_device.id, v_grant.id, v_grant.generation, t, 'allocated', v_identity_hashes,
           v_device.installation_key_id
    from unnest(v_new) t;
  else
    v_new := '{}'::uuid[];
  end if;

  result := 'accepted';
  grant_id := v_grant.id;
  generation := v_grant.generation;
  entitlement_source := v_grant.entitlement_source;
  issued_at := v_grant.issued_at;
  expires_at := v_grant.expires_at;
  entitlement_expires_at := v_grant.entitlement_expires_at;
  ticket_ids := v_outstanding || v_new;
  attestation_state := v_grant.attestation_state;
  return next;
  return;
end;
$$;

comment on function public.issue_offline_grant(text, integer) is
  'Issues the next-generation offline grant for one registered, non-revoked device of the caller (live API session required), under access_lock_key(uid); the device may be attested or unattested and the grant records which. Pro: a lease ending at min(now + 7 days, verified entitlement expiry), no tickets. Free: re-issues the installation''s outstanding tickets owned by the caller''s account or sign-in identities (original-installation recovery across account re-creation) and allocates new ones only within lifetime_scored_count() + live online reservations (online_reservation_count(): reserved, < 24h, not yet settled by a shot — the same reader the online path uses) + offline holds ≤ 2. Returns accepted | access.paywall_required | offline.device_not_registered | offline.device_revoked | offline.invalid_input.';

revoke all on function public.issue_offline_grant(text, integer) from public, anon, service_role;
grant execute on function public.issue_offline_grant(text, integer) to authenticated;
