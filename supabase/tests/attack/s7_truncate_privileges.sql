-- ============================================================================
-- S7 — TRUNCATE / TRIGGER / REFERENCES held by the client roles.
--
-- Hosted Supabase's default privileges (modelled in supabase/tests/
-- shim_auth.sql: `grant all on tables to anon, authenticated, service_role`)
-- hand every new public table ALL privileges, and the migrations only ever
-- REVOKE the DML they mean to close (20260902130000_shots_delete_revoke.sql
-- removes DELETE from shots, 20260831160000 sizes UPDATE grants). TRUNCATE,
-- TRIGGER and REFERENCES are never revoked. TRUNCATE is NOT subject to
-- row-level security and fires no row triggers, so whoever can run SQL as
-- `authenticated` can empty EVERY user's rows with one statement.
--
-- Reachability (INFERRED, not tested here): PostgREST does not expose
-- TRUNCATE, so a JWT alone cannot reach this; it needs a SQL surface running
-- as the client role (leaked pooler credentials with role switching, a
-- future RPC that interpolates SQL, a misconfigured SQL editor role). The
-- probe asserts the least-privilege posture the rest of the schema already
-- claims: client roles must hold nothing they cannot use through the API.
--
--   A. Two owners, each with a shot + phases + captures. As authenticated:
--      TRUNCATE public.shots (expected today: FK error, NOT permission
--      denied), then TRUNCATE public.shots CASCADE → every user's shots,
--      shot_phases, shot_measurements, shot_checkpoints AND captures gone.
--   B. TRUNCATE public.billing_entitlements (no children) → every premium
--      entitlement gone. TRUNCATE public.profiles CASCADE → everything.
--   C. Service-only tables: free_rating_ledger / webhook_events must refuse.
--   D. Survey: every public table × {anon, authenticated} × {TRUNCATE,
--      TRIGGER, REFERENCES}.
--   E. TRIGGER: CREATE TRIGGER on public.shots as authenticated. Needs
--      EXECUTE on a trigger-returning function; assert none is executable
--      by client roles (the grant is inert only for that reason).
--   F. REFERENCES: a temp table cannot reference a permanent one and client
--      roles hold CREATE on no schema, so the grant is inert; recorded.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

\i /attack/_helpers.sql

select attack.new_user('00000000-0000-4000-8000-0000000000a7'::uuid, 's7-victim@attack.example', 'apple', 'apple-sub-s7');
select attack.new_user('00000000-0000-4000-8000-0000000000b7'::uuid, 's7-attacker@attack.example', 'google', 'google-sub-s7');
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-0000000000a7', true, now() + interval '30 days');

create temporary table attack_failures (probe text, detail text);
create temporary table results (k text, v text);
grant all on attack_failures, results to authenticated;

-- Seed one shot (with children) per user through the sanctioned path.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a7';
select public.reserve_analysis_permit('s7-v');
select public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e7'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's7-v'), 'scored', 7.1, 'dink', now(), 6));
insert into public.captures (id, user_id, shot_id, captured_at, duration_ms, fps, capture_mode, evidence_status, status)
values (gen_random_uuid(), '00000000-0000-4000-8000-0000000000a7', '00000000-0000-4000-8000-0000000000e7', now(), 1200, 60.0,
        'automatic_pose_trigger', 'valid', 'analyzed');
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b7';
select public.reserve_analysis_permit('s7-a');
select public.apply_synced_shot(attack.shot_payload(
  '00000000-0000-4000-8000-0000000000e8'::uuid,
  (select id from public.analysis_permits where idempotency_key = 's7-a'), 'scored', 6.2, 'drive', now(), 6));
reset role;

create temporary table before_counts as
select 'shots' as t, count(*) as n from public.shots
union all select 'shot_phases', count(*) from public.shot_phases
union all select 'captures', count(*) from public.captures
union all select 'billing_entitlements', count(*) from public.billing_entitlements
union all select 'profiles', count(*) from public.profiles
union all select 'free_rating_ledger', count(*) from public.free_rating_ledger;

-- A: as the attacker (owns 1 shot, sees only their own rows under RLS).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b7';

insert into results select 'A-visible-shots-under-rls', count(*)::text from public.shots;

do $$
begin
  truncate public.shots;
  insert into results values ('A-truncate-shots', 'SUCCEEDED');
