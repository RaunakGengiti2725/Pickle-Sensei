-- A05 — boundary values and clocks on the new RPC surface:
--   installation key: 128 chars accepted, 129 refused, leading '-', empty,
--     NUL-free unicode, whitespace → offline.invalid_input (never an error)
--   requested tickets: -1, 3, null → invalid_input; 0 with no outstanding
--     ticket → invalid_input, never a grant
--   environment: mismatch on re-registration, unknown environment
--   Pro lease: entitlement 1 hour out → lease ends at the entitlement;
--     entitlement 30 days out → lease exactly 7 days; entitlement 'infinity'
--     → 7 days; entitlement expired 1s ago with premium=true → NOT premium,
--     free path (no lease past a lapsed entitlement); premium=false with a
--     far-future expires_at → free path
-- Expected: every bound holds; no grant row ever violates the table checks.
begin;
\ir _prelude.sql

select pg_temp.mk_user('00000000-0000-4000-8000-00000000a501', 'google', 'google-sub-a05', '00000000-0000-4000-8000-0000000a0501');
do $$ begin perform set_config('request.headers', pg_temp.api_header(), true); end $$;

create function pg_temp.set_entitlement(p_uid uuid, p_premium boolean, p_expires timestamptz)
returns void language plpgsql security definer as $$
begin
  insert into public.billing_entitlements (user_id, premium, expires_at, verified_at, verification_order, active_entitlements)
  values (p_uid, p_premium, p_expires, clock_timestamp(), 0, case when p_premium then array['pickle_sensei_pro'] else '{}'::text[] end)
  on conflict (user_id) do update
    set premium = excluded.premium, expires_at = excluded.expires_at,
        verified_at = excluded.verified_at, active_entitlements = excluded.active_entitlements;
end $$;
grant execute on function pg_temp.set_entitlement(uuid, boolean, timestamptz) to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a501';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-0000000a0501"}';

do $$
declare
  uid uuid := (select auth.uid());
  key128 text := 'k' || repeat('x', 127);
  key129 text := 'k' || repeat('x', 128);
  r record; g record; k text;
