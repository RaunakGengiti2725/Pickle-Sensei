-- ============================================================================
-- Pickle Sensei — server-authoritative offline grants: device registry,
-- per-device grants with bounded expiry, append-only allocation ledger
-- (W04-01; follows 20260908100000).
--
-- THE GAP. packages/shared-types/src/offlineAuthorization.ts fixes the wire
-- shape of an offline execution grant (device challenge/registration, free
-- ticket allocation, Pro lease, result receipt, unused-ticket return), but
-- nothing in the database records a device, allocates a ticket, or bounds a
-- lease. The online decision points — access_state(), reserve_analysis_
-- permit() (20260902150000), apply_synced_shot()'s backstop and the shots
-- write gate (20260907000000) — count lifetime scored ratings plus LIVE
-- (< 24h, still 'reserved') permits only, so
--   * a ticket handed to a device that then goes offline is invisible to the
--     online path: the same free rating can be spent twice;
--   * a permit that aged past 24h or was swept to released/expired stops being
--     counted while apply_synced_shot() still honours it (permit_backs_sync,
--     20260906130000): a reservation the client can still spend is not a
--     reservation to the allocator;
--   * nothing prevents a lease from outliving the verified entitlement.
--
-- THE FIX — four tables, one settlement path, five RPCs, all behind the API
-- gate.
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
--        consumed   — the ticket paid for ONE scored shot that the settlement
--                     RPC itself wrote, in the same transaction, right after
--                     this row
--        released   — the ticket was returned explicitly (the device brought
--                     it back, or support reviewed it); terminal
--      A ticket has at most one terminal event; allocation ≠ consumption.
--      Rows carry the owner's identity hashes AND the installation key the
--      ticket was handed to, so the hold follows the sign-in identity through
--      delete-and-recreate and the ORIGINAL installation can still recover it
--      (OFFLINE_FREE_ALLOCATION_POLICY.recovery =
--      original_installation_proof_or_explicit_support_review): ownership of
--      a ticket, for every path that re-issues or closes it, is
--        api_private.offline_ticket_owned_by(allocation owner, allocation
--        identity hashes, caller) = same account OR overlapping identity.
--      A client can only return an unused ticket; `support_review` is an
--      audit reason written by support through the table in the identity's
--      name — never self-asserted through the RPC.
--   4. Settlement is SERVER-AUTHORITATIVE. consume_offline_ticket(ticket,
--      shot payload) is the only writer of a `consumed` row AND of the shot it
--      names: under access_lock_key(uid) it appends the consumed event and then
--      inserts the scored shot from the payload with analysis_permit_id NULL,
--      vouching for the pair through the transaction-local setting
--      pickle.offline_ticket_id (the same mechanism apply_synced_shot() uses
--      for pickle.sync_permit_id). The ledger guard refuses a `consumed` row
--      without that vouch, or naming a shot id that already exists anywhere
--      in public.shots; the shots gate refuses a permit-less scored row under
--      the vouch unless the consumed row names exactly (this ticket, this shot
--      id, this owner). A rating that was already written — paid for by an
--      online permit, counted before the ticket existed, or carrying any
--      client-chosen created_at — can therefore never settle a ticket: the
--      ticket's rating is by construction the one row the settlement wrote.
--   5. Conservation. For a free identity, under
--      pg_advisory_xact_lock(access_lock_key(uid)) at every decision:
--        SPEND (apply_synced_shot()'s backstop and the shots gate — direct
--        INSERT, vouched sync and offline settlement alike):
--          lifetime_scored_count() + offline holds < 2, else refused
--          (offline holds = tickets allocated, never consumed:
--          public.offline_hold_count(); a released ticket still counts —
--          returning a ticket is not a re-credit).
--        ALLOCATE (issue_offline_grant()):
--          lifetime + public.online_reservation_count() + holds ≤ 2, where
--          an online reservation is every permit a late sync can still spend
--          (permit_backs_sync: reserved at ANY age, or swept to
--          released/expired) that no shot has settled — the sweep and the
--          clock walk a permit out of the 24h UI window while its sync stays
--          acceptable, so a ticket is never handed out against its slot.
--        RESERVE (reserve_analysis_permit()):
--          lifetime + permits still 'reserved' (ANY age) + holds ≤ 2. A
--          swept released/expired permit does not block a new reservation
--          (the existing contract: the owner of a swept permit and a live one
--          may still reserve — security_regression Q3); the spend rule above
--          is what keeps its late sync from becoming a third rating.
--      So at every instant scored + outstanding tickets ≤ 2, and no order of
--      allocate / reserve / direct insert / late sync yields a third unit.
--      access_state().reserved_count keeps its UI meaning (live permits,
--      < 24h) plus the offline holds; the decisions never read it. Nothing
--      here — no cron, no expiry check, no cascade — ever releases an
--      allocation automatically: an expired grant, a swept permit, a
--      reinstall, a key replacement or an account deletion leaves the hold in
--      place until the ticket is consumed or returned.
--   6. Access. The client role may SELECT its own rows through the API and
--      holds no INSERT/UPDATE/DELETE on any of the tables; service_role holds
--      nothing on them either (TRUNCATE fires no row trigger, so the
--      append-only guard alone would not keep a service credential from
--      reclaiming every allocation — the grant itself is absent). Mutations go
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
revoke all on public.offline_devices from public, anon, authenticated, service_role;
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
revoke all on public.offline_grants from public, anon, authenticated, service_role;
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

revoke all on function public.guard_offline_grant() from public, anon, authenticated, service_role;

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
  installation_key_id text not null,
  created_at timestamptz not null default now(),
  constraint offline_allocation_ledger_event
    check (event in ('allocated', 'consumed', 'released')),
  constraint offline_allocation_ledger_installation_key_bounds
    check (installation_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint offline_allocation_ledger_consumed_names_shot
    check ((event = 'consumed') = (shot_id is not null)),
  constraint offline_allocation_ledger_released_names_reason
    check ((event = 'released') = (reason is not null)),
  unique (ticket_id, event)
);

