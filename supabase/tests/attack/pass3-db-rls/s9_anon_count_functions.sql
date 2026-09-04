-- S9: with no request.jwt.claim.sub, anon (and an authenticated role with no
-- claim) calling public.identity_scored_count() / public.lifetime_scored_count()
-- / public.access_state() must get insufficient_privilege or 0 — never Alice's
-- count. Alice's ledger is seeded at 2 so any leak is visible.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _seed_alice.sql

insert into public.free_rating_ledger (identity_hash, scored_count)
values (public.free_rating_identity_hash('google', 'google-sub-alice'), 2);

-- Sanity: Alice herself reads 2.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
do $$
begin
  if public.identity_scored_count() <> 2 or public.lifetime_scored_count() <> 2 then
    raise exception 'S9 setup: Alice must read 2';
  end if;
end $$;
reset role;

-- S9a: anon, no claim at all.
set local role anon;
reset request.jwt.claim.sub;
do $$
declare v int;
begin
  begin
    v := public.identity_scored_count();
    if v <> 0 then
      raise exception 'S9a: BROKEN anon identity_scored_count() returned % (leak)', v;
    end if;
    raise notice 'RESULT S9a: HELD anon identity_scored_count() = 0';
  exception when insufficient_privilege then
    raise notice 'RESULT S9a: HELD anon identity_scored_count() → insufficient_privilege';
  end;
  begin
    v := public.lifetime_scored_count();
    if v <> 0 then
      raise exception 'S9a: BROKEN anon lifetime_scored_count() returned % (leak)', v;
    end if;
    raise notice 'RESULT S9a: HELD anon lifetime_scored_count() = 0';
  exception when insufficient_privilege then
    raise notice 'RESULT S9a: HELD anon lifetime_scored_count() → insufficient_privilege';
  end;
  begin
    perform * from public.access_state();
    raise notice 'RESULT S9a: INFO anon access_state() executable';
  exception when insufficient_privilege then
    raise notice 'RESULT S9a: HELD anon access_state() → insufficient_privilege';
  end;
end $$;
reset role;

-- S9b: anon with an EMPTY claim string (auth.uid() → null via nullif).
set local role anon;
set local request.jwt.claim.sub = '';
do $$
declare v int;
begin
  begin
    v := public.identity_scored_count();
    if v <> 0 then raise exception 'S9b: BROKEN leak %', v; end if;
    raise notice 'RESULT S9b: HELD anon(empty sub) identity_scored_count() = 0';
  exception when insufficient_privilege then
    raise notice 'RESULT S9b: HELD anon(empty sub) identity_scored_count() → insufficient_privilege';
  end;
end $$;
reset role;

-- S9c: authenticated role but no claim (a mis-issued JWT without sub).
set local role authenticated;
reset request.jwt.claim.sub;
do $$
declare v int; a record;
begin
  v := public.identity_scored_count();
  if v <> 0 then
    raise exception 'S9c: BROKEN authenticated-without-sub identity_scored_count() returned %', v;
  end if;
  v := public.lifetime_scored_count();
  if v <> 0 then
    raise exception 'S9c: BROKEN authenticated-without-sub lifetime_scored_count() returned %', v;
  end if;
  select * into a from public.access_state();
  if a.scored_count <> 0 or a.premium or a.reserved_count <> 0 then
    raise exception 'S9c: BROKEN authenticated-without-sub access_state leaked %', a;
  end if;
  raise notice 'RESULT S9c: HELD authenticated-without-sub reads 0/0/false';
end $$;
reset role;

-- S9d: authenticated as Bob (a different user) reads 0, not Alice's 2.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000b';
do $$
begin
  if public.identity_scored_count() <> 0 or public.lifetime_scored_count() <> 0 then
    raise exception 'S9d: BROKEN Bob read Alice''s count';
  end if;
  raise notice 'RESULT S9d: HELD Bob reads 0';
end $$;
reset role;

-- S9e: definer helper cannot be pointed at another user — it takes no
-- arguments; assert no overload with parameters exists and anon lacks EXECUTE.
do $$
declare n int;
begin
  select count(*) into n from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'identity_scored_count' and p.pronargs > 0;
  if n <> 0 then
    raise exception 'S9e: BROKEN identity_scored_count has a parameterised overload';
  end if;
  if has_function_privilege('anon', 'public.identity_scored_count()', 'EXECUTE') then
    raise notice 'RESULT S9e: INFO anon holds EXECUTE on identity_scored_count()';
  else
    raise notice 'RESULT S9e: HELD anon lacks EXECUTE on identity_scored_count()';
  end if;
  if has_function_privilege('anon', 'public.lifetime_scored_count()', 'EXECUTE') then
    raise notice 'RESULT S9e: INFO anon holds EXECUTE on lifetime_scored_count()';
  else
    raise notice 'RESULT S9e: HELD anon lacks EXECUTE on lifetime_scored_count()';
  end if;
  if has_table_privilege('anon', 'public.free_rating_ledger', 'SELECT')
     or has_table_privilege('authenticated', 'public.free_rating_ledger', 'SELECT') then
    raise exception 'S9e: BROKEN client role can SELECT free_rating_ledger';
  end if;
  raise notice 'RESULT S9e: HELD no client SELECT on free_rating_ledger';
end $$;

rollback;
\echo S9 DONE
