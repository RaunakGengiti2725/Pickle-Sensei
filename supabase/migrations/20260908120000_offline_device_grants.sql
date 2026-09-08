-- ============================================================================
-- Pickle Sensei — server-authoritative offline grants: device registry,
-- per-device grants with bounded expiry, append-only allocation ledger
-- (W04-01; follows 20260908100000).
--
-- THE GAP. packages/shared-types/src/offlineAuthorization.ts fixes the wire
-- shape of an offline execution grant (device challenge/registration, free
-- ticket allocation, Pro lease, result receipt, unused-ticket return), but
-- nothing in the database records a device, allocates a ticket, or bounds a
-- lease. The two online decision points — access_state() and
-- reserve_analysis_permit() (20260902150000) — count lifetime scored ratings
-- plus live permits only, so a ticket handed to a device that then goes
-- offline would not be visible to the online path: the same free rating
-- could be spent twice, and nothing prevents a lease from outliving the
-- verified entitlement.
--
-- THE FIX — three tables and five RPCs, all behind the API gate.
--   1. public.offline_devices: one row per (owner, installation key) with an
--      explicit attestation environment + state. Grants require an attested
--      device. Cascades with the account (nothing private survives deletion).
--   2. public.offline_grants: one row per (device, generation). The lease is
--      bounded AT THE TABLE: expires_at ≤ issued_at + 7 days, and for a Pro
--      lease ≤ the verified entitlement expiry; a Pro lease exists only for
--      an EFFECTIVE entitlement (premium AND not past expires_at — the same
--      predicate access_state() applies). Rows are immutable once issued.
--   3. public.offline_allocation_ledger: append-only for EVERY role, with NO
--      foreign key anywhere — the ledger outlives the device, the grant and
--      the account, exactly like public.free_rating_ledger. Vocabulary:
--        allocated  — a ticket was handed to a device (a HOLD, not a rating)
--        consumed   — the ticket paid for ONE durably delivered scored shot
--                     of the same owner that no online permit already paid for
--        released   — the ticket was returned explicitly (the device brought
--                     it back, or support reviewed it); terminal
--      A ticket has at most one terminal event; allocation ≠ consumption.
--      Rows carry the owner's identity hashes so the hold follows the
--      sign-in identity through delete-and-recreate.
--   4. Conservation. offline_hold_count() = tickets allocated to the caller's
--      account or identities that were never CONSUMED (a released ticket
--      stays part of the entitlement: returning a ticket is not a re-credit).
--      access_state().reserved_count and reserve_analysis_permit() add it to
--      the live online reservations, and issue_offline_grant() allocates
--      under the SAME pg_advisory_xact_lock(access_lock_key(uid)) the online
--      path holds, so at every instant
--        lifetime_scored_count() + live reservations + offline holds ≤ 2
--      for a free identity. Nothing here — no cron, no expiry check, no
--      cascade — ever releases an allocation automatically: an expired grant,
--      a swept permit, a reinstall, a key replacement or an account deletion
--      leaves the hold in place until the ticket is consumed or returned.
--   5. Access. The client role may SELECT its own rows through the API and
--      holds no INSERT/UPDATE/DELETE on any of the three tables. Mutations go
--      through register_offline_device / issue_offline_grant /
--      consume_offline_ticket / release_offline_ticket: SECURITY DEFINER
--      (the client has no table write to run under), pinned search_path,
--      bound to a LIVE API session (api_private.is_active_session(), which
--      itself refuses a request without the API proof) and scoped to
--      auth.uid() in every read and write.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Device registry
-- ---------------------------------------------------------------------------
create table if not exists public.offline_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  installation_key_id text not null,
  attestation_environment text not null,
  attestation_state text not null,
  attested_at timestamptz,
  created_at timestamptz not null default now(),
  last_registered_at timestamptz not null default now(),
  constraint offline_devices_installation_key_bounds
    check (installation_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint offline_devices_attestation_environment
    check (attestation_environment in ('production', 'development')),
  constraint offline_devices_attestation_state
    check (attestation_state in ('attested', 'unattested')),
  constraint offline_devices_attestation_consistent
    check ((attestation_state = 'attested') = (attested_at is not null)),
  unique (user_id, installation_key_id)
);

