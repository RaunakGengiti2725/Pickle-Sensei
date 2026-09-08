-- ADV-10 — id collisions across users, the offline sweep, and deleted history.
--
-- Boundaries probed through the client roles (bearer + API key):
--   1. B syncs a shot whose id already belongs to A (a colliding client id or
--      a replayed foreign outbox): typed refusal, no row for B, B's permit
--      still reserved (clean retry with a fresh id possible), A's row intact.
--   2. A's permit is swept to released/expired while the device is offline;
--      the device comes back with an abstention (low_confidence): the permit
--      settles to released/low_confidence, no rating is counted, and a later
--      scored sync reusing that permit for ANOTHER shot id is refused.
--   3. Owner-role removal of A's scored shots (support tooling / history
--      purge / cascade bug) must not hand the free ratings back:
--      lifetime_scored_count() stays 2 and reserve_analysis_permit() refuses.
--   4. Owner-role delete of A's finalized permit leaves a tombstone: a new
--      shot on that permit id is refused; the original shot id replays as
--      accepted (still owned) — never a second row.
--   5. Client attempts to reopen / re-settle A's finalized permit are refused
--      and leave the row unchanged.
\set ON_ERROR_STOP on
\set QUIET on
begin;

create function pg_temp.adv10_shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 end, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.adv10_shot(uuid, uuid, text) to authenticated, anon;

create function pg_temp.adv10_become(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
end $$;
grant execute on function pg_temp.adv10_become(uuid) to authenticated, anon;

insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 'adv10-a@example.com', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000b1', 'adv10-b@example.com', '{"provider":"google"}');
insert into auth.identities (id, user_id, provider, provider_id) values
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1', 'apple', 'adv10-apple-A'),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b1', 'google', 'adv10-google-B');

-- A: one scored shot (permit pa1), one more permit (pa2) left reserved.
do $$ begin perform pg_temp.adv10_become('00000000-0000-4000-8000-0000000000a1'); end $$;
set local role authenticated;
do $$
declare pa1 uuid; pa2 uuid; r text;
begin
  select permit_id into pa1 from public.reserve_analysis_permit('adv10-a-k1');
  select permit_id into pa2 from public.reserve_analysis_permit('adv10-a-k2');
  r := public.apply_synced_shot(pg_temp.adv10_shot('00000000-0000-4000-8000-0000000000a3', pa1, 'scored'));
  if r <> 'accepted' then raise exception 'ADV-10 precondition: A first sync %', r; end if;
  perform set_config('adv10.pa1', pa1::text, true);
  perform set_config('adv10.pa2', pa2::text, true);
end $$;
reset role;

-- 1. B collides with A's shot id.
do $$ begin perform pg_temp.adv10_become('00000000-0000-4000-8000-0000000000b1'); end $$;
set local role authenticated;
do $$
declare pb uuid; r text;
begin
  select permit_id into pb from public.reserve_analysis_permit('adv10-b-k1');
  r := public.apply_synced_shot(pg_temp.adv10_shot('00000000-0000-4000-8000-0000000000a3', pb, 'scored'));
  if r = 'accepted' then
    raise exception 'ADV-10 BREAK: B was told accepted for a shot id owned by A';
  end if;
  if r not like 'shot.%' and r not like 'access.%' then
    raise exception 'ADV-10 BREAK: colliding id produced an untyped result %', r;
  end if;
  if exists (select 1 from public.shots where user_id = '00000000-0000-4000-8000-0000000000b1') then
    raise exception 'ADV-10 BREAK: a colliding sync wrote a row for B';
  end if;
  if (select status from public.analysis_permits where id = pb) <> 'reserved' then
    raise exception 'ADV-10 BREAK: a colliding sync settled B''s permit (%)', (select status || '/' || coalesce(outcome, 'NULL') from public.analysis_permits where id = pb);
  end if;
  if public.lifetime_scored_count() <> 0 then
    raise exception 'ADV-10 BREAK: a refused collision counted a rating for B';
  end if;
  -- Clean retry with a fresh id works on the same permit.
  r := public.apply_synced_shot(pg_temp.adv10_shot('00000000-0000-4000-8000-0000000000b3', pb, 'scored'));
  if r <> 'accepted' then raise exception 'ADV-10 BREAK: retry with a fresh id after a collision refused: %', r; end if;
end $$;
reset role;

-- A's row is intact.
do $$
begin
  if (select user_id from public.shots where id = '00000000-0000-4000-8000-0000000000a3') <> '00000000-0000-4000-8000-0000000000a1' then
    raise exception 'ADV-10 BREAK: A''s shot changed owner';
  end if;
end $$;

-- 2. pg_cron sweep of A's pa2 (exact statement from the migration), then an
-- offline abstention lands on it.
update public.analysis_permits set status = 'released', outcome = 'expired'
where status = 'reserved' and id = current_setting('adv10.pa2')::uuid;

