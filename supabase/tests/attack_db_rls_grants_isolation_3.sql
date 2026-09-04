-- ============================================================================
-- Pickle Sensei — adversarial pass 3: db-rls-grants-isolation (HELD matrix).
--
-- Runs after every migration in supabase/migrations, exactly like
-- security_regression.sql (see run_attack_db_rls_grants_isolation_3.sh). Every
-- case below is an ATTACK that the database is expected to defeat; the case
-- asserts the exact denial (SQLSTATE / RPC status / row count) and the state
-- invariants that must survive the attempt. Any assertion failure aborts the
-- script (ON_ERROR_STOP) with the failing case name.
--
-- Scenarios whose attack SUCCEEDS on the audited revision live in
-- attack_db_rls_grants_isolation_3_findings.sql instead, so this file stays
-- green and documents the boundary that HELD.
--
-- Matrix:
--   K1. account_deletion_requests owner reassignment (Alice → Bob) is refused
--       by the UPDATE WITH CHECK; Bob gains no challenge row
--   K2. apply_synced_shot() with another user's shot id returns
--       shot.id_conflict (scored AND abstention, rapid repeats), the caller's
--       permit stays reserved, no row leaks into the caller's row space
--   K3. sessions PK collision: insert-or-ignore inserts 0 rows, the id stays
--       invisible, DO UPDATE variants are refused (RLS USING / column grant)
--   K4. anon has no EXECUTE on lifetime_scored_count(),
--       identity_scored_count(), access_lock_key(uuid),
--       reserve_analysis_permit(text) (+ apply_synced_shot, access_state)
--   K5. apply_synced_shot() with a malformed id raises 22P02
--       invalid_text_representation BEFORE any lock/write (pinned; seeded fuzz
--       over 64 garbage ids, setseed(0.42)); structurally-empty payloads
--       return a status string
--   K6. account_deletion_feedback cannot be rewritten from a nested trigger
--       by a CLIENT role even when it owns a trampoline table (grants hold);
--       the ledger trigger blocks nested UPDATE for every role
--   K7. analysis_permits.outcome / created_at / status abuse in the owner's
--       own row is bounded (size cap, no created_at grant, status CHECK)
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000000a', 'alice@example.com',
   '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@example.com',
   '{"full_name":"Bob"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000a',
   '{"sub":"google-sub-alice","email":"alice@example.com"}'),
  ('apple', 'apple-sub-bob', '00000000-0000-4000-8000-00000000000b',
   '{"sub":"apple-sub-bob","email":"bob@example.com"}');

do $$
begin
  if (select count(*) from public.profiles) <> 2 then
    raise exception 'SETUP: handle_new_user trigger did not provision profiles';
  end if;
end $$;

-- Shared shot payload builder (owner-agnostic; the RPC stamps user_id itself).
create function pg_temp.shot_payload(
  p_id text, p_permit uuid, p_kind text, p_session text default null
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.shot_payload(text, uuid, text, text)
  to authenticated, anon;

-- ─────────────── Alice fixture: session d1, permit a-k1, scored shot e1 ──────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';

insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1',
        '00000000-0000-4000-8000-00000000000a', now());

do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('alice-k1');
  if r.result <> 'accepted' then
    raise exception 'SETUP: Alice reserve must be accepted (got %)', r.result;
  end if;
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e1', r.permit_id, 'scored',
    '00000000-0000-4000-8000-0000000000d1'));
  if v <> 'accepted' then
    raise exception 'SETUP: Alice scored sync must be accepted (got %)', v;
  end if;
end $$;

insert into public.account_deletion_requests (user_id)
values ('00000000-0000-4000-8000-00000000000a');

-- ───────────── K1: deletion-request owner reassignment (Alice → Bob) ─────────

do $$
declare n int;
begin
  begin
    update public.account_deletion_requests
       set user_id = '00000000-0000-4000-8000-00000000000b'
     where user_id = '00000000-0000-4000-8000-00000000000a';
    get diagnostics n = row_count;
    -- Postgres raises on a WITH CHECK failure; reaching here means the row was
    -- either not visible (0) or — the breach — moved to Bob.
    if n <> 0 then
      raise exception 'K1: owner reassignment updated % row(s)', n;
    end if;
    raise exception 'K1: expected WITH CHECK violation, got 0-row update';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%row-level security%' then
        raise exception 'K1: unexpected 42501 (%)', sqlerrm;
      end if;
  end;
  if (select count(*) from public.account_deletion_requests
      where user_id = '00000000-0000-4000-8000-00000000000a') <> 1 then
    raise exception 'K1: Alice''s challenge row must be untouched';
  end if;
