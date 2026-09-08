-- ADV-07 — account switch on one device: the spent identity must stay spent
-- after delete + re-sign-in, and a different account on the same device must
-- neither inherit the spend nor reach the other account's rows/permits.
--
-- Boundaries probed (all through the client roles with the API header):
--   1. A (apple sub S) spends both free ratings, deletes the account
--      (auth.users cascade), signs in again as A2 with the SAME apple sub:
--      lifetime_scored_count() = 2 and reserve_analysis_permit() refuses.
--   2. B (google, different subject) signs in on the same device: lifetime 0,
--      one reservation accepted.
--   3. B replays A's outbox (shot ids + permit ids that belonged to A):
--      apply_synced_shot() must refuse with a typed result, insert nothing
--      for B, and never report `accepted` for a row B does not own.
--   4. B cannot see or move A2's permits, sessions or shots through RLS.
--   5. A2 deletes again; linking the apple identity to B AFTER B spent one
--      rating: B's count becomes max(own=1, apple ledger=2) = 2 → paywall,
--      never a third rating.
\set ON_ERROR_STOP on
\set QUIET on
begin;

create function pg_temp.adv07_shot(p_id uuid, p_permit uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.adv07_shot(uuid, uuid) to authenticated, anon;

create function pg_temp.adv07_become(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_uid)::text, true);
end $$;
grant execute on function pg_temp.adv07_become(uuid) to authenticated, anon;

