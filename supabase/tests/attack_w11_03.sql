-- Adversarial probes for W11-03 (20260910110300_cron_offline_allocation_safe):
-- api_private.sweep_stale_analysis_permits() at its failure boundaries.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/attack_w11_03.sql
--
-- against a database that has shim_auth.sql and every migration applied. The
-- file runs in autocommit: the fixture users, the probe schema and the
-- concurrency rows are COMMITTED so that the second/third connections
-- (dblink) can see them; every attack cleans up after itself and the last
-- statement removes the fixtures. Each attack first sweeps whatever stale
-- permits the database already carries so its counts are exact (the run
-- therefore assumes a disposable database). Each attack is a DO block that raises on a
-- break, so ON_ERROR_STOP turns any break into a non-zero exit.
--
-- Attacks (all against the candidate; none may modify the candidate's own
-- tests or migration):
--   A1 cron execution context: owner session, no API proof, no JWT — sweeps
--      exactly the stale reserved permits, returns the count, idempotent, and
--      the batch bound takes the OLDEST first.
--   A2 boundary values: created_at exactly at, 1µs before and 1µs after the
--      24h cutoff; a far-future created_at; p_limit NULL/-1/0/1/10000/10001;
--      an empty batch.
--   A3 corrupt/partial state: every settled outcome (scored, low_confidence,
--      partial, cancelled, failed, unsupported, incorrect_recognition,
--      free_limit_exceeded, expired) aged past the cutoff is terminal to the
--      sweep; a stale reserved permit already recorded on a shot moves
--      without touching the shot or its receipt.
--   A4 concurrency (reverse lock direction): the sweep holds the row lock
--      while a late apply_synced_shot() arrives; the sync must wait, then be
--      ACCEPTED against the released/expired row (finalized/scored, receipt
--      written, counted once). Also: LIMIT 1 refills past a locked row, and
--      two overlapping sweeps partition the batch with no double count.
--   A5 unauthorised roles: anon, authenticated (API proof + active session)
--      and service_role are all 42501 (schema or function); no client role
--      holds EXECUTE; the definer is owned by the cron user.
--   A6 conservation: an outstanding offline ticket, its HELD receipt, the
--      consumed ticket's receipt and lifetime_scored_count() are byte-for-byte
--      unchanged by a sweep that DOES move a stale online permit of the same
--      user.
--   A8 plan regression: the function's own UPDATE stays index-backed on a
--      populated table (bounded and unbounded).
-- A7 (live pg_cron worker run) needs a pg_cron build and lives in
-- attack_w11_03_cron.sql; the AC2 base premise probe is
-- attack_w11_03_base_premise.sql.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- committed fixtures (the free-rating ledger follows the sign-in identity and
-- survives account deletion by design, so it is reset for the fixture
-- identities explicitly)
-- ---------------------------------------------------------------------------
delete from public.free_rating_ledger where identity_hash in (
  encode(sha256(convert_to('google:google-sub-ada', 'UTF8')), 'hex'),
  encode(sha256(convert_to('apple:apple-sub-abe', 'UTF8')), 'hex'),
  encode(sha256(convert_to('google:google-sub-al', 'UTF8')), 'hex'));
delete from auth.users where id in (
  '00000000-0000-4000-8000-00000000a081',
  '00000000-0000-4000-8000-00000000a082',
  '00000000-0000-4000-8000-00000000a083');
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('00000000-0000-4000-8000-00000000a081', 'ada@example.com', '{"full_name":"Ada"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a082', 'abe@example.com', '{"full_name":"Abe"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-00000000a083', 'al@example.com', '{"full_name":"Al"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-ada', '00000000-0000-4000-8000-00000000a081', '{"sub":"google-sub-ada","email":"ada@example.com"}'),
  ('apple', 'apple-sub-abe', '00000000-0000-4000-8000-00000000a082', '{"sub":"apple-sub-abe","email":"abe@example.com"}'),
  ('google', 'google-sub-al', '00000000-0000-4000-8000-00000000a083', '{"sub":"google-sub-al","email":"al@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000000a181', '00000000-0000-4000-8000-00000000a081'),
  ('00000000-0000-4000-8000-00000000a182', '00000000-0000-4000-8000-00000000a082'),
  ('00000000-0000-4000-8000-00000000a183', '00000000-0000-4000-8000-00000000a083');