comment on table public.offline_allocation_ledger is
  'Append-only. allocated = a ticket held by a device (never a rating by itself); consumed = the ticket paid for the one scored shot consume_offline_ticket() wrote right after this row (never a pre-existing shot); released = the ticket was returned explicitly. No FK: an expired grant, a deleted device or a deleted account never erases an allocation, and nothing reclaims one automatically. installation_key_id is the ledger''s own copy of the device key so the original installation can recover the ticket after the device row is gone.';

create unique index if not exists offline_allocation_ledger_shot_idx
  on public.offline_allocation_ledger (shot_id) where shot_id is not null;
create index if not exists offline_allocation_ledger_user_event_idx
  on public.offline_allocation_ledger (user_id, event, created_at);
create index if not exists offline_allocation_ledger_ticket_idx
  on public.offline_allocation_ledger (ticket_id, event);
create index if not exists offline_allocation_ledger_identity_idx
  on public.offline_allocation_ledger using gin (identity_hashes);
create index if not exists offline_allocation_ledger_installation_idx
  on public.offline_allocation_ledger (installation_key_id, event);

alter table public.offline_allocation_ledger enable row level security;
revoke all on public.offline_allocation_ledger from public, anon, authenticated, service_role;
revoke all on sequence public.offline_allocation_ledger_id_seq from public, anon, authenticated, service_role;
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
  raise exception '% is append-only', tg_table_name
    using errcode = 'check_violation';
end;
$$;

revoke all on function public.guard_offline_ledger_append_only() from public, anon, authenticated, service_role;

drop trigger if exists offline_allocation_ledger_append_only on public.offline_allocation_ledger;
create trigger offline_allocation_ledger_append_only
  before update or delete on public.offline_allocation_ledger
  for each row execute function public.guard_offline_ledger_append_only();

-- ---------------------------------------------------------------------------
-- 3b. Late-linked identities: the hold follows every identity of the holder
-- ---------------------------------------------------------------------------
-- An allocation row snapshots the holder's sign-in identities AT ALLOCATION.
-- An identity linked to the account afterwards (the same late-link event
-- 20260905000100 propagates the free-rating ledger on) is recorded here per
-- outstanding ticket, so that after the account is deleted and re-created
-- through ONLY that identity the tickets are still its holds: counted by
-- offline_hold_count(), recoverable by the original installation, and never
-- a fresh allocation. No foreign key (survives the account, like the
-- ledger); append-only; no client or service role reads or writes it — the
-- definers below are its only readers, the auth.identities trigger its only
-- writer.
create table if not exists public.offline_allocation_identity_links (
  id bigint generated always as identity primary key,
  ticket_id uuid not null,
  identity_hash text not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  constraint offline_allocation_identity_links_hash_shape
    check (identity_hash ~ '^[0-9a-f]{64}$'),
  unique (ticket_id, identity_hash)
);

comment on table public.offline_allocation_identity_links is
  'Append-only. One row per (outstanding ticket, sign-in identity linked to the holder AFTER the allocation): the hold follows a late-linked identity through account deletion and re-creation exactly as the free-rating ledger does. user_id is the account that linked the identity. No FK, no client or service grant; written only by the auth.identities trigger, read only by the ownership definers.';

create index if not exists offline_allocation_identity_links_hash_idx
  on public.offline_allocation_identity_links (identity_hash, ticket_id);

alter table public.offline_allocation_identity_links enable row level security;
revoke all on public.offline_allocation_identity_links from public, anon, authenticated, service_role;
revoke all on sequence public.offline_allocation_identity_links_id_seq from public, anon, authenticated, service_role;

drop trigger if exists offline_allocation_identity_links_append_only on public.offline_allocation_identity_links;
create trigger offline_allocation_identity_links_append_only
  before update or delete on public.offline_allocation_identity_links
  for each row execute function public.guard_offline_ledger_append_only();

-- The sign-in identities of an account, hashed exactly like
-- public.free_rating_ledger (sha256 of provider:provider_id). Definer: the
-- caller cannot read auth.identities. Not callable by any client role.
create or replace function api_private.offline_identity_hashes(p_uid uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(public.free_rating_identity_hash(i.provider, i.provider_id)), '{}'::text[])
  from auth.identities i
  where i.user_id = p_uid
$$;

revoke all on function api_private.offline_identity_hashes(uuid) from public, anon, authenticated, service_role;