comment on table public.offline_devices is
  'One row per (owner, installation key). attestation_state is explicit: only an attested device receives offline grants. Written only by register_offline_device(); clients read their own rows through the API.';

alter table public.offline_devices enable row level security;
revoke all on public.offline_devices from public, anon, authenticated;
grant select on public.offline_devices to authenticated;
create policy offline_devices_select_own on public.offline_devices
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy api_requests_only on public.offline_devices as restrictive for all to authenticated
  using ((select api_private.is_api_request()))
  with check ((select api_private.is_api_request()));

-- ---------------------------------------------------------------------------
-- 2. Per-device grants (free execution windows and Pro leases)
-- ---------------------------------------------------------------------------
create table if not exists public.offline_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_id uuid not null references public.offline_devices (id) on delete cascade,
  entitlement_source text not null,
  generation integer not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  entitlement_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint offline_grants_entitlement_source
    check (entitlement_source in ('identity_lifetime_free', 'verified_store')),
  constraint offline_grants_generation_positive check (generation >= 1),
  constraint offline_grants_bounded_lease
    check (expires_at > issued_at and expires_at <= issued_at + interval '7 days'),
  constraint offline_grants_within_entitlement
    check (entitlement_expires_at is null or expires_at <= entitlement_expires_at),
  constraint offline_grants_free_has_no_entitlement_expiry
    check (entitlement_source = 'verified_store' or entitlement_expires_at is null),
  unique (device_id, generation)
);

comment on table public.offline_grants is
  'One offline execution grant per (device, generation). expires_at ≤ issued_at + 7 days always; a verified_store lease also ≤ the verified entitlement expiry it records. Immutable once issued (guard_offline_grant). Written only by issue_offline_grant().';

create index if not exists offline_grants_user_idx on public.offline_grants (user_id, issued_at desc);

alter table public.offline_grants enable row level security;
revoke all on public.offline_grants from public, anon, authenticated;
grant select on public.offline_grants to authenticated;
create policy offline_grants_select_own on public.offline_grants
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy api_requests_only on public.offline_grants as restrictive for all to authenticated
  using ((select api_private.is_api_request()))
  with check ((select api_private.is_api_request()));

-- The guard reads public.billing_entitlements (service-only) and the device
-- row, so it is a pinned definer; it is not client-executable.
create or replace function public.guard_offline_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_premium boolean;
  v_entitlement_expires_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    raise exception 'offline grants are immutable once issued'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.offline_devices d
    where d.id = new.device_id and d.user_id = new.user_id
  ) then
    raise exception 'offline grant device must belong to the grant owner'
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.offline_devices d
    where d.id = new.device_id and d.attestation_state = 'attested'
  ) then
    raise exception 'offline grants require an attested device'
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

drop trigger if exists offline_grants_guard on public.offline_grants;
create trigger offline_grants_guard
  before insert or update on public.offline_grants
  for each row execute function public.guard_offline_grant();

-- ---------------------------------------------------------------------------
-- 3. Append-only allocation ledger (no foreign keys — survives everything)
-- ---------------------------------------------------------------------------
create table if not exists public.offline_allocation_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  device_id uuid not null,
  grant_id uuid not null,
  generation integer not null,
  ticket_id uuid not null,
  event text not null,
  shot_id uuid,
  reason text,
  identity_hashes text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  constraint offline_allocation_ledger_event
    check (event in ('allocated', 'consumed', 'released')),
  constraint offline_allocation_ledger_consumed_names_shot
    check ((event = 'consumed') = (shot_id is not null)),
  constraint offline_allocation_ledger_released_names_reason
    check ((event = 'released') = (reason is not null)),
  unique (ticket_id, event)
);

comment on table public.offline_allocation_ledger is
  'Append-only. allocated = a ticket held by a device (never a rating by itself); consumed = the ticket paid for one durably delivered scored shot; released = the ticket was returned explicitly. No FK: an expired grant, a deleted device or a deleted account never erases an allocation, and nothing reclaims one automatically.';

create unique index if not exists offline_allocation_ledger_shot_idx
  on public.offline_allocation_ledger (shot_id) where shot_id is not null;
create index if not exists offline_allocation_ledger_user_event_idx
  on public.offline_allocation_ledger (user_id, event, created_at);