exception when others then
  insert into results values ('A-truncate-shots', sqlstate || ' ' || sqlerrm);
end $$;

do $$
begin
  truncate public.shots cascade;
  insert into results values ('A-truncate-shots-cascade', 'SUCCEEDED');
exception when others then
  insert into results values ('A-truncate-shots-cascade', sqlstate || ' ' || sqlerrm);
end $$;

-- B
do $$
begin
  truncate public.billing_entitlements;
  insert into results values ('B-truncate-billing_entitlements', 'SUCCEEDED');
exception when others then
  insert into results values ('B-truncate-billing_entitlements', sqlstate || ' ' || sqlerrm);
end $$;

-- C
do $$
begin
  truncate public.free_rating_ledger;
  insert into results values ('C-truncate-free_rating_ledger', 'SUCCEEDED');
exception when others then
  insert into results values ('C-truncate-free_rating_ledger', sqlstate || ' ' || sqlerrm);
end $$;
do $$
begin
  truncate public.webhook_events;
  insert into results values ('C-truncate-webhook_events', 'SUCCEEDED');
exception when others then
  insert into results values ('C-truncate-webhook_events', sqlstate || ' ' || sqlerrm);
end $$;

-- E
do $$
begin
  create trigger attack_trg before insert on public.shots
    for each row execute function public.set_updated_at();
  insert into results values ('E-create-trigger-on-shots', 'SUCCEEDED');
exception when others then
  insert into results values ('E-create-trigger-on-shots', sqlstate || ' ' || sqlerrm);
end $$;

-- F
do $$
begin
  create temporary table attack_ref (shot_id uuid references public.shots (id));
  insert into results values ('F-temp-table-fk-to-shots', 'SUCCEEDED');
exception when others then
  insert into results values ('F-temp-table-fk-to-shots', sqlstate || ' ' || sqlerrm);
end $$;

reset role;

create temporary table after_counts as
select 'shots' as t, count(*) as n from public.shots
union all select 'shot_phases', count(*) from public.shot_phases
union all select 'captures', count(*) from public.captures
union all select 'billing_entitlements', count(*) from public.billing_entitlements
union all select 'profiles', count(*) from public.profiles
union all select 'free_rating_ledger', count(*) from public.free_rating_ledger;

-- B (continued): profiles cascade, in a savepoint so the survey below still
-- runs against a populated schema.
savepoint profiles_wipe;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b7';
do $$
begin
  truncate public.profiles cascade;
  insert into results values ('B-truncate-profiles-cascade', 'SUCCEEDED, profiles left=' ||
    (select count(*) from public.profiles) || ', analysis_permits left=' || (select count(*) from public.analysis_permits));
exception when others then
  insert into results values ('B-truncate-profiles-cascade', sqlstate || ' ' || sqlerrm);
end $$;
reset role;
select v as profiles_wipe_result from results where k = 'B-truncate-profiles-cascade' \gset
rollback to savepoint profiles_wipe;
insert into results values ('B-truncate-profiles-cascade', :'profiles_wipe_result');

-- D: survey
create temporary table survey as
select c.relname as table_name, r.rolname,
       has_table_privilege(r.rolname, c.oid, 'TRUNCATE') as can_truncate,
       has_table_privilege(r.rolname, c.oid, 'TRIGGER') as can_trigger,
       has_table_privilege(r.rolname, c.oid, 'REFERENCES') as can_references,
       has_table_privilege(r.rolname, c.oid, 'DELETE') as can_delete
from pg_class c
cross join (values ('anon'), ('authenticated')) r(rolname)
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
order by 1, 2;

do $$
declare
  r record;
  v_trunc text;
  v_trig text;
  v_refs text;
  v_exec_trig text;