-- Ownership of a ticket: the account it was allocated to, OR an account that
-- currently holds one of the sign-in identities it was allocated under, OR
-- one that holds an identity linked to the holder after the allocation. The
-- identity arms are what let the original installation of a deleted-and-
-- re-created account recover, consume or return its outstanding ticket; an
-- unrelated account on the same installation key matches no arm.
create or replace function api_private.offline_ticket_owned_by(
  p_allocation_user_id uuid,
  p_identity_hashes text[],
  p_ticket_id uuid,
  p_uid uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_uid is not null and (
    p_allocation_user_id = p_uid
    or p_identity_hashes && api_private.offline_identity_hashes(p_uid)
    or exists (
      select 1
      from public.offline_allocation_identity_links l
      where l.ticket_id = p_ticket_id
        and l.identity_hash = any(api_private.offline_identity_hashes(p_uid))
    )
  )
$$;

revoke all on function api_private.offline_ticket_owned_by(uuid, text[], uuid, uuid) from public, anon, authenticated, service_role;

-- Advisory-lock key serializing the terminal event of ONE ticket. The
-- per-user key does not cover two accounts that own the same ticket through a
-- shared sign-in identity (an account deleted and re-created per identity);
-- consume_offline_ticket() and release_offline_ticket() take this key after
-- access_lock_key(uid), always in that order, so the loser re-reads the
-- terminal state and answers with the contract verdict instead of racing the
-- ledger's uniqueness.
create or replace function api_private.offline_ticket_lock_key(p_ticket_id uuid)
returns bigint
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.hashtextextended('pickle.offline_ticket:' || p_ticket_id::text, 0)
$$;

revoke all on function api_private.offline_ticket_lock_key(uuid) from public, anon, authenticated, service_role;

-- Every allocated ticket an account owns, by any of the three arms above —
-- the one set offline_hold_count() counts and the late-link trigger extends.
create or replace function api_private.offline_owned_allocations(p_uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.ticket_id
  from public.offline_allocation_ledger a
  where a.event = 'allocated'
    and (
      a.user_id = p_uid
      or a.identity_hashes && api_private.offline_identity_hashes(p_uid)
    )
  union
  select l.ticket_id
  from public.offline_allocation_identity_links l
  where l.identity_hash = any(api_private.offline_identity_hashes(p_uid))
$$;

revoke all on function api_private.offline_owned_allocations(uuid) from public, anon, authenticated, service_role;

-- A link names an allocated ticket that the linking account owns (by any
-- arm) — nothing can attach a stranger's identity to a ticket.
create or replace function public.guard_offline_identity_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation public.offline_allocation_ledger%rowtype;
begin
  select * into v_allocation
  from public.offline_allocation_ledger a
  where a.ticket_id = new.ticket_id and a.event = 'allocated';
  if not found then
    raise exception 'offline ticket % was never allocated', new.ticket_id
      using errcode = 'check_violation';
  end if;
  if not api_private.offline_ticket_owned_by(v_allocation.user_id, v_allocation.identity_hashes, v_allocation.ticket_id, new.user_id) then
    raise exception 'offline ticket % belongs to another owner', new.ticket_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_offline_identity_link() from public, anon, authenticated, service_role;

drop trigger if exists offline_allocation_identity_links_guard on public.offline_allocation_identity_links;
create trigger offline_allocation_identity_links_guard
  before insert on public.offline_allocation_identity_links
  for each row execute function public.guard_offline_identity_link();

-- The late-link event. Fires beside inherit_free_rating_ledger
-- (20260905000100): when an identity is added to an account, every
-- outstanding ticket the account owns is recorded for every identity the
-- account now holds that the allocation did not already name. Consumed or
-- released tickets are terminal and need no link. Idempotent.
create or replace function public.inherit_offline_allocation_holds()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.offline_allocation_identity_links (ticket_id, identity_hash, user_id)
  select o.ticket_id, h.identity_hash, new.user_id
  from api_private.offline_owned_allocations(new.user_id) o(ticket_id)
  join public.offline_allocation_ledger a
    on a.ticket_id = o.ticket_id and a.event = 'allocated'
  cross join unnest(api_private.offline_identity_hashes(new.user_id)) h(identity_hash)
  where not (h.identity_hash = any(a.identity_hashes))
    and not exists (
      select 1 from public.offline_allocation_ledger t
      where t.ticket_id = o.ticket_id and t.event in ('consumed', 'released')
    )
  on conflict (ticket_id, identity_hash) do nothing;
  return new;
end;
$$;

revoke all on function public.inherit_offline_allocation_holds() from public, anon, authenticated, service_role;

drop trigger if exists offline_holds_on_identity_link on auth.identities;
create trigger offline_holds_on_identity_link
  after insert on auth.identities
  for each row execute function public.inherit_offline_allocation_holds();

-- Every append passes the state machine. An allocation names the installation
-- key of the device it was issued to (inherited from the device row when not
-- given). A terminal event needs a prior allocation, no earlier terminal
-- event, an owner that is the allocation's account or holds one of its
-- sign-in identities, and the allocation's installation key. Consumption is
-- written ONLY under the settlement vouch (pickle.offline_ticket_id, set by
-- consume_offline_ticket() for exactly this ticket, transaction-local — no
-- client and no direct table write can set it) and names a shot id that does
-- not exist yet: the settlement writes that shot next, so a row that already
-- exists — an online-permit rating, a rating counted before the ticket, a
-- row with any client-chosen created_at — is never the ticket's rating.
-- Release names a known reason. Reads public.shots for any owner → definer.
create or replace function public.guard_offline_ledger_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation public.offline_allocation_ledger%rowtype;
  v_device_key text;
  v_vouched_ticket uuid;
begin
  if new.event = 'allocated' then
    select d.installation_key_id into v_device_key
    from public.offline_devices d
    where d.id = new.device_id and d.user_id = new.user_id;
    if new.installation_key_id is null then
      if v_device_key is null then
        raise exception 'offline ticket % names no installation', new.ticket_id
          using errcode = 'check_violation';
      end if;
      new.installation_key_id := v_device_key;
    elsif v_device_key is not null and new.installation_key_id <> v_device_key then
      raise exception 'offline ticket % names another installation than device %', new.ticket_id, new.device_id
        using errcode = 'check_violation';
    end if;
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
  if not api_private.offline_ticket_owned_by(v_allocation.user_id, v_allocation.identity_hashes, v_allocation.ticket_id, new.user_id) then
    raise exception 'offline ticket % belongs to another owner', new.ticket_id
      using errcode = 'check_violation';
  end if;
  if new.installation_key_id is null then
    new.installation_key_id := v_allocation.installation_key_id;
  elsif new.installation_key_id is distinct from v_allocation.installation_key_id then
    raise exception 'offline ticket % is held by installation %', new.ticket_id, v_allocation.installation_key_id
      using errcode = 'check_violation';
  end if;
  if new.event = 'consumed' then
    v_vouched_ticket := nullif(pg_catalog.current_setting('pickle.offline_ticket_id', true), '')::uuid;
    if v_vouched_ticket is null or v_vouched_ticket <> new.ticket_id then
      raise exception 'offline ticket % is consumed only by consume_offline_ticket', new.ticket_id
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.shots s where s.id = new.shot_id) then
      raise exception 'offline ticket % cannot be consumed by an existing shot %', new.ticket_id, new.shot_id
        using errcode = 'check_violation';
    end if;
  elsif not (new.reason in ('unused_ticket_returned', 'support_review')) then
    raise exception 'offline ticket % release reason % is unknown', new.ticket_id, new.reason
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_offline_ledger_event() from public, anon, authenticated, service_role;

drop trigger if exists offline_allocation_ledger_guard_event on public.offline_allocation_ledger;
create trigger offline_allocation_ledger_guard_event
  before insert on public.offline_allocation_ledger
  for each row execute function public.guard_offline_ledger_event();

-- ---------------------------------------------------------------------------
-- 4. Conservation: the two reservation readers and every decision point
-- ---------------------------------------------------------------------------
-- Tickets allocated to the caller's account or to any of the caller's sign-in
-- identities (named at allocation or linked afterwards) that were never
-- consumed. Definer because auth.identities and other accounts' ledger rows
-- are not client-readable; the read is scoped to auth.uid() and answers 0
-- without the API proof.
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
      from api_private.offline_owned_allocations((select auth.uid())) o(ticket_id)
      where not exists (
        select 1 from public.offline_allocation_ledger c
        where c.ticket_id = o.ticket_id and c.event = 'consumed'
      )
    )
  end