create index if not exists offline_allocation_ledger_ticket_idx
  on public.offline_allocation_ledger (ticket_id, event);
create index if not exists offline_allocation_ledger_identity_idx
  on public.offline_allocation_ledger using gin (identity_hashes);

alter table public.offline_allocation_ledger enable row level security;
revoke all on public.offline_allocation_ledger from public, anon, authenticated;
revoke all on sequence public.offline_allocation_ledger_id_seq from public, anon, authenticated;
grant select on public.offline_allocation_ledger to authenticated;
create policy offline_allocation_ledger_select_own on public.offline_allocation_ledger
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy api_requests_only on public.offline_allocation_ledger as restrictive for all to authenticated
  using ((select api_private.is_api_request()))
  with check ((select api_private.is_api_request()));

create or replace function public.guard_offline_ledger_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'offline_allocation_ledger is append-only'
    using errcode = 'check_violation';
end;
$$;

revoke execute on function public.guard_offline_ledger_append_only() from public, anon, authenticated;

drop trigger if exists offline_allocation_ledger_append_only on public.offline_allocation_ledger;
create trigger offline_allocation_ledger_append_only
  before update or delete on public.offline_allocation_ledger
  for each row execute function public.guard_offline_ledger_append_only();

-- Every append passes the state machine: a terminal event needs a prior
-- allocation of the same owner and no earlier terminal event; consumption
-- names a scored shot of the same owner that no online permit paid for;
-- release names a known reason. Reads public.shots for any owner → definer.
create or replace function public.guard_offline_ledger_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation public.offline_allocation_ledger%rowtype;
begin
  if new.event = 'allocated' then
    return new;
  end if;
  select * into v_allocation
  from public.offline_allocation_ledger a
  where a.ticket_id = new.ticket_id and a.event = 'allocated';
  if not found then
    raise exception 'offline ticket % was never allocated', new.ticket_id
      using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.offline_allocation_ledger t
    where t.ticket_id = new.ticket_id and t.event in ('consumed', 'released')
  ) then
    raise exception 'offline ticket % already has a terminal event', new.ticket_id
      using errcode = 'check_violation';
  end if;
  if new.user_id is distinct from v_allocation.user_id then
    raise exception 'offline ticket % belongs to another owner', new.ticket_id
      using errcode = 'check_violation';
  end if;
  if new.event = 'consumed' then
    if not exists (
      select 1 from public.shots s
      where s.id = new.shot_id
        and s.user_id = new.user_id
        and s.result_kind = 'scored'
        and s.analysis_permit_id is null
    ) then
      raise exception 'offline ticket % cannot be consumed by shot %', new.ticket_id, new.shot_id
        using errcode = 'check_violation';
    end if;
  elsif not (new.reason in ('unused_ticket_returned', 'support_review')) then
    raise exception 'offline ticket % release reason % is unknown', new.ticket_id, new.reason
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_offline_ledger_event() from public, anon, authenticated;

drop trigger if exists offline_allocation_ledger_guard_event on public.offline_allocation_ledger;
create trigger offline_allocation_ledger_guard_event
  before insert on public.offline_allocation_ledger
  for each row execute function public.guard_offline_ledger_event();

-- ---------------------------------------------------------------------------
-- 4. Conservation: the hold reader and the two online decision points
-- ---------------------------------------------------------------------------
-- Tickets allocated to the caller's account or to any of the caller's sign-in
-- identities that were never consumed. Definer because auth.identities and
-- other accounts' ledger rows are not client-readable; the read is scoped to
-- auth.uid() and answers 0 without the API proof.
create or replace function public.offline_hold_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null or not api_private.is_api_request() then 0
    else (
      select count(*)::int
      from public.offline_allocation_ledger a
      where a.event = 'allocated'
        and (
          a.user_id = (select auth.uid())
          or a.identity_hashes && (
            select coalesce(array_agg(public.free_rating_identity_hash(i.provider, i.provider_id)), '{}'::text[])
            from auth.identities i
            where i.user_id = (select auth.uid())
          )
        )
        and not exists (
          select 1 from public.offline_allocation_ledger c
          where c.ticket_id = a.ticket_id and c.event = 'consumed'
        )
    )
  end