begin
  for r in select b.t, b.n as before_n, a.n as after_n from before_counts b join after_counts a using (t) order by 1 loop
    raise notice 'OBSERVED rows % : before=% after=%', r.t, r.before_n, r.after_n;
  end loop;
  for r in select * from results order by k loop
    raise notice 'OBSERVED % = %', r.k, r.v;
  end loop;

  select string_agg(table_name, ', ' order by table_name) into v_trunc from survey where rolname = 'authenticated' and can_truncate;
  select string_agg(table_name, ', ' order by table_name) into v_trig  from survey where rolname = 'authenticated' and can_trigger;
  select string_agg(table_name, ', ' order by table_name) into v_refs  from survey where rolname = 'authenticated' and can_references;
  raise notice 'OBSERVED D authenticated TRUNCATE on [%]', coalesce(v_trunc, '');
  raise notice 'OBSERVED D authenticated TRIGGER on [%]', coalesce(v_trig, '');
  raise notice 'OBSERVED D authenticated REFERENCES on [%]', coalesce(v_refs, '');
  raise notice 'OBSERVED D authenticated TRUNCATE-but-not-DELETE on [%]',
    coalesce((select string_agg(table_name, ', ' order by table_name) from survey where rolname = 'authenticated' and can_truncate and not can_delete), '');
  raise notice 'OBSERVED D anon TRUNCATE on [%]',
    coalesce((select string_agg(table_name, ', ' order by table_name) from survey where rolname = 'anon' and can_truncate), '');

  select string_agg(p.proname, ', ') into v_exec_trig
  from pg_proc p
  where p.prorettype = 'trigger'::regtype
    and p.pronamespace in ('public'::regnamespace, 'auth'::regnamespace)
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'));
  raise notice 'OBSERVED E trigger-returning functions executable by client roles: [%]', coalesce(v_exec_trig, '');

  if (select v from results where k = 'A-truncate-shots') not like '42501%' then
    insert into attack_failures values ('S7-A', format('TRUNCATE public.shots as authenticated → %s (expected 42501 permission denied)',
      (select v from results where k = 'A-truncate-shots')));
  end if;
  if (select v from results where k = 'A-truncate-shots-cascade') = 'SUCCEEDED' then
    insert into attack_failures values ('S7-A', format(
      'TRUNCATE public.shots CASCADE as authenticated wiped every user: shots %s→%s, shot_phases %s→%s, captures %s→%s',
      (select before_n from (select b.n as before_n from before_counts b where t = 'shots') x),
      (select n from after_counts where t = 'shots'),
      (select n from before_counts where t = 'shot_phases'), (select n from after_counts where t = 'shot_phases'),
      (select n from before_counts where t = 'captures'), (select n from after_counts where t = 'captures')));
  end if;
  if (select v from results where k = 'B-truncate-billing_entitlements') = 'SUCCEEDED' then
    insert into attack_failures values ('S7-B', format('TRUNCATE public.billing_entitlements as authenticated wiped every entitlement: %s→%s',
      (select n from before_counts where t = 'billing_entitlements'), (select n from after_counts where t = 'billing_entitlements')));
  end if;
  if (select v from results where k = 'B-truncate-profiles-cascade') like 'SUCCEEDED%' then
    insert into attack_failures values ('S7-B', 'TRUNCATE public.profiles CASCADE as authenticated: ' || (select v from results where k = 'B-truncate-profiles-cascade'));
  end if;
  if (select v from results where k = 'C-truncate-free_rating_ledger') not like '42501%'
     or (select v from results where k = 'C-truncate-webhook_events') not like '42501%' then
    insert into attack_failures values ('S7-C', 'a service-only table accepted TRUNCATE from authenticated');
  end if;
  if v_trunc is not null then
    insert into attack_failures values ('S7-D', 'authenticated holds TRUNCATE on: ' || v_trunc);
  end if;
  if v_trig is not null then
    insert into attack_failures values ('S7-D', 'authenticated holds TRIGGER on: ' || v_trig);
  end if;
  if v_refs is not null then
    insert into attack_failures values ('S7-D', 'authenticated holds REFERENCES on: ' || v_refs);
  end if;
  if (select v from results where k = 'E-create-trigger-on-shots') = 'SUCCEEDED' or v_exec_trig is not null then
    insert into attack_failures values ('S7-E', 'authenticated could attach a trigger to public.shots');
  end if;
  if (select v from results where k = 'F-temp-table-fk-to-shots') = 'SUCCEEDED' then
    insert into attack_failures values ('S7-F', 'authenticated created a foreign key onto public.shots');
  end if;
end $$;

do $$
declare v_report text;
begin
  select string_agg(format(E'\n[%s] %s', probe, detail), '') into v_report from attack_failures;
  if v_report is not null then
    raise exception 'S7 BROKEN:%', v_report;
  end if;
end $$;

rollback;

\echo S7: HELD