$$;

comment on function public.offline_hold_count() is
  'Outstanding offline tickets of the caller (allocated, not consumed; a released ticket still counts — returning a ticket is not a re-credit), across the caller''s account and sign-in identities. Counted by access_state(), reserve_analysis_permit(), issue_offline_grant(), apply_synced_shot() and the shots write gate.';

revoke all on function public.offline_hold_count() from public, anon, service_role;
grant execute on function public.offline_hold_count() to authenticated;

-- Online reservations the caller can still spend: every permit
-- apply_synced_shot() would honour (permit_backs_sync — reserved at ANY age,
-- or swept to released/expired) that no shot has settled. The 24h window
-- access_state() shows the UI is not a spending boundary: the sweep and the
-- clock walk a permit out of that window while its late sync stays
-- acceptable, so the allocator must keep counting it. Invoker (the caller's
-- own permits and shots, under RLS); reached only through the definer RPCs,
-- not client-executable.
create or replace function public.online_reservation_count()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::int
  from public.analysis_permits p
  left join public.shots s on s.analysis_permit_id = p.id
  where p.user_id = (select auth.uid())
    and public.permit_backs_sync(p.status, p.outcome)
    and s.id is null
$$;

comment on function public.online_reservation_count() is
  'Permits of the caller that can still back a synced shot (permit_backs_sync: reserved at any age, or released/expired) and that no shot has settled. The reservation term of the offline allocation rule in issue_offline_grant().';

revoke all on function public.online_reservation_count() from public, anon, authenticated, service_role;

-- access_state(): scored stays lifetime_scored_count(); reserved_count keeps
-- the live-permit UI meaning and adds the offline holds the device carries.
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
  -- issue_offline_grant(), consume_offline_ticket() and the shots gate hold.
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
  -- Reservations are every permit still 'reserved' — at ANY age: a stale one
  -- backs a late sync exactly like a fresh one, so it holds its slot until it
  -- is synced, cancelled or swept — plus every outstanding offline ticket.
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
-- 4b. The shots write gate: offline holds are part of the allowance, and the
--     offline settlement is a third, vouched way to back a scored row.
--     Everything else is byte-for-byte 20260907000000 (permit link written
--     only under the sync vouch, PKP01/PKP02 verdicts, 24h live-permit rule
--     for direct INSERTs, lifetime allowance).
--
--     Allowance: a free identity may not hold lifetime_scored_count() +
--     offline_hold_count() ≥ 2 and still write a scored row — a direct INSERT
--     beside an outstanding ticket spends the ticket's slot otherwise (the
--     device renders that rating offline and the sync of the online permit
--     would be the third unit). The offline path settles a ticket that is
--     already `consumed` (not a hold any more) so its own slot is not double
--     counted.
--
--     Offline settlement: pickle.offline_ticket_id names the ticket
--     consume_offline_ticket() just recorded as consumed for THIS shot id and
--     THIS owner; the row is written with analysis_permit_id NULL and needs no
--     permit. Both vouches at once is an unknown state → refused. A direct
--     INSERT cannot set either vouch.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_scored_shot_permit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
  v_vouched uuid;
  v_offline_ticket uuid;