$$;

comment on function public.offline_hold_count() is
  'Outstanding offline tickets of the caller (allocated, not consumed; a released ticket still counts — returning a ticket is not a re-credit), across the caller''s account and sign-in identities. Counted by access_state(), reserve_analysis_permit() and issue_offline_grant().';

revoke all on function public.offline_hold_count() from public, anon;
grant execute on function public.offline_hold_count() to authenticated;

create or replace function public.access_state()
returns table (premium boolean, scored_count integer, reserved_count integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = (select auth.uid())
    ), false) as premium,
    public.lifetime_scored_count() as scored_count,
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = (select auth.uid())
        and p.status = 'reserved'
        and p.created_at > now() - interval '24 hours'
    ) + public.offline_hold_count() as reserved_count
$$;

create or replace function public.reserve_analysis_permit(p_idempotency_key text)
returns table (
  result text,
  permit_id uuid,
  permit_status text,
  permit_outcome text,
  permit_created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
  v_scored int;
  v_reserved int;
  v_held int;
  v_remaining int;
  v_row public.analysis_permits%rowtype;
begin
  if v_uid is null then
    result := 'auth.required';
    return next;
    return;
  end if;

  -- Fast path: an idempotent replay of a key we already hold never contends
  -- for the lock. This is the overwhelmingly common retry shape.
  select * into v_row
  from public.analysis_permits p
  where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
  if found then
    result := 'accepted';
    permit_id := v_row.id;
    permit_status := v_row.status;
    permit_outcome := v_row.outcome;
    permit_created_at := v_row.created_at;
    return next;
    return;
  end if;

  -- Serialize the check-then-insert for this user — the same lock
  -- issue_offline_grant() holds while it allocates.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Re-check under the lock: a concurrent request with the SAME key may have
  -- inserted between the fast-path read above and acquiring the lock.
  select * into v_row
  from public.analysis_permits p
  where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
  if found then
    result := 'accepted';
    permit_id := v_row.id;
    permit_status := v_row.status;
    permit_outcome := v_row.outcome;
    permit_created_at := v_row.created_at;
    return next;
    return;
  end if;

  -- IDENTITY LEDGER: the scored count is the identity-aware
  -- lifetime_scored_count(), never the raw shots count of this account row.
  -- Outstanding offline tickets are reservations too.
  select
    coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false),
    public.lifetime_scored_count(),
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = v_uid
        and p.status = 'reserved'
        and p.created_at > now() - interval '24 hours'
    ),
    public.offline_hold_count()
  into v_premium, v_scored, v_reserved, v_held;

  v_remaining := 2 - least(v_scored, 2);

  if not v_premium and v_remaining <= v_reserved + v_held then
    result := 'access.paywall_required';
    return next;
    return;
  end if;

  insert into public.analysis_permits (user_id, idempotency_key)
  values (v_uid, p_idempotency_key)
  returning * into v_row;

  result := 'accepted';
  permit_id := v_row.id;
  permit_status := v_row.status;
  permit_outcome := v_row.outcome;
  permit_created_at := v_row.created_at;
  return next;
  return;
