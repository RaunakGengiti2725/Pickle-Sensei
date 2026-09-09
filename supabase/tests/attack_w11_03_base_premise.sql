-- W11-03 AC2 premise probe. Run against a database at BASE_SHA 2e09b154
-- (shim_auth.sql + every base migration, no candidate migration):
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/attack_w11_03_base_premise.sql
--
-- AC2 says the regression must FAIL on base because "sweep reclaims offline
-- allocation on base". This file replays the base cron sweep — the anonymous
-- UPDATE that 20260831000000_scale_and_security.sql hands to pg_cron,
-- byte-for-byte — over the same offline fixture the candidate matrix uses
-- (a device with one consumed and one HELD ticket plus a stale online
-- permit) and records what the base sweep actually does:
--
--   B1  the candidate function is absent on base (the structural reason the
--       candidate's section V fails at V1);
--   B2  the base anonymous UPDATE releases the stale online permit and does
--       NOT change a byte of offline_devices / offline_grants /
--       offline_allocation_ledger / settlement_receipts /
--       offline_receipt_settlements / free_rating_ledger — i.e. base never
--       reclaimed offline allocations either; the AC2 premise does not
--       reproduce;
--   B3  the behavioural difference the candidate does introduce: the base
--       UPDATE takes plain row locks and blocks behind an in-flight
--       apply_synced_shot() FOR UPDATE (lock_timeout fires), where the
--       candidate's FOR UPDATE SKIP LOCKED sweep returns immediately.
--
-- Exit 0 here means B1–B3 all hold on base. It is a finding about the
-- acceptance criterion, not a candidate defect.

\set ON_ERROR_STOP on

do $$
begin
  if to_regprocedure('api_private.sweep_stale_analysis_permits(integer)') is not null then
    raise exception 'B1: this database already carries the candidate function; run this file against BASE_SHA';
  end if;
end $$;

delete from public.free_rating_ledger where identity_hash =
  encode(sha256(convert_to('google:google-sub-bea', 'UTF8')), 'hex');
delete from auth.users where id = '00000000-0000-4000-8000-00000000b081';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000b081', 'bea@example.com', '{"full_name":"Bea"}', '{"provider":"google"}');
insert into auth.identities (id, user_id, provider, provider_id, identity_data)
values ('00000000-0000-4000-8000-00000000b181', '00000000-0000-4000-8000-00000000b081', 'google', 'google-sub-bea',
        '{"sub":"google-sub-bea","email":"bea@example.com"}');
insert into auth.sessions (id, user_id)
values ('00000000-0000-4000-8000-00000000b281', '00000000-0000-4000-8000-00000000b081');

drop schema if exists atk_base cascade;
create schema atk_base;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'dblink') then
    execute 'alter extension dblink set schema atk_base';
  else
    execute 'create extension dblink with schema atk_base';
  end if;
end $$;
create function atk_base.shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-09-10T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
create function atk_base.receipt(
  p_receipt_id text, p_owner uuid, p_key text, p_grant uuid, p_ticket uuid, p_operation text, p_result uuid
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', 'offline-result-receipt-v1', 'receiptId', p_receipt_id, 'ownerId', p_owner,
    'installationKeyId', p_key, 'grantId', p_grant, 'grantJwsSha256', repeat('a', 64), 'lifecycleSequence', 1,
    'nativeTime', jsonb_build_object('monotonicMs', 1000, 'wallClockIso', '2026-09-10T10:00:00Z'),
    'ticket', jsonb_build_object('allocationId', p_grant, 'generation', 1, 'ticketId', p_ticket),
    'operationId', p_operation, 'resultId', p_result, 'fullOutputSha256', repeat('c', 64),
    'billingDisposition', 'joint_verification_required')
$$;
create function atk_base.settle_receipt(p_receipt jsonb, p_output jsonb, p_hold text)
returns table (result text, delivery text, status text, reason_code text, financial_disposition text, result_id text)
language sql set search_path = '' as $$
  select * from public.settle_offline_receipt(
    p_receipt, encode(pg_catalog.sha256(convert_to(p_receipt::text, 'UTF8')), 'hex'), p_output, p_hold)