begin
  if v_uid is null then
    return new;
  end if;

  -- apply_synced_shot() names the permit it locked and validated for this
  -- insert; consume_offline_ticket() names the ticket it just consumed for
  -- this insert. Nothing else can set either (PostgREST exposes no set_config
  -- and the schema-exposed RPCs never take them from input).
  v_vouched := nullif(pg_catalog.current_setting('pickle.sync_permit_id', true), '')::uuid;
  v_offline_ticket := nullif(pg_catalog.current_setting('pickle.offline_ticket_id', true), '')::uuid;

  if v_vouched is not null and v_offline_ticket is not null then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: a row is backed by an online permit or by an offline ticket, never both',
      hint = 'offline.shot_not_chargeable';
  end if;

  -- The permit link is the vouch's to write: a direct INSERT may not claim a
  -- permit, and a vouched insert records the vouched permit and no other.
  if new.analysis_permit_id is not null
     and (v_vouched is null or new.analysis_permit_id <> v_vouched) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: analysis_permit_id is written only by apply_synced_shot for the permit it consumed',
      hint = 'access.permit_not_reserved';
  end if;
  new.analysis_permit_id := v_vouched;

  if new.result_kind <> 'scored' then
    if v_offline_ticket is not null then
      raise exception using
        errcode = 'PKP03',
        message = 'shots: an offline ticket settles only a scored shot',
        hint = 'offline.shot_not_chargeable';
    end if;
    return new;
  end if;

  -- Same key as reserve_analysis_permit() / apply_synced_shot() /
  -- consume_offline_ticket(): a direct writer racing itself (or a sync)
  -- serializes here. Re-entrant inside the RPCs, which already hold it for
  -- this transaction.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  if v_offline_ticket is not null then
    -- Offline settlement: the consumed event for exactly this ticket, this
    -- shot id and this owner must already be in the ledger (written by the
    -- settlement RPC in this transaction, under its vouch).
    if not exists (
      select 1 from public.offline_allocation_ledger c
      where c.ticket_id = v_offline_ticket
        and c.event = 'consumed'
        and c.shot_id = new.id
        and c.user_id = v_uid
    ) then
      raise exception using
        errcode = 'PKP03',
        message = 'shots: the offline ticket named for this shot has not been consumed for it',
        hint = 'offline.shot_not_chargeable';
    end if;
  elsif v_vouched is not null then
    -- Sync path: the ONE permit the shot names must back it. No fallback to
    -- any other reservation the caller may hold.
    if not exists (
      select 1 from public.analysis_permits p
      where p.user_id = v_uid
        and p.id = v_vouched
        and public.permit_backs_sync(p.status, p.outcome)
    ) then
      raise exception using
        errcode = 'PKP01',
        message = 'shots: the permit named for this synced shot is not acceptable backing',
        hint = 'access.permit_not_reserved';
    end if;
  elsif not exists (
    -- Direct client INSERT: byte-for-byte the pre-fix rule — a live reserved
    -- permit younger than 24h.
    select 1 from public.analysis_permits p
    where p.user_id = v_uid
      and p.status = 'reserved'
      and p.created_at > now() - interval '24 hours'
  ) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: a scored shot requires a live reserved analysis permit (use apply_synced_shot)',
      hint = 'access.permit_not_reserved';
  end if;

  select coalesce((
    select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b
    where b.user_id = v_uid
  ), false) into v_premium;

  if not v_premium and public.lifetime_scored_count() + public.offline_hold_count() >= 2 then
    raise exception using
      errcode = case when v_vouched is not null or v_offline_ticket is not null then 'PKP02' else 'insufficient_privilege' end,
      message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)',
      hint = 'access.paywall_required';
  end if;

  return new;
end;
$$;

comment on function public.enforce_scored_shot_permit() is
  'BEFORE INSERT gate on public.shots: analysis_permit_id may only be the permit apply_synced_shot() vouches for through the transaction-local pickle.sync_permit_id setting (a direct client INSERT must leave it NULL — 42501 otherwise). A scored row written from a client session must be backed by a live reserved permit (direct INSERT, < 24h) — or, under the sync vouch, by THAT permit alone (permit_backs_sync: reserved at any age, or released/expired; no fallback) — or, under the offline vouch (pickle.offline_ticket_id, set only by consume_offline_ticket()), by the consumed ledger event naming exactly this ticket, this shot id and this owner — and fit the lifetime free-rating allowance: lifetime_scored_count() + offline_hold_count() < 2 (premium bypasses the allowance, never the backing). A refusal inside a vouched insert raises SQLSTATE PKP01 (permit) / PKP02 (allowance) / PKP03 (offline ticket) so the RPC returns the contract verdict, not a grant error; a direct INSERT refusal stays 42501 (PostgREST 403). Runs under the same per-user advisory lock as reserve_analysis_permit()/apply_synced_shot()/consume_offline_ticket().';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4c. apply_synced_shot(): the free-limit backstop counts the offline holds.
