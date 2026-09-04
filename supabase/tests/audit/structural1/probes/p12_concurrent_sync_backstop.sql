-- @fresh
-- P12 — Two concurrent apply_synced_shot calls holding DIFFERENT reserved
-- permits at lifetime_scored_count = 1 mint exactly ONE more scored shot.
--
-- 20260902150000_free_rating_identity_ledger.sql:398 takes
-- pg_advisory_xact_lock(access_lock_key(uid)) before the backstop count, so
-- the second writer must wait for the first commit and then see count = 2.
-- Over-issued permits are simulated by inserting two reserved rows as the
-- owner (reserve_analysis_permit would refuse the second at count = 1).
-- Uses dblink (postgres contrib) for two real sessions; commits fixture data,
-- hence @fresh.
\set ON_ERROR_STOP on
create extension if not exists dblink;
\i /probes/_seed.psql

-- Alice already spent one rating and (somehow) holds two reserved permits.
insert into public.analysis_permits (id, user_id, idempotency_key, status, outcome) values
  ('00000000-0000-4000-8000-0000000000a0', '00000000-0000-4000-8000-00000000000a', 'k0', 'finalized', 'scored'),
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 'k1', 'reserved', null),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-00000000000a', 'k2', 'reserved', null);
insert into public.shots (
  id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version, source)
values ('00000000-0000-4000-8000-0000000000e0', '00000000-0000-4000-8000-00000000000a', 'drive', 'side',
        '2026-08-30T10:00:00Z', 0, 500, 1000, 7.0, 0.9, 'scored',
        '1.0.0', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c', 'real');

-- One statement per session: become Alice, sync, then keep the transaction
-- (and the advisory lock) open for p_hold seconds before returning
-- '<status>|<seconds the RPC call itself took>'.
create table public.__probe_payloads as
select 1 as n, pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', 'scored', 7.1) as payload
union all
select 2, pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000a2', 'scored', 6.9);

create function public.__probe_sync_as_alice(p_n int, p_hold float)
returns text language plpgsql as $$
declare
  v text;
  t0 timestamptz := clock_timestamp();
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', true);
  select public.apply_synced_shot(payload) into v from public.__probe_payloads where n = p_n;
  v := v || '|' || extract(epoch from clock_timestamp() - t0)::text;
  perform pg_sleep(p_hold);
  return v;
end $$;
grant execute on function public.__probe_sync_as_alice(int, float) to authenticated;
grant select on public.__probe_payloads to authenticated;

select dblink_connect('c1', 'dbname=postgres user=postgres');
select dblink_connect('c2', 'dbname=postgres user=postgres');
select dblink_send_query('c1', 'select public.__probe_sync_as_alice(1, 2.0)');
select pg_sleep(0.3);
select dblink_send_query('c2', 'select public.__probe_sync_as_alice(2, 0)');

create temp table outcomes as
select conn, split_part(r, '|', 1) as status, split_part(r, '|', 2)::float as rpc_seconds
from (
  select 'c1' as conn, r from dblink_get_result('c1') as t(r text)
  union all
  select 'c2', r from dblink_get_result('c2') as t(r text)
) x;
select dblink_disconnect('c1');
select dblink_disconnect('c2');

begin;
select pg_temp.check('both sessions returned a status → ' || (select string_agg(conn || '=' || coalesce(status, '<none>'), ' ' order by conn) from outcomes),
  (select count(*) from outcomes where status is not null) = 2);
select pg_temp.check('session 2 queued behind session 1''s advisory lock (rpc took >= 1.5s) → ' || (select rpc_seconds::text from outcomes where conn = 'c2'),
  (select rpc_seconds from outcomes where conn = 'c2') >= 1.5);
select pg_temp.check('exactly one of the two concurrent syncs was accepted',
  (select count(*) from outcomes where status = 'accepted') = 1);
select pg_temp.check('the other was refused by the backstop (access.paywall_required)',
  (select count(*) from outcomes where status = 'access.paywall_required') = 1);
select pg_temp.check('alice ends with exactly 2 lifetime scored shots',
  (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-00000000000a' and result_kind = 'scored') = 2);
select pg_temp.check('the refused permit was released as free_limit_exceeded, the other finalized',
  (select string_agg(status || '/' || outcome, ',' order by status) from public.analysis_permits
   where id in ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2')) = 'finalized/scored,released/free_limit_exceeded');
select pg_temp.finish();
rollback;
