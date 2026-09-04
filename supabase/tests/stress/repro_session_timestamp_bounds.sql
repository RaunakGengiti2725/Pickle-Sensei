-- Exact single-backend SQL repro: sessions.started_at has no range CHECK while
-- shots/captures.captured_at do (20260904000000_apply_synced_shot_error_hygiene.sql),
-- and a server-clock finalize can leave ended_at < started_at.
--
-- Run against the disposable database from ./stress_pg_up.sh:
--   docker exec -i pickle-stress-pg psql -v ON_ERROR_STOP=0 -U postgres -d postgres \
--     < supabase/tests/stress/repro_session_timestamp_bounds.sql
--
-- Expected (defense in depth): the year-9999 / 1999 inserts fail with 23514 like the
-- captures insert does. Observed on 1fb0efd7: both session inserts succeed as the
-- authenticated role, and the finalize returns ended_at < started_at.
\set uid '33333333-3333-4333-8333-333333333333'

delete from auth.users where id = :'uid';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (:'uid', 'bounds@stress.test', '{"full_name":"Bounds"}', '{"provider":"google"}');

begin isolation level read committed;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'uid', true),
       set_config('request.jwt.claims', '{"sub":"' || :'uid' || '","role":"authenticated"}', true);

-- 1. out-of-range started_at is accepted (captured_at with the same values is 23514)
insert into public.sessions (id, user_id, started_at)
  values ('44444444-4444-4444-8444-444444444441', :'uid', '9999-12-31T23:59:59Z');
insert into public.sessions (id, user_id, started_at)
  values ('44444444-4444-4444-8444-444444444442', :'uid', '1999-12-31T23:59:59Z');
select id, started_at from public.sessions where user_id = :'uid' order by started_at;

-- 2. same instant into captures is refused by captures_captured_at_bounds (client has no
--    capture INSERT at all; shown from the owner plane after the transaction).
-- 3. in-range future started_at (clock ahead) + server-clock finalize → negative duration
insert into public.sessions (id, user_id, started_at)
  values ('44444444-4444-4444-8444-444444444443', :'uid', '2099-12-31T23:59:59Z');
update public.sessions set ended_at = now()
  where id = '44444444-4444-4444-8444-444444444443' and user_id = :'uid'
  returning started_at, ended_at, (ended_at < started_at) as ended_before_started;
commit;

-- owner plane: the bounded sibling column refuses the same instant
insert into public.captures (id, user_id, captured_at, duration_ms, fps, capture_mode, evidence_status)
  values ('55555555-5555-4555-8555-555555555555', :'uid', '9999-12-31T23:59:59Z', 1200, 30, 'automatic_pose_trigger', 'valid');

delete from auth.users where id = :'uid';
