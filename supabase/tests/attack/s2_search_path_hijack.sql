-- ============================================================================
-- S2 — search_path hijack against the three functions that do not pin it.
--
-- 20260831160000_defense_in_depth.sql pins `set search_path = ''` on every
-- definer function; complete_onboarding() (SQL, SECURITY INVOKER),
-- set_updated_at() (plpgsql trigger) and player_rank_tier() stay unpinned.
-- A plain-`$$` SQL function body and every plpgsql expression are parsed at
-- CALL time with the CALLER's search_path, so an authenticated session that
-- puts pg_temp in front can shadow anything the body leaves unqualified.
--
-- Threat model note: the product's clients reach Postgres only through
-- PostgREST/RPC and cannot run SET or CREATE TEMP TABLE. This scenario is
-- the defense-in-depth question: what does a direct authenticated SQL
-- session (leaked pooler credential, future SQL surface) get from the
-- unpinned functions that it could not get anyway?
--
--   A. pg_temp.profiles shadow → complete_onboarding(). The body names
--      public.profiles and auth.uid() explicitly, so the REAL row must flip
--      and the temp table must stay untouched.
--   B. pg_temp.now() shadow → any own-row UPDATE fires set_updated_at(),
--      whose body calls unqualified now(). updated_at is NOT in the
--      authenticated column-UPDATE grant (20260831160000). If the trigger
--      picks up pg_temp.now(), the caller writes a column the grant denies.
--   C. Blast radius: the other user's profile must be untouched by A and B.
--   D. Why B cannot work at all: Postgres never resolves unqualified
--      FUNCTION/OPERATOR names through pg_temp (only relations and types),
--      even when pg_temp is listed explicitly ahead of pg_catalog — checked
--      directly. So a function hijack needs CREATE on a real schema, and D
--      asserts authenticated/anon hold CREATE on no schema at all.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

select attack.new_user('00000000-0000-4000-8000-0000000000a2'::uuid, 's2-victim@attack.example');
select attack.new_user('00000000-0000-4000-8000-0000000000b2'::uuid, 's2-other@attack.example');

-- Precondition: both rows exist, both pending (bootstrap trigger).
do $$
begin
  if (select count(*) from public.profiles
      where id in ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000b2')
        and onboarding_state = 'pending') <> 2 then
    raise exception 'S2 precondition: expected two pending profiles';
  end if;
end $$;

create temporary table attack_failures (probe text, detail text);

-- ─────────────── attacker session ──────────────────────────────────────────
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';

-- A: shadow the table.
create temporary table profiles (
  id uuid primary key,
  onboarding_state text not null default 'pending'
);
insert into profiles (id) values ('00000000-0000-4000-8000-0000000000a2');

set local search_path = pg_temp, public;
select public.complete_onboarding();

do $$
declare
  v_real text;
  v_temp text;
begin
  select onboarding_state into v_real from public.profiles
  where id = '00000000-0000-4000-8000-0000000000a2';
  select onboarding_state into v_temp from pg_temp.profiles
  where id = '00000000-0000-4000-8000-0000000000a2';
  perform attack.note('S2-A real public.profiles.onboarding_state', v_real);
  perform attack.note('S2-A shadow pg_temp.profiles.onboarding_state', v_temp);
  if v_real <> 'complete' then
    insert into attack_failures values ('S2-A',
      format('complete_onboarding() did not flip the real row (real=%s, temp=%s)', v_real, v_temp));
  end if;
  if v_temp <> 'pending' then
    insert into attack_failures values ('S2-A',
      format('complete_onboarding() wrote the pg_temp shadow (real=%s, temp=%s)', v_real, v_temp));
  end if;
end $$;

-- B: shadow now() ahead of pg_catalog, then do an update the grant allows.
reset search_path;
create function pg_temp.now() returns timestamptz language sql
as $fn$ select '1999-12-31 23:59:59+00'::timestamptz $fn$;

set local search_path = pg_temp, pg_catalog, public;
update public.profiles set skill_level = 'intermediate'
where id = '00000000-0000-4000-8000-0000000000a2';
reset search_path;

do $$
declare
  v_updated timestamptz;
begin
  select updated_at into v_updated from public.profiles
  where id = '00000000-0000-4000-8000-0000000000a2';
  perform attack.note('S2-B profiles.updated_at after own-row update with pg_temp.now()', v_updated::text);
  if v_updated = '1999-12-31 23:59:59+00'::timestamptz then
    insert into attack_failures values ('S2-B',
      'set_updated_at() resolved pg_temp.now(): caller controls updated_at, a column outside its UPDATE grant');
  end if;
end $$;

-- Control for B: is updated_at really outside the grant?
do $$
begin
  update public.profiles set updated_at = '2000-01-01'
  where id = '00000000-0000-4000-8000-0000000000a2';
  insert into attack_failures values ('S2-B-control',
    'direct UPDATE of profiles.updated_at succeeded for authenticated — grant wider than documented');
exception when insufficient_privilege then
  perform attack.note('S2-B-control direct UPDATE profiles.updated_at', 'permission denied (expected)');
end $$;

-- D: the function-resolution rule B depends on, and the schema-CREATE surface.
do $$
declare
  v_now timestamptz;
  v_creatable text;
begin
  set local search_path = pg_temp, pg_catalog, public;
  select now() into v_now;
  reset search_path;
  perform attack.note('S2-D unqualified now() with search_path=pg_temp,pg_catalog,public', v_now::text);
  if v_now = '1999-12-31 23:59:59+00'::timestamptz then
    insert into attack_failures values ('S2-D', 'pg_temp WAS consulted for an unqualified function name');
  end if;

  select string_agg(n.nspname || ':' || r.rolname, ', ' order by n.nspname, r.rolname)
    into v_creatable
  from pg_namespace n
  cross join (values ('authenticated'), ('anon')) r(rolname)
  where n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast%'
    and n.nspname <> 'attack'
    and has_schema_privilege(r.rolname, n.oid, 'CREATE');
  perform attack.note('S2-D schemas where client roles hold CREATE', coalesce(v_creatable, '(none)'));
  if v_creatable is not null then
    insert into attack_failures values ('S2-D',
      'client roles can CREATE in a non-temp schema: ' || v_creatable);
  end if;
end $$;

reset role;

-- C: blast radius.
do $$
declare
  v_other record;
begin
  select onboarding_state, skill_level, updated_at into v_other from public.profiles
  where id = '00000000-0000-4000-8000-0000000000b2';
  perform attack.note('S2-C other user row', row_to_json(v_other)::text);
  if v_other.onboarding_state <> 'pending' or v_other.skill_level is not null then
    insert into attack_failures values ('S2-C', 'another user''s profile changed');
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'S2 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo S2: HELD
