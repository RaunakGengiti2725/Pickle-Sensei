-- ADV-05 — two devices of ONE free account race their last free rating.
--
-- Boundary: lifetime_scored_count() must be read under access_lock_key(uid)
-- in apply_synced_shot so two concurrent scored syncs holding DIFFERENT
-- reserved permits cannot both pass the backstop. Also: two concurrent copies
-- of the SAME shot (double tap / outbox replay after process death) must both
-- answer 'accepted' with exactly one row and one permit consumed. Real
-- concurrency: two extra sessions through dblink, the second blocked on the
-- advisory lock while the first holds its transaction open.
\set ON_ERROR_STOP on
\set QUIET on
create extension if not exists dblink;

-- Fixture (committed: dblink sessions must see it; re-runnable).
delete from auth.users where id = '00000000-0000-4000-8000-00000000ad51';
delete from public.free_rating_ledger
where identity_hash = public.free_rating_identity_hash('google', 'adv05-google-sub');
insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad51', 'adv05@example.com', '{"provider":"google"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad52', '00000000-0000-4000-8000-00000000ad51', 'google', 'adv05-google-sub');

\set adv05_conn 'host=' :socket_dir ' dbname=' :dbname ' user=postgres'
\o /dev/null
select set_config('adv05.conn', :'adv05_conn', false);
\o

create function pg_temp.adv05_shot(p_id uuid, p_permit uuid) returns text
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))::text
$$;

-- Each dblink session becomes the user with the API header, like PostgREST.
create function pg_temp.adv05_become(conn text) returns void language plpgsql as $$
begin
  perform dblink_exec(conn, 'begin');
  perform * from dblink(conn, format('select set_config(''request.headers'', %L, true)',
    jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text)) as t(v text);
  perform dblink_exec(conn, 'set local role authenticated');
  perform dblink_exec(conn, 'set local request.jwt.claim.sub = ''00000000-0000-4000-8000-00000000ad51''');
end $$;

create function pg_temp.adv05_await_lock(conn text) returns void language plpgsql as $$
declare i int := 0;
begin
  loop
    exit when exists (
      select 1 from pg_stat_activity a
      where a.application_name = conn and a.wait_event_type = 'Lock' and a.state = 'active'
    );
    i := i + 1;
    if i > 400 then raise exception 'ADV-05: second session never blocked on the advisory lock'; end if;
    perform pg_sleep(0.025);
  end loop;
end $$;

