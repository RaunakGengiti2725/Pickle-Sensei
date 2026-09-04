-- Minimized repro for the two boundary findings the db-drills-saved
-- boundary/malformed campaign reduced to (see stress/README.md):
--
--   F1  public.user_saved_drills.saved_at accepts non-finite / absurd
--       timestamps from an ordinary authenticated session. GET
--       /v1/me/saved-drills stringifies whatever is stored
--       (supabase/functions/api/index.ts listSavedDrills), and the mobile
--       parser rejects a row whose Date.parse is NaN by throwing for the
--       WHOLE response (apps/mobile/src/training/api.ts parseSavedDrill /
--       isIso) — one poisoned row hides every saved drill.
--
--   F2  `authenticated` holds table-wide INSERT/UPDATE on the table, so a
--       client can rewrite slug and saved_at of an existing bookmark even
--       though the edge function only ever upserts (user_id, slug) with
--       ignoreDuplicates and never issues an UPDATE.
--
-- Run against the throwaway cluster built by stress/setup_db.sh (schema is
-- identical to run_rls_tests.sh: shim_auth.sql + every migration in order):
--
--   ./supabase/tests/run_rls_tests.sh          # unrelated: the existing gate
--   ./supabase/tests/stress/setup_db.sh
--   docker cp supabase/tests/stress/repro_saved_at_unbounded.sql \
--     pickle-stress-db:/repro.sql
--   docker exec pickle-stress-db psql -U postgres -v ON_ERROR_STOP=1 -f /repro.sql
--
-- Expected once fixed: every INSERT/UPDATE below fails with 23514 (a
-- saved_at bounds CHECK), or the UPDATE fails with 42501 (no client UPDATE
-- grant). Today they all succeed, which is why this file ends in ROLLBACK
-- and prints the accepted rows instead of raising.
\set ON_ERROR_STOP on

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000da11c', 'stress-alice@example.test')
on conflict (id) do nothing;
insert into public.profiles (id, display_name)
values ('00000000-0000-4000-8000-0000000da11c', 'Stress Alice')
on conflict (id) do nothing;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000da11c';
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-0000000da11c","role":"authenticated"}';

-- F1 via INSERT (campaign seed drills-saved-boundary:143 = ts-infinity).
insert into public.user_saved_drills (user_id, slug, saved_at)
values
  ('00000000-0000-4000-8000-0000000da11c', 'dink-cross-court', 'infinity'),
  ('00000000-0000-4000-8000-0000000da11c', 'dink-straight', '-infinity'),
  ('00000000-0000-4000-8000-0000000da11c', 'third-shot-drop', '294276-01-01T00:00:00Z'),
  ('00000000-0000-4000-8000-0000000da11c', 'reset-block', '4714-11-24 BC'),
  ('00000000-0000-4000-8000-0000000da11c', 'serve-depth', '1970-01-01T00:00:00Z');

-- F2 via UPDATE (campaign seed drills-saved-boundary:83 = ts-max-year): the
-- edge function never updates this table, yet the client may rewrite both
-- non-key columns in place.
update public.user_saved_drills
set slug = 'renamed-by-client', saved_at = 'infinity'
where user_id = '00000000-0000-4000-8000-0000000da11c'
  and slug = 'serve-depth';

-- What the API would hand the app: to_jsonb() is exactly the shape
-- PostgREST/supabase-js returns, and `parseable` is what mobile isIso() does.
select
  slug,
  saved_at::text as stored,
  to_jsonb(saved_at) #>> '{}' as api_string,
  saved_at > '2000-01-01Z'::timestamptz and saved_at < '2100-01-01Z'::timestamptz as in_window
from public.user_saved_drills
where user_id = '00000000-0000-4000-8000-0000000da11c'
order by saved_at;

rollback;
