-- A02 — release semantics under replay and re-credit attempts.
--
-- Attack: allocate both free tickets, hand one back, then try every way of
-- turning the returned ticket into a fresh rating: re-issue on the same
-- device, re-issue on a second device, an online reservation, consuming the
-- released ticket, releasing it again with a different reason, a client
-- written 'allocated' row, and a client written 'released' row with the
-- support-only reason.
--
-- Expected (objective: allocated + consumed + released ≤ entitlement): the
-- released ticket keeps its slot, nothing re-credits, the ledger stays
-- exactly allocated:2,released:1, and release replay is idempotent.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(2, 'apple', 'apple-sub-a02');
create temp table a02 (k text primary key, v uuid);
grant all on a02 to authenticated;

select pg_temp.atk_become(2);
do $$
declare g record; p record; v text; t1 uuid; t2 uuid; st text; rec record;
begin
  select * into g from public.register_offline_device('a02-key', 'production', true);
  select * into g from public.issue_offline_grant('a02-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A02 precondition: two tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  t1 := g.ticket_ids[1]; t2 := g.ticket_ids[2];
  insert into a02 values ('t1', t1), ('t2', t2);

  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A02 precondition: release (got %)', v; end if;

  -- replay with the same and with a foreign reason
  v := public.release_offline_ticket(t1, 'unused_ticket_returned');
  if v <> 'accepted' then raise exception 'A02 BREAK: release replay is not idempotent (got %)', v; end if;
  v := public.release_offline_ticket(t1, 'support_review');
  if v <> 'offline.invalid_input' then raise exception 'A02 BREAK: client self-asserted support_review (got %)', v; end if;
  v := public.release_offline_ticket(t1, '');
  if v <> 'offline.invalid_input' then raise exception 'A02 BREAK: empty reason accepted (got %)', v; end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:2,released:1' then
    raise exception 'A02 BREAK: ledger after release replays (got %)', pg_temp.atk_events((select auth.uid()));
  end if;

  -- re-issue on the same device: only the live ticket comes back, nothing new
  select * into g from public.issue_offline_grant('a02-key', 2);
  if g.result <> 'accepted' or g.ticket_ids <> array[t2] then
    raise exception 'A02 BREAK: released ticket re-credited on re-issue (got %, %)', g.result, g.ticket_ids;
  end if;
  -- a second device of the same account
  select * into g from public.register_offline_device('a02-key-2', 'production', true);
  select * into g from public.issue_offline_grant('a02-key-2', 2);
  if g.result <> 'access.paywall_required' then
    raise exception 'A02 BREAK: second device allocated after a release (got %, %)', g.result, g.ticket_ids;
  end if;
  -- online
  select * into p from public.reserve_analysis_permit('a02-online');
  if p.result <> 'access.paywall_required' then
    raise exception 'A02 BREAK: online reservation granted after a release (got %)', p.result;
  end if;
  select * into rec from public.access_state();
  if rec.reserved_count <> 2 or rec.scored_count <> 0 then
    raise exception 'A02 BREAK: access_state does not count the released ticket (reserved %, scored %)', rec.reserved_count, rec.scored_count;
  end if;

  -- the released ticket can never pay for a shot
  perform pg_temp.atk_reset();
  st := pg_temp.atk_direct_shot('00000000-0000-4000-8000-0000000a0201', pg_temp.atk_uid(2));
  if st is not null then raise exception 'A02 precondition: owner shot insert (%)', st; end if;
  perform pg_temp.atk_become(2);
  v := public.consume_offline_ticket(t1, '00000000-0000-4000-8000-0000000a0201');
  if v <> 'offline.ticket_released' then
    raise exception 'A02 BREAK: released ticket consumed (got %)', v;
  end if;

  -- client-written ledger rows
  st := pg_temp.atk_try(format(
    $q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, installation_key_id)
       select user_id, device_id, grant_id, generation, gen_random_uuid(), 'allocated', installation_key_id
       from public.offline_allocation_ledger where ticket_id = %L and event = 'allocated'$q$, t1));
  if st is distinct from '42501' then raise exception 'A02 BREAK: client wrote an allocated row (%)', st; end if;
  st := pg_temp.atk_try(format(
    $q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, reason, installation_key_id)
       select user_id, device_id, grant_id, generation, ticket_id, 'released', 'support_review', installation_key_id
       from public.offline_allocation_ledger where ticket_id = %L and event = 'allocated'$q$, t2));
  if st is distinct from '42501' then raise exception 'A02 BREAK: client wrote a released row (%)', st; end if;
  st := pg_temp.atk_try(format($q$delete from public.offline_allocation_ledger where ticket_id = %L and event = 'released'$q$, t1));
  if st is distinct from '42501' then raise exception 'A02 BREAK: client deleted a ledger row (%)', st; end if;
  st := pg_temp.atk_try(format($q$update public.offline_allocation_ledger set event = 'allocated' where ticket_id = %L and event = 'released'$q$, t1));
  if st is distinct from '42501' then raise exception 'A02 BREAK: client rewrote a ledger row (%)', st; end if;

  if pg_temp.atk_events((select auth.uid())) <> 'allocated:2,released:1' then
    raise exception 'A02 BREAK: ledger drifted (%)', pg_temp.atk_events((select auth.uid()));
  end if;
end $$;
select pg_temp.atk_reset();

-- owner-level (support) mutation of the ledger is refused as well: append-only
do $$
declare st text; t1 uuid := (select v from a02 where k = 't1');
begin
  st := pg_temp.atk_try(format($q$delete from public.offline_allocation_ledger where ticket_id = %L$q$, t1));
  if st is null then raise exception 'A02 BREAK: ledger rows deletable by the table owner'; end if;
  st := pg_temp.atk_try(format($q$update public.offline_allocation_ledger set reason = 'support_review' where ticket_id = %L and event = 'released'$q$, t1));
  if st is null then raise exception 'A02 BREAK: ledger rows updatable by the table owner'; end if;
  st := pg_temp.atk_try(format(
    $q$insert into public.offline_allocation_ledger (user_id, device_id, grant_id, generation, ticket_id, event, shot_id, installation_key_id)
       select user_id, device_id, grant_id, generation, ticket_id, 'consumed', '00000000-0000-4000-8000-0000000a0201', installation_key_id
       from public.offline_allocation_ledger where ticket_id = %L and event = 'allocated'$q$, t1));
  if st is distinct from '23514' then raise exception 'A02 BREAK: released ticket got a consumed row through the table (%)', st; end if;
end $$;
rollback;
\echo A02 PASS: release is terminal, idempotent, never re-credits