end $$;

-- Rapid repeat: 20 back-to-back attempts, every one refused, state unchanged.
do $$
declare i int; refused int := 0;
begin
  for i in 1..20 loop
    begin
      update public.account_deletion_requests
         set user_id = '00000000-0000-4000-8000-00000000000b';
      raise exception 'K1: repeat % succeeded', i;
    exception when insufficient_privilege then refused := refused + 1;
    end;
  end loop;
  if refused <> 20 then raise exception 'K1: only % of 20 refused', refused; end if;
end $$;

set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
begin
  if (select count(*) from public.account_deletion_requests) <> 0 then
    raise exception 'K1: Bob must not gain a challenge row';
  end if;
  if exists (select 1 from public.account_deletion_requests
             where user_id = '00000000-0000-4000-8000-00000000000b') then
    raise exception 'K1: Bob-owned challenge row appeared';
  end if;
end $$;

-- ──────────── K2: Bob syncs a shot whose id already belongs to Alice ─────────

do $$
declare r record; v text; i int; st text; oc text;
begin
  select * into r from public.reserve_analysis_permit('bob-k1');
  if r.result <> 'accepted' then
    raise exception 'K2: Bob reserve must be accepted (got %)', r.result;
  end if;

  -- scored collision
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e1', r.permit_id, 'scored'));
  if v <> 'shot.id_conflict' then
    raise exception 'K2a: cross-user shot id must be shot.id_conflict (got %)', v;
  end if;

  -- abstention collision (different code path: no free-limit backstop)
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e1', r.permit_id, 'low_confidence'));
  if v <> 'shot.id_conflict' then
    raise exception 'K2b: abstention on foreign id must be shot.id_conflict (got %)', v;
  end if;

  -- rapid repeats: 25 consecutive collisions, none accepted
  for i in 1..25 loop
    v := public.apply_synced_shot(pg_temp.shot_payload(
      '00000000-0000-4000-8000-0000000000e1', r.permit_id, 'scored'));
    if v <> 'shot.id_conflict' then
      raise exception 'K2c: repeat % returned %', i, v;
    end if;
  end loop;

  -- foreign session id inside the payload
  v := public.apply_synced_shot(pg_temp.shot_payload(
    '00000000-0000-4000-8000-0000000000e9', r.permit_id, 'scored',
    '00000000-0000-4000-8000-0000000000d1'));
  if v <> 'shot.session_not_found' then
    raise exception 'K2d: Alice''s session id must be shot.session_not_found (got %)', v;
  end if;

  select p.status, p.outcome into st, oc
    from public.analysis_permits p where p.id = r.permit_id;
  if st <> 'reserved' or oc is not null then
    raise exception 'K2: Bob''s permit must remain reserved/null (got %/%)', st, oc;
  end if;
  if (select count(*) from public.shots) <> 0 then
    raise exception 'K2: no shot may land in Bob''s row space';
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000e1') then
    raise exception 'K2: Alice''s shot must stay invisible to Bob';
  end if;
  if (select reserved_count from public.access_state()) <> 1
     or (select scored_count from public.access_state()) <> 0 then
    raise exception 'K2: Bob''s access_state must be scored 0 / reserved 1';
  end if;
end $$;

-- ────────────── K3: Bob inserts a session with Alice's session id ────────────

