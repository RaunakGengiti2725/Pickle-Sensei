-- Repro (boundary-malformed, seeds 1587929949 / 3276865404 / 2231381163):
-- account_deletion_requests grants the authenticated role INSERT/UPDATE on
-- created_at and expires_at (needed for the PostgREST merge-duplicates upsert),
-- and neither column is bounded. A client holding its own JWT can therefore
-- store expires_at = 'infinity' / created_at = '-infinity' on its own row:
--   * the pg_cron sweep `expires_at < now() - interval '1 day'` never purges it;
--   * PostgREST returns the literal strings "infinity" / "-infinity", which
--     Date.parse() turns into NaN, so in confirmAccountDeletion
--     (supabase/functions/api/index.ts) `Date.parse(expires_at) <= Date.now()`
--     and `Date.now() - Date.parse(created_at) < DELETE_CONFIRM_MIN_AGE_MS` are
--     both false: the challenge never expires and the review cool-down is skipped.
-- Run against the throwaway stress database only:
--   docker exec -i pickle-stress-pg psql -U postgres -v ON_ERROR_STOP=1 -f - < this_file
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'stress-a@example.test') on conflict (id) do nothing;
insert into public.profiles (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'stress-a@example.test') on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';

insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
values ('00000000-0000-4000-8000-0000000000aa', gen_random_uuid(), '-infinity', 'infinity')
on conflict (user_id) do update
  set challenge = excluded.challenge, created_at = excluded.created_at, expires_at = excluded.expires_at;

select user_id, created_at, expires_at,
       expires_at < now() - interval '1 day' as sweep_would_purge
from public.account_deletion_requests
where user_id = '00000000-0000-4000-8000-0000000000aa';

reset role;
-- The exact pg_cron statement from 20260831000000_scale_and_security.sql:
delete from public.account_deletion_requests where expires_at < now() - interval '1 day';
select count(*) as rows_surviving_sweep from public.account_deletion_requests
where user_id = '00000000-0000-4000-8000-0000000000aa';
rollback;
