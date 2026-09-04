-- Postgres-backed boundary fuzz for the ONE query GET /v1/me/saved-drills
-- issues through PostgREST (supabase/functions/api/index.ts listSavedDrills):
--
--   select slug, saved_at from public.user_saved_drills
--    where user_id = <authed.id> order by saved_at desc
--
-- Run by stress_saved_drills_pg.sh against a disposable postgres:16 with
-- supabase/tests/shim_auth.sql + every migration applied (never a hosted
-- project). Seeded through setseed() so every iteration is replayable from
-- (:seed, :iterations). Emits one JSON document on stdout; the whole run is
-- a single transaction that is rolled back.
--
-- Invariants fuzzed, as role `authenticated` with request.jwt.claim.sub set:
--   R1  the route's query returns exactly the caller's rows, newest first
--   R2  a scope-abuse filter (`?user_id=eq.<victim>` forwarded to PostgREST)
--       yields 0 rows for anyone but the owner (RLS, not the filter, decides)
--   R3  an unfiltered select never leaks another user's row
--   R4  a random slug is storable iff it matches the edge's DRILL_SLUG_RE
--       (^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$) — the DB check constraint and
--       the edge validator agree on every generated string
--   R5  anon sees nothing and cannot insert
\set ON_ERROR_STOP on
\set QUIET on

begin;

select setseed(:seed) as _seeded \gset
select set_config('stress.iterations', :'iterations', true) as _iterations \gset

create temp table stress_users (idx int primary key, id uuid not null);
insert into stress_users
select g, ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid
from generate_series(1, 40) g;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
select id, 'stress' || idx || '@example.com', '{}'::jsonb, '{"provider":"google"}'::jsonb
from stress_users;

-- Seed 0..12 well-formed rows per user as the owner role (what the app's
-- POST /v1/me/saved-drills would have written), with distinct saved_at.
insert into public.user_saved_drills (user_id, slug, saved_at)
select u.id,
       'drill-' || u.idx || '-' || s,
       now() - (s * interval '1 hour') - (random() * interval '30 minutes')
from stress_users u
cross join lateral generate_series(1, (random() * 12)::int) s;

create temp table stress_results (
  iter int primary key,
  kind text not null,
  actor uuid,
  target uuid,
  payload text,
  expected text not null,
  observed text not null,
  held boolean not null
);

do $$
declare
  n int := current_setting('stress.iterations')::int;
  i int;
  actor stress_users%rowtype;
  victim stress_users%rowtype;
  kind text;
  truth_json text;
  seen_json text;
  cnt int;
  gen_slug text;
  safe_alphabet text := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  alphabet text := safe_alphabet || './ ~!@#$%^&*()+=[]{}|\;:''",<>?éü中🏓' || chr(9) || chr(10);
  safe_glyphs text[];
  glyphs text[];
  pool text[];
  len int;
  k int;
  slug_ok boolean;
  stored boolean;
  err text;