$$;
create function atk_base.permits(p_uid uuid) returns text
language sql security definer set search_path = '' as $$
  select coalesce(string_agg(right(p.id::text, 4) || '=' || p.status || '/' || coalesce(p.outcome, '-'), ',' order by p.created_at, p.id), '')
  from public.analysis_permits p where p.user_id = p_uid;
$$;
create function atk_base.digest(p_table text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  execute format('select coalesce(md5(string_agg(t::text, %L order by t::text)), %L) from %s t', '|', 'empty', p_table) into v;
  return v;
end $$;
create function atk_base.offline_digest() returns text
language sql security definer set search_path = '' as $$
  select atk_base.digest('public.offline_devices') || '/' || atk_base.digest('public.offline_grants') || '/'
      || atk_base.digest('public.offline_allocation_ledger') || '/' || atk_base.digest('public.settlement_receipts') || '/'
      || atk_base.digest('public.offline_receipt_settlements') || '/' || atk_base.digest('public.free_rating_ledger')
$$;
-- the base cron command, byte-for-byte from 20260831000000_scale_and_security.sql
create function atk_base.base_sweep() returns integer
language plpgsql set search_path = '' as $$
declare n integer;
begin
  update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';
  get diagnostics n = row_count;
  return n;
end $$;
create function atk_base.conn() returns text
language sql stable set search_path = '' as $$
  select format('host=%s port=%s dbname=%s user=postgres',
    split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database())
$$;
grant usage on schema atk_base to authenticated;
grant execute on all functions in schema atk_base to authenticated;

-- B2: base sweep over the offline fixture --------------------------------------
begin;
set local lock_timeout = '5s';
select atk_base.base_sweep();
do $$
begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
end $$;
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000b861', '00000000-0000-4000-8000-00000000b081', 'b2-stale', now() - interval '2 days');
create temporary table b2_state (key text primary key, id uuid, digest text);
grant select, insert on b2_state to authenticated;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000b081';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000000b281"}';
do $$
declare bea uuid := (select auth.uid()); r record; g record; v record;
begin
  select * into r from public.register_offline_device('bea-key-1', 'production', true);
  if r.result <> 'accepted' then
    raise exception 'B2 precondition: registration (got %)', r.result;
  end if;
  select * into g from public.issue_offline_grant('bea-key-1', 2);
  if g.result <> 'accepted' or coalesce(array_length(g.ticket_ids, 1), 0) <> 2 then
    raise exception 'B2 precondition: two free tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  insert into b2_state (key, id) values ('grant', g.grant_id), ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
  select * into v from atk_base.settle_receipt(
    atk_base.receipt('b2-rcpt-1', bea, 'bea-key-1', g.grant_id, g.ticket_ids[1], 'b2-op-1', '00000000-0000-4000-8000-00000000b871'),
    atk_base.shot('00000000-0000-4000-8000-00000000b871', null, 'scored'), null);
  if v.result <> 'accepted' or v.delivery <> 'settled' or v.financial_disposition <> 'consumed' then
    raise exception 'B2 precondition: first ticket consumed (got %, %, %)', v.result, v.delivery, v.financial_disposition;
  end if;
  select * into v from atk_base.settle_receipt(
    atk_base.receipt('b2-rcpt-2', bea, 'bea-key-1', g.grant_id, g.ticket_ids[2], 'b2-op-2', '00000000-0000-4000-8000-00000000b872'),
    atk_base.shot('00000000-0000-4000-8000-00000000b872', null, 'scored'), 'evidence_ambiguous');
  if v.result <> 'accepted' or v.delivery <> 'held' or v.financial_disposition <> 'reserved' then
    raise exception 'B2 precondition: second receipt held (got %, %, %)', v.result, v.delivery, v.financial_disposition;
  end if;
  if public.offline_hold_count() <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'B2 precondition: one hold, one scored (got %, %)', public.offline_hold_count(), public.lifetime_scored_count();
  end if;
end $$;
reset role;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '';
insert into b2_state (key, digest) values ('offline', atk_base.offline_digest());
do $$
declare n integer;
begin
  n := atk_base.base_sweep();
  if n <> 1 or atk_base.permits('00000000-0000-4000-8000-00000000b081') <> 'b861=released/expired' then
    raise exception 'B2: the base sweep releases the stale online permit (got %, %)', n, atk_base.permits('00000000-0000-4000-8000-00000000b081');
  end if;
  if atk_base.offline_digest() <> (select digest from b2_state where key = 'offline') then
    raise exception 'B2: the base sweep changed offline/receipt/ledger state — the AC2 premise reproduces on base';
  end if;
  if (select count(*) from public.offline_receipt_settlements where user_id = '00000000-0000-4000-8000-00000000b081'
        and status = 'reconciliation_required' and financial_disposition = 'reserved'
        and ticket_id = (select id from b2_state where key = 't2')) <> 1
     or (select count(*) from public.offline_receipt_settlements where user_id = '00000000-0000-4000-8000-00000000b081'
        and status = 'result_recorded' and financial_disposition = 'consumed'
        and ticket_id = (select id from b2_state where key = 't1')) <> 1 then
    raise exception 'B2: the base sweep touched the held or settled receipt — the AC2 premise reproduces on base';
  end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000b081';
set local request.jwt.claims = '{"session_id":"00000000-0000-4000-8000-00000000b281"}';
do $$
declare g record;
begin
  if public.offline_hold_count() <> 1 or public.lifetime_scored_count() <> 1 then
    raise exception 'B2: base sweep changed hold/scored counts (got %, %)', public.offline_hold_count(), public.lifetime_scored_count();
  end if;
  select * into g from public.issue_offline_grant('bea-key-1', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[(select id from b2_state where key = 't2')] then
    raise exception 'B2: base sweep changed the outstanding ticket (got %, %)', g.result, g.ticket_ids;
  end if;
end $$;
reset role;
rollback;

-- B3: the base sweep blocks behind a late sync's FOR UPDATE -------------------
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000b841', '00000000-0000-4000-8000-00000000b081', 'b3-stale', now() - interval '2 days');
do $$
declare v text := null; blocked boolean := false;
begin
  perform atk_base.dblink_connect('atk_b', atk_base.conn());
  perform atk_base.dblink_exec('atk_b', 'begin');
  perform * from atk_base.dblink('atk_b',
    'select id from public.analysis_permits where id = ''00000000-0000-4000-8000-00000000b841'' for update') as t(id uuid);
  perform atk_base.dblink_connect('atk_c', atk_base.conn());
  perform atk_base.dblink_exec('atk_c', 'set lock_timeout = ''2s''');
  begin
    perform * from atk_base.dblink('atk_c', 'select atk_base.base_sweep()') as t(n integer);
  exception when others then
    v := sqlerrm;
    blocked := v like '%lock timeout%';
  end;
  perform atk_base.dblink_exec('atk_b', 'rollback');
  perform atk_base.dblink_disconnect('atk_b');
  perform atk_base.dblink_disconnect('atk_c');
  if v is null then
    raise exception 'B3: the base sweep did NOT block behind the row lock (unexpected on base)';
  end if;
  if not blocked then
    raise exception 'B3: unexpected failure while the row was locked: %', v;
  end if;
end $$;

drop schema atk_base cascade;
delete from public.free_rating_ledger where identity_hash =
  encode(sha256(convert_to('google:google-sub-bea', 'UTF8')), 'hex');
delete from auth.users where id = '00000000-0000-4000-8000-00000000b081';
\echo W11-03 BASE PREMISE: B1 function absent, B2 base sweep preserves offline state, B3 base sweep blocks behind FOR UPDATE
