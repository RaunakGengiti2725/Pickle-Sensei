-- Repro (boundary-malformed, seeds 2871461063 / 1248319915 / 3756893335):
-- analysis_permits grants the authenticated role INSERT on id, created_at,
-- status, outcome, idempotency_key (RLS pins user_id = auth.uid()). created_at
-- is unbounded, so a client can insert its own *reserved* permit with
-- created_at = 'infinity' (or year 9999):
--   * `expire-stale-analysis-permits` (created_at < now() - 24h) never releases it;
--   * access_state() counts it in reserved_count forever (created_at > now() - 24h),
--     so the user's own free allowance is permanently consumed (self-inflicted);
--   * apply_synced_shot() treats it as a live permit (age check passes) — the
--     lifetime free-rating backstop still holds because it counts scored shots,
--     not permits.
-- Run against the throwaway stress database only.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'stress-a@example.test') on conflict (id) do nothing;
insert into public.profiles (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'stress-a@example.test') on conflict (id) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000aa';
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}';

insert into public.analysis_permits (user_id, idempotency_key, status, created_at)
values ('00000000-0000-4000-8000-0000000000aa', 'repro-infinity', 'reserved', 'infinity'),
       ('00000000-0000-4000-8000-0000000000aa', 'repro-9999', 'reserved', '9999-12-31T00:00:00Z');

select * from public.access_state();

reset role;
-- The exact pg_cron statement from 20260831000000_scale_and_security.sql:
update public.analysis_permits set status = 'released', outcome = 'expired'
where status = 'reserved' and created_at < now() - interval '24 hours';

select idempotency_key, status, outcome, created_at
from public.analysis_permits
where user_id = '00000000-0000-4000-8000-0000000000aa' and idempotency_key like 'repro-%'
order by idempotency_key;
rollback;