drop schema if exists atk_probe cascade;
create schema atk_probe;
-- dblink is relocatable; a database that already carries it (another probe
-- schema left by an earlier suite) lends it to this schema for the run
do $$
begin
  if exists (select 1 from pg_extension where extname = 'dblink') then
    execute 'alter extension dblink set schema atk_probe';
  else
    execute 'create extension dblink with schema atk_probe';
  end if;
end $$;

create function atk_probe.shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-10T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
create function atk_probe.settle(p_owner uuid, p_shot jsonb, p_operation text)
returns jsonb language sql immutable set search_path = '' as $$
  with binding as (
    select jsonb_build_object(
      'ownerId', p_owner,
      'shotId', p_shot ->> 'id',
      'analysisPermitId', p_shot ->> 'analysisPermitId',
      'resultKind', p_shot ->> 'resultKind',
      'installationKeyId', 'ik_atk_phone',
      'grant', null,
      'ticket', null,
      'operationId', p_operation,
      'payloadSha256', encode(pg_catalog.sha256(convert_to(p_shot::text, 'UTF8')), 'hex')
    ) as b
  ), receipt as (
    select jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'settlement_receipt',
      'binding', b,
      'bindingSha256', encode(pg_catalog.sha256(convert_to(b::text, 'UTF8')), 'hex'),
      'policy', jsonb_build_object('version', 'policy-2026-09-08', 'sha256', repeat('b', 64))
    ) as r
    from binding
  )
  select p_shot || jsonb_build_object('settlementReceipt', jsonb_build_object(
    'canonical', r::text,
    'sha256', encode(pg_catalog.sha256(convert_to(r::text, 'UTF8')), 'hex')))
  from receipt
$$;
create function atk_probe.receipt(
  p_receipt_id text, p_owner uuid, p_key text, p_grant uuid, p_ticket uuid,
  p_operation text, p_result uuid
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', 'offline-result-receipt-v1',
    'receiptId', p_receipt_id,
    'ownerId', p_owner,
    'installationKeyId', p_key,
    'grantId', p_grant,
    'grantJwsSha256', repeat('a', 64),
    'lifecycleSequence', 1,
    'nativeTime', jsonb_build_object('monotonicMs', 1000, 'wallClockIso', '2026-09-10T10:00:00Z'),
    'ticket', jsonb_build_object('allocationId', p_grant, 'generation', 1, 'ticketId', p_ticket),
    'operationId', p_operation,
    'resultId', p_result,
    'fullOutputSha256', repeat('c', 64),
    'billingDisposition', 'joint_verification_required')
$$;
create function atk_probe.settle_receipt(p_receipt jsonb, p_output jsonb, p_hold text)
returns table (result text, delivery text, status text, reason_code text, financial_disposition text, result_id text)
language sql set search_path = '' as $$
  select * from public.settle_offline_receipt(
    p_receipt, encode(pg_catalog.sha256(convert_to(p_receipt::text, 'UTF8')), 'hex'), p_output, p_hold)
