-- ADV-08 — the API-only gate and the callable function surface.
--
-- Boundaries probed:
--   1. A valid bearer WITHOUT the x-pickle-api-key header (a leaked JWT used
--      straight against PostgREST) must get NOTHING from every table and every
--      client RPC, and must write nothing. Same with a wrong key, same for
--      anon carrying the correct key.
--   2. Catalogue: the set of public/api_private functions EXECUTABLE by
--      `authenticated` is exactly the documented client RPC surface; anon can
--      execute none of them; every SECURITY DEFINER function pins search_path;
--      the raw API key reader is not callable by any client role.
--   3. A well-formed request that passes the gate must still work (the gate
--      is not fail-closed for the real client).
\set ON_ERROR_STOP on
\set QUIET on
begin;

insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad81', 'adv08@example.com', '{"provider":"google"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad82', '00000000-0000-4000-8000-00000000ad81', 'google', 'adv08-google-sub');
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-00000000ad83', '00000000-0000-4000-8000-00000000ad81', now());
-- Real data a gated caller must not see: premium, one live reservation.
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
values ('00000000-0000-4000-8000-00000000ad81', true, now() + interval '30 days', now());
insert into public.analysis_permits (user_id, idempotency_key)
values ('00000000-0000-4000-8000-00000000ad81', 'adv08-seeded');
do $$ begin perform set_config('adv08.onboarding_before',
  (select onboarding_state from public.profiles where id = '00000000-0000-4000-8000-00000000ad81'), true); end $$;

create function pg_temp.adv08_probe(p_label text) returns text[] language plpgsql as $$
declare
  breaks text[] := '{}'; n int; r text; p uuid; t text;
begin
  -- Reads: every client table must be empty (or denied) for this caller.
  foreach t in array array['profiles', 'sessions', 'analysis_permits', 'shots', 'billing_entitlements'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n <> 0 then breaks := breaks || format('%s read %s rows of %s', p_label, n, t); end if;
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- Writes: a session insert / update must not land.
  begin
    insert into public.sessions (id, user_id, started_at)
    values (gen_random_uuid(), '00000000-0000-4000-8000-00000000ad81', now());
    breaks := breaks || format('%s inserted a session', p_label);
  exception when others then null;
  end;
  begin
    update public.sessions set ended_at = now() where id = '00000000-0000-4000-8000-00000000ad83';
    if found then breaks := breaks || format('%s updated a session', p_label); end if;
  exception when others then null;
  end;

  -- RPCs: must refuse (typed) or raise; never mint a permit.
  begin
    select result, permit_id into r, p from public.reserve_analysis_permit('adv08-' || p_label);
    if p is not null or r = 'accepted' then
      breaks := breaks || format('%s reserved a permit (%s)', p_label, r);
    end if;
  exception when others then null;
  end;
  -- access_state() is SECURITY INVOKER: a gated caller may get a row, but it
  -- must carry nothing true about the account (premium, spend, reservations).
  begin
    if exists (select 1 from public.access_state() a
               where a.premium or a.scored_count <> 0 or a.reserved_count <> 0) then
      breaks := breaks || format('%s read real data through access_state()', p_label);
    end if;
  exception when others then null;
  end;
  begin
    if public.identity_scored_count() is distinct from 0 then
      breaks := breaks || format('%s read identity_scored_count()=%s', p_label, public.identity_scored_count());
    end if;
  exception when others then null;
  end;
  begin
    perform public.complete_onboarding();
  exception when others then null;
  end;
  return breaks;
end $$;
grant execute on function pg_temp.adv08_probe(text) to authenticated, anon;

-- 1a. Correct user, no header.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad81';
select set_config('request.headers', '', true) \gset _
do $$
declare b text[] := pg_temp.adv08_probe('no-header');
begin
  if array_length(b, 1) > 0 then raise exception 'ADV-08 BREAK: %', array_to_string(b, ' | '); end if;
end $$;

-- 1b. Correct user, wrong key.
select set_config('request.headers', '{"x-pickle-api-key":"not-the-key"}', true) \gset _
do $$
declare b text[] := pg_temp.adv08_probe('wrong-key');
begin
  if array_length(b, 1) > 0 then raise exception 'ADV-08 BREAK: %', array_to_string(b, ' | '); end if;
end $$;

-- 1c. Header with an empty key and a key-shaped but unrelated JSON header.
select set_config('request.headers', '{"x-pickle-api-key":""}', true) \gset _
do $$
declare b text[] := pg_temp.adv08_probe('empty-key');
begin
  if array_length(b, 1) > 0 then raise exception 'ADV-08 BREAK: %', array_to_string(b, ' | '); end if;
end $$;
reset role;

-- 1d. anon with the CORRECT key (key leaked, no bearer).
do $$ begin perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role anon;
set local request.jwt.claim.sub = '';
do $$
declare b text[] := pg_temp.adv08_probe('anon+key');
begin
  if array_length(b, 1) > 0 then raise exception 'ADV-08 BREAK: %', array_to_string(b, ' | '); end if;
end $$;
reset role;

-- Nothing was written by any of the refused callers.
do $$
begin
  if (select count(*) from public.sessions where user_id = '00000000-0000-4000-8000-00000000ad81') <> 1
     or (select count(*) from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000ad81') <> 1
     or (select onboarding_state from public.profiles where id = '00000000-0000-4000-8000-00000000ad81') is distinct from
        current_setting('adv08.onboarding_before') then
    raise exception 'ADV-08 BREAK: a gated caller wrote through the gate';
  end if;
end $$;

-- 2. Callable surface catalogue.
do $$
declare
  expected text[] := array[
    'api_private.is_active_session()',
    'api_private.is_api_request()',
    'public.access_lock_key(p_uid uuid)',
    'public.access_state()',
    'public.apply_synced_shot(shot jsonb)',
    'public.complete_onboarding()',
    'public.identity_scored_count()',
    'public.is_api_session_active()',
    'public.lifetime_scored_count()',
    'public.permit_backs_sync(p_status text, p_outcome text)',
    'public.permit_tombstoned(p_permit_id uuid)',
    'public.reserve_analysis_permit(p_idempotency_key text)'
  ];
  observed text[]; anon_exec text[]; unpinned text[];
begin
  select coalesce(array_agg(sig order by sig), '{}') into observed from (
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'api_private')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      and p.proname not like 'dblink%'
  ) s;
  if observed <> expected then
    raise exception 'ADV-08 BREAK: authenticated EXECUTE surface drifted. observed=% expected=%', observed, expected;
  end if;

  select coalesce(array_agg(sig order by sig), '{}') into anon_exec from (
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'api_private')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname not like 'dblink%'
  ) s;
  if array_length(anon_exec, 1) > 0 then
    raise exception 'ADV-08 BREAK: anon can EXECUTE %', anon_exec;
  end if;

  select coalesce(array_agg(sig order by sig), '{}') into unpinned from (
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'api_private')
      and p.prosecdef
      and p.proname not like 'dblink%'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  ) s;
  if array_length(unpinned, 1) > 0 then
    raise exception 'ADV-08 BREAK: SECURITY DEFINER without a pinned search_path: %', unpinned;
  end if;

  if has_function_privilege('authenticated', 'public.get_api_request_key()', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_api_request_key()', 'EXECUTE') then
    raise exception 'ADV-08 BREAK: a client role can read the raw API request key';
  end if;
  if has_table_privilege('authenticated', 'api_private.request_key', 'SELECT')
     or has_table_privilege('anon', 'api_private.request_key', 'SELECT')
     or has_table_privilege('service_role', 'api_private.request_key', 'SELECT')
     or has_schema_privilege('anon', 'api_private', 'USAGE') then
    raise exception 'ADV-08 BREAK: api_private.request_key reachable by a client role';
  end if;
  -- authenticated needs USAGE on api_private for the policy predicates; the
  -- only callable objects there must be the two boolean gates.
  select coalesce(array_agg(p.oid::regprocedure::text order by 1), '{}') into unpinned
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_private'
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))
    and p.oid::regprocedure::text not in ('api_private.is_api_request()', 'api_private.is_active_session()');
  if array_length(unpinned, 1) > 0 then
    raise exception 'ADV-08 BREAK: client-callable api_private functions beyond the two gates: %', unpinned;
  end if;
end $$;

-- 3. The real client shape still works.
do $$ begin perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad81';
do $$
declare p uuid;
begin
  if (select count(*) from public.sessions) <> 1 then
    raise exception 'ADV-08 BREAK: the gate refuses a well-formed client read';
  end if;
  select permit_id into p from public.reserve_analysis_permit('adv08-real');
  if p is null then raise exception 'ADV-08 BREAK: the gate refuses a well-formed reservation'; end if;
  if not exists (select 1 from public.access_state() a where a.premium and a.scored_count = 0 and a.reserved_count = 2) then
    raise exception 'ADV-08 BREAK: access_state() hides real data from the real client';
  end if;
end $$;
reset role;

rollback;
\echo 'ADV-08 API gate and function surface: PASS'