exception
  when unique_violation then
    -- Same-key insert settled concurrently despite the lock (possible only if
    -- a caller bypasses this function). Return the winner — idempotent by
    -- contract, never a spurious 402.
    select * into v_row
    from public.analysis_permits p
    where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
    if found then
      result := 'accepted';
      permit_id := v_row.id;
      permit_status := v_row.status;
      permit_outcome := v_row.outcome;
      permit_created_at := v_row.created_at;
      return next;
      return;
    end if;
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Mutating RPCs — the only write path. Each one: live API session or
--    42501, scoped to auth.uid(), refused input persists nothing.
-- ---------------------------------------------------------------------------
create or replace function public.register_offline_device(
  p_installation_key_id text,
  p_attestation_environment text,
  p_attested boolean
)
returns table (result text, device_id uuid, attestation_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_device public.offline_devices%rowtype;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_installation_key_id is null
     or p_installation_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or p_attestation_environment is null
     or p_attestation_environment not in ('production', 'development')
     or p_attested is null then
    result := 'offline.invalid_input';
    return next;
    return;
  end if;

  select * into v_device
  from public.offline_devices d
  where d.user_id = v_uid and d.installation_key_id = p_installation_key_id
  for update;

  if found then
    if v_device.attestation_environment <> p_attestation_environment then
      result := 'offline.device_environment_mismatch';
      device_id := v_device.id;
      attestation_state := v_device.attestation_state;
      return next;
      return;
    end if;
    -- Re-registration never downgrades: an attested device stays attested.
    update public.offline_devices d
    set last_registered_at = now(),
        attestation_state = case
          when d.attestation_state = 'attested' or p_attested then 'attested'
          else 'unattested'
        end,
        attested_at = case
          when d.attested_at is not null then d.attested_at
          when p_attested then now()
          else null
        end
    where d.id = v_device.id
    returning * into v_device;
  else
    insert into public.offline_devices (
      user_id, installation_key_id, attestation_environment, attestation_state, attested_at
    ) values (
      v_uid, p_installation_key_id, p_attestation_environment,
      case when p_attested then 'attested' else 'unattested' end,
      case when p_attested then now() else null end
    )
    returning * into v_device;
  end if;

  result := 'accepted';
  device_id := v_device.id;
  attestation_state := v_device.attestation_state;
  return next;
  return;
end;
$$;

comment on function public.register_offline_device(text, text, boolean) is
  'Idempotent device registration for the caller (live API session required). Records the installation key and its attestation environment/state; never downgrades an attested device; refuses an environment change for a known key. Returns accepted | offline.invalid_input | offline.device_environment_mismatch.';

revoke all on function public.register_offline_device(text, text, boolean) from public, anon;
grant execute on function public.register_offline_device(text, text, boolean) to authenticated;

create or replace function public.issue_offline_grant(
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
  ticket_ids uuid[]
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
  if v_device.attestation_state <> 'attested' then
    result := 'offline.device_not_attested';
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
      user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at
    ) values (
      v_uid, v_device.id, 'verified_store',
      coalesce((select max(g.generation) from public.offline_grants g where g.device_id = v_device.id), 0) + 1,
      v_now,
      least(v_now + interval '7 days', coalesce(v_entitlement_expires_at, v_now + interval '7 days')),
      v_entitlement_expires_at
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
    return next;
    return;
  end if;

  -- Free identity: tickets this device already holds are re-issued; new
  -- tickets come only out of what lifetime scored + live online reservations
  -- + every outstanding offline hold leave of the 2 lifetime free ratings.
  select coalesce(array_agg(a.ticket_id order by a.created_at, a.id), '{}'::uuid[])
  into v_outstanding
  from public.offline_allocation_ledger a
  where a.user_id = v_uid
    and a.device_id = v_device.id
    and a.event = 'allocated'
    and not exists (
      select 1 from public.offline_allocation_ledger t
      where t.ticket_id = a.ticket_id and t.event in ('consumed', 'released')
    );

  select
    public.lifetime_scored_count(),
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = v_uid
        and p.status = 'reserved'
        and p.created_at > now() - interval '24 hours'
    ),
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
    user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at
  ) values (
    v_uid, v_device.id, 'identity_lifetime_free',
    coalesce((select max(g.generation) from public.offline_grants g where g.device_id = v_device.id), 0) + 1,
    v_now, v_now + interval '7 days', null
  )
  returning * into v_grant;

  if v_new_count > 0 then
    select coalesce(array_agg(public.free_rating_identity_hash(i.provider, i.provider_id)), '{}'::text[])
    into v_identity_hashes
    from auth.identities i
    where i.user_id = v_uid;
    select array_agg(gen_random_uuid()) into v_new from generate_series(1, v_new_count);
    insert into public.offline_allocation_ledger (
      user_id, device_id, grant_id, generation, ticket_id, event, identity_hashes
    )
    select v_uid, v_device.id, v_grant.id, v_grant.generation, t, 'allocated', v_identity_hashes
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
  return next;
  return;
end;
$$;

comment on function public.issue_offline_grant(text, integer) is
  'Issues the next-generation offline grant for one attested device of the caller (live API session required), under access_lock_key(uid). Pro: a lease ending at min(now + 7 days, verified entitlement expiry), no tickets. Free: re-issues the device''s outstanding tickets and allocates new ones only within lifetime_scored_count() + live reservations + offline holds ≤ 2. Returns accepted | access.paywall_required | offline.device_not_registered | offline.device_not_attested | offline.invalid_input.';

