-- REPRO (deterministic, single session) — F3: POST /v1/sessions/:id/finalize
-- moves `ended_at` on a replay, contradicting its own contract
-- ("Stamps ended_at once (a replay never moves it)",
-- supabase/functions/api/index.ts:1750-1776). The route reads `ended_at`,
-- decides in TypeScript, then issues an UPDATE whose WHERE clause is only
-- (id, user_id) — nothing pins `ended_at is null`, so two finalize calls that
-- both read NULL (duplicate outbox flush, two devices, retry after a timeout)
-- both write, and the LAST writer's timestamp wins.
--
--   docker exec -i <stress pg> psql -U postgres -v ON_ERROR_STOP=1 \
--     -f /tests/stress/repro_session_finalize_stamp.sql
--
-- The two statements below are exactly what the route emits, in the order two
-- interleaved requests emit them (both reads happen before either write).
--
-- Expected: the second write is a no-op; ended_at keeps the first value.
-- Observed: ended_at moves to the second value (`moved` = t).
\set ON_ERROR_STOP on
\set u_id '55555555-5555-4555-8555-555555555555'
\set s_id '66666666-6666-4666-8666-666666666666'

insert into auth.users (id, email, raw_app_meta_data)
values (:'u_id', 'finalize@stress.local', jsonb_build_object('provider', 'apple'));
insert into auth.identities (provider_id, user_id, identity_data, provider)
values ('finalize-a', :'u_id', jsonb_build_object('sub', 'finalize-a'), 'apple');

begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', :'u_id', 'role', 'authenticated')::text, true);
insert into public.sessions (id, user_id, started_at)
values (:'s_id', :'u_id', now());

-- request 1 read           → ended_at is null
select ended_at is null as r1_saw_null from public.sessions
where id = :'s_id' and user_id = :'u_id';
-- request 2 read (interleaved, same answer)
select ended_at is null as r2_saw_null from public.sessions
where id = :'s_id' and user_id = :'u_id';

-- request 1 write
update public.sessions set ended_at = '2026-09-04T10:00:00Z'
where id = :'s_id' and user_id = :'u_id';
-- request 2 write — the guard the route never sends would make this 0 rows
update public.sessions set ended_at = '2026-09-04T11:30:00Z'
where id = :'s_id' and user_id = :'u_id';

select ended_at,
       ended_at <> '2026-09-04T10:00:00Z' as moved
from public.sessions where id = :'s_id';
commit;