do $$
declare
  c text := current_setting('adv05.conn');
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; r1 text; r2 text; n int; consumed int;
begin
  perform dblink_connect('a', c || ' application_name=a');
  perform dblink_connect('b', c || ' application_name=b');

  -- One rating already spent; two more permits reserved (the second reserve
  -- is allowed: 1 used + 1 reserved < 2). The user is at the boundary.
  perform pg_temp.adv05_become('a');
  select v into p1 from dblink('a', 'select permit_id::text from public.reserve_analysis_permit(''adv05-k1'')') as t(v uuid);
  select v into r1 from dblink('a', format('select public.apply_synced_shot(%L::jsonb)', pg_temp.adv05_shot('00000000-0000-4000-8000-00000000ad53', p1))) as t(v text);
  if r1 <> 'accepted' then raise exception 'ADV-05 precondition: first rating %', r1; end if;
  select v into p2 from dblink('a', 'select permit_id::text from public.reserve_analysis_permit(''adv05-k2'')') as t(v uuid);
  perform dblink_exec('a', 'commit');
  if p2 is null then raise exception 'ADV-05 precondition: second permit must be reservable (1 used)'; end if;

  -- A third permit must be refused (1 used + 1 reserved = 2)... unless the
  -- second device raced: make it a swept/late permit instead, which still
  -- backs a sync (release/expired) but no longer occupies a slot.
  perform pg_temp.adv05_become('a');
  select v into r1 from dblink('a', 'select result from public.reserve_analysis_permit(''adv05-k3'')') as t(v text);
  perform dblink_exec('a', 'commit');
  if r1 <> 'access.paywall_required' then raise exception 'ADV-05 precondition: third reserve must be refused, got %', r1; end if;
  -- Owner sweep (committed on its own connection): p2 expires, freeing the
  -- slot; device B reserves p3.
  perform dblink_exec('a', format('update public.analysis_permits set status = ''released'', outcome = ''expired'' where id = %L::uuid', p2));
  perform pg_temp.adv05_become('b');
  select v into p3 from dblink('b', 'select permit_id::text from public.reserve_analysis_permit(''adv05-k3'')') as t(v uuid);
  perform dblink_exec('b', 'commit');
  if p3 is null then raise exception 'ADV-05 precondition: after the sweep a new permit must be reservable'; end if;

  -- RACE 1: device A syncs a scored shot on the swept p2 while device B syncs
  -- a scored shot on the live p3. Exactly ONE may become the second free
  -- rating; the other must be refused with the paywall and its permit
  -- released, never a third scored row.
  perform pg_temp.adv05_become('a');
  perform pg_temp.adv05_become('b');
  perform * from dblink('a', 'select pg_advisory_xact_lock(public.access_lock_key(''00000000-0000-4000-8000-00000000ad51''::uuid))') as t(v text);
  perform dblink_send_query('b', format('select public.apply_synced_shot(%L::jsonb)', pg_temp.adv05_shot('00000000-0000-4000-8000-00000000ad55', p3)));
  perform pg_temp.adv05_await_lock('b');
  select v into r1 from dblink('a', format('select public.apply_synced_shot(%L::jsonb)', pg_temp.adv05_shot('00000000-0000-4000-8000-00000000ad54', p2))) as t(v text);
  perform dblink_exec('a', 'commit');
  select v into r2 from dblink_get_result('b') as t(v text);
  perform * from dblink_get_result('b') as t(v text); -- drains the async result set
  perform dblink_exec('b', 'commit');

  select count(*) into n from public.shots where user_id = '00000000-0000-4000-8000-00000000ad51' and result_kind = 'scored';
  if n <> 2 then
    raise exception 'ADV-05 BREAK: concurrent scored syncs produced % scored rows for a free account (results a=%, b=%)', n, r1, r2;
  end if;
  if not ((r1 = 'accepted' and r2 = 'access.paywall_required') or (r1 = 'access.paywall_required' and r2 = 'accepted')) then
    raise exception 'ADV-05 BREAK: exactly one of the racing syncs must be accepted, got a=% b=%', r1, r2;
  end if;
  select count(*) into consumed from public.analysis_permits
  where user_id = '00000000-0000-4000-8000-00000000ad51' and status = 'finalized';
  if consumed <> 2 then
    raise exception 'ADV-05 BREAK: % permits finalized, expected exactly the two accepted ratings', consumed;
  end if;
  if exists (select 1 from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000ad51' and status = 'reserved') then
    raise exception 'ADV-05 BREAK: the losing permit stayed reserved (occupies an allowance slot forever)';
  end if;
  if (select max(scored_count) from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('google', 'adv05-google-sub')) <> 2 then
    raise exception 'ADV-05 BREAK: identity ledger disagrees with the two scored rows';
  end if;

  -- RACE 2: the SAME shot twice (double tap / relaunch replay of the outbox)
  -- on a premium account: both copies must answer accepted, one row.
  perform dblink_exec('a', 'insert into public.billing_entitlements (user_id, premium, expires_at, verified_at) values (''00000000-0000-4000-8000-00000000ad51'', true, now() + interval ''30 days'', now())');
  perform pg_temp.adv05_become('a');
  select v into p4 from dblink('a', 'select permit_id::text from public.reserve_analysis_permit(''adv05-k4'')') as t(v uuid);
  perform dblink_exec('a', 'commit');
  perform pg_temp.adv05_become('a');
  perform pg_temp.adv05_become('b');
  perform * from dblink('a', 'select pg_advisory_xact_lock(public.access_lock_key(''00000000-0000-4000-8000-00000000ad51''::uuid))') as t(v text);
  perform dblink_send_query('b', format('select public.apply_synced_shot(%L::jsonb)', pg_temp.adv05_shot('00000000-0000-4000-8000-00000000ad56', p4)));
  perform pg_temp.adv05_await_lock('b');
  select v into r1 from dblink('a', format('select public.apply_synced_shot(%L::jsonb)', pg_temp.adv05_shot('00000000-0000-4000-8000-00000000ad56', p4))) as t(v text);
  perform dblink_exec('a', 'commit');
  select v into r2 from dblink_get_result('b') as t(v text);
  perform * from dblink_get_result('b') as t(v text); -- drains the async result set
  perform dblink_exec('b', 'commit');
  if r1 <> 'accepted' or r2 <> 'accepted' then
    raise exception 'ADV-05 BREAK: a replayed copy of an accepted shot must be accepted, got a=% b=%', r1, r2;
  end if;
  select count(*) into n from public.shots where id = '00000000-0000-4000-8000-00000000ad56';
  if n <> 1 then raise exception 'ADV-05 BREAK: replay duplicated the shot (% rows)', n; end if;

  perform dblink_disconnect('a');
  perform dblink_disconnect('b');
end $$;

-- Cleanup (the ledger row is retained by design).
delete from auth.users where id = '00000000-0000-4000-8000-00000000ad51';
\echo 'ADV-05 concurrent sync double spend: PASS'