revoke all on function public.issue_offline_grant(text, integer) from public, anon;
grant execute on function public.issue_offline_grant(text, integer) to authenticated;

create or replace function public.consume_offline_ticket(p_ticket_id uuid, p_shot_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_allocation public.offline_allocation_ledger%rowtype;
  v_terminal public.offline_allocation_ledger%rowtype;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_ticket_id is null or p_shot_id is null then
    return 'offline.invalid_input';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  select * into v_allocation
  from public.offline_allocation_ledger a
  where a.ticket_id = p_ticket_id and a.event = 'allocated' and a.user_id = v_uid;
  if not found then
    return 'offline.ticket_not_found';
  end if;

  select * into v_terminal
  from public.offline_allocation_ledger t
  where t.ticket_id = p_ticket_id and t.event in ('consumed', 'released');
  if found then
    if v_terminal.event = 'consumed' then
      return case when v_terminal.shot_id = p_shot_id then 'accepted' else 'offline.ticket_consumed' end;
    end if;
    return 'offline.ticket_released';
  end if;

  -- Chargeable: a durably delivered scored shot of this owner that no online
  -- permit paid for and that no other ticket has already paid for.
  if not exists (
    select 1 from public.shots s
    where s.id = p_shot_id
      and s.user_id = v_uid
      and s.result_kind = 'scored'
      and s.analysis_permit_id is null
  ) or exists (
    select 1 from public.offline_allocation_ledger c
    where c.shot_id = p_shot_id and c.event = 'consumed'
  ) then
    return 'offline.shot_not_chargeable';
  end if;

  insert into public.offline_allocation_ledger (
    user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes
  ) values (
    v_allocation.user_id, v_allocation.device_id, v_allocation.grant_id, v_allocation.generation,
    p_ticket_id, 'consumed', p_shot_id, v_allocation.identity_hashes
  );
  return 'accepted';
end;
$$;

comment on function public.consume_offline_ticket(uuid, uuid) is
  'Binds one outstanding ticket of the caller to one durably delivered scored shot of the caller that no online permit and no other ticket paid for (live API session required). Idempotent for the same (ticket, shot). Returns accepted | offline.ticket_not_found | offline.ticket_consumed | offline.ticket_released | offline.shot_not_chargeable | offline.invalid_input.';

revoke all on function public.consume_offline_ticket(uuid, uuid) from public, anon;
grant execute on function public.consume_offline_ticket(uuid, uuid) to authenticated;

create or replace function public.release_offline_ticket(p_ticket_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_allocation public.offline_allocation_ledger%rowtype;
  v_terminal public.offline_allocation_ledger%rowtype;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_ticket_id is null or p_reason is null
     or p_reason not in ('unused_ticket_returned', 'support_review') then
    return 'offline.invalid_input';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  select * into v_allocation
  from public.offline_allocation_ledger a
  where a.ticket_id = p_ticket_id and a.event = 'allocated' and a.user_id = v_uid;
  if not found then
    return 'offline.ticket_not_found';
  end if;

  select * into v_terminal
  from public.offline_allocation_ledger t
  where t.ticket_id = p_ticket_id and t.event in ('consumed', 'released');
  if found then
    return case when v_terminal.event = 'consumed' then 'offline.ticket_consumed' else 'accepted' end;
  end if;

  insert into public.offline_allocation_ledger (
    user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes
  ) values (
    v_allocation.user_id, v_allocation.device_id, v_allocation.grant_id, v_allocation.generation,
    p_ticket_id, 'released', p_reason, v_allocation.identity_hashes
  );
  return 'accepted';
end;
$$;

comment on function public.release_offline_ticket(uuid, text) is
  'Explicit, terminal return of one outstanding ticket of the caller (live API session required). A released ticket still counts against the entitlement and can never be consumed; a consumed ticket cannot be released. Idempotent. Returns accepted | offline.ticket_not_found | offline.ticket_consumed | offline.invalid_input.';

revoke all on function public.release_offline_ticket(uuid, text) from public, anon;
grant execute on function public.release_offline_ticket(uuid, text) to authenticated;
