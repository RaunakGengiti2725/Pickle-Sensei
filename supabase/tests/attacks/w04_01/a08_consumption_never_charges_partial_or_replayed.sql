-- A08 — what a ticket may be settled with.
--
-- Attack: try to close a hold with a shot that is low-confidence, partial, backed by an online permit (already paid for), created before
-- the allocation, owned by another account, non-existent, or already bound
-- to another ticket; replay the successful consume with the same and with a
-- different shot; try to bind a second ticket to the same shot through the
-- table; delete the settled shot; and confirm the crash window between
-- storing a scored offline shot and calling consume never turns into credit.
-- Expected: only a fresh, scored, permit-free, caller-owned shot settles a
-- ticket, exactly once; every other attempt is a verdict with no ledger row;
-- deleting the shot leaves the settlement and the lifetime count; a stored
-- but unbound offline shot over-counts (paywall), never under-counts.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(13, 'apple', 'apple-sub-a08');
select pg_temp.atk_user(14, 'google', 'google-sub-a08-other');
create temp table a08 (k text primary key, v uuid);
grant all on a08 to authenticated;

-- a pre-allocation scored shot, online-permitted and synced the normal way
select pg_temp.atk_become(13);
do $$
declare p record; v text;
begin
  select * into p from public.reserve_analysis_permit('a08-online-1');
  if p.result <> 'accepted' then raise exception 'A08 precondition: reserve (%)', p.result; end if;
  v := public.apply_synced_shot(pg_temp.atk_shot('00000000-0000-4000-8000-0000000a0801', p.permit_id));
  if v <> 'accepted' then raise exception 'A08 precondition: sync (%)', v; end if;
  insert into a08 values ('permit1', p.permit_id);