begin
  glyphs := regexp_split_to_array(alphabet, '');
  safe_glyphs := regexp_split_to_array(safe_alphabet, '');
  for i in 1..n loop
    select * into actor from stress_users order by idx offset floor(random() * 40)::int limit 1;
    select * into victim from stress_users where idx <> actor.idx order by idx offset floor(random() * 39)::int limit 1;
    kind := (array['route', 'route', 'route', 'scope-abuse', 'unfiltered', 'slug', 'slug', 'anon'])[1 + floor(random() * 8)::int];

    -- ground truth as the table owner (superuser: bypasses RLS)
    reset role;
    perform set_config('request.jwt.claim.sub', '', true);
    select coalesce(json_agg(json_build_object('slug', d.slug, 'saved_at', d.saved_at) order by d.saved_at desc)::text, '[]')
      into truth_json
      from public.user_saved_drills d where d.user_id = actor.id;

    if kind = 'anon' then
      set local role anon;
      perform set_config('request.jwt.claim.sub', '', true);
      begin
        select count(*) into cnt from public.user_saved_drills;
        seen_json := cnt || ' rows visible';
      exception when insufficient_privilege then
        cnt := 0;
        seen_json := 'select refused 42501';
      end;
      begin
        insert into public.user_saved_drills (user_id, slug) values (actor.id, 'anon-write');
        err := 'insert succeeded';
      exception when others then
        err := sqlstate;
      end;
      reset role;
      insert into stress_results values (i, kind, null, actor.id, null,
        'no rows visible; insert refused', seen_json || '; insert → ' || err,
        cnt = 0 and err <> 'insert succeeded');
      continue;
    end if;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', actor.id::text, true);

    if kind = 'route' then
      select coalesce(json_agg(json_build_object('slug', q.slug, 'saved_at', q.saved_at) order by q.saved_at desc)::text, '[]')
        into seen_json
        from (select d.slug, d.saved_at from public.user_saved_drills d
               where d.user_id = actor.id order by d.saved_at desc) q;
      reset role;
      insert into stress_results values (i, kind, actor.id, actor.id, null, truth_json, seen_json, seen_json = truth_json);

    elsif kind = 'scope-abuse' then
      select count(*) into cnt
        from public.user_saved_drills d where d.user_id = victim.id;
      reset role;
      insert into stress_results values (i, kind, actor.id, victim.id, 'user_id=eq.' || victim.id,
        '0 rows', cnt || ' rows', cnt = 0);

    elsif kind = 'unfiltered' then
      select count(*) into cnt from public.user_saved_drills d where d.user_id <> actor.id;
      reset role;
      insert into stress_results values (i, kind, actor.id, null, 'select * (no user_id filter)',
        '0 foreign rows', cnt || ' foreign rows', cnt = 0);

    elsif kind = 'slug' then
      -- half the strings come from the slug-safe alphabet so the length
      -- boundary (120/121) and the leading -/_ rule are exercised as often
      -- as outright hostile bytes are
      pool := case when random() < 0.5 then safe_glyphs else glyphs end;
      len := case when random() < 0.3 then 115 + floor(random() * 10)::int else 1 + floor(random() * 130)::int end;
      gen_slug := '';
      for k in 1..len loop
        gen_slug := gen_slug || pool[1 + floor(random() * array_length(pool, 1))::int];
      end loop;
      slug_ok := gen_slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$';
      begin
        insert into public.user_saved_drills (user_id, slug) values (actor.id, gen_slug);
        stored := true;
        err := null;
        -- keep the fixture stable for later 'route' iterations
        delete from public.user_saved_drills d where d.user_id = actor.id and d.slug = gen_slug;
      exception when check_violation then
        stored := false; err := sqlstate;
      when unique_violation then
        stored := true; err := 'duplicate of fixture row';
      when others then
        stored := false; err := 'UNEXPECTED ' || sqlstate || ' ' || sqlerrm;
      end;
      reset role;
      insert into stress_results values (i, kind, actor.id, actor.id, gen_slug,
        case when slug_ok then 'stored (matches DRILL_SLUG_RE)' else 'check_violation 23514' end,
        case when stored then 'stored' else coalesce(err, 'refused') end,
        (stored = slug_ok) and (stored or err = '23514'));
    end if;
  end loop;
end $$;

reset role;

select json_build_object(
  'seed', :seed,
  'iterations', :iterations,
  'postgres', version(),
  'executed', (select count(*) from stress_results),
  'held', (select count(*) from stress_results where held),
  'broken', (select count(*) from stress_results where not held),
  'byKind', (select json_object_agg(kind, c) from (select kind, count(*) c from stress_results group by kind) k),
  'slugAccepted', (select count(*) from stress_results where kind = 'slug' and observed = 'stored'),
  'slugRejected', (select count(*) from stress_results where kind = 'slug' and observed <> 'stored'),
  'brokenRows', (select coalesce(json_agg(r order by iter), '[]'::json) from stress_results r where not held),
  'slugSample', (select coalesce(json_agg(json_build_object('iter', iter, 'slug', payload, 'observed', observed) order by iter), '[]'::json)
                   from (select * from stress_results where kind = 'slug' order by iter limit 25) s)
);

rollback;
