-- Adversarial pass 3 — what the REAL webhook_events / billing_entitlements
-- schema does with the payloads the edge webhook forwards verbatim.
-- Run against a throwaway Postgres with every migration applied
-- (see wf-webhook-events-attack-db.sh). Each block RAISEs on an unexpected
-- outcome so a failing invariant is a non-zero psql exit.

\set ON_ERROR_STOP on

-- A1: a NUL escape inside the JSON payload is rejected by jsonb — the audit
--     upsert fails, so the id is never recorded (same class as scenario 7).
do $$
begin
  begin
    insert into public.webhook_events (id, event_type, payload)
    values ('evt-nul', 'RENEWAL', '{"event":{"note":"a\u0000b"}}'::jsonb);
    raise exception 'A1: expected jsonb to reject \u0000, but the row was written';
  exception
    when untranslatable_character then
      raise notice 'A1 OK: jsonb rejects \u0000 (%)', sqlerrm;
  end;
end $$;

-- A2: an 8 KiB event id is accepted as the primary key (no size cap on
--     webhook_events.id) and the dedupe index works on it.
do $$
declare
  big text := 'evt-' || repeat('x', 8192);
  n int;
begin
  insert into public.webhook_events (id, event_type, payload)
  values (big, 'RENEWAL', '{}'::jsonb)
  on conflict (id) do nothing;
  insert into public.webhook_events (id, event_type, payload)
  values (big, 'RENEWAL', '{}'::jsonb)
  on conflict (id) do nothing;
  select count(*) into n from public.webhook_events where id = big;
  if n <> 1 then
    raise exception 'A2: expected exactly one row for the 8 KiB id, got %', n;
  end if;
  raise notice 'A2 OK: 8 KiB id stored once (length %)', length(big);
end $$;

-- A3: the empty-string id is a legal primary key, so two distinct events
--     with id '' collapse onto one audit row (edge scenario X3 on the DB side).
do $$
declare
  n int;
begin
  insert into public.webhook_events (id, event_type, app_user_id, payload)
  values ('', 'INITIAL_PURCHASE', '11111111-1111-4111-8111-111111111111', '{}'::jsonb)
  on conflict (id) do nothing;
  insert into public.webhook_events (id, event_type, app_user_id, payload)
  values ('', 'EXPIRATION', '22222222-2222-4222-8222-222222222222', '{}'::jsonb)
  on conflict (id) do nothing;
  select count(*) into n from public.webhook_events where id = '';
  if n <> 1 then
    raise exception 'A3: expected one row for id '''', got %', n;
  end if;
  if (select event_type from public.webhook_events where id = '') <> 'INITIAL_PURCHASE' then
    raise exception 'A3: first writer must win under ignoreDuplicates';
  end if;
  raise notice 'A3 OK: id '''' collapses two events onto one row';
end $$;

-- A4: billing_entitlements requires an existing profile — a TRANSFER
--     destination that has never signed in fails with 23503 (scenario 9's
--     injected error is the real one).
do $$
begin
  begin
    insert into public.billing_entitlements (user_id, premium, verified_at)
    values ('22222222-2222-4222-8222-222222222222', true, now())
    on conflict (user_id) do update set premium = excluded.premium, verified_at = excluded.verified_at;
    raise exception 'A4: expected 23503 for an unknown user_id';
  exception
    when foreign_key_violation then
      raise notice 'A4 OK: billing_entitlements upsert for an unknown profile → 23503 (%)', sqlerrm;
  end;
end $$;

-- A5: case-variant UUID strings are ONE uuid row — the edge fn's two RC
--     lookups for the same subject (X5) collapse onto a single upsert target.
do $$
declare
  uid uuid := 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  n int;
begin
  insert into auth.users (id, email) values (uid, 'case@example.com');
  insert into public.profiles (id) values (uid) on conflict do nothing;
  insert into public.billing_entitlements (user_id, premium, verified_at)
  values ('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', true, now())
  on conflict (user_id) do update set premium = excluded.premium;
  insert into public.billing_entitlements (user_id, premium, verified_at)
  values ('A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D', false, now())
  on conflict (user_id) do update set premium = excluded.premium;
  select count(*) into n from public.billing_entitlements where user_id = uid;
  if n <> 1 then
    raise exception 'A5: expected one row, got %', n;
  end if;
  if (select premium from public.billing_entitlements where user_id = uid) then
    raise exception 'A5: last writer (premium=false) must win';
  end if;
  raise notice 'A5 OK: case-variant UUIDs collapse onto one row, last writer wins';
end $$;

select 'wf-webhook-events-attack-db: all invariants held' as result;