-- Account A: apple subject S, spends both ratings.
insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad71', 'adv07-a@example.com', '{"provider":"apple"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad72', '00000000-0000-4000-8000-00000000ad71', 'apple', 'adv07-apple-S');

do $$ begin perform pg_temp.adv07_become('00000000-0000-4000-8000-00000000ad71'); end $$;
set local role authenticated;
do $$
declare p1 uuid; p2 uuid; r text;
begin
  select permit_id into p1 from public.reserve_analysis_permit('adv07-a-k1');
  select permit_id into p2 from public.reserve_analysis_permit('adv07-a-k2');
  r := public.apply_synced_shot(pg_temp.adv07_shot('00000000-0000-4000-8000-00000000ad73', p1));
  if r <> 'accepted' then raise exception 'ADV-07 precondition: A first sync %', r; end if;
  r := public.apply_synced_shot(pg_temp.adv07_shot('00000000-0000-4000-8000-00000000ad74', p2));
  if r <> 'accepted' then raise exception 'ADV-07 precondition: A second sync %', r; end if;
  perform set_config('adv07.a_permit', p1::text, true);
end $$;
reset role;

-- A deletes the account (auth.users cascade) and signs in again with the same
-- Apple ID: a NEW auth user with the SAME identity subject.
delete from auth.users where id = '00000000-0000-4000-8000-00000000ad71';
insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad75', 'adv07-a2@example.com', '{"provider":"apple"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad76', '00000000-0000-4000-8000-00000000ad75', 'apple', 'adv07-apple-S');

do $$ begin perform pg_temp.adv07_become('00000000-0000-4000-8000-00000000ad75'); end $$;
set local role authenticated;
do $$
declare r text; p uuid;
begin
  if public.lifetime_scored_count() <> 2 then
    raise exception 'ADV-07 BREAK: delete + re-sign-in with the same Apple ID reset the lifetime count to %', public.lifetime_scored_count();
  end if;
  select result, permit_id into r, p from public.reserve_analysis_permit('adv07-a2-k1');
  if r <> 'access.paywall_required' or p is not null then
    raise exception 'ADV-07 BREAK: re-signed-in spent identity was granted a permit (%)', r;
  end if;
  if (select scored_count from public.access_state()) <> 2 then
    raise exception 'ADV-07 BREAK: access_state() shows % scored for a spent identity', (select scored_count from public.access_state());
  end if;
end $$;
reset role;

-- Account B: google, unrelated subject, same device.
insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad77', 'adv07-b@example.com', '{"provider":"google"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad78', '00000000-0000-4000-8000-00000000ad77', 'google', 'adv07-google-B');

-- A2 reserves one permit so B has a live foreign permit to aim at. A2 is
-- spent, so the owner role grants it premium first.
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
values ('00000000-0000-4000-8000-00000000ad75', true, now() + interval '30 days', now());
do $$ begin perform pg_temp.adv07_become('00000000-0000-4000-8000-00000000ad75'); end $$;
set local role authenticated;
do $$
declare p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('adv07-a2-premium');
  if p is null then raise exception 'ADV-07 precondition: premium A2 must reserve'; end if;
  perform set_config('adv07.a2_permit', p::text, true);
  insert into public.sessions (id, user_id, started_at)
  values ('00000000-0000-4000-8000-00000000ad79', '00000000-0000-4000-8000-00000000ad75', now());
end $$;
reset role;

do $$ begin perform pg_temp.adv07_become('00000000-0000-4000-8000-00000000ad77'); end $$;
set local role authenticated;
do $$
declare
  r text; pb uuid; a2p uuid := current_setting('adv07.a2_permit')::uuid;
  gone uuid := current_setting('adv07.a_permit')::uuid; n int;
begin
  if public.lifetime_scored_count() <> 0 then
    raise exception 'ADV-07 BREAK: B inherited a lifetime count of % from another identity', public.lifetime_scored_count();
  end if;

  -- 3a. Replay A's (deleted) outbox: A's old permit id is gone.
  r := public.apply_synced_shot(pg_temp.adv07_shot('00000000-0000-4000-8000-00000000ad73', gone));
  if r = 'accepted' then
    raise exception 'ADV-07 BREAK: B replayed a deleted account''s shot and was told accepted';
  end if;
  -- 3b. B uses A2's LIVE permit for its own new shot.
  r := public.apply_synced_shot(pg_temp.adv07_shot('00000000-0000-4000-8000-00000000ad7a', a2p));
  if r not in ('access.permit_not_found', 'access.permit_not_reserved') then
    raise exception 'ADV-07 BREAK: B synced a scored shot on A2''s permit: %', r;
  end if;
  -- 3c. B pins its own shot to A2's session id.
  select permit_id into pb from public.reserve_analysis_permit('adv07-b-k1');
  if pb is null then raise exception 'ADV-07 precondition: B first reservation'; end if;
  r := public.apply_synced_shot(pg_temp.adv07_shot('00000000-0000-4000-8000-00000000ad7b', pb)
       || jsonb_build_object('sessionId', '00000000-0000-4000-8000-00000000ad79'));
  if r <> 'shot.session_not_found' then
    raise exception 'ADV-07 BREAK: B attached a shot to A2''s session: %', r;
  end if;
  select count(*) into n from public.shots where user_id = '00000000-0000-4000-8000-00000000ad77';
  if n <> 0 then raise exception 'ADV-07 BREAK: refused syncs left % rows for B', n; end if;
  -- The refused attempts must not have consumed B's permit.
  if (select status from public.analysis_permits where id = pb) <> 'reserved' then
    raise exception 'ADV-07 BREAK: a refused sync settled B''s permit';
  end if;

  -- 4. RLS: B sees none of A2 and cannot move A2's permit.
  if exists (select 1 from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000ad75')
     or exists (select 1 from public.sessions where user_id = '00000000-0000-4000-8000-00000000ad75')
     or exists (select 1 from public.profiles where id = '00000000-0000-4000-8000-00000000ad75') then
    raise exception 'ADV-07 BREAK: B can read another account''s rows';
  end if;
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = a2p;
  if found then raise exception 'ADV-07 BREAK: B released A2''s permit'; end if;

  -- B spends its own first rating.
  r := public.apply_synced_shot(pg_temp.adv07_shot('00000000-0000-4000-8000-00000000ad7c', pb));
  if r <> 'accepted' then raise exception 'ADV-07 precondition: B first sync %', r; end if;
end $$;
reset role;

-- 5. A2 deletes its account again; B then links the spent Apple identity
-- (the subject is unique per provider in auth.identities, so it must be free
-- before it can be linked).
delete from auth.users where id = '00000000-0000-4000-8000-00000000ad75';
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad7d', '00000000-0000-4000-8000-00000000ad77', 'apple', 'adv07-apple-S');
do $$ begin perform pg_temp.adv07_become('00000000-0000-4000-8000-00000000ad77'); end $$;
set local role authenticated;
do $$
declare r text; p uuid;
begin
  if public.lifetime_scored_count() <> 2 then
    raise exception 'ADV-07 BREAK: linking a spent identity gives lifetime %, expected 2', public.lifetime_scored_count();
  end if;
  select result, permit_id into r, p from public.reserve_analysis_permit('adv07-b-k2');
  if r <> 'access.paywall_required' then
    raise exception 'ADV-07 BREAK: B reserved a third rating after linking a spent identity (%)', r;
  end if;
end $$;
reset role;

-- The identity ledger for the Apple subject must still be exactly 2 (no
-- double counting across the two users that carried it).
do $$
begin
  if (select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('apple', 'adv07-apple-S')) <> 2 then
    raise exception 'ADV-07 BREAK: ledger for the shared Apple subject is not 2';
  end if;
  if (select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('google', 'adv07-google-B')) <> 2 then
    raise exception 'ADV-07 BREAK: B''s google identity did not inherit max(1, 2) = 2 at link time';
  end if;
end $$;

rollback;
\echo 'ADV-07 account switch / identity isolation: PASS'
