-- ATTACK A03 — boundary values on the two input-taking RPCs: installation key
-- at/over the cap, newline, empty, non-ASCII; null environment/attestation;
-- requested tickets null / negative / 3 / int max / 0; a refresh that asks for
-- fewer tickets than are outstanding must still re-issue every outstanding
-- one and allocate nothing new. Refused inputs persist nothing.
begin;
\ir _setup.sql

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare r record; g record; k128 text := repeat('k', 128);
begin
  select * into r from public.register_offline_device(k128, 'production', true);
  if r.result <> 'accepted' then raise exception 'A03: a 128-char key is within bounds (got %)', r.result; end if;
  select * into r from public.register_offline_device(repeat('k', 129), 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: 129 chars must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device(E'abc\ndef', 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: a newline in the key must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('', 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: an empty key must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('abc' || chr(233), 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: a non-ASCII key must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('.leading-dot', 'production', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: a key not starting alphanumeric must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('e1-key', null, true);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: null environment must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('e1-key', 'staging', true);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: unknown environment must be refused (got %)', r.result; end if;
  select * into r from public.register_offline_device('e1-key', 'production', null);
  if r.result <> 'offline.invalid_input' then raise exception 'A03: null attestation must be refused (got %)', r.result; end if;
  if (select count(*) from public.offline_devices) <> 1 then
    raise exception 'A03: refused registrations must persist nothing (devices = %)', (select count(*) from public.offline_devices);
  end if;

  select * into g from public.issue_offline_grant(k128, null);
  if g.result <> 'offline.invalid_input' then raise exception 'A03: null request must be refused (got %)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, -1);
  if g.result <> 'offline.invalid_input' then raise exception 'A03: negative request must be refused (got %)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, 3);
  if g.result <> 'offline.invalid_input' then raise exception 'A03: 3 tickets exceed the budget (got %)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, 2147483647);
  if g.result <> 'offline.invalid_input' then raise exception 'A03: int max must be refused (got %)', g.result; end if;
  select * into g from public.issue_offline_grant(k128, 0);
  if g.result <> 'offline.invalid_input' then raise exception 'A03: 0 tickets with nothing outstanding is not a grant (got %)', g.result; end if;
  select * into g from public.issue_offline_grant(repeat('k', 129), 2);
  if g.result <> 'offline.invalid_input' then raise exception 'A03: oversize key on issue must be refused (got %)', g.result; end if;
  if (select count(*) from public.offline_grants) <> 0 or pg_temp.events((select auth.uid())) <> '' then
    raise exception 'A03: refused grant requests must persist nothing (grants %, events %)',
      (select count(*) from public.offline_grants), pg_temp.events((select auth.uid()));
  end if;

  select * into g from public.issue_offline_grant(k128, 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A03 precondition: two tickets (got %, %)', g.result, g.ticket_ids;
  end if;
  -- Requesting fewer than outstanding: every outstanding ticket comes back, none new.
  select * into g from public.issue_offline_grant(k128, 1);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 or g.generation <> 2 then
    raise exception 'A03: a refresh for 1 must re-issue both outstanding tickets and allocate none (got %, %, gen %)', g.result, g.ticket_ids, g.generation;
  end if;
  select * into g from public.issue_offline_grant(k128, 0);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 or g.generation <> 3 then
    raise exception 'A03: a refresh for 0 re-issues the outstanding tickets (got %, %, gen %)', g.result, g.ticket_ids, g.generation;
  end if;
  if pg_temp.tickets_ever(k128) <> 2 or public.offline_hold_count() <> 2 then
    raise exception 'A03: refreshes never allocate (ever %, hold %)', pg_temp.tickets_ever(k128), public.offline_hold_count();
  end if;

  -- consume / release boundary inputs
  if public.consume_offline_ticket(null, gen_random_uuid()) <> 'offline.invalid_input' then raise exception 'A03: null ticket'; end if;
  if public.consume_offline_ticket(g.ticket_ids[1], null) <> 'offline.invalid_input' then raise exception 'A03: null shot'; end if;
  if public.release_offline_ticket(g.ticket_ids[1], null) <> 'offline.invalid_input' then raise exception 'A03: null reason'; end if;
  if public.release_offline_ticket(g.ticket_ids[1], '') <> 'offline.invalid_input' then raise exception 'A03: empty reason'; end if;
  if public.release_offline_ticket(g.ticket_ids[1], 'support_closed') <> 'offline.invalid_input' then raise exception 'A03: support reason from a client'; end if;
  if public.release_offline_ticket(g.ticket_ids[1], 'UNUSED_TICKET_RETURNED') <> 'offline.invalid_input' then raise exception 'A03: case-variant reason'; end if;
  if public.consume_offline_ticket(gen_random_uuid(), gen_random_uuid()) <> 'offline.ticket_not_found' then raise exception 'A03: unknown ticket'; end if;
  if pg_temp.events((select auth.uid())) <> 'allocated:2' then
    raise exception 'A03: refused consume/release must persist nothing (got %)', pg_temp.events((select auth.uid()));
  end if;
end $$;
rollback;
