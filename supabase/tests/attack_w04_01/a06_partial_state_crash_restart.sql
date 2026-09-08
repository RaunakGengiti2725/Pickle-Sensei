-- ATTACK A06 — crash between steps, process restart and corrupt/partial
-- persisted state: the edge function dies after the grant COMMITs and before
-- the device hears about it (client retries); support deletes the grant row;
-- the device row is downgraded to unattested / deleted / re-registered
-- unattested / re-attested; a consumed ticket is replayed with a different
-- shot after restart; a released ticket is replayed as consume. In every
-- case: no ticket is reclaimed, none duplicated, the hold never changes by
-- itself, and every generation number stays unique per device.
begin;
\ir _setup.sql

create temporary table a6 (k text primary key, val uuid);
grant select, insert on a6 to authenticated;

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare r record; g record; g2 record;
begin
  select * into r from public.register_offline_device('e1-key', 'production', true);
  insert into a6 values ('device', r.device_id);
  select * into g from public.issue_offline_grant('e1-key', 2);
  -- crash after COMMIT, before the response reached the device: the retry
  select * into g2 from public.issue_offline_grant('e1-key', 2);
  if g2.generation <> 2 or g2.ticket_ids <> g.ticket_ids or pg_temp.tickets_ever('e1-key') <> 2 then
    raise exception 'A06 BREAK: the retry after a crash must re-issue the same two tickets and allocate none (got gen %, % vs %, ever %)',
      g2.generation, g2.ticket_ids, g.ticket_ids, pg_temp.tickets_ever('e1-key');
  end if;
  insert into a6 values ('t1', g.ticket_ids[1]), ('t2', g.ticket_ids[2]);
end $$;

-- the two offline ratings are durably written by the server (reconcile)
select pg_temp.as_owner();
select pg_temp.owner_scored_shot('00000000-0000-4000-8000-00000000a601', '00000000-0000-4000-8000-0000000000e1', now());
select pg_temp.owner_scored_shot('00000000-0000-4000-8000-00000000a602', '00000000-0000-4000-8000-0000000000e1', now());
-- support deletes every grant row of the device (owner role); the ledger has no FK
delete from public.offline_grants where device_id = (select val from a6 where k = 'device');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare g record;
begin
  if public.offline_hold_count() <> 2 then
    raise exception 'A06 BREAK: deleting the grant rows reclaimed the allocation (hold %)', public.offline_hold_count();
  end if;
  select * into g from public.issue_offline_grant('e1-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 or pg_temp.tickets_ever('e1-key') <> 2 then
    raise exception 'A06 BREAK: after grant deletion the same tickets are re-issued, none new (got %, %, ever %)', g.result, g.ticket_ids, pg_temp.tickets_ever('e1-key');
  end if;
end $$;

-- the device row is downgraded to unattested (corrupt state written by the owner)
select pg_temp.as_owner();
update public.offline_devices set attestation_state = 'unattested', attested_at = null where id = (select val from a6 where k = 'device');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare g record; v text;
begin
  select * into g from public.issue_offline_grant('e1-key', 2);
  if g.result <> 'offline.device_not_attested' then
    raise exception 'A06: an unattested device gets no new grant (got %)', g.result;
  end if;
  if public.offline_hold_count() <> 2 then
    raise exception 'A06 BREAK: attestation loss reclaimed the allocation (hold %)', public.offline_hold_count();
  end if;
  -- the delivered rating still settles against its ticket
  v := public.consume_offline_ticket((select val from a6 where k = 't1'), '00000000-0000-4000-8000-00000000a601');
  if v <> 'accepted' then raise exception 'A06: consumption does not depend on the device row (got %)', v; end if;
end $$;

-- device deleted (reinstall) and re-registered UNattested, then attested
select pg_temp.as_owner();
delete from public.offline_devices where id = (select val from a6 where k = 'device');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare r record; g record; v text;
begin
  if public.offline_hold_count() <> 1 then
    raise exception 'A06 BREAK: device deletion changed the hold (hold %)', public.offline_hold_count();
  end if;
  select * into r from public.register_offline_device('e1-key', 'production', false);
  if r.result <> 'accepted' or r.attestation_state <> 'unattested' then raise exception 'A06: re-registration (got %, %)', r.result, r.attestation_state; end if;
  select * into g from public.issue_offline_grant('e1-key', 2);
  if g.result <> 'offline.device_not_attested' then raise exception 'A06: unattested after reinstall (got %)', g.result; end if;
  select * into r from public.register_offline_device('e1-key', 'production', true);
  if r.attestation_state <> 'attested' then raise exception 'A06: re-attestation (got %)', r.attestation_state; end if;
  select * into g from public.issue_offline_grant('e1-key', 2);
  -- generation restarts for the new device row; the outstanding ticket comes back, none new
  if g.result <> 'accepted' or g.generation <> 1 or g.ticket_ids <> array[(select val from a6 where k = 't2')] or pg_temp.tickets_ever('e1-key') <> 2 then
    raise exception 'A06 BREAK: after reinstall the one outstanding ticket is re-issued, none new (got %, gen %, %, ever %)',
      g.result, g.generation, g.ticket_ids, pg_temp.tickets_ever('e1-key');
  end if;
  -- restart replays: consumed ticket with a different shot, released ticket as consume
  v := public.consume_offline_ticket((select val from a6 where k = 't1'), '00000000-0000-4000-8000-00000000a602');
  if v <> 'offline.ticket_consumed' then raise exception 'A06 BREAK: a consumed ticket accepted a second shot (%)', v; end if;
  v := public.release_offline_ticket((select val from a6 where k = 't2'), 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A06: release (got %)', v; end if;
  v := public.consume_offline_ticket((select val from a6 where k = 't2'), '00000000-0000-4000-8000-00000000a602');
  if v <> 'offline.ticket_released' then raise exception 'A06 BREAK: a released ticket was consumed after restart (%)', v; end if;
  v := public.release_offline_ticket((select val from a6 where k = 't2'), 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A06: release replay is idempotent (got %)', v; end if;
  if pg_temp.events((select auth.uid())) <> 'allocated:2,consumed:1,released:1' then
    raise exception 'A06 BREAK: ledger drifted (%)', pg_temp.events((select auth.uid()));
  end if;
  if public.offline_hold_count() <> 1 then
    raise exception 'A06 BREAK: a released ticket must still count as a hold, never a re-credit (hold %)', public.offline_hold_count();
  end if;
  -- the released ticket is not re-issued, and nothing new is allocated: 2 lifetime (1 consumed + a602 counted) → budget spent
  select * into g from public.issue_offline_grant('e1-key', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'A06 BREAK: a released ticket came back or a new one was allocated (got %, %)', g.result, g.ticket_ids;
  end if;
end $$;
rollback;
