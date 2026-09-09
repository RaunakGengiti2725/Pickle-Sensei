-- ADV-06 — the restrictive API-only gate under every degraded credential
-- shape a client can present: wrong API key, missing key, missing/garbage
-- session claim, another account's live session id, expired session
-- (not_after in the past), banned account, session revoked by logout.
--
-- Expected. Key shapes (wrong/missing x-pickle-api-key): the DB is API-only
-- (20260905190106), so NOTHING may answer — tables read 0 rows and refuse
-- writes, every client RPC denies/raises, no row is written. The one
-- tolerated answer is access_state() = (f,0,0): the gate fails to ZERO rather
-- than raising (the same convention T8 pins for offline_hold_count() without
-- the key), so a gate-less caller learns nothing true about the account —
-- but any premium=true or non-zero count there is a leak and is flagged.
-- Session shapes
-- (right key, bad session): the DB contract enforces the live session inside
-- the four offline RPCs (register/issue/consume/release raise 42501); the
-- edge function enforces it for every other route (index.ts calls
-- is_api_session_active before routing), so for those the DB-layer answer is
-- recorded as evidence, and only the offline RPCs are asserted. The intact
-- shape must keep working, and lifting a ban must re-admit the account.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-0000000006a1','mia@example.com','{"full_name":"Mia"}','{"provider":"apple"}'),
 ('00000000-0000-4000-8000-0000000006b1','ned@example.com','{"full_name":"Ned"}','{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
 ('apple','adv06-mia','00000000-0000-4000-8000-0000000006a1','{"sub":"adv06-mia"}'),
 ('google','adv06-ned','00000000-0000-4000-8000-0000000006b1','{"sub":"adv06-ned"}');
insert into auth.sessions (id, user_id) values
 ('00000000-0000-4000-8000-0000000006a2','00000000-0000-4000-8000-0000000006a1'),
 ('00000000-0000-4000-8000-0000000006a3','00000000-0000-4000-8000-0000000006a1'),
 ('00000000-0000-4000-8000-0000000006b2','00000000-0000-4000-8000-0000000006b1');
insert into public.sessions (id, user_id, started_at)
 values ('00000000-0000-4000-8000-0000000006d1','00000000-0000-4000-8000-0000000006a1', now());
-- Mia is a verified Pro subscriber who has also spent both lifetime free ratings on her Apple ID:
-- a truthful access_state() for her is (t,2,0); without the API gate only the
-- fail-to-zero tuple (f,0,0) is acceptable (nothing true may leak past the gate)
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
 values ('00000000-0000-4000-8000-0000000006a1', true, null, now());
insert into public.free_rating_ledger (identity_hash, scored_count)
 values (public.free_rating_identity_hash('apple', 'adv06-mia'), 2);

create function pg_temp.set_headers(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.headers', case when p_key is null then '' else jsonb_build_object('x-pickle-api-key', p_key)::text end, true);
end $$;
grant execute on function pg_temp.set_headers(text) to authenticated;

-- probe: every client-reachable read/write/RPC; returns the list of things that were ALLOWED
create function pg_temp.probe(p_label text) returns text[] language plpgsql as $$
declare
  allowed text[] := '{}';
  n bigint; v text; r record; permit uuid;
begin
  begin
    select count(*) into n from public.sessions;
    if n > 0 then allowed := array_append(allowed, 'select_sessions'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into n from public.profiles;
    if n > 0 then allowed := array_append(allowed, 'select_profiles'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.sessions (id, user_id, started_at) values (gen_random_uuid(), '00000000-0000-4000-8000-0000000006a1', now());
    allowed := array_append(allowed, 'insert_session');
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sessions set ended_at = now() where id = '00000000-0000-4000-8000-0000000006d1';
    if found then allowed := array_append(allowed, 'update_session'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select * into r from public.reserve_analysis_permit('adv06-' || p_label);
    if r.result = 'accepted' then allowed := array_append(allowed, 'reserve_permit'); permit := r.permit_id; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.apply_synced_shot(jsonb_build_object('id', gen_random_uuid(), 'analysisPermitId', coalesce(permit, gen_random_uuid()),
      'resultKind', 'low_confidence', 'shotType', 'drive',
      'capturedAt', '2026-09-08T10:00:00Z', 'startMs', 0, 'endMs', 1000, 'confidence', 0.2,
      'versionVector', jsonb_build_object('appVersion', '1.0.0', 'modelBundleVersion', 'b', 'poseModelVersion', 'p',
        'paddleModelVersion', 'p', 'strokeDetectorVersion', 's', 'phaseModelVersion', 'p', 'scoringModelVersion', 's',
        'shotConfigVersion', 'c')));
    if v = 'accepted' then allowed := array_append(allowed, 'apply_synced_shot'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select * into r from public.access_state();
    allowed := array_append(allowed, 'access_state=' || r::text);
  exception when insufficient_privilege then null;
  end;
  begin
    select * into r from public.register_offline_device('adv06-' || p_label, 'production', true);
    if r.result = 'accepted' then allowed := array_append(allowed, 'register_offline_device'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    select * into r from public.issue_offline_grant('adv06-' || p_label, 1);
    if r.result = 'accepted' then allowed := array_append(allowed, 'issue_offline_grant'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.consume_offline_ticket(gen_random_uuid(), jsonb_build_object('id', gen_random_uuid(), 'resultKind', 'scored'));
    if v = 'accepted' then allowed := array_append(allowed, 'consume_offline_ticket'); end if;
  exception when insufficient_privilege then null;
  end;
  begin
    v := public.release_offline_ticket(gen_random_uuid(), 'unused_ticket_returned');
    if v = 'accepted' then allowed := array_append(allowed, 'release_offline_ticket'); end if;
  exception when insufficient_privilege then null;
  end;
  return allowed;
end $$;
grant execute on function pg_temp.probe(text) to authenticated;

-- a session shape breaks only if an offline RPC answered; the rest is recorded evidence
create function pg_temp.session_shape(p_label text, p_allowed text[]) returns text[] language plpgsql as $$
declare offline text[];
begin
  raise notice 'ADV-06 session shape % — DB layer allowed (edge enforces is_api_session_active for non-offline routes): %', p_label, p_allowed;
  offline := array(select x from unnest(p_allowed) x
    where x in ('register_offline_device', 'issue_offline_grant', 'consume_offline_ticket', 'release_offline_ticket'));
  if cardinality(offline) > 0 then
    return array[p_label || ':offline_rpc_allowed:' || offline::text];
  end if;
  return '{}';
end $$;
grant execute on function pg_temp.session_shape(text, text[]) to authenticated;

create function pg_temp.counts() returns text language sql as $$
  select (select count(*) from public.sessions where user_id = '00000000-0000-4000-8000-0000000006a1') || '/'
      || (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-0000000006a1') || '/'
      || (select count(*) from public.analysis_permits where user_id = '00000000-0000-4000-8000-0000000006a1') || '/'
      || (select count(*) from public.offline_devices where user_id = '00000000-0000-4000-8000-0000000006a1') || '/'
      || (select count(*) from public.offline_allocation_ledger where user_id = '00000000-0000-4000-8000-0000000006a1')
$$;

do $$ begin perform set_config('adv06.key', public.get_api_request_key(), true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000006a1';

do $$
declare
  a text[]; expect_all text[] := array['select_sessions','select_profiles','insert_session','update_session','reserve_permit',
    'apply_synced_shot','access_state=(t,2,0)','register_offline_device','issue_offline_grant'];
begin
  -- intact
  perform pg_temp.set_headers(current_setting('adv06.key'));
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-0000000006a2"}', true);
  a := pg_temp.probe('ok');
  if not (a @> expect_all) then
    raise exception 'ADV-06 precondition: intact credentials were refused: allowed=%', a;
  end if;
end $$;
reset role;
do $$ begin perform set_config('adv06.counts_after_intact', pg_temp.counts(), true); end $$;
set local role authenticated;

do $$
declare a text[]; findings text[] := '{}';
begin
  -- wrong key
  perform pg_temp.set_headers('not-the-key');
  a := pg_temp.probe('wrongkey');
  raise notice 'ADV-06 wrong key — DB layer allowed: %', a;
  a := array_remove(a, 'access_state=(f,0,0)');
  if cardinality(a) > 0 then findings := array_append(findings, 'wrong_key:' || a::text); end if;
  -- missing key header
  perform pg_temp.set_headers(null);
  a := pg_temp.probe('nokey');
  raise notice 'ADV-06 no key — DB layer allowed: %', a;
  a := array_remove(a, 'access_state=(f,0,0)');
  if cardinality(a) > 0 then findings := array_append(findings, 'no_key:' || a::text); end if;
  perform set_config('adv06.findings', findings::text, true);
end $$;
reset role;
do $$
declare findings text[] := current_setting('adv06.findings')::text[];
begin
  if pg_temp.counts() <> current_setting('adv06.counts_after_intact') then
    findings := array_append(findings, 'key_shapes_wrote_rows:' || current_setting('adv06.counts_after_intact') || '->' || pg_temp.counts());
  end if;
  perform set_config('adv06.findings', findings::text, true);
end $$;
set local role authenticated;
do $$
declare a text[]; findings text[] := current_setting('adv06.findings')::text[];
begin
  -- right key, no session claim
  perform pg_temp.set_headers(current_setting('adv06.key'));
  perform set_config('request.jwt.claims', '{}', true);
  a := pg_temp.probe('noclaim');
  findings := findings || pg_temp.session_shape('no_session_claim', a);
  -- garbage session claim
  perform set_config('request.jwt.claims', '{"session_id":"not-a-uuid"}', true);
  a := pg_temp.probe('garbage');
  findings := findings || pg_temp.session_shape('garbage_session_claim', a);
  -- another account's live session id
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-0000000006b2"}', true);
  a := pg_temp.probe('foreign');
  findings := findings || pg_temp.session_shape('foreign_session', a);
  -- unknown session id (never issued / already purged)
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-00000000ffff"}', true);
  a := pg_temp.probe('unknown');
  findings := findings || pg_temp.session_shape('unknown_session', a);
  perform set_config('adv06.findings', findings::text, true);
end $$;

reset role;
update auth.sessions set not_after = now() - interval '1 second' where id = '00000000-0000-4000-8000-0000000006a3';
set local role authenticated;
do $$
declare a text[]; findings text[] := current_setting('adv06.findings')::text[];
begin
  perform pg_temp.set_headers(current_setting('adv06.key'));
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-0000000006a3"}', true);
  a := pg_temp.probe('expired');
  findings := findings || pg_temp.session_shape('expired_session', a);
  perform set_config('adv06.findings', findings::text, true);
end $$;

reset role;
update auth.users set banned_until = now() + interval '1 day' where id = '00000000-0000-4000-8000-0000000006a1';
set local role authenticated;
do $$
declare a text[]; findings text[] := current_setting('adv06.findings')::text[];
begin
  perform pg_temp.set_headers(current_setting('adv06.key'));
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-0000000006a2"}', true);
  a := pg_temp.probe('banned');
  findings := findings || pg_temp.session_shape('banned_account', a);
  perform set_config('adv06.findings', findings::text, true);
end $$;

reset role;
do $$ begin
  raise notice 'ADV-06 rows sessions/shots/permits/devices/ledger after intact=% after session shapes=% (device/ledger counts must match: offline RPCs refused)',
    current_setting('adv06.counts_after_intact'), pg_temp.counts();
  if split_part(pg_temp.counts(), '/', 4) <> split_part(current_setting('adv06.counts_after_intact'), '/', 4)
     or split_part(pg_temp.counts(), '/', 5) <> split_part(current_setting('adv06.counts_after_intact'), '/', 5) then
    perform set_config('adv06.findings', (current_setting('adv06.findings')::text[] || 'session_shapes_wrote_offline_rows')::text, true);
  end if;
end $$;

-- ban lifted: the live session is admitted again (no tombstoning of a re-admitted account)
update auth.users set banned_until = now() - interval '1 second' where id = '00000000-0000-4000-8000-0000000006a1';
set local role authenticated;
do $$
declare a text[]; findings text[] := current_setting('adv06.findings')::text[];
begin
  perform pg_temp.set_headers(current_setting('adv06.key'));
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-0000000006a2"}', true);
  a := pg_temp.probe('unbanned');
  if not (a @> array['select_sessions','access_state=(t,2,0)','reserve_permit']) then
    findings := array_append(findings, 'unbanned_still_refused:' || a::text);
  end if;
  perform set_config('adv06.findings', findings::text, true);
end $$;

-- logout revoked the session row (scope=local): the bearer's session_id no longer exists
reset role;
do $$ begin perform set_config('adv06.counts_after_unbanned', pg_temp.counts(), true); end $$;
delete from auth.sessions where id = '00000000-0000-4000-8000-0000000006a2';
set local role authenticated;
do $$
declare a text[]; findings text[] := current_setting('adv06.findings')::text[];
begin
  perform pg_temp.set_headers(current_setting('adv06.key'));
  perform set_config('request.jwt.claims', '{"session_id":"00000000-0000-4000-8000-0000000006a2"}', true);
  a := pg_temp.probe('revoked');
  findings := findings || pg_temp.session_shape('revoked_session', a);
  perform set_config('adv06.findings', findings::text, true);
end $$;

reset role;
do $$
declare findings text[] := current_setting('adv06.findings')::text[];
begin
  if split_part(pg_temp.counts(), '/', 4) <> split_part(current_setting('adv06.counts_after_unbanned'), '/', 4)
     or split_part(pg_temp.counts(), '/', 5) <> split_part(current_setting('adv06.counts_after_unbanned'), '/', 5) then
    findings := array_append(findings, 'revoked_session_wrote_offline_rows');
  end if;
  raise notice 'ADV-06 row counts sessions/shots/permits/devices/ledger: intact=% unbanned=% final=%',
    current_setting('adv06.counts_after_intact'), current_setting('adv06.counts_after_unbanned'), pg_temp.counts();
  raise notice 'ADV-06 findings: %', findings;
  if cardinality(findings) > 0 then
    raise exception 'ADV-06 BREAK: %', findings;
  end if;
  raise notice 'ADV-06: PASS';
end $$;
rollback;