do $$ begin perform pg_temp.adv10_become('00000000-0000-4000-8000-0000000000a1'); end $$;
set local role authenticated;
do $$
declare pa2 uuid := current_setting('adv10.pa2')::uuid; r text; st text;
begin
  r := public.apply_synced_shot(pg_temp.adv10_shot('00000000-0000-4000-8000-0000000000a4', pa2, 'low_confidence'));
  if r <> 'accepted' then raise exception 'ADV-10 BREAK: abstention on a swept permit refused: %', r; end if;
  select status || '/' || coalesce(outcome, 'NULL') into st from public.analysis_permits where id = pa2;
  if st <> 'released/low_confidence' then
    raise exception 'ADV-10 BREAK: swept permit after an abstention is %, expected released/low_confidence', st;
  end if;
  if public.lifetime_scored_count() <> 1 then
    raise exception 'ADV-10 BREAK: an abstention changed the lifetime count to %', public.lifetime_scored_count();
  end if;
  -- The same permit cannot back a second, scored shot.
  r := public.apply_synced_shot(pg_temp.adv10_shot('00000000-0000-4000-8000-0000000000a5', pa2, 'scored'));
  if r <> 'access.permit_not_reserved' then
    raise exception 'ADV-10 BREAK: a settled permit backed a second shot: %', r;
  end if;
  if public.lifetime_scored_count() <> 1 then
    raise exception 'ADV-10 BREAK: lifetime count moved on a refused sync';
  end if;
end $$;

-- 5. Client attempts to move A's finalized permit.
do $$
begin
  update public.analysis_permits set status = 'reserved', outcome = null where id = current_setting('adv10.pa1')::uuid;
  raise exception 'ADV-10 BREAK: client reopened a finalized permit as reserved';
exception when check_violation or insufficient_privilege then
  null;
end $$;
do $$
begin
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = current_setting('adv10.pa1')::uuid;
  raise exception 'ADV-10 BREAK: client re-settled a finalized permit as released/cancelled';
exception when check_violation or insufficient_privilege then
  null;
end $$;
do $$
begin
  if (select status || '/' || outcome from public.analysis_permits where id = current_setting('adv10.pa1')::uuid) <> 'finalized/scored' then
    raise exception 'ADV-10 BREAK: A''s finalized permit changed';
  end if;
end $$;
reset role;

-- 3. Owner-role history purge: A's scored shots vanish; the free ratings must
-- not come back (A has spent 1 of 2; spend the second first so the boundary
-- is exact).
do $$ begin perform pg_temp.adv10_become('00000000-0000-4000-8000-0000000000a1'); end $$;
set local role authenticated;
do $$
declare p uuid; r text;
begin
  select permit_id into p from public.reserve_analysis_permit('adv10-a-k3');
  if p is null then raise exception 'ADV-10 precondition: A second reservation'; end if;
  r := public.apply_synced_shot(pg_temp.adv10_shot('00000000-0000-4000-8000-0000000000a6', p, 'scored'));
  if r <> 'accepted' then raise exception 'ADV-10 precondition: A second sync %', r; end if;
  if public.lifetime_scored_count() <> 2 then raise exception 'ADV-10 precondition: A lifetime 2'; end if;
end $$;
reset role;

delete from public.shots where user_id = '00000000-0000-4000-8000-0000000000a1';

do $$ begin perform pg_temp.adv10_become('00000000-0000-4000-8000-0000000000a1'); end $$;
set local role authenticated;
do $$
declare r text; p uuid;
begin
  if public.lifetime_scored_count() <> 2 then
    raise exception 'ADV-10 BREAK: deleting the scored rows refunded free ratings (lifetime now %)', public.lifetime_scored_count();
  end if;
  select result, permit_id into r, p from public.reserve_analysis_permit('adv10-a-k4');
  if r <> 'access.paywall_required' or p is not null then
    raise exception 'ADV-10 BREAK: a purged history let the identity reserve again (%)', r;
  end if;
  if (select scored_count from public.access_state()) <> 2 then
    raise exception 'ADV-10 BREAK: access_state() shows % after a purge', (select scored_count from public.access_state());
  end if;
end $$;
reset role;

-- 4. Owner-role delete of A's finalized permit → tombstone.
delete from public.analysis_permits where id = current_setting('adv10.pa1')::uuid;
do $$
begin
  if not exists (select 1 from public.analysis_permit_tombstones where permit_id = current_setting('adv10.pa1')::uuid) then
    raise exception 'ADV-10 BREAK: deleting a finalized permit left no tombstone';
  end if;
end $$;

-- Make A premium so only the permit logic decides.
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
values ('00000000-0000-4000-8000-0000000000a1', true, now() + interval '30 days', now());

do $$ begin perform pg_temp.adv10_become('00000000-0000-4000-8000-0000000000a1'); end $$;
set local role authenticated;
do $$
declare pa1 uuid := current_setting('adv10.pa1')::uuid; r text;
begin
  r := public.apply_synced_shot(pg_temp.adv10_shot('00000000-0000-4000-8000-0000000000a7', pa1, 'scored'));
  if r <> 'access.permit_not_reserved' then
    raise exception 'ADV-10 BREAK: a tombstoned (consumed) permit backed a new shot: %', r;
  end if;
  if exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000a7') then
    raise exception 'ADV-10 BREAK: a tombstoned permit produced a row';
  end if;
  -- The client re-creates the permit as reserved (INSERT grant) to reuse it.
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values (pa1, '00000000-0000-4000-8000-0000000000a1', 'adv10-a-k1-again');
    raise exception 'ADV-10 BREAK: a tombstoned permit id was re-created as reserved';
  exception when check_violation or insufficient_privilege then
    null;
  end;
end $$;
reset role;

rollback;
\echo 'ADV-10 collisions, sweeps and deleted history: PASS'