end $$;
select pg_temp.atk_reset();
-- a pre-allocation permit-free scored shot (server-owned write, before the ticket exists)
do $$
declare st text;
begin
  -- dated a minute before this transaction's clock: the allocation row below is stamped now()
  st := pg_temp.atk_try(format($q$insert into public.shots (id, user_id, shot_type, captured_at, created_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values (%L, %L, 'drive', now(), now() - interval '1 minute', 0, 1000, 8.0, 0.9, 'scored', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')$q$,
    '00000000-0000-4000-8000-0000000a0802', pg_temp.atk_uid(13)));
  if st is not null then raise exception 'A08 precondition: pre-allocation shot (%)', st; end if;
end $$;
select pg_sleep(0.01);

-- scored 2 already (one online, one offline-shaped) → the free budget is spent: no ticket
select pg_temp.atk_become(13);
do $$
declare g record;
begin
  select * into g from public.register_offline_device('a08-key', 'production', true);
  if g.result <> 'accepted' then raise exception 'A08: registration (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a08-key', 1);
  if g.result <> 'access.paywall_required' then raise exception 'A08 BREAK: allotted beside two scored shots (%, %)', g.result, g.ticket_ids; end if;
end $$;
select pg_temp.atk_reset();
-- remove the online shot so exactly one lifetime rating is used, then allocate one ticket
delete from public.shots where id = '00000000-0000-4000-8000-0000000a0801';
delete from public.free_rating_ledger;
delete from public.analysis_permits where id = (select x.v from a08 x where x.k = 'permit1');
insert into public.free_rating_ledger (identity_hash, scored_count)
select public.free_rating_identity_hash(i.provider, i.provider_id), 1 from auth.identities i where i.user_id = pg_temp.atk_uid(13);
select pg_temp.atk_become(13);
do $$
declare g record;
begin
  if public.lifetime_scored_count() <> 1 then raise exception 'A08 precondition: lifetime %', public.lifetime_scored_count(); end if;
  select * into g from public.issue_offline_grant('a08-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then raise exception 'A08 precondition: one ticket (%, %)', g.result, g.ticket_ids; end if;
  insert into a08 values ('t1', g.ticket_ids[1]);
end $$;
select pg_temp.atk_reset();
select pg_sleep(0.01);

-- post-allocation shots of every disallowed shape
do $$
declare st text; p uuid;
begin
  -- unscored / low-confidence / abstained
  st := pg_temp.atk_try(format($q$insert into public.shots (id, user_id, shot_type, captured_at, created_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values (%L, %L, 'drive', now(), clock_timestamp(), 0, 1000, null, 0.2, 'low_confidence', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')$q$,
    '00000000-0000-4000-8000-0000000a0803', pg_temp.atk_uid(13)));
  if st is not null then raise exception 'A08 precondition: low-confidence shot (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.shots (id, user_id, shot_type, captured_at, created_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values (%L, %L, 'drive', now(), clock_timestamp(), 0, 1000, null, 0.9, 'partial', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')$q$,
    '00000000-0000-4000-8000-0000000a0807', pg_temp.atk_uid(13)));
  if st is not null then raise exception 'A08 precondition: partial shot (%)', st; end if;
  -- a fresh online-permitted scored shot (paid for by the permit)
  insert into public.analysis_permits (id, user_id, idempotency_key) values ('00000000-0000-4000-8000-0000000a0810', pg_temp.atk_uid(13), 'a08-online-2');
  st := pg_temp.atk_try(format($q$insert into public.shots (id, user_id, analysis_permit_id, shot_type, captured_at, created_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
      app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
    values (%L, %L, %L, 'drive', now(), clock_timestamp(), 0, 1000, 8.0, 0.9, 'scored', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')$q$,
    '00000000-0000-4000-8000-0000000a0804', pg_temp.atk_uid(13), '00000000-0000-4000-8000-0000000a0810'));
  if st is not null then raise exception 'A08 precondition: permitted shot (%)', st; end if;
  -- another account's fresh permit-free scored shot
  st := pg_temp.atk_direct_shot('00000000-0000-4000-8000-0000000a0805', pg_temp.atk_uid(14));
  if st is not null then raise exception 'A08 precondition: foreign shot (%)', st; end if;
  -- the caller's own fresh permit-free scored shot — the ONE chargeable shape
  st := pg_temp.atk_direct_shot('00000000-0000-4000-8000-0000000a0806', pg_temp.atk_uid(13));
  if st is not null then raise exception 'A08 precondition: chargeable shot (%)', st; end if;
end $$;

select pg_temp.atk_become(13);
do $$
declare t1 uuid := (select x.v from a08 x where x.k = 't1'); v text; st text; g record;
  chargeable uuid := '00000000-0000-4000-8000-0000000a0806';
begin
  -- crash window: the offline shot is stored, consume has not run → over-count, never credit
  if public.offline_hold_count() <> 1 then raise exception 'A08 BREAK: hold % before consume', public.offline_hold_count(); end if;
  select r.result into v from public.reserve_analysis_permit('a08-online-3') r;
  if v <> 'access.paywall_required' then raise exception 'A08 BREAK: online reservation in the crash window (%)', v; end if;
  select * into g from public.issue_offline_grant('a08-key', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[t1] then raise exception 'A08 BREAK: crash window allotted (%, %)', g.result, g.ticket_ids; end if;

  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0802');
  if v <> 'offline.shot_not_chargeable' then raise exception 'A08 BREAK: pre-allocation shot settled the ticket (%)', v; end if;
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0803');
  if v <> 'offline.shot_not_chargeable' then raise exception 'A08 BREAK: low-confidence shot settled the ticket (%)', v; end if;
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0807');
  if v <> 'offline.shot_not_chargeable' then raise exception 'A08 BREAK: partial shot settled the ticket (%)', v; end if;
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0804');
  if v <> 'offline.shot_not_chargeable' then raise exception 'A08 BREAK: permit-backed shot settled the ticket (%)', v; end if;
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0805');
  if v <> 'offline.shot_not_chargeable' then raise exception 'A08 BREAK: another account''s shot settled the ticket (%)', v; end if;
  v := public.consume_offline_ticket(t1, gen_random_uuid());
  if v <> 'offline.shot_not_chargeable' then raise exception 'A08 BREAK: a missing shot settled the ticket (%)', v; end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:1' then raise exception 'A08 BREAK: refused consumes wrote rows (%)', pg_temp.atk_events((select auth.uid())); end if;

  -- the one chargeable shape, then replays
  v := public.consume_offline_ticket(t1, chargeable);
  if v <> 'accepted' then raise exception 'A08 BREAK: chargeable shot refused (%)', v; end if;
  v := public.consume_offline_ticket(t1, chargeable);
  if v <> 'accepted' then raise exception 'A08 BREAK: idempotent replay (%)', v; end if;
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0804');
  if v <> 'offline.ticket_consumed' then raise exception 'A08 BREAK: replay with another shot (%)', v; end if;
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'offline.ticket_consumed' then raise exception 'A08 BREAK: release after consume (%)', v; end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:1,consumed:1' then raise exception 'A08 BREAK: ledger after replays (%)', pg_temp.atk_events((select auth.uid())); end if;
  if public.offline_hold_count() <> 0 then raise exception 'A08 BREAK: hold after consume %', public.offline_hold_count(); end if;
  if public.lifetime_scored_count() <> 3 then raise exception 'A08 BREAK: lifetime after consume %', public.lifetime_scored_count(); end if;
  select r.result into v from public.reserve_analysis_permit('a08-online-4') r;
  if v <> 'access.paywall_required' then raise exception 'A08 BREAK: online reservation after settlement (%)', v; end if;
end $$;
select pg_temp.atk_reset();

-- table-level: a second ticket cannot be bound to the settled shot, nor to a permit-backed shot
do $$
declare st text; dev uuid := (select id from public.offline_devices where installation_key_id = 'a08-key');
  gid uuid := (select id from public.offline_grants where device_id = (select id from public.offline_devices where installation_key_id = 'a08-key') order by generation limit 1);
  t9 uuid := gen_random_uuid();
begin
  insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, installation_key_id)
  values (pg_temp.atk_uid(13), dev, gid, 1, t9, 'allocated', 'a08-key');
  st := pg_temp.atk_try(format($q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, installation_key_id)
    values (%L, %L, %L, 1, %L, 'consumed', %L, 'a08-key')$q$, pg_temp.atk_uid(13), dev, gid, t9, '00000000-0000-4000-8000-0000000a0806'));
  if st is null then raise exception 'A08 BREAK: one shot settled two tickets through the table'; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, installation_key_id)
    values (%L, %L, %L, 1, %L, 'consumed', %L, 'a08-key')$q$, pg_temp.atk_uid(13), dev, gid, t9, '00000000-0000-4000-8000-0000000a0804'));
  if st is distinct from '23514' then raise exception 'A08 BREAK: permit-backed shot settled a ticket through the table (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, installation_key_id)
    values (%L, %L, %L, 1, %L, 'consumed', %L, 'a08-key')$q$, pg_temp.atk_uid(13), dev, gid, t9, '00000000-0000-4000-8000-0000000a0802'));
  if st is distinct from '23514' then raise exception 'A08 BREAK: pre-allocation shot settled a ticket through the table (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, installation_key_id)
    values (%L, %L, %L, 1, %L, 'consumed', %L, 'a08-key')$q$, pg_temp.atk_uid(14), dev, gid, t9, '00000000-0000-4000-8000-0000000a0805'));
  if st is distinct from '23514' then raise exception 'A08 BREAK: another account settled the ticket with their shot (%)', st; end if;
  delete from public.offline_allocation_ledger where ticket_id = t9;
  raise exception 'A08 BREAK: ledger row deleted by the owner without the append-only guard';
exception when check_violation then
  if sqlerrm not like '%append-only%' and sqlerrm not like '%immutable%' and sqlerrm not like '%never%' then
    raise exception 'A08 BREAK: unexpected guard message on delete: %', sqlerrm;
  end if;
end $$;

-- the settled shot disappears (session deletion etc.): settlement and lifetime count stay
delete from public.shots where id = '00000000-0000-4000-8000-0000000a0806';
select pg_temp.atk_become(13);
do $$
declare v text;
begin
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:1,consumed:1' then raise exception 'A08 BREAK: settlement followed the shot (%)', pg_temp.atk_events((select auth.uid())); end if;
  if public.offline_hold_count() <> 0 then raise exception 'A08 BREAK: hold after shot deletion %', public.offline_hold_count(); end if;
  if public.lifetime_scored_count() <> 3 then raise exception 'A08 BREAK: lifetime after shot deletion %', public.lifetime_scored_count(); end if;
  select r.result into v from public.reserve_analysis_permit('a08-online-5') r;
  if v <> 'access.paywall_required' then raise exception 'A08 BREAK: shot deletion re-credited the online path (%)', v; end if;
end $$;
rollback;
\echo A08 PASS: only a fresh, scored, permit-free, own shot settles a ticket, once
