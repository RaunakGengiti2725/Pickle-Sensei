-- F1: DML against the aggregate views (practice_days, progress_daily,
-- player_technique_rating) fails with SQLSTATE 55000 (object_not_in_prerequisite_state)
-- for BOTH anon and authenticated — PostgreSQL rejects the rewrite before any
-- privilege check, so the anon REVOKE never produces 42501 here and PostgREST
-- maps 55000 to HTTP 500 with the view's DISTINCT/GROUP BY detail in the body.
-- Minimized from campaign seeds 1262119525 (index 334, anon delete
-- practice_days) and 3194190382 (index 1168, nullsub insert
-- player_technique_rating). Expected by the lens: typed 4xx (42501 → 401/403).
\set ON_ERROR_STOP off
\set QUIET on
\pset format unaligned
\pset tuples_only on

begin;
set local role anon;
delete from public.practice_days where user_id = '00000000-0000-4000-8000-00000000000a';
\echo OBSERVED anon delete practice_days sqlstate=:LAST_ERROR_SQLSTATE
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
delete from public.practice_days where user_id = '00000000-0000-4000-8000-00000000000a';
\echo OBSERVED alice delete practice_days sqlstate=:LAST_ERROR_SQLSTATE
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
insert into public.player_technique_rating (user_id) values ('00000000-0000-4000-8000-00000000000a');
\echo OBSERVED alice insert player_technique_rating sqlstate=:LAST_ERROR_SQLSTATE
rollback;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
delete from public.progress_daily where user_id = '00000000-0000-4000-8000-00000000000a';
\echo OBSERVED alice delete progress_daily sqlstate=:LAST_ERROR_SQLSTATE
rollback;

-- root cause: hosted default privileges hand authenticated every table
-- privilege on the views; anon holds none yet still reaches 55000.
select 'GRANTS ' || table_name || ' ' || grantee || ' ' || string_agg(privilege_type, ',' order by privilege_type)
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('practice_days', 'progress_daily', 'player_technique_rating')
  and grantee in ('anon', 'authenticated')
group by table_name, grantee
order by table_name, grantee;