--     Everything else is byte-for-byte 20260907100000.
-- ---------------------------------------------------------------------------
create or replace function public.apply_synced_shot(shot jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_permit_id uuid;
  v_session_id uuid;
  v_result_kind text;
  v_permit public.analysis_permits%rowtype;
  v_premium boolean;
  v_consumed integer;
  entry jsonb;
begin
  if v_uid is null then
    return 'auth.required';
  end if;

  v_id := (shot ->> 'id')::uuid;
  v_permit_id := (shot ->> 'analysisPermitId')::uuid;
  v_session_id := nullif(shot ->> 'sessionId', '')::uuid;
  v_result_kind := shot ->> 'resultKind';

  -- Idempotent replay: this user already owns the row. Checked before the
  -- lock so replays never contend.
  if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
    return 'accepted';
  end if;

  -- FREE-LIMIT BACKSTOP (1/2): take the same per-user lock reserve_analysis_
  -- permit uses, so the scored-shot count below cannot change under us and
  -- two concurrent syncs holding DIFFERENT permits cannot both pass it.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Idempotent replay, again, now that we hold the lock: a concurrent copy of
  -- this very sync may have committed while we waited. Its permit is already
  -- finalized/released, so the permit checks below would hand us a permanent
  -- verdict for a row the server holds. Ownership decides first.
  if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
    return 'accepted';
  end if;

  -- Lock the permit so a concurrent retry of the same sync serializes here.
  select * into v_permit
  from public.analysis_permits p
  where p.id = v_permit_id and p.user_id = v_uid
  for update;
  if not found then
    -- A settled permit of this user that the owner role deleted is consumed,
    -- not unknown: the same permanent verdict its row would have given.
    if public.permit_tombstoned(v_permit_id) then
      return 'access.permit_not_reserved';
    end if;
    return 'access.permit_not_found';
  end if;

  -- A permit this user reserved backs the shot at ANY age: still 'reserved'
  -- (the stale-permit sweep has not run), or already swept to
  -- released/expired while the device was offline. Every other state —
  -- consumed (finalized), released for the free limit, cancelled, any other
  -- abstention outcome, or a NULL/unknown outcome — cannot back a new shot
  -- (permit_backs_sync is NULL-safe: unknown → false → refused). The free
  -- allowance is decided by the lifetime count below, never by permit age.
  if not public.permit_backs_sync(v_permit.status, v_permit.outcome) then
    return 'access.permit_not_reserved';
  end if;

  -- ONE-PERMIT-ONE-SHOT, data layer: a permit id already linked to a shot is
  -- consumed whatever its row says (or however it came to exist again).
  if exists (select 1 from public.shots s where s.analysis_permit_id = v_permit_id) then
    return 'access.permit_not_reserved';
  end if;

  -- FREE-LIMIT BACKSTOP (2/2): holding a permit is not by itself authority to
  -- record a scored shot. If an extra permit was ever issued (every build
  -- before reserve_analysis_permit could do this), or a swept permit's slot
  -- was re-spent while the device was offline, a non-premium account still
  -- may not exceed two lifetime scored ratings. The permit is released rather
  -- than left reserved so it stops occupying an allowance slot and the sweep
  -- has nothing to collect.
  -- IDENTITY LEDGER: the count is lifetime_scored_count(), so a re-created
  -- account whose identity already spent both ratings is refused here too.
  -- OFFLINE HOLDS: a ticket handed to a device is a rating the device renders
  -- offline; the slot it holds is not this permit's to spend.
  if v_result_kind = 'scored' then
    select coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false) into v_premium;

    if not v_premium and public.lifetime_scored_count() + public.offline_hold_count() >= 2 then
      update public.analysis_permits
         set status = 'released', outcome = 'free_limit_exceeded'
       where id = v_permit_id and user_id = v_uid
         and public.permit_backs_sync(status, outcome);
      return 'access.paywall_required';
    end if;
  end if;

  if v_session_id is not null and not exists (
    select 1 from public.sessions se
    where se.id = v_session_id and se.user_id = v_uid
  ) then
    return 'shot.session_not_found';
  end if;

  -- Atomic write block: any failure rolls back the shot, its details, AND
  -- leaves the permit untouched (still backing a clean retry). The vouch is
  -- set inside the block so a failure reverts it with everything else.
  begin
    -- Tell the shots BEFORE INSERT gate which permit backs this row: the one
    -- locked and validated above, whatever its age. The gate decides on this
    -- permit alone, and the row records it (shots_analysis_permit_unique).
    perform pg_catalog.set_config('pickle.sync_permit_id', v_permit_id::text, true);

    insert into public.shots (
      id, user_id, session_id, analysis_permit_id, shot_type, camera_view,
      captured_at, start_ms, contact_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version, source
    ) values (
      v_id,
      v_uid,
      v_session_id,
      v_permit_id,
      shot ->> 'shotType',
      shot ->> 'cameraView',
      (shot ->> 'capturedAt')::timestamptz,
      (shot ->> 'startMs')::int,
      (shot ->> 'contactMs')::int,
      (shot ->> 'endMs')::int,
      (shot ->> 'overallScore')::numeric,
      (shot ->> 'confidence')::numeric,
      v_result_kind,
      shot -> 'versionVector' ->> 'appVersion',
      shot -> 'versionVector' ->> 'modelBundleVersion',
      shot -> 'versionVector' ->> 'poseModelVersion',
      shot -> 'versionVector' ->> 'paddleModelVersion',
      shot -> 'versionVector' ->> 'strokeDetectorVersion',
      shot -> 'versionVector' ->> 'phaseModelVersion',
      shot -> 'versionVector' ->> 'scoringModelVersion',
      shot -> 'versionVector' ->> 'shotConfigVersion',
      'real'
    );

    perform pg_catalog.set_config('pickle.sync_permit_id', '', true);

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'phases', '[]'::jsonb))
    loop
      insert into public.shot_phases (
        shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'startMs')::int,
        (entry ->> 'representativeMs')::int,
        (entry ->> 'endMs')::int,
        (entry ->> 'confidence')::numeric
      )
      on conflict (shot_id, phase_key) do nothing;
    end loop;

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'checkpoints', '[]'::jsonb))
    loop
      insert into public.shot_checkpoints (
        shot_id, user_id, checkpoint_key, score, confidence, band,
        direction, severity, applicable
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'score')::numeric,
        (entry ->> 'confidence')::numeric,
        entry ->> 'band',
        entry ->> 'direction',
        (entry ->> 'severity')::numeric,
        (entry ->> 'applicable')::boolean
      )
      on conflict (shot_id, checkpoint_key) do nothing;
    end loop;

    -- A scored shot finalizes its permit; an abstention releases it — in the
    -- SAME transaction as the shot write. A late or swept permit ends in
    -- exactly the state a fresh one does, so it can never back a second shot.
    -- ONE-PERMIT-ONE-SHOT: the row locked above must be the row consumed
    -- here; anything else rolls the whole write back.
    update public.analysis_permits
       set status = case when v_result_kind = 'scored' then 'finalized' else 'released' end,
           outcome = v_result_kind
     where id = v_permit_id and user_id = v_uid
       and public.permit_backs_sync(status, outcome);
    get diagnostics v_consumed = row_count;
    if v_consumed <> 1 then
      raise exception using
        errcode = 'check_violation',
        message = format('shots: permit %s was not consumed exactly once (%s rows)', v_permit_id, v_consumed);
    end if;

    return 'accepted';
  exception
    when unique_violation then
      -- The shot id settled concurrently. Ours → replay-accept; the permit
      -- already backs another row (shots_analysis_permit_unique) → the permit
      -- verdict; a different user's id (invisible under RLS) → permanent
      -- conflict.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      if exists (select 1 from public.shots s where s.analysis_permit_id = v_permit_id) then
        return 'access.permit_not_reserved';
      end if;
      return 'shot.id_conflict';
    when sqlstate 'PKP01' then
      -- The shots gate refused THIS permit under the vouch: a contract
      -- verdict the outbox settles, never a transient grant error. (Any real
      -- 42501 falls through to write_failed and keeps the rating on-device.)
      return 'access.permit_not_reserved';
    when sqlstate 'PKP02' then
      return 'access.paywall_required';
    when others then
      -- SQLSTATE ONLY: sqlerrm echoes the client's input for cast failures
      -- and would carry it into the edge function's logs. The five-char class
      -- is enough for operators; the edge maps every write_failed:* to the
      -- stable client code.
      return 'shot.write_failed:' || sqlstate;
  end;