$$;
-- The client's late sync, exactly as the edge issues it: role authenticated,
-- API proof header, JWT sub + active session. Runs in whatever connection
-- calls it (used from the async second connection in A4).
create function atk_probe.late_sync(p_uid uuid, p_session uuid, p_shot jsonb) returns text
language plpgsql set search_path = '' as $$
declare v text;
begin
  perform pg_catalog.set_config('request.headers',
    jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', p_uid::text, true);
  perform pg_catalog.set_config('request.jwt.claims', jsonb_build_object('session_id', p_session)::text, true);
  execute 'set local role authenticated';
  v := public.apply_synced_shot(p_shot);
  execute 'reset role';
  return v;
end $$;
create function atk_probe.permits(p_uid uuid) returns text
language sql security definer set search_path = '' as $$
  select coalesce(string_agg(right(p.id::text, 4) || '=' || p.status || '/' || coalesce(p.outcome, '-'), ',' order by p.created_at, p.id), '')
  from public.analysis_permits p where p.user_id = p_uid;
$$;
create function atk_probe.digest(p_table text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  execute format(
    'select coalesce(md5(string_agg(t::text, %L order by t::text)), %L) from %s t',
    '|', 'empty', p_table) into v;
  return v;
end $$;
create function atk_probe.offline_digest() returns text
language sql security definer set search_path = '' as $$
  select atk_probe.digest('public.offline_devices') || '/' || atk_probe.digest('public.offline_grants') || '/'
      || atk_probe.digest('public.offline_allocation_ledger') || '/' || atk_probe.digest('public.settlement_receipts') || '/'
      || atk_probe.digest('public.offline_receipt_settlements') || '/' || atk_probe.digest('public.free_rating_ledger')
$$;
create function atk_probe.conn() returns text
language sql stable set search_path = '' as $$
  select format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database())
$$;
grant usage on schema atk_probe to authenticated;
grant execute on all functions in schema atk_probe to authenticated;

-- ---------------------------------------------------------------------------
-- A1: the cron execution context. pg_cron runs the job in a fresh session as
-- the scheduling user: no request.headers, no JWT, no API proof. The sweep
-- must neither depend on nor be blocked by any of that.
-- ---------------------------------------------------------------------------
begin;
select set_config('request.headers', '', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claims', '', true);
set local lock_timeout = '5s';
-- a database that already carries stale permits (e.g. a pg_cron image whose
-- hourly job has not fired yet) is swept first so the counts below are exact
select api_private.sweep_stale_analysis_permits();
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000a801', '00000000-0000-4000-8000-00000000a082', 'a1-stale-oldest', now() - interval '3 days'),
  ('00000000-0000-4000-8000-00000000a802', '00000000-0000-4000-8000-00000000a082', 'a1-stale-middle', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000a803', '00000000-0000-4000-8000-00000000a082', 'a1-stale-newest', now() - interval '25 hours'),
  ('00000000-0000-4000-8000-00000000a804', '00000000-0000-4000-8000-00000000a082', 'a1-live', now() - interval '1 hour');
do $$
declare n integer; abe uuid := '00000000-0000-4000-8000-00000000a082';
begin
  if api_private.is_api_request() or (select auth.uid()) is not null then
    raise exception 'A1 precondition: the cron context carries no API proof and no JWT';
  end if;
  n := api_private.sweep_stale_analysis_permits(1);
  if n <> 1 or atk_probe.permits(abe) <> 'a801=released/expired,a802=reserved/-,a803=reserved/-,a804=reserved/-' then
    raise exception 'A1: a batch of 1 sweeps exactly the OLDEST stale permit (got %, %)', n, atk_probe.permits(abe);
  end if;
  n := api_private.sweep_stale_analysis_permits();
  if n <> 2 or atk_probe.permits(abe) <> 'a801=released/expired,a802=released/expired,a803=released/expired,a804=reserved/-' then
    raise exception 'A1: the unbounded sweep takes the rest and leaves the live reservation (got %, %)', n, atk_probe.permits(abe);
  end if;
  n := api_private.sweep_stale_analysis_permits();
  if n <> 0 then
    raise exception 'A1: a second sweep is a no-op (got %)', n;
  end if;
  if exists (select 1 from public.analysis_permits where user_id = abe and status = 'released' and updated_at < created_at) then
    raise exception 'A1: updated_at moves with the sweep';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- A2: boundary values. now() is fixed for the transaction, so a created_at
-- of exactly now() - 24h is the cutoff itself.
-- ---------------------------------------------------------------------------
begin;
set local lock_timeout = '5s';
select api_private.sweep_stale_analysis_permits();
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000a811', '00000000-0000-4000-8000-00000000a082', 'a2-exactly-24h', now() - interval '24 hours'),
  ('00000000-0000-4000-8000-00000000a812', '00000000-0000-4000-8000-00000000a082', 'a2-24h-plus-1us', now() - interval '24 hours' - interval '1 microsecond'),
  ('00000000-0000-4000-8000-00000000a813', '00000000-0000-4000-8000-00000000a082', 'a2-24h-minus-1us', now() - interval '24 hours' + interval '1 microsecond'),
  ('00000000-0000-4000-8000-00000000a814', '00000000-0000-4000-8000-00000000a082', 'a2-far-future', now() + interval '1 year'),
  ('00000000-0000-4000-8000-00000000a815', '00000000-0000-4000-8000-00000000a082', 'a2-far-past', '1970-01-01T00:00:00Z');
do $$
declare n integer; abe uuid := '00000000-0000-4000-8000-00000000a082'; bad integer;
begin
  foreach bad in array array[-1, 0, 10001, -2147483648, 2147483647] loop
    begin
      perform api_private.sweep_stale_analysis_permits(bad);
      raise exception 'A2: batch bound % must be refused', bad;
    exception when invalid_parameter_value then null;
    end;
  end loop;
  if atk_probe.permits(abe) <> 'a815=reserved/-,a812=reserved/-,a811=reserved/-,a813=reserved/-,a814=reserved/-' then
    raise exception 'A2: a refused bound must not sweep anything (got %)', atk_probe.permits(abe);
  end if;
  n := api_private.sweep_stale_analysis_permits(10000);
  if n <> 2 or atk_probe.permits(abe) <> 'a815=released/expired,a812=released/expired,a811=reserved/-,a813=reserved/-,a814=reserved/-' then
    raise exception 'A2: only strictly-older-than-24h permits are swept; the cutoff itself, 1µs inside it and a future clock stay reserved (got %, %)',
      n, atk_probe.permits(abe);
  end if;
  n := api_private.sweep_stale_analysis_permits(1);
  if n <> 0 then
    raise exception 'A2: an empty bounded batch returns 0 (got %)', n;
  end if;
  n := api_private.sweep_stale_analysis_permits(null);
  if n <> 0 then
    raise exception 'A2: an empty unbounded batch returns 0 (got %)', n;
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- A3: corrupt/partial persisted state. Every settled shape is terminal to
-- the sweep however old; a stale reserved permit that is already recorded on
-- a shot (owner-written) is released like any other and its shot and receipt
-- are untouched.
-- ---------------------------------------------------------------------------
begin;
set local lock_timeout = '5s';
select api_private.sweep_stale_analysis_permits();
insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
select ('00000000-0000-4000-8000-00000000a8' || lpad((20 + o.n)::text, 2, '0'))::uuid,
       '00000000-0000-4000-8000-00000000a082', 'a3-' || o.n, now() - interval '30 days'
from generate_series(1, 10) as o(n);
update public.analysis_permits set status = 'finalized', outcome = 'scored' where idempotency_key = 'a3-1';
update public.analysis_permits set status = 'released', outcome = 'low_confidence' where idempotency_key = 'a3-2';
update public.analysis_permits set status = 'released', outcome = 'partial' where idempotency_key = 'a3-3';
update public.analysis_permits set status = 'released', outcome = 'cancelled' where idempotency_key = 'a3-4';
update public.analysis_permits set status = 'released', outcome = 'failed' where idempotency_key = 'a3-5';
update public.analysis_permits set status = 'released', outcome = 'unsupported' where idempotency_key = 'a3-6';
update public.analysis_permits set status = 'released', outcome = 'incorrect_recognition' where idempotency_key = 'a3-7';
update public.analysis_permits set status = 'released', outcome = 'free_limit_exceeded' where idempotency_key = 'a3-8';
update public.analysis_permits set status = 'released', outcome = 'expired' where idempotency_key = 'a3-9';
-- a3-10 stays reserved and is linked to an owner-written shot
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-00000000a8a0', '00000000-0000-4000-8000-00000000a082', now() - interval '30 days');
insert into public.shots (id, user_id, session_id, analysis_permit_id, result_kind, shot_type, camera_view,
  captured_at, start_ms, contact_ms, end_ms, overall_score, analysis_confidence,
  app_version, model_bundle_version, pose_model_version, paddle_model_version,
  stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
values ('00000000-0000-4000-8000-00000000a8a1', '00000000-0000-4000-8000-00000000a082', '00000000-0000-4000-8000-00000000a8a0',
  '00000000-0000-4000-8000-00000000a830', 'scored', 'drive', 'side', now() - interval '30 days', 0, 500, 1000, 7.1, 0.9,
  '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
do $$
declare n integer; abe uuid := '00000000-0000-4000-8000-00000000a082'; before_shape text; after_shape text; shot_before text; shot_after text;
begin
  before_shape := atk_probe.permits(abe);
  shot_before := (select s::text from public.shots s where s.id = '00000000-0000-4000-8000-00000000a8a1');
  n := api_private.sweep_stale_analysis_permits();
  after_shape := atk_probe.permits(abe);
  shot_after := (select s::text from public.shots s where s.id = '00000000-0000-4000-8000-00000000a8a1');
  if n <> 1 then
    raise exception 'A3: only the one stale reserved permit moves; every settled outcome is terminal (got %, before %, after %)', n, before_shape, after_shape;
  end if;
  if replace(before_shape, 'a830=reserved/-', 'a830=released/expired') <> after_shape then
    raise exception 'A3: settled permits are byte-identical after the sweep (before %, after %)', before_shape, after_shape;
  end if;
  if shot_before <> shot_after then
    raise exception 'A3: the recorded shot is untouched by the sweep';
  end if;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- A4: concurrency, reverse lock direction. Connection C runs the sweep and
-- holds its transaction open; connection B (the edge, as the client) syncs
-- the late rating against the permit C is releasing. B must WAIT (not fail)
-- and, once C commits, settle against the released/expired row: accepted,
-- finalized/scored, receipt written, counted exactly once. Then: LIMIT 1 must
-- refill past a row another transaction holds, and two overlapping sweeps
-- must partition the stale set with no double count.
-- ---------------------------------------------------------------------------
delete from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000a083';
select api_private.sweep_stale_analysis_permits();
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000a841', '00000000-0000-4000-8000-00000000a083', 'a4-race', now() - interval '2 days'),
  ('00000000-0000-4000-8000-00000000a842', '00000000-0000-4000-8000-00000000a083', 'a4-oldest', now() - interval '5 days'),
  ('00000000-0000-4000-8000-00000000a843', '00000000-0000-4000-8000-00000000a083', 'a4-second', now() - interval '4 days'),
  ('00000000-0000-4000-8000-00000000a844', '00000000-0000-4000-8000-00000000a083', 'a4-third', now() - interval '3 days');
do $$
declare
  al uuid := '00000000-0000-4000-8000-00000000a083';
  n integer; r text; waited integer := 0; blocked boolean := false; rec record; receipts integer;
  al_hash text := encode(pg_catalog.sha256(convert_to('google:google-sub-al', 'UTF8')), 'hex');
  ledger_before integer := coalesce((select l.scored_count from public.free_rating_ledger l where l.identity_hash = al_hash), 0);
begin
  perform atk_probe.dblink_connect('atk_c', atk_probe.conn() || ' application_name=atk_c');
  perform atk_probe.dblink_connect('atk_b', atk_probe.conn() || ' application_name=atk_b');
  perform atk_probe.dblink_exec('atk_c', 'set statement_timeout = ''20s''');
  perform atk_probe.dblink_exec('atk_b', 'set statement_timeout = ''20s''');

  -- 1. C sweeps Al's four stale permits (the race permit among them) and
  --    holds its transaction open, so their row locks are still held.
  perform atk_probe.dblink_exec('atk_c', 'begin');
  select t.n into n from atk_probe.dblink('atk_c', 'select api_private.sweep_stale_analysis_permits()') as t(n integer);
  if n <> 4 then
    raise exception 'A4 precondition: C releases the four stale permits under its open transaction (got %)', n;
  end if;
  -- 2. B: the late sync for the race permit arrives while C holds the lock.
  perform atk_probe.dblink_send_query('atk_b', format(
    'select atk_probe.late_sync(%L, %L, atk_probe.settle(%L, atk_probe.shot(%L, %L, %L), %L))',
    al, '00000000-0000-4000-8000-00000000a183', al,
    '00000000-0000-4000-8000-00000000a8b1', '00000000-0000-4000-8000-00000000a841', 'scored', 'a4-op-race'));
  while waited < 100 loop
    perform pg_sleep(0.05);
    waited := waited + 1;
    select a.wait_event_type = 'Lock' into blocked
    from pg_stat_activity a where a.application_name = 'atk_b' and a.state = 'active';
    exit when blocked;
  end loop;
  if not blocked then
    raise exception 'A4: the late sync must block on the sweep''s row lock (busy=%, activity=%)',
      atk_probe.dblink_is_busy('atk_b'),
      (select string_agg(a.state || ':' || coalesce(a.wait_event_type, '-') || ':' || coalesce(a.wait_event, '-'), ',')
       from pg_stat_activity a where a.application_name = 'atk_b');
  end if;
  -- 3. C commits; B's sync now sees released/expired and must still settle.
  perform atk_probe.dblink_exec('atk_c', 'commit');
  select t.r into r from atk_probe.dblink_get_result('atk_b') as t(r text);
  perform 1 from atk_probe.dblink_get_result('atk_b') as t(r text);
  select p.status, p.outcome into rec from public.analysis_permits p where p.id = '00000000-0000-4000-8000-00000000a841';
  select count(*) into receipts from public.settlement_receipts where user_id = al;
  if r <> 'accepted' or rec.status <> 'finalized' or rec.outcome <> 'scored' or receipts <> 1 then
    raise exception 'A4: a late sync that raced the sweep settles once the sweep commits (got %, %/%, receipts %)',
      r, rec.status, rec.outcome, receipts;
  end if;
  if (select count(*) from public.shots s where s.analysis_permit_id = '00000000-0000-4000-8000-00000000a841') <> 1
     or (select l.scored_count from public.free_rating_ledger l where l.identity_hash = al_hash) <> ledger_before + 1 then
    raise exception 'A4: the raced rating is recorded and counted exactly once (ledger % -> %)',
      ledger_before, (select l.scored_count from public.free_rating_ledger l where l.identity_hash = al_hash);
  end if;

  -- 4. LIMIT 1 refills past a locked row (fresh rows: a released permit
  --    cannot legally return to reserved).
  perform atk_probe.dblink_exec('atk_c', $sql$
    insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
      ('00000000-0000-4000-8000-00000000a845', '00000000-0000-4000-8000-00000000a083', 'a4-lock-oldest', now() - interval '9 days'),
      ('00000000-0000-4000-8000-00000000a846', '00000000-0000-4000-8000-00000000a083', 'a4-lock-second', now() - interval '8 days'),
      ('00000000-0000-4000-8000-00000000a847', '00000000-0000-4000-8000-00000000a083', 'a4-lock-third', now() - interval '7 days')
  $sql$);
  perform atk_probe.dblink_exec('atk_c', 'begin');
  perform 1 from atk_probe.dblink('atk_c',
    'select id from public.analysis_permits where id = ''00000000-0000-4000-8000-00000000a845'' for update') as t(id uuid);
  perform set_config('lock_timeout', '5s', true);
  n := api_private.sweep_stale_analysis_permits(1);
  if n <> 1 or (select p.status from public.analysis_permits p where p.id = '00000000-0000-4000-8000-00000000a846') <> 'released'
     or (select p.status from public.analysis_permits p where p.id = '00000000-0000-4000-8000-00000000a845') <> 'reserved' then
    raise exception 'A4: LIMIT 1 must skip the locked oldest row and take the next stale one (got %, %)', n, atk_probe.permits(al);
  end if;
  -- 5. two overlapping sweeps: C (still holding a845) now sweeps under its
  --    transaction; this connection sweeps concurrently.
  select t.n into n from atk_probe.dblink('atk_c', 'select api_private.sweep_stale_analysis_permits()') as t(n integer);
  if n <> 2 then
    raise exception 'A4: the second sweep takes the rows it can lock (got %)', n;
  end if;
  n := api_private.sweep_stale_analysis_permits();
  if n <> 0 then
    raise exception 'A4: an overlapping sweep never double-releases a row another sweep holds (got %)', n;
  end if;
  perform atk_probe.dblink_exec('atk_c', 'commit');
  n := api_private.sweep_stale_analysis_permits();
  if n <> 0 or atk_probe.permits(al) <> 'a845=released/expired,a846=released/expired,a847=released/expired,a842=released/expired,a843=released/expired,a844=released/expired,a841=finalized/scored' then
    raise exception 'A4: after both sweeps commit every stale permit is released exactly once (got %, %)', n, atk_probe.permits(al);
  end if;
  perform atk_probe.dblink_disconnect('atk_c');
  perform atk_probe.dblink_disconnect('atk_b');
end $$;

-- ---------------------------------------------------------------------------
-- A5: unauthorised roles. Each client role in the exact context the edge
-- gives it (API proof + JWT + active session) is refused; the definer is
-- owned by the user pg_cron runs the job as.
-- ---------------------------------------------------------------------------
begin;
do $$
declare r text;
begin
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'api_private.sweep_stale_analysis_permits(integer)', 'execute') then
      raise exception 'A5: % holds EXECUTE on the sweep', r;
    end if;
  end loop;
  if (select rolname from pg_roles where oid = (select proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'api_private' and p.proname = 'sweep_stale_analysis_permits')) <> 'postgres' then
    raise exception 'A5: the sweep definer must be owned by the cron user (postgres)';
  end if;
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a081';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000000a181"}';
do $$
declare bad integer;
begin
  if not api_private.is_api_request() or not api_private.is_active_session() then
    raise exception 'A5 precondition: the authenticated caller carries API proof and an active session';
  end if;
  foreach bad in array array[1, 10000] loop
    begin
      perform api_private.sweep_stale_analysis_permits(bad);
      raise exception 'A5: a signed-in API caller must not run a bounded sweep (%)', bad;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform api_private.sweep_stale_analysis_permits();
    raise exception 'A5: a signed-in API caller must not run the sweep';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
do $$
begin
  begin
    perform api_private.sweep_stale_analysis_permits();
    raise exception 'A5: anon must not run the sweep';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role service_role;
do $$
begin
  begin
    perform api_private.sweep_stale_analysis_permits();
    raise exception 'A5: service_role must not run the sweep';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;

-- ---------------------------------------------------------------------------
-- A6: conservation. Ada: two free tickets on a device, one consumed through
-- its receipt, one HELD; plus a stale online permit. The sweep releases the
-- online permit and every offline/receipt/ledger byte is unchanged; her
-- outstanding ticket is still hers and the free-rating count is unchanged.
-- ---------------------------------------------------------------------------
begin;
set local lock_timeout = '5s';
select api_private.sweep_stale_analysis_permits();
do $$
begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000a861', '00000000-0000-4000-8000-00000000a081', 'a6-stale', now() - interval '2 days');
create temporary table a6_state (key text primary key, id uuid, digest text);
grant select, insert on a6_state to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a081';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000000a181"}';
do $$
declare ada uuid := (select auth.uid()); r record; g record; v record;
begin
  select * into r from public.register_offline_device('ada-key-1', 'production', true);
  if r.result <> 'accepted' then
    raise exception 'A6 precondition: registration (got %)', r.result;
  end if;
  select * into g from public.issue_offline_grant('ada-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'A6 precondition: two free tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  insert into a6_state (key, id) values ('grant', g.grant_id), ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
  select * into v from atk_probe.settle_receipt(
    atk_probe.receipt('a6-rcpt-1', ada, 'ada-key-1', g.grant_id, g.ticket_ids[1], 'a6-op-1', '00000000-0000-4000-8000-00000000a871'),
    atk_probe.shot('00000000-0000-4000-8000-00000000a871', null, 'scored'), null);
  if v.result <> 'accepted' or v.delivery <> 'settled' or v.financial_disposition <> 'consumed' then
    raise exception 'A6 precondition: first ticket consumed through its receipt (got %, %, %)', v.result, v.delivery, v.financial_disposition;
  end if;
  select * into v from atk_probe.settle_receipt(
    atk_probe.receipt('a6-rcpt-2', ada, 'ada-key-1', g.grant_id, g.ticket_ids[2], 'a6-op-2', '00000000-0000-4000-8000-00000000a872'),
    atk_probe.shot('00000000-0000-4000-8000-00000000a872', null, 'scored'), 'evidence_ambiguous');
  if v.result <> 'accepted' or v.delivery <> 'held' or v.financial_disposition <> 'reserved' then
    raise exception 'A6 precondition: second receipt held (got %, %, %)', v.result, v.delivery, v.financial_disposition;
  end if;
  if public.offline_hold_count() <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'A6 precondition: one hold, one scored (got %, %)', public.offline_hold_count(), public.lifetime_scored_count();
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
insert into a6_state (key, digest) values ('offline', atk_probe.offline_digest());
do $$
declare n integer;
begin
  n := api_private.sweep_stale_analysis_permits();
  if n <> 1 or atk_probe.permits('00000000-0000-4000-8000-00000000a081') <> 'a861=released/expired' then
    raise exception 'A6: the stale online permit is released (got %, %)', n, atk_probe.permits('00000000-0000-4000-8000-00000000a081');
  end if;
  if atk_probe.offline_digest() <> (select digest from a6_state where key = 'offline') then
    raise exception 'A6: the sweep must not change a byte of offline_devices, offline_grants, offline_allocation_ledger, settlement_receipts, offline_receipt_settlements or free_rating_ledger';
  end if;
  if (select count(*) from public.offline_receipt_settlements where user_id = '00000000-0000-4000-8000-00000000a081'
        and status = 'reconciliation_required' and financial_disposition = 'reserved'
        and ticket_id = (select id from a6_state where key = 't2')) <> 1
     or (select count(*) from public.offline_receipt_settlements where user_id = '00000000-0000-4000-8000-00000000a081'
        and status = 'result_recorded' and financial_disposition = 'consumed'
        and ticket_id = (select id from a6_state where key = 't1')) <> 1 then
    raise exception 'A6: the held receipt keeps its ticket reserved and the settled receipt keeps its consumption through the sweep';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a081';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000000a181"}';
do $$
declare g record; rec record;
begin
  if public.offline_hold_count() <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'A6: hold and scored counts survive the sweep (got %, %)', public.offline_hold_count(), public.lifetime_scored_count();
  end if;
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 1 or rec.reserved_count <> 1 then
    raise exception 'A6: access_state keeps counting the outstanding hold (got %, %, %)', rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  select * into g from public.issue_offline_grant('ada-key-1', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[(select id from a6_state where key = 't2')] then
    raise exception 'A6: the device re-obtains exactly its outstanding ticket (got %, %)', g.result, g.ticket_ids;
  end if;
end $$;
reset role;
rollback;

-- ---------------------------------------------------------------------------
-- A8: plan regression. The __wf__ static pin only EXPLAINs the superseded
-- anonymous UPDATE from 20260831000000; the shipping sweep is now the
-- function's IN (subselect … FOR UPDATE SKIP LOCKED) shape. With a populated
-- table it must still be served by analysis_permits_reserved_created_idx and
-- never seq-scan every permit ever issued, bounded and unbounded alike.
-- ---------------------------------------------------------------------------
begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
select ('00000000-0000-4000-9000-' || lpad(to_hex(g), 12, '0'))::uuid, 'a8-' || g || '@example.com', '{}'::jsonb, '{"provider":"google"}'::jsonb
from generate_series(1, 1500) g;
insert into public.analysis_permits (user_id, idempotency_key, status, outcome, created_at)
select p.id, 'a8-' || g, case when g % 50 = 0 then 'reserved' else 'finalized' end, 'scored', now() - (g || ' days')::interval
from public.profiles p cross join generate_series(1, 15) g;
analyze public.analysis_permits;
do $$
declare
  body text := (select pg_get_functiondef('api_private.sweep_stale_analysis_permits(integer)'::regprocedure));
  stmt text; plan text; line text; lim text;
begin
  -- the exact UPDATE the function runs, lifted from its own definition
  stmt := substring(body from '(?i)(update public\.analysis_permits.*?for update skip locked\s*\))');
  if stmt is null then
    raise exception 'A8 precondition: could not lift the sweep UPDATE from the function body: %', body;
  end if;
  foreach lim in array array['null', '1', '10000'] loop
    plan := '';
    for line in execute 'explain (costs off) ' || replace(stmt, 'p_limit', lim) loop
      plan := plan || line || E'\n';
    end loop;
    if plan like '%Seq Scan on analysis_permits%' or plan not like '%analysis_permits_reserved_created_idx%' then
      raise exception 'A8: sweep with limit % must be index-backed by analysis_permits_reserved_created_idx and never seq-scan permits; plan: %', lim, plan;
    end if;
  end loop;
end $$;
rollback;

-- ---------------------------------------------------------------------------
-- cleanup of the committed fixtures
-- ---------------------------------------------------------------------------
drop schema atk_probe cascade;
delete from public.free_rating_ledger where identity_hash in (
  encode(sha256(convert_to('google:google-sub-ada', 'UTF8')), 'hex'),
  encode(sha256(convert_to('apple:apple-sub-abe', 'UTF8')), 'hex'),
  encode(sha256(convert_to('google:google-sub-al', 'UTF8')), 'hex'));
delete from auth.users where id in (
  '00000000-0000-4000-8000-00000000a081',
  '00000000-0000-4000-8000-00000000a082',
  '00000000-0000-4000-8000-00000000a083');
do $$
begin
  if exists (select 1 from public.analysis_permits where user_id in (
      '00000000-0000-4000-8000-00000000a081', '00000000-0000-4000-8000-00000000a082', '00000000-0000-4000-8000-00000000a083')) then
    raise exception 'cleanup: fixture permits must cascade away with their users';
  end if;
end $$;
\echo W11-03 ATTACK MATRIX: NO BREAK REPRODUCED
