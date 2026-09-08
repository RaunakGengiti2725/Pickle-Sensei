-- A05 — boundary values on every RPC argument.
--
-- Attack: empty / max-length / over-length / leading-punctuation / whitespace
-- / unicode / NULL installation keys; environments in the wrong case or
-- outside the enum; NULL attestation; ticket counts -1, 0, 3, 2147483647,
-- NULL; NULL / random ticket and shot ids; reasons in the wrong case, empty,
-- NULL. Each invalid input must be refused as a verdict (never an exception,
-- never a partial write); each valid edge (128-char key, a key that is one
-- character, development environment, 0 tickets against an outstanding
-- ticket) must behave as documented.
\set ON_ERROR_STOP on
\set QUIET on
begin;
\ir _prelude.sql

select pg_temp.atk_user(8, 'google', 'google-sub-a05');
select pg_temp.atk_become(8);
do $$
declare g record; v text; st text; k128 text := repeat('k', 128); k129 text := repeat('k', 129); t1 uuid;
  bad_keys text[] := array['', '-lead', '.lead', ':lead', 'has space', E'tab\tkey', E'uni\u00e9', 'semi;colon', 'quote''s', E'nl\nkey', 'slash/x', 'back\x', k129];
  key text; n integer;
begin
  -- installation keys
  foreach key in array bad_keys loop
    st := pg_temp.atk_try(format($q$select * from public.register_offline_device(%L, 'production', true)$q$, key));
    if st is not null then raise exception 'A05 BREAK: registration raised % for key %', st, key; end if;
    select * into g from public.register_offline_device(key, 'production', true);
    if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: key % registered (%)', key, g.result; end if;
    select * into g from public.issue_offline_grant(key, 2);
    if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: issue with key % (%)', key, g.result; end if;
  end loop;
  select * into g from public.register_offline_device(null, 'production', true);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL key (%)', g.result; end if;
  select * into g from public.issue_offline_grant(null, 2);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL key issue (%)', g.result; end if;
  select * into g from public.register_offline_device(k128, 'production', true);
  if g.result <> 'accepted' then raise exception 'A05 BREAK: 128-char key refused (%)', g.result; end if;
  select * into g from public.register_offline_device('k', 'production', true);
  if g.result <> 'accepted' then raise exception 'A05 BREAK: 1-char key refused (%)', g.result; end if;
  select * into g from public.register_offline_device('A.b_c:d-9', 'development', true);
  if g.result <> 'accepted' then raise exception 'A05 BREAK: full alphabet key refused (%)', g.result; end if;

  -- environments and attestation
  select * into g from public.register_offline_device('a05-env', 'Production', true);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: environment case (%)', g.result; end if;
  select * into g from public.register_offline_device('a05-env', 'staging', true);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: environment enum (%)', g.result; end if;
  select * into g from public.register_offline_device('a05-env', '', true);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: empty environment (%)', g.result; end if;
  select * into g from public.register_offline_device('a05-env', null, true);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL environment (%)', g.result; end if;
  select * into g from public.register_offline_device('a05-env', 'production', null);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL attested (%)', g.result; end if;
  select count(*) into n from public.offline_devices where installation_key_id = 'a05-env';
  if n <> 0 then raise exception 'A05 BREAK: an invalid registration wrote a row'; end if;
  -- environment flip on a known key is refused, unattested → attested upgrade only
  select * into g from public.register_offline_device('a05-dev', 'development', false);
  if g.result <> 'accepted' or g.attestation_state <> 'unattested' then raise exception 'A05: dev registration (%, %)', g.result, g.attestation_state; end if;
  select * into g from public.issue_offline_grant('a05-dev', 2);
  if g.result <> 'offline.device_not_attested' then raise exception 'A05 BREAK: unattested device allocated (%)', g.result; end if;
  select * into g from public.register_offline_device('a05-dev', 'production', true);
  if g.result <> 'offline.device_environment_mismatch' then raise exception 'A05 BREAK: environment flip (%)', g.result; end if;
  select * into g from public.register_offline_device('a05-dev', 'development', true);
  if g.result <> 'accepted' or g.attestation_state <> 'attested' then raise exception 'A05: attestation upgrade (%, %)', g.result, g.attestation_state; end if;
  select * into g from public.register_offline_device('a05-dev', 'development', false);
  if g.result <> 'accepted' or g.attestation_state <> 'attested' then raise exception 'A05 BREAK: attestation downgraded (%, %)', g.result, g.attestation_state; end if;

  -- ticket counts
  select * into g from public.issue_offline_grant('a05-dev', -1);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: -1 tickets (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a05-dev', 3);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: 3 tickets (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a05-dev', 2147483647);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: int max tickets (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a05-dev', -2147483648);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: int min tickets (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a05-dev', null);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL tickets (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a05-dev', 0);
  if g.result <> 'offline.invalid_input' then raise exception 'A05 BREAK: 0 tickets with nothing outstanding (%)', g.result; end if;
  select * into g from public.issue_offline_grant('a05-unknown-key', 1);
  if g.result <> 'offline.device_not_registered' then raise exception 'A05 BREAK: unknown key (%)', g.result; end if;
  if pg_temp.atk_events((select auth.uid())) <> '' then
    raise exception 'A05 BREAK: invalid inputs wrote ledger rows (%)', pg_temp.atk_events((select auth.uid()));
  end if;
  select count(*) into n from public.offline_grants; if n <> 0 then raise exception 'A05 BREAK: invalid inputs wrote % grants', n; end if;

  -- a real allocation, then 0 as a refresh: re-issues, allocates nothing
  select * into g from public.issue_offline_grant('a05-dev', 1);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 1 then raise exception 'A05: one ticket (%, %)', g.result, g.ticket_ids; end if;
  t1 := g.ticket_ids[1];
  select * into g from public.issue_offline_grant('a05-dev', 0);
  if g.result <> 'accepted' or g.ticket_ids <> array[t1] or g.generation <> 2 then
    raise exception 'A05 BREAK: refresh with 0 (%, %, %)', g.result, g.ticket_ids, g.generation;
  end if;
  select * into g from public.issue_offline_grant('a05-dev', 1);
  if g.result <> 'accepted' or g.ticket_ids <> array[t1] then raise exception 'A05 BREAK: re-request 1 (%, %)', g.result, g.ticket_ids; end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:1' then
    raise exception 'A05 BREAK: refreshes allocated (%)', pg_temp.atk_events((select auth.uid()));
  end if;

  -- ticket / shot / reason arguments
  v := public.consume_offline_ticket(null, gen_random_uuid());
  if v <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL ticket consume (%)', v; end if;
  v := public.consume_offline_ticket(t1, null);
  if v <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL shot consume (%)', v; end if;
  v := public.consume_offline_ticket(gen_random_uuid(), gen_random_uuid());
  if v <> 'offline.ticket_not_found' then raise exception 'A05 BREAK: random ticket (%)', v; end if;
  v := public.consume_offline_ticket(t1, gen_random_uuid());
  if v <> 'offline.shot_not_chargeable' then raise exception 'A05 BREAK: random shot (%)', v; end if;
  v := public.release_offline_ticket(null, 'unused_ticket_returned');
  if v <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL ticket release (%)', v; end if;
  v := public.release_offline_ticket(t1, null);
  if v <> 'offline.invalid_input' then raise exception 'A05 BREAK: NULL reason (%)', v; end if;
  v := public.release_offline_ticket(t1, 'Unused_Ticket_Returned');
  if v <> 'offline.invalid_input' then raise exception 'A05 BREAK: reason case (%)', v; end if;
  v := public.release_offline_ticket(t1, 'unused_ticket_returned ');
  if v <> 'offline.invalid_input' then raise exception 'A05 BREAK: reason whitespace (%)', v; end if;
  v := public.release_offline_ticket(gen_random_uuid(), 'unused_ticket_returned');
  if v <> 'offline.ticket_not_found' then raise exception 'A05 BREAK: random ticket release (%)', v; end if;
  if pg_temp.atk_events((select auth.uid())) <> 'allocated:1' then
    raise exception 'A05 BREAK: invalid consume/release wrote rows (%)', pg_temp.atk_events((select auth.uid()));
  end if;
end $$;
select pg_temp.atk_reset();

-- table-level bounds hold for the owner too (no bypass around the RPC checks)
do $$
declare st text; dev uuid := (select id from public.offline_devices where installation_key_id = 'a05-dev');
begin
  st := pg_temp.atk_try(format($q$insert into public.offline_devices (user_id, installation_key_id, attestation_environment, attestation_state) values (%L, %L, 'production', 'unattested')$q$, pg_temp.atk_uid(8), repeat('k', 129)));
  if st is distinct from '23514' then raise exception 'A05 BREAK: 129-char key stored through the table (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_devices (user_id, installation_key_id, attestation_environment, attestation_state, attested_at) values (%L, 'a05-x', 'production', 'unattested', now())$q$, pg_temp.atk_uid(8)));
  if st is distinct from '23514' then raise exception 'A05 BREAK: inconsistent attestation stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at) values (%L, %L, 'identity_lifetime_free', 0, now(), now() + interval '1 day')$q$, pg_temp.atk_uid(8), dev));
  if st is distinct from '23514' then raise exception 'A05 BREAK: generation 0 stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at) values (%L, %L, 'identity_lifetime_free', 99, now(), now())$q$, pg_temp.atk_uid(8), dev));
  if st is distinct from '23514' then raise exception 'A05 BREAK: zero-length lease stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at) values (%L, %L, 'identity_lifetime_free', 99, now(), now() + interval '7 days 1 second')$q$, pg_temp.atk_uid(8), dev));
  if st is distinct from '23514' then raise exception 'A05 BREAK: 7d+1s lease stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at) values (%L, %L, 'identity_lifetime_free', 99, now(), 'infinity')$q$, pg_temp.atk_uid(8), dev));
  if st is distinct from '23514' then raise exception 'A05 BREAK: infinite lease stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at) values (%L, %L, 'identity_lifetime_free', 99, now(), now() - interval '1 day')$q$, pg_temp.atk_uid(8), dev));
  if st is distinct from '23514' then raise exception 'A05 BREAK: lease ending before issue stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at) values (%L, %L, 'identity_lifetime_free', 99, now(), now() + interval '1 day', now() + interval '30 days')$q$, pg_temp.atk_uid(8), dev));
  if st is distinct from '23514' then raise exception 'A05 BREAK: free grant with an entitlement expiry stored (%)', st; end if;
  st := pg_temp.atk_try(format($q$insert into public.offline_grants (user_id, device_id, entitlement_source, generation, issued_at, expires_at) values (%L, %L, 'verified_store', 99, now(), now() + interval '1 day')$q$, pg_temp.atk_uid(8), dev));
  if st is distinct from '23514' then raise exception 'A05 BREAK: Pro lease without an entitlement stored (%)', st; end if;
end $$;
rollback;
\echo A05 PASS: boundary inputs refused as verdicts, valid edges honoured
