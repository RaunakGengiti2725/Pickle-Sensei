-- Exact SQL repro for the evaluation_trials size-cap unit mismatch
-- (found by boundary_malformed.test.ts seeds 2425218288 / 1571656339).
--
-- The edge fn (supabase/functions/api/index.ts, uploadEvaluationTrials) caps a
-- trial at `JSON.stringify(trial).length > 250_000` UTF-16 code units; the DB
-- caps `pg_column_size(payload) <= 262144` BYTES of *jsonb* (20260831160000
-- _defense_in_depth.sql). jsonb stores numerics as varlena `numeric` and
-- strings as UTF-8, so a payload that passes the edge check can still exceed
-- the DB cap -> 23514 -> the edge answers `evaluation.trial_write_failed`,
-- a code apps/mobile/src/data/sync.ts lists as TRANSIENT (retry forever).
--
-- Run against the disposable stress DB:
--   docker exec -i pickle-stress-pg psql -U postgres -v ON_ERROR_STOP=0 -f - \
--     < supabase/tests/stress/repro_trial_size_gap.sql
\set uid '''aaaaaaaa-0000-4000-8000-00000000000a'''
\set QUIET on
\pset format unaligned
\set QUIET off

begin;
insert into auth.users (id, email) values (:uid, 'stress-a@example.test') on conflict do nothing;
insert into public.profiles (id) values (:uid) on conflict do nothing;

-- (1) numeric-heavy: 30,000 two-decimal samples ("0.42") = ~150,000 chars of
-- JSON text (< 250,000 edge cap); each becomes a 12-byte jsonb numeric ...
select
  length(t)                              as text_chars,
  octet_length(t)                        as text_utf8_bytes,
  pg_column_size(t::jsonb)               as jsonb_bytes,
  pg_column_size(t::jsonb) > 262144      as over_db_cap,
  length(t) <= 250000                    as under_edge_cap
from (
  select '{"trialId":"11111111-1111-4111-8111-111111111111","schemaVersion":1,"samples":['
      || string_agg('0.' || lpad((g * 37 % 100)::text, 2, '0'), ',')
      || ']}' as t
  from generate_series(1, 30000) g
) s;

-- ... which the DB refuses (23514 evaluation_trials_payload_size) even though
-- the edge fn would have forwarded it:
savepoint numeric_heavy;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
insert into public.evaluation_trials (id, user_id, payload)
select '11111111-1111-4111-8111-111111111111', :uid,
  ('{"trialId":"11111111-1111-4111-8111-111111111111","schemaVersion":1,"samples":['
      || string_agg('0.' || lpad((g * 37 % 100)::text, 2, '0'), ',')
      || ']}')::jsonb
from generate_series(1, 30000) g;
rollback to savepoint numeric_heavy;

-- (2) multibyte: 90,611 chars (271,711 UTF-8 bytes) — same mismatch.
select
  length(t) as text_chars, octet_length(t) as text_utf8_bytes,
  pg_column_size(t::jsonb) as jsonb_bytes,
  pg_column_size(t::jsonb) > 262144 as over_db_cap,
  length(t) <= 250000 as under_edge_cap
from (select '{"trialId":"22222222-2222-4222-8222-222222222222","notes":"' || repeat('測', 90550) || '"}' as t) s;

savepoint multibyte;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-00000000000a', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
insert into public.evaluation_trials (id, user_id, payload)
values ('22222222-2222-4222-8222-222222222222', :uid,
  ('{"trialId":"22222222-2222-4222-8222-222222222222","notes":"' || repeat('測', 90550) || '"}')::jsonb);
rollback to savepoint multibyte;

-- Control: the same shape at 250,000 ASCII chars of short-digit numerics is
-- ALSO over the cap; only small/plain-ASCII payloads fit both.
select pg_column_size(('{"a":"' || repeat('x', 249990) || '"}')::jsonb) as ascii_250k_jsonb_bytes,
       pg_column_size(('{"a":"' || repeat('x', 249990) || '"}')::jsonb) <= 262144 as ascii_250k_fits;
rollback;