do $$
declare n int;
begin
  insert into public.sessions (id, user_id, started_at)
  values ('00000000-0000-4000-8000-0000000000d1',
          '00000000-0000-4000-8000-00000000000b', now())
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'K3a: insert-or-ignore on a foreign id inserted % row(s)', n;
  end if;
  if exists (select 1 from public.sessions
             where id = '00000000-0000-4000-8000-0000000000d1') then
    raise exception 'K3a: Bob can select Alice''s session id';
  end if;
  if (select count(*) from public.sessions) <> 0 then
    raise exception 'K3a: Bob must see zero sessions';
  end if;

  -- The bare insert surfaces the PK conflict (the API's 409 session.id_conflict).
  begin
    insert into public.sessions (id, user_id, started_at)
    values ('00000000-0000-4000-8000-0000000000d1',
            '00000000-0000-4000-8000-00000000000b', now());
    raise exception 'K3b: bare insert on a foreign id must raise unique_violation';
  exception when unique_violation then null;
  end;

  -- DO UPDATE on an owner-scoped column: the existing row fails the UPDATE
  -- USING policy, Postgres raises instead of silently touching Alice's row.
  begin
    insert into public.sessions (id, user_id, started_at)
    values ('00000000-0000-4000-8000-0000000000d1',
            '00000000-0000-4000-8000-00000000000b', now())
    on conflict (id) do update set ended_at = now();
    raise exception 'K3c: upsert DO UPDATE ended_at must be RLS-refused';
  exception when insufficient_privilege then
    if sqlerrm not like '%row-level security%' then
      raise exception 'K3c: unexpected 42501 (%)', sqlerrm;
    end if;
  end;

  -- DO UPDATE on user_id: no column grant at all.
  begin
    insert into public.sessions (id, user_id, started_at)
    values ('00000000-0000-4000-8000-0000000000d1',
            '00000000-0000-4000-8000-00000000000b', now())
    on conflict (id) do update set user_id = excluded.user_id;
    raise exception 'K3d: upsert DO UPDATE user_id must be grant-refused';
  exception when insufficient_privilege then
    if sqlerrm not like '%permission denied%' then
      raise exception 'K3d: unexpected 42501 (%)', sqlerrm;
    end if;
  end;

  update public.sessions set ended_at = now()
   where id = '00000000-0000-4000-8000-0000000000d1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'K3e: Bob updated Alice''s session'; end if;
  delete from public.sessions where id = '00000000-0000-4000-8000-0000000000d1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'K3f: Bob deleted Alice''s session'; end if;
end $$;

-- Alice's session is intact and still hers.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
begin
  if not exists (select 1 from public.sessions
                 where id = '00000000-0000-4000-8000-0000000000d1'
                   and user_id = '00000000-0000-4000-8000-00000000000a'
                   and ended_at is null) then
    raise exception 'K3: Alice''s session must be unchanged';
  end if;
end $$;

reset role;

-- ───────────────── K4: anon EXECUTE on the protected functions ───────────────

set local role anon;
do $$
declare v bigint;
begin
  begin
    v := public.lifetime_scored_count();
    raise exception 'K4a: anon executed lifetime_scored_count()';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for function%' then
      raise exception 'K4a: denied by a later layer, not the EXECUTE grant (%)', sqlerrm;
    end if;
  end;
  begin
    v := public.identity_scored_count();
    raise exception 'K4b: anon executed identity_scored_count()';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for function%' then
      raise exception 'K4b: denied by a later layer, not the EXECUTE grant (%)', sqlerrm;
    end if;
  end;
  begin
    v := public.access_lock_key(gen_random_uuid());
    raise exception 'K4c: anon executed access_lock_key(uuid)';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for function%' then
      raise exception 'K4c: denied by a later layer, not the EXECUTE grant (%)', sqlerrm;
    end if;
  end;
  begin
    perform * from public.reserve_analysis_permit('k');
    raise exception 'K4d: anon executed reserve_analysis_permit(text)';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for function%' then
      raise exception 'K4d: denied by a later layer, not the EXECUTE grant (%)', sqlerrm;
    end if;
  end;
  begin
    perform public.apply_synced_shot('{"id":"not-a-uuid"}'::jsonb);
    raise exception 'K4e: anon executed apply_synced_shot(jsonb)';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for function%' then
      raise exception 'K4e: denied by a later layer, not the EXECUTE grant (%)', sqlerrm;
    end if;
  end;
  begin
    perform * from public.access_state();
    raise exception 'K4f: anon executed access_state()';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for function%' then
      raise exception 'K4f: denied by a later layer, not the EXECUTE grant (%)', sqlerrm;
    end if;
  end;
  begin
    perform public.free_rating_identity_hash('google', 'google-sub-alice');
    raise exception 'K4g: anon executed free_rating_identity_hash()';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for function%' then
      raise exception 'K4g: denied by a later layer, not the EXECUTE grant (%)', sqlerrm;
    end if;
  end;
  -- anon must not even see the ledger or the permits
  begin
    perform * from public.free_rating_ledger;
    raise exception 'K4h: anon read free_rating_ledger';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for table%' then
      raise exception 'K4h: unexpected 42501 (%)', sqlerrm;
    end if;
  end;
  begin
    perform * from public.analysis_permits;
    raise exception 'K4i: anon read analysis_permits';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for table%' then
      raise exception 'K4i: unexpected 42501 (%)', sqlerrm;
    end if;
  end;
end $$;
reset role;

-- ────────── K5: malformed shot id in apply_synced_shot() — pinned ────────────
-- Pinned behaviour on this revision: the cast `(shot ->> 'id')::uuid` runs
-- before the advisory lock and before any write, so a malformed id raises
-- SQLSTATE 22P02 (invalid_text_representation) — it does NOT return a status
-- string. The edge function validates UUIDs before calling the RPC, so only a
-- direct PostgREST caller ever sees this; nothing is written either way.

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare v text; shots_before int; permits_before text; i int; garbage text;
begin
  select count(*) into shots_before from public.shots;
  select string_agg(id::text || ':' || status || ':' || coalesce(outcome, ''), ','
                    order by id)
    into permits_before from public.analysis_permits;

  begin
    v := public.apply_synced_shot('{"id":"not-a-uuid"}'::jsonb);
    raise exception 'K5a: malformed id returned a status string (%) — behaviour changed', v;
  exception when invalid_text_representation then null;
  end;

  -- malformed permit id / session id take the same path
  begin
    v := public.apply_synced_shot(
      '{"id":"00000000-0000-4000-8000-0000000000ff","analysisPermitId":"nope"}'::jsonb);
    raise exception 'K5b: malformed analysisPermitId returned %', v;
  exception when invalid_text_representation then null;
  end;
  begin
    v := public.apply_synced_shot(
      '{"id":"00000000-0000-4000-8000-0000000000ff","analysisPermitId":"00000000-0000-4000-8000-0000000000ff","sessionId":"garbage"}'::jsonb);
    raise exception 'K5c: malformed sessionId returned %', v;
  exception when invalid_text_representation then null;
  end;

  -- unicode, numeric, huge (1 MiB) ids
  begin
    v := public.apply_synced_shot(jsonb_build_object('id', 'ゼロ幅​文字'));
    raise exception 'K5d: unicode id returned %', v;
  exception when invalid_text_representation then null;
  end;
  begin
    v := public.apply_synced_shot(jsonb_build_object('id', 12345));
    raise exception 'K5e: numeric id returned %', v;
  exception when invalid_text_representation then null;
  end;
  begin
    v := public.apply_synced_shot(jsonb_build_object('id', repeat('a', 1024 * 1024)));
    raise exception 'K5f: 1 MiB id returned %', v;
  exception when invalid_text_representation then null;
  end;

  -- seeded fuzz: 64 garbage ids derived from setseed(0.42)
  perform setseed(0.42);
  for i in 1..64 loop
    -- a non-hex 'g' guarantees the string can never parse as a uuid
    garbage := substr(md5(random()::text), 1, 1 + (random() * 40)::int)
               || case when random() < 0.5 then '-g' else 'g' end
               || substr(md5(random()::text), 1, (random() * 30)::int);
    begin
      v := public.apply_synced_shot(jsonb_build_object('id', garbage));
      raise exception 'K5g: fuzz #% id % returned %', i, garbage, v;
    exception when invalid_text_representation then null;
    end;
  end loop;

  -- structurally empty payloads DO return a status string (missing id/permit
  -- cast to NULL): the RPC reports the permit as not found, writes nothing.
  foreach garbage in array array['{}', '[]', 'null', '"str"', '{"id":null}'] loop
    v := public.apply_synced_shot(garbage::jsonb);
    if v <> 'access.permit_not_found' then
      raise exception 'K5h: payload % returned % (expected access.permit_not_found)', garbage, v;
    end if;
  end loop;

  if (select count(*) from public.shots) <> shots_before then
    raise exception 'K5: a malformed payload wrote a shot';
  end if;
  if (select string_agg(id::text || ':' || status || ':' || coalesce(outcome, ''), ','
                        order by id) from public.analysis_permits) is distinct from permits_before then
    raise exception 'K5: a malformed payload touched a permit';
  end if;
end $$;
reset role;

-- ───── K6: nested-trigger rewrite of the exit survey from a CLIENT role ──────
-- Hosted worst case: give `authenticated` CREATE on public so it can own a
-- trampoline table + trigger. The nested UPDATE/DELETE still runs as the
-- invoker, so the missing UPDATE/DELETE grant must refuse it at depth > 1.

insert into public.account_deletion_feedback (user_id, reason, details)
values ('00000000-0000-4000-8000-00000000000a', 'other', 'orig');
grant create on schema public to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
create table public.__attack3_client_tramp (id int);
create function public.__attack3_client_upd() returns trigger
language plpgsql as $$
begin
  update public.account_deletion_feedback set details = 'pwned';
  return new;
end $$;
create function public.__attack3_client_del() returns trigger
language plpgsql as $$
begin
  delete from public.account_deletion_feedback;
  return new;
end $$;
create trigger upd before insert on public.__attack3_client_tramp
  for each row execute function public.__attack3_client_upd();
do $$
begin
  begin
    insert into public.__attack3_client_tramp values (1);
    raise exception 'K6a: client nested UPDATE of the exit survey succeeded';
  exception when insufficient_privilege then
    if sqlerrm not like '%permission denied%' then
      raise exception 'K6a: unexpected 42501 (%)', sqlerrm;
    end if;
  end;
end $$;
drop trigger upd on public.__attack3_client_tramp;
create trigger del before insert on public.__attack3_client_tramp
  for each row execute function public.__attack3_client_del();
do $$
begin
  begin
    insert into public.__attack3_client_tramp values (2);
    raise exception 'K6b: client nested DELETE of the exit survey succeeded';
  exception when insufficient_privilege then
    if sqlerrm not like '%permission denied%' then
      raise exception 'K6b: unexpected 42501 (%)', sqlerrm;
    end if;
  end;
end $$;
reset role;
revoke create on schema public from authenticated;

do $$
begin
  if (select string_agg(details, ',') from public.account_deletion_feedback) <> 'orig' then
    raise exception 'K6: exit survey row was altered by a client nested trigger';
  end if;
end $$;

-- The ledger trigger (reject_ledger_mutation) refuses nested UPDATE for EVERY
-- role — including the table owner — so a depth-1-only guard is not the norm.
insert into public.consent_records (user_id, scope, action)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'withdraw');
create table public.__attack3_owner_tramp (id int);
create function public.__attack3_owner_ledger_upd() returns trigger
language plpgsql as $$
begin
  update public.consent_records set action = 'grant';
  return new;
