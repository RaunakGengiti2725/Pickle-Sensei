-- S1: does the `pg_trigger_depth() > 1` passthrough in reject_ledger_mutation()
-- admit a NON-cascade delete of consent_records when the delete is issued from
-- a plpgsql function invoked by a trigger on an unrelated table?
--
-- Attack: table owner (postgres) creates a trigger on public.sessions whose
-- body deletes consent_records; an ordinary INSERT into sessions then runs
-- the delete at trigger depth 2 while Alice's profile still exists.
--
-- Runs inside one transaction and rolls back. Exits non-zero on assertion
-- failure via ON_ERROR_STOP. Result lines are printed as RESULT S1x: ...
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _seed_alice.sql

insert into public.consent_records (user_id, scope, action, consent_version, source)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant', 'v1', 'app'),
       ('00000000-0000-4000-8000-00000000000a', 'video_analysis', 'grant', 'v1', 'app');

-- S1a (control): a direct owner DELETE at depth 1 is refused, as D2 pins.
do $$
begin
  begin
    delete from public.consent_records
    where user_id = '00000000-0000-4000-8000-00000000000a';
    raise exception 'S1a: direct owner delete at depth 1 must be refused';
  exception when insufficient_privilege then
    raise notice 'RESULT S1a: HELD direct owner delete refused (%)', sqlerrm;
  end;
end $$;

-- S1b: owner-created trigger on sessions deletes consent_records at depth 2.
create function public.s1_attack_nested_delete()
returns trigger
language plpgsql
as $$
begin
  raise notice 'RESULT S1b: inside trigger, pg_trigger_depth()=%', pg_trigger_depth();
  delete from public.consent_records where user_id = new.user_id;
  return new;
end;
$$;

create trigger s1_attack_sessions_ins
  after insert on public.sessions
  for each row execute function public.s1_attack_nested_delete();

do $$
declare
  v_before int;
  v_after int;
  v_profile_alive boolean;
begin
  select count(*) into v_before from public.consent_records
  where user_id = '00000000-0000-4000-8000-00000000000a';

  insert into public.sessions (id, user_id, started_at)
  values ('00000000-0000-4000-8000-0000000000d9',
          '00000000-0000-4000-8000-00000000000a', now());

  select count(*) into v_after from public.consent_records
  where user_id = '00000000-0000-4000-8000-00000000000a';
  select exists (select 1 from public.profiles
                 where id = '00000000-0000-4000-8000-00000000000a')
    into v_profile_alive;

  raise notice 'RESULT S1b: consent rows before=% after=% profile_alive=%',
    v_before, v_after, v_profile_alive;

  if v_after = 0 and v_profile_alive then
    raise notice 'RESULT S1b: BROKEN non-cascade delete admitted at depth>1 (owner-created trigger; account still exists)';
  elsif v_after = v_before then
    raise notice 'RESULT S1b: HELD nested delete refused';
  else
    raise exception 'S1b: unexpected state before=% after=%', v_before, v_after;
  end if;
end $$;

drop trigger s1_attack_sessions_ins on public.sessions;
drop function public.s1_attack_nested_delete();

-- S1c: the same trick attempted by service_role (not owner). It holds TRIGGER
-- on every public table (hosted-like default privileges) but has no CREATE on
-- schema public, so it needs a trigger function it can create: pg_temp.
insert into public.consent_records (user_id, scope, action, consent_version, source)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant', 'v1', 'app');

do $$
declare
  v_after int;
begin
  begin
    set local role service_role;
    create function pg_temp.s1_svc_nested_delete()
    returns trigger
    language plpgsql
    as $f$
    begin
      delete from public.consent_records where user_id = new.user_id;
      return new;
    end;
    $f$;
    create trigger s1_svc_sessions_ins
      after insert on public.sessions
      for each row execute function pg_temp.s1_svc_nested_delete();
    insert into public.sessions (id, user_id, started_at)
    values ('00000000-0000-4000-8000-0000000000d8',
            '00000000-0000-4000-8000-00000000000a', now());
    select count(*) into v_after from public.consent_records
    where user_id = '00000000-0000-4000-8000-00000000000a';
    reset role;
    if v_after = 0 then
      raise notice 'RESULT S1c: BROKEN service_role (non-owner) deleted consent rows via pg_temp trigger function';
    else
      raise notice 'RESULT S1c: HELD service_role nested delete left % rows', v_after;
    end if;
  exception when others then
    reset role;
    raise notice 'RESULT S1c: HELD service_role attempt failed: % (%)', sqlerrm, sqlstate;
  end;
end $$;

-- S1e: reachability probe — does `authenticated` (hosted-like default
-- privileges: ALL on public tables incl. TRIGGER) get the same route with a
-- pg_temp trigger function? PostgREST never runs DDL, so this only matters
-- for a role that can issue raw SQL; it turns the INFERRED TRIGGER residual
-- in docs/devin/SECURITY_BOUNDARIES.md into a VERIFIED statement.
insert into public.consent_records (user_id, scope, action, consent_version, source)
values ('00000000-0000-4000-8000-00000000000a', 'model_training', 'grant', 'v1', 'app');

do $$
declare
  v_after int;
begin
  raise notice 'RESULT S1e: authenticated TRIGGER privilege on sessions=% TRUNCATE=%',
    has_table_privilege('authenticated', 'public.sessions', 'TRIGGER'),
    has_table_privilege('authenticated', 'public.sessions', 'TRUNCATE');
  begin
    set local role authenticated;
    set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
    create function pg_temp.s1_auth_nested_delete()
    returns trigger
    language plpgsql
    as $f$
    begin
      delete from public.consent_records where user_id = new.user_id;
      return new;
    end;
    $f$;
    create trigger s1_auth_sessions_ins
      after insert on public.sessions
      for each row execute function pg_temp.s1_auth_nested_delete();
    insert into public.sessions (id, user_id, started_at)
    values ('00000000-0000-4000-8000-0000000000d7',
            '00000000-0000-4000-8000-00000000000a', now());
    select count(*) into v_after from public.consent_records
    where user_id = '00000000-0000-4000-8000-00000000000a';
    reset role;
    if v_after = 0 then
      raise notice 'RESULT S1e: BROKEN authenticated (raw SQL) deleted its own consent rows via pg_temp trigger function';
    else
      raise notice 'RESULT S1e: HELD authenticated nested delete left % rows', v_after;
    end if;
  exception when others then
    reset role;
    raise notice 'RESULT S1e: HELD authenticated attempt failed: % (%)', sqlerrm, sqlstate;
  end;
end $$;

-- S1d: the intended cascade path still works — deleting the profile removes
-- the consent rows (the parent delete is the audit event).
do $$
declare v int;
begin
  delete from public.profiles where id = '00000000-0000-4000-8000-00000000000a';
  select count(*) into v from public.consent_records
  where user_id = '00000000-0000-4000-8000-00000000000a';
  if v <> 0 then
    raise exception 'S1d: FK cascade must remove consent rows (left %)', v;
  end if;
  raise notice 'RESULT S1d: HELD FK cascade from profiles delete still clears consent rows';
end $$;

rollback;
\echo S1 DONE
