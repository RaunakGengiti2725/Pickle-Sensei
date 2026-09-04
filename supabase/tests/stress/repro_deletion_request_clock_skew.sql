-- Exact repro for the clock-skew observation recorded by
-- deletion_consent_concurrency.mjs (scenario clock_skew_probe): the
-- authenticated client holds INSERT/UPDATE grants on
-- public.account_deletion_requests.created_at / expires_at, and no CHECK
-- constrains the pair. A client can therefore self-mint a deletion challenge
-- that is already older than the edge function's DELETE_CONFIRM_MIN_AGE_MS
-- cooling-off (supabase/functions/api/index.ts:3062) and that never expires
-- (index.ts:3055), or an incoherent row whose expires_at precedes created_at.
--
-- Blast radius is the caller's OWN account only (RLS pins user_id = auth.uid()
-- and the confirm path re-reads the row for that user), so this is a
-- defense-in-depth gap, not an auth bypass.
--
-- Run against a throwaway DB built by ./supabase/tests/stress/setup_stress_db.sh:
--   psql "$STRESS_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/stress/repro_deletion_request_clock_skew.sql

begin;

insert into auth.users (id, email, raw_app_meta_data)
values (
  '00000000-0000-4000-8000-0000c10c5ce0'::uuid,
  'clock-skew@example.com',
  '{"provider":"apple"}'::jsonb
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-8000-0000c10c5ce0',
  true
);

-- (1) backdated created_at + effectively unbounded expires_at: accepted.
insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
values (
  auth.uid(),
  gen_random_uuid(),
  now() - interval '10 years',
  now() + interval '200 years'
)
on conflict (user_id) do update
  set challenge = excluded.challenge,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at;

select
  now() - created_at         as age_at_confirm_time,   -- >> 3s cooling-off
  expires_at > now()         as still_live,            -- never expires
  expires_at - created_at    as window_width
from public.account_deletion_requests
where user_id = auth.uid();

-- (2) incoherent window (expires_at < created_at): also accepted.
update public.account_deletion_requests
set created_at = now(),
    expires_at = now() - interval '1 hour'
where user_id = auth.uid();

select created_at > expires_at as inverted_window
from public.account_deletion_requests
where user_id = auth.uid();

rollback;