end $$;
create trigger upd before insert on public.__attack3_owner_tramp
  for each row execute function public.__attack3_owner_ledger_upd();
do $$
begin
  begin
    insert into public.__attack3_owner_tramp values (1);
    raise exception 'K6c: owner nested UPDATE of consent_records succeeded';
  exception when insufficient_privilege then
    if sqlerrm not like '%append-only%' then
      raise exception 'K6c: unexpected 42501 (%)', sqlerrm;
    end if;
  end;
  if (select string_agg(action, ',') from public.consent_records) <> 'withdraw' then
    raise exception 'K6c: consent ledger was rewritten';
  end if;
end $$;

-- ───────── K7: owner-row abuse of analysis_permits is bounded ────────────────

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
declare n int;
begin
  -- huge outcome: size cap (analysis_permits_key_bounds, 50 chars)
  begin
    update public.analysis_permits set outcome = repeat('x', 5 * 1024 * 1024)
     where idempotency_key = 'alice-k1';
    raise exception 'K7a: 5 MiB outcome accepted';
  exception when check_violation then null;
  end;
  -- created_at (the 24h reserve window / expiry clock) has no client grant
  begin
    update public.analysis_permits set created_at = now() + interval '30 days'
     where idempotency_key = 'alice-k1';
    raise exception 'K7b: client moved a permit clock (created_at)';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set updated_at = now()
     where idempotency_key = 'alice-k1';
    raise exception 'K7c: client wrote updated_at';
  exception when insufficient_privilege then null;
  end;
  -- status outside the lifecycle vocabulary
  begin
    update public.analysis_permits set status = 'bogus'
     where idempotency_key = 'alice-k1';
    raise exception 'K7d: invalid status accepted';
  exception when check_violation then null;
  end;
  -- identity columns
  begin
    update public.analysis_permits set user_id = '00000000-0000-4000-8000-00000000000b'
     where idempotency_key = 'alice-k1';
    raise exception 'K7e: client rewrote permit user_id';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set idempotency_key = 'alice-k1-b'
     where idempotency_key = 'alice-k1';
    raise exception 'K7f: client rewrote idempotency_key';
  exception when insufficient_privilege then null;
  end;
  -- Bob's permit is out of reach entirely
  update public.analysis_permits set status = 'released'
   where idempotency_key = 'bob-k1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'K7g: Alice touched Bob''s permit'; end if;
end $$;
reset role;

rollback;

\echo ATTACK PASS 3 (db-rls-grants-isolation) HELD MATRIX: ALL CASES PASSED