end;
$$;

comment on function public.apply_synced_shot(jsonb) is
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Idempotent on the client-generated shot id: ownership is checked before AND after the per-user advisory lock, so a duplicate copy that lost the race replays as accepted instead of seeing its already-consumed permit. Backing is decided by permit_backs_sync() — reserved at any age, or swept to released/expired — NULL-safe and default-deny, so a released/NULL or any other settled permit is refused (access.permit_not_reserved) and the shot is never written; a permit id already recorded on a shot (shots.analysis_permit_id, unique) is refused the same way, as is a permit id of this user that was deleted while settled (analysis_permit_tombstones via permit_tombstoned()); the finalize UPDATE must consume exactly that one permit. Enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count() plus the outstanding offline holds (offline_hold_count()). A shots-gate refusal surfaces as its verdict (hint), never as shot.write_failed:42501. Other write failures return shot.write_failed:<SQLSTATE> only — never sqlerrm, which echoes client input.';

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

revoke all on function public.register_offline_device(text, text, boolean) from public, anon, service_role;
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

  -- Free identity: tickets this installation already holds for this account
  -- or one of its sign-in identities are re-issued (the original installation
  -- of a deleted-and-re-created account recovers its ticket here — the
  -- device row is gone, the ledger's installation key is not); new tickets
  -- come only out of what lifetime scored + online reservations + every
  -- outstanding offline hold leave of the 2 lifetime free ratings. An online
  -- reservation is every permit apply_synced_shot() would still honour
  -- (permit_backs_sync: reserved at any age, or swept to released/expired)
  -- that no shot has settled yet — online_reservation_count().
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
    user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at
  ) values (
    v_uid, v_device.id, 'identity_lifetime_free',
    coalesce((select max(g.generation) from public.offline_grants g where g.device_id = v_device.id), 0) + 1,
    v_now, v_now + interval '7 days', null
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
  return next;
  return;
end;
$$;

comment on function public.issue_offline_grant(text, integer) is
  'Issues the next-generation offline grant for one attested device of the caller (live API session required), under access_lock_key(uid). Pro: a lease ending at min(now + 7 days, verified entitlement expiry), no tickets. Free: re-issues the installation''s outstanding tickets owned by the caller''s account or sign-in identities (original-installation recovery across account re-creation) and allocates new ones only within lifetime_scored_count() + online_reservation_count() (every permit permit_backs_sync() still honours, at any age, not yet settled by a shot) + offline_hold_count() ≤ 2. Returns accepted | access.paywall_required | offline.device_not_registered | offline.device_not_attested | offline.invalid_input.';

revoke all on function public.issue_offline_grant(text, integer) from public, anon, service_role;
grant execute on function public.issue_offline_grant(text, integer) to authenticated;

-- Settlement: the ONE path that turns a ticket into a rating. Takes the
-- delivered shot as the same payload apply_synced_shot() takes, and writes it
-- itself — a shot that already exists (by any owner) is never chargeable,
-- whatever its columns say, because it was either paid for by an online
-- permit, counted before this ticket existed, or written by a client that
-- chose its own created_at. analysisPermitId in the payload, or any result
-- kind other than scored, is not chargeable either. Idempotent for the same
-- (ticket, shot id).
create or replace function public.consume_offline_ticket(p_ticket_id uuid, shot jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_session_id uuid;
  v_result_kind text;
  v_allocation public.offline_allocation_ledger%rowtype;
  v_terminal public.offline_allocation_ledger%rowtype;
  entry jsonb;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_ticket_id is null or shot is null or jsonb_typeof(shot) <> 'object' then
    return 'offline.invalid_input';
  end if;

  begin
    v_id := (shot ->> 'id')::uuid;
    v_session_id := nullif(shot ->> 'sessionId', '')::uuid;
  exception
    when others then
      return 'offline.invalid_input';
  end;
  v_result_kind := shot ->> 'resultKind';
  if v_id is null then
    return 'offline.invalid_input';
  end if;

  -- A rating an online permit paid for, or an abstention, never settles a
  -- ticket. Decided before anything is written.
  if nullif(shot ->> 'analysisPermitId', '') is not null or v_result_kind is distinct from 'scored' then
    return 'offline.shot_not_chargeable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));
  perform pg_catalog.pg_advisory_xact_lock(api_private.offline_ticket_lock_key(p_ticket_id));

  select * into v_allocation
  from public.offline_allocation_ledger a
  where a.ticket_id = p_ticket_id
    and a.event = 'allocated'
    and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid);
  if not found then
    return 'offline.ticket_not_found';
  end if;

  select * into v_terminal
  from public.offline_allocation_ledger t
  where t.ticket_id = p_ticket_id and t.event in ('consumed', 'released');
  if found then
    if v_terminal.event = 'consumed' then
      -- Replay of the settlement that already happened: the ticket's rating
      -- is on the server. Any other shot is not this ticket's.
      return case when v_terminal.shot_id = v_id then 'accepted' else 'offline.ticket_consumed' end;
    end if;
    return 'offline.ticket_released';
  end if;

  -- Chargeable only if the shot does not exist yet (any owner — an existing
  -- row was counted or paid for already, and the id is not ours to reuse)
  -- and no other ticket has named it.
  if exists (select 1 from public.shots s where s.id = v_id)
     or exists (
       select 1 from public.offline_allocation_ledger c
       where c.shot_id = v_id and c.event = 'consumed'
     ) then
    return 'offline.shot_not_chargeable';
  end if;

  if v_session_id is not null and not exists (
    select 1 from public.sessions se
    where se.id = v_session_id and se.user_id = v_uid
  ) then
    return 'shot.session_not_found';
  end if;

  -- Atomic write block: the consumed event, then the shot it names, then its
  -- details. Any failure rolls all of it back — the ticket stays outstanding
  -- and nothing is counted. The vouch is set inside the block so a failure
  -- reverts it with everything else.
  begin
    perform pg_catalog.set_config('pickle.offline_ticket_id', p_ticket_id::text, true);

    -- Written in the CALLER's name: after account re-creation the terminal
    -- row names the account that delivered the shot, while ticket/
    -- installation/identity hashes stay those of the allocation.
    insert into public.offline_allocation_ledger (
      user_id, device_id, grant_id, generation, ticket_id, event, shot_id, identity_hashes, installation_key_id
    ) values (
      v_uid, v_allocation.device_id, v_allocation.grant_id, v_allocation.generation,
      p_ticket_id, 'consumed', v_id, v_allocation.identity_hashes, v_allocation.installation_key_id
    );

    insert into public.shots (
      id, user_id, session_id, analysis_permit_id, shot_type, camera_view,
      captured_at, start_ms, contact_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version, source
    ) values (
      v_id,
      v_uid,
      v_session_id,
      null,
      shot ->> 'shotType',
      shot ->> 'cameraView',
      (shot ->> 'capturedAt')::timestamptz,
      (shot ->> 'startMs')::int,
      (shot ->> 'contactMs')::int,
      (shot ->> 'endMs')::int,
      (shot ->> 'overallScore')::numeric,
      (shot ->> 'confidence')::numeric,
      v_result_kind,
      shot -> 'versionVector' ->> 'appVersion',
      shot -> 'versionVector' ->> 'modelBundleVersion',
      shot -> 'versionVector' ->> 'poseModelVersion',
      shot -> 'versionVector' ->> 'paddleModelVersion',
      shot -> 'versionVector' ->> 'strokeDetectorVersion',
      shot -> 'versionVector' ->> 'phaseModelVersion',
      shot -> 'versionVector' ->> 'scoringModelVersion',
      shot -> 'versionVector' ->> 'shotConfigVersion',
      'real'
    );

    perform pg_catalog.set_config('pickle.offline_ticket_id', '', true);

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'phases', '[]'::jsonb))
    loop
      insert into public.shot_phases (
        shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'startMs')::int,
        (entry ->> 'representativeMs')::int,
        (entry ->> 'endMs')::int,
        (entry ->> 'confidence')::numeric
      )
      on conflict (shot_id, phase_key) do nothing;
    end loop;

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'checkpoints', '[]'::jsonb))
    loop
      insert into public.shot_checkpoints (
        shot_id, user_id, checkpoint_key, score, confidence, band,
        direction, severity, applicable
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'score')::numeric,
        (entry ->> 'confidence')::numeric,
        entry ->> 'band',
        entry ->> 'direction',
        (entry ->> 'severity')::numeric,
        (entry ->> 'applicable')::boolean
      )
      on conflict (shot_id, checkpoint_key) do nothing;
    end loop;

    return 'accepted';
  exception
    when sqlstate 'PKP02' then
      return 'access.paywall_required';
    when sqlstate 'PKP03' then
      return 'offline.shot_not_chargeable';
    when others then
      -- SQLSTATE ONLY: sqlerrm echoes the client's input for cast failures
      -- and would carry it into the edge function's logs.
      return 'shot.write_failed:' || sqlstate;
  end;