begin
  -- installation key bounds
  select * into r from public.register_offline_device(key128, 'production', true);
  if r.result <> 'accepted' then raise exception 'A05 BREAK: a 128-char key is within bounds (got %)', r.result; end if;
  foreach k in array array[key129, '-leading-dash', '', ' ', 'k y', 'kéy', 'k/y', E'k\ty'] loop
    select * into r from public.register_offline_device(k, 'production', true);
    if r.result <> 'offline.invalid_input' then
      raise exception 'A05 BREAK: key % must be refused as invalid input (got %)', quote_literal(k), r.result;
    end if;
  end loop;
  select * into r from public.register_offline_device(null, 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: null key (got %)', r.result; end if;
  select * into r from public.register_offline_device('a05-key', 'staging', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: unknown environment (got %)', r.result; end if;
  select * into r from public.register_offline_device('a05-key', 'production', null);
  if r.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: null attestation flag (got %)', r.result; end if;

  -- environment pinning on re-registration
  select * into r from public.register_offline_device('a05-key', 'production', true);
  if r.result <> 'accepted' then raise exception 'A05 precondition: registration (got %)', r.result; end if;
  select * into r from public.register_offline_device('a05-key', 'development', true);
  if r.result <> 'offline.device_environment_mismatch' then
    raise exception 'A05 BREAK: a known key cannot switch environment (got %)', r.result;
  end if;
  select * into r from public.register_offline_device('a05-key', 'production', false);
  if r.result <> 'accepted' or r.attestation_state <> 'attested' then
    raise exception 'A05 BREAK: re-registration never downgrades attestation (got %, %)', r.result, r.attestation_state;
  end if;

  -- requested-ticket bounds (free path, nothing outstanding)
  foreach k in array array['-1', '3', '2147483647', '-2147483648'] loop
    select * into g from public.issue_offline_grant('a05-key', k::int);
    if g.result <> 'offline.invalid_input' then
      raise exception 'A05 BREAK: requested % must be invalid input (got %)', k, g.result;
    end if;
  end loop;
  select * into g from public.issue_offline_grant('a05-key', null);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: null request (got %)', g.result; end if;
  select * into g from public.issue_offline_grant('a05-key', 0);
  if g.result <> 'offline.invalid_input' or g.grant_id is not null then
    raise exception 'A05 BREAK: requesting 0 with nothing outstanding must not mint a grant (got %, %)', g.result, g.grant_id;
  end if;
  select * into g from public.issue_offline_grant('a05-unregistered', 1);
  if g.result <> 'offline.device_not_registered' then raise exception 'A05 BREAK: unregistered key (got %)', g.result; end if;
  if pg_temp.tickets_ever_allocated(uid) <> 0 then
    raise exception 'A05 BREAK: refused requests must allocate nothing (got %)', pg_temp.tickets_ever_allocated(uid);
  end if;

  -- Pro lease clocks
  perform pg_temp.set_entitlement(uid, true, now() + interval '1 hour');
  select * into g from public.issue_offline_grant('a05-key', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'verified_store' or g.ticket_ids <> '{}'::uuid[]
     or g.expires_at <> now() + interval '1 hour' or g.expires_at > g.entitlement_expires_at then
    raise exception 'A05 BREAK: a 1-hour entitlement must bound the lease to 1 hour (got % % exp=% ent=%)',
      g.result, g.entitlement_source, g.expires_at, g.entitlement_expires_at;
  end if;

  perform pg_temp.set_entitlement(uid, true, now() + interval '30 days');
  select * into g from public.issue_offline_grant('a05-key', 2);
  if g.result <> 'accepted' or g.expires_at <> g.issued_at + interval '7 days' then
    raise exception 'A05 BREAK: a 30-day entitlement must still cap the lease at 7 days (got % exp=% issued=%)', g.result, g.expires_at, g.issued_at;
  end if;

  perform pg_temp.set_entitlement(uid, true, 'infinity'::timestamptz);
  select * into g from public.issue_offline_grant('a05-key', 2);
  if g.result <> 'accepted' or g.expires_at <> g.issued_at + interval '7 days' then
    raise exception 'A05 BREAK: an unbounded entitlement must cap the lease at 7 days (got % exp=%)', g.result, g.expires_at;
  end if;

  perform pg_temp.set_entitlement(uid, true, now() - interval '1 second');
  select * into g from public.issue_offline_grant('a05-key', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'A05 BREAK: a lapsed entitlement is not Pro — the free path applies (got % % tickets=%)', g.result, g.entitlement_source, g.ticket_ids;
  end if;

  perform pg_temp.set_entitlement(uid, false, now() + interval '400 days');
  select * into g from public.issue_offline_grant('a05-key', 2);
  if g.result <> 'accepted' or g.entitlement_source <> 'identity_lifetime_free' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'A05 BREAK: premium=false with a future expires_at is not Pro (got % %)', g.result, g.entitlement_source;
  end if;

  -- the same 2 tickets, re-issued, never a third
  if pg_temp.tickets_ever_allocated(uid) <> 2 then
    raise exception 'A05 BREAK: % tickets ever allocated across the free refreshes', pg_temp.tickets_ever_allocated(uid);
  end if;
end $$;

-- every persisted lease respects the table's own bounds
reset role;
do $$
begin
  if exists (select 1 from public.offline_grants g
             where g.user_id = '00000000-0000-4000-8000-00000000a501'
               and (g.expires_at > g.issued_at + interval '7 days'
                    or (g.entitlement_expires_at is not null and g.expires_at > g.entitlement_expires_at))) then
    raise exception 'A05 BREAK: a persisted lease exceeds 7 days or its entitlement';
  end if;
end $$;

rollback;
\echo A05 PASSED