end;
$$;

comment on function public.consume_offline_ticket(uuid, jsonb) is
  'Settles one outstanding ticket owned by the caller''s account or sign-in identities against the scored shot the device rendered under it (live API session required), under access_lock_key(uid) and then the ticket''s own lock (api_private.offline_ticket_lock_key — two heirs of one identity race on the ticket, not on a user key): appends the consumed event and writes the shot itself (analysis_permit_id NULL) in one transaction, vouching through pickle.offline_ticket_id. A shot that already exists, names an analysisPermitId, or is not scored is never chargeable. Idempotent for the same (ticket, shot id). Returns accepted | offline.ticket_not_found | offline.ticket_consumed | offline.ticket_released | offline.shot_not_chargeable | offline.invalid_input | access.paywall_required | shot.session_not_found | shot.write_failed:<SQLSTATE>.';

revoke all on function public.consume_offline_ticket(uuid, jsonb) from public, anon, service_role;
grant execute on function public.consume_offline_ticket(uuid, jsonb) to authenticated;

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
  -- The one reason a client may state: it is handing an unused ticket back.
  if p_ticket_id is null or p_reason is null or p_reason <> 'unused_ticket_returned' then
    return 'offline.invalid_input';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));
  perform pg_catalog.pg_advisory_xact_lock(api_private.offline_ticket_lock_key(p_ticket_id));

  select * into v_allocation
  from public.offline_allocation_ledger a
  where a.ticket_id = p_ticket_id
    and a.event = 'allocated'
    and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid);
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
    user_id, device_id, grant_id, generation, ticket_id, event, reason, identity_hashes, installation_key_id
  ) values (
    v_uid, v_allocation.device_id, v_allocation.grant_id, v_allocation.generation,
    p_ticket_id, 'released', p_reason, v_allocation.identity_hashes, v_allocation.installation_key_id
  );
  return 'accepted';
end;
$$;

comment on function public.release_offline_ticket(uuid, text) is
  'Explicit, terminal return of one outstanding ticket owned by the caller''s account or sign-in identities (live API session required), under access_lock_key(uid) and then the ticket''s own lock; the only client reason is unused_ticket_returned — support_review is written by support through the table, never self-asserted here. A released ticket still counts against the entitlement and can never be consumed; a consumed ticket cannot be released. Idempotent. Returns accepted | offline.ticket_not_found | offline.ticket_consumed | offline.invalid_input.';

revoke all on function public.release_offline_ticket(uuid, text) from public, anon, service_role;
grant execute on function public.release_offline_ticket(uuid, text) to authenticated;
