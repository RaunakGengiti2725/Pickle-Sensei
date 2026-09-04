-- ============================================================================
-- Pickle Sensei — db-schema-migrations execution audit: RPC state matrix.
--
-- Runs against a throwaway Postgres with supabase/tests/shim_auth.sql and every
-- migration applied (see run_audit_probes.sh). Exercises access_state(),
-- reserve_analysis_permit(), apply_synced_shot() and lifetime_scored_count()
-- through every documented return status plus the empty / stale / missing /
-- cross-user / malformed states that the production matrix
-- (security_regression.sql) does not pin one by one. Every case asserts; any
-- deviation aborts the script (ON_ERROR_STOP) naming the case. Read-only with
-- respect to the repo: nothing here changes a migration.
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- ───────────────────────────── fixtures ─────────────────────────────────────
-- u1: free, one google identity          u2: free, one apple identity (foil)
-- u3: premium, EXPIRED entitlement       u4: premium, ACTIVE entitlement
-- u5: two linked identities              u6: no auth.identities row at all
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-9000-000000000001', 'u1@example.com', '{"full_name":"U1"}', '{"provider":"google"}'),
  ('00000000-0000-4000-9000-000000000002', 'u2@example.com', '{"full_name":"U2"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-9000-000000000003', 'u3@example.com', '{"full_name":"U3"}', '{"provider":"google"}'),
  ('00000000-0000-4000-9000-000000000004', 'u4@example.com', '{"full_name":"U4"}', '{"provider":"google"}'),
  ('00000000-0000-4000-9000-000000000005', 'u5@example.com', '{"full_name":"U5"}', '{"provider":"google"}'),
  ('00000000-0000-4000-9000-000000000006', 'u6@example.com', '{"full_name":"U6"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'g-u1', '00000000-0000-4000-9000-000000000001', '{"sub":"g-u1"}'),
  ('apple',  'a-u2', '00000000-0000-4000-9000-000000000002', '{"sub":"a-u2"}'),
  ('google', 'g-u3', '00000000-0000-4000-9000-000000000003', '{"sub":"g-u3"}'),
  ('google', 'g-u4', '00000000-0000-4000-9000-000000000004', '{"sub":"g-u4"}'),
  ('google', 'g-u5', '00000000-0000-4000-9000-000000000005', '{"sub":"g-u5"}'),
  ('apple',  'a-u5', '00000000-0000-4000-9000-000000000005', '{"sub":"a-u5"}');
insert into public.billing_entitlements (user_id, premium, product_key, expires_at) values
  ('00000000-0000-4000-9000-000000000003', true, 'pickle_sensei_pro_monthly', now() - interval '1 minute'),
  ('00000000-0000-4000-9000-000000000004', true, 'pickle_sensei_pro_monthly', now() + interval '30 days');

-- Canonical sync payload builder (mirrors apps/mobile/src/data/sync.ts
-- toSyncPayload after the edge parser flattened timestamps). `extra` is
-- merged last so a case can override or corrupt any field.
create function pg_temp.shot_json(
  p_id uuid, p_permit uuid, p_session uuid, p_kind text, p_extra jsonb default '{}'::jsonb
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'shotType', 'dink',
    'cameraView', 'side',
    'capturedAt', '2026-09-01T12:00:00Z',
    'startMs', 0, 'contactMs', 400, 'endMs', 900,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', 0.91,
    'resultKind', p_kind,
    'phases', jsonb_build_array(
      jsonb_build_object('key','setup','startMs',0,'representativeMs',100,'endMs',300,'confidence',0.9),
      jsonb_build_object('key','contact','startMs',300,'representativeMs',400,'endMs',600,'confidence',0.9)
    ),
    'checkpoints', jsonb_build_array(
      jsonb_build_object('key','paddle_ready','score',7,'confidence',0.8,'band','green','direction','none','severity',0.1,'applicable',true)
    ),
    'versionVector', jsonb_build_object(
      'appVersion','1.0.0','modelBundleVersion','b1','poseModelVersion','p1','paddleModelVersion','pd1',
      'strokeDetectorVersion','s1','phaseModelVersion','ph1','scoringModelVersion','sc1','shotConfigVersion','c1')
  ) || p_extra
$$;

-- ───────────────── R1: no session at all (auth.uid() is null) ───────────────
set local role authenticated;
do $$
declare v text; r record; rec record;
begin
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), gen_random_uuid(), null, 'scored'));
  if v <> 'auth.required' then
    raise exception 'R1: apply_synced_shot without a session must return auth.required (got %)', v;
  end if;
  select * into r from public.reserve_analysis_permit('r1-no-session');
  if r.result <> 'auth.required' or r.permit_id is not null then
    raise exception 'R1: reserve without a session must return auth.required (got %)', r.result;
  end if;
  -- access_state() has no auth.required branch: it answers the empty world.
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 0 then
    raise exception 'R1: access_state without a session must be (false,0,0) (got %,%,%)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
  if public.lifetime_scored_count() <> 0 then
    raise exception 'R1: lifetime_scored_count without a session must be 0';
  end if;
end $$;

-- ───────────────── R2: empty account — the initial state ────────────────────
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000001';
do $$
declare rec record;
begin
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 0 or rec.reserved_count <> 0 then
    raise exception 'R2: fresh account must be (false,0,0) (got %,%,%)',
      rec.premium, rec.scored_count, rec.reserved_count;
  end if;
end $$;

-- ───────────── R3: permit missing / foreign / not reserved / stale ──────────
do $$
declare v text; r record; p1 uuid; p2 uuid; s1 uuid := gen_random_uuid();
begin
  -- missing
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), gen_random_uuid(), null, 'scored'));
  if v <> 'access.permit_not_found' then
    raise exception 'R3a: unknown permit must be access.permit_not_found (got %)', v;
  end if;

  -- two live permits for u1
  select permit_id into p1 from public.reserve_analysis_permit('u1-k1');
  select permit_id into p2 from public.reserve_analysis_permit('u1-k2');
  if p1 is null or p2 is null then
    raise exception 'R3b: two free reserves must succeed';
  end if;

  -- scored sync consumes p1
  v := public.apply_synced_shot(pg_temp.shot_json(s1, p1, null, 'scored'));
  if v <> 'accepted' then raise exception 'R3c: first scored sync must be accepted (got %)', v; end if;
  if (select status || '/' || outcome from public.analysis_permits where id = p1) <> 'finalized/scored' then
    raise exception 'R3c: consumed permit must be finalized/scored';
  end if;

  -- a DIFFERENT shot presenting the already-finalized permit
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p1, null, 'scored'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'R3d: reusing a finalized permit must be access.permit_not_reserved (got %)', v;
  end if;
  if exists (select 1 from public.shots where user_id = (select auth.uid()) and id <> s1) then
    raise exception 'R3d: the refused shot must not have been written';
  end if;
end $$;

-- stale: age p2 past the 24h window as the table owner, then sync with it
reset role;
update public.analysis_permits
   set created_at = now() - interval '24 hours 1 second'
 where user_id = '00000000-0000-4000-9000-000000000001' and idempotency_key = 'u1-k2';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000001';
do $$
declare v text; p2 uuid; rec record;
begin
  select id into p2 from public.analysis_permits where idempotency_key = 'u1-k2';
  -- stale reserved permits are NOT counted as reserved by access_state
  select * into rec from public.access_state();
  if rec.reserved_count <> 0 or rec.scored_count <> 1 then
    raise exception 'R3e: a >24h reserved permit must not count as reserved (got reserved=%, scored=%)',
      rec.reserved_count, rec.scored_count;
  end if;
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p2, null, 'scored'));
  if v <> 'access.permit_expired' then
    raise exception 'R3f: a >24h permit must be access.permit_expired (got %)', v;
  end if;
  if (select status || '/' || outcome from public.analysis_permits where id = p2) <> 'released/expired' then
    raise exception 'R3f: the expired permit must be released/expired';
  end if;
  -- idempotent replay of the stale key returns the released row, never a fresh one
  select * into rec from public.reserve_analysis_permit('u1-k2');
  if rec.result <> 'accepted' or rec.permit_id <> p2 or rec.permit_status <> 'released' then
    raise exception 'R3g: replaying an expired key must return the same released permit (got %/%/%)',
      rec.result, rec.permit_id, rec.permit_status;
  end if;
end $$;

-- ────────────── R4: sessions — missing, foreign, own ─────────────────────────
reset role;
insert into public.sessions (id, user_id, started_at) values
  ('00000000-0000-4000-9000-0000000000a2', '00000000-0000-4000-9000-000000000002', now());
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000001';
do $$
declare v text; p uuid; own_session uuid := gen_random_uuid();
begin
  select permit_id into p from public.reserve_analysis_permit('u1-k3');
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, gen_random_uuid(), 'low_confidence'));
  if v <> 'shot.session_not_found' then
    raise exception 'R4a: unknown session must be shot.session_not_found (got %)', v;
  end if;
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, '00000000-0000-4000-9000-0000000000a2', 'low_confidence'));
  if v <> 'shot.session_not_found' then
    raise exception 'R4b: another user''s session must be shot.session_not_found (got %)', v;
  end if;
  if (select status from public.analysis_permits where id = p) <> 'reserved' then
    raise exception 'R4b: a session miss must leave the permit reserved for retry';
  end if;
  insert into public.sessions (id, user_id, started_at) values (own_session, (select auth.uid()), now());
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, own_session, 'low_confidence'));
  if v <> 'accepted' then raise exception 'R4c: own session must sync (got %)', v; end if;
  if (select status || '/' || outcome from public.analysis_permits where id = p) <> 'released/low_confidence' then
    raise exception 'R4c: an abstention must release its permit with outcome low_confidence';
  end if;
  if public.lifetime_scored_count() <> 1 then
    raise exception 'R4c: an abstention must not move the lifetime count';
  end if;
end $$;

-- ────────────── R5: id conflict with another user's row ─────────────────────
reset role;
insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, end_ms,
  analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
  paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version,
  shot_config_version, source)
values ('00000000-0000-4000-9000-0000000000f2', '00000000-0000-4000-9000-000000000002', 'dink', 'side',
  now(), 0, 900, 0.5, 'low_confidence', '1','1','1','1','1','1','1','1', 'real');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000001';
do $$
declare v text; p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('u1-k4');
  v := public.apply_synced_shot(pg_temp.shot_json('00000000-0000-4000-9000-0000000000f2', p, null, 'low_confidence'));
  if v <> 'shot.id_conflict' then
    raise exception 'R5: a foreign shot id must be shot.id_conflict (got %)', v;
  end if;
  if (select status from public.analysis_permits where id = p) <> 'reserved' then
    raise exception 'R5: an id conflict must leave the permit reserved';
  end if;
end $$;

-- ────────────── R6: schema rejections surface as shot.write_failed ──────────
do $$
declare v text; p uuid; sid uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('u1-k4');  -- replay: same reserved permit

  -- invalid checkpoint band
  sid := gen_random_uuid();
  v := public.apply_synced_shot(pg_temp.shot_json(sid, p, null, 'low_confidence',
        jsonb_build_object('checkpoints', jsonb_build_array(
          jsonb_build_object('key','k','score',null,'confidence',0.5,'band','purple','direction','none','severity',0,'applicable',false)))));
  if v not like 'shot.write_failed:%' then
    raise exception 'R6a: invalid band must be shot.write_failed:* (got %)', v;
  end if;
  if exists (select 1 from public.shots where id = sid) then
    raise exception 'R6a: a failed detail insert must roll the shot back';
  end if;

  -- scored without a score
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'scored', '{"overallScore": null}'));
  if v not like 'shot.write_failed:%' then
    raise exception 'R6b: scored-without-score must be shot.write_failed:* (got %)', v;
  end if;

  -- unknown resultKind
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'bogus'));
  if v not like 'shot.write_failed:%' then
    raise exception 'R6c: unknown resultKind must be shot.write_failed:* (got %)', v;
  end if;

  -- oversized shot_type (shots_text_bounds, 20260831160000)
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'low_confidence',
        jsonb_build_object('shotType', repeat('x', 65))));
  if v not like 'shot.write_failed:%' then
    raise exception 'R6d: oversized shotType must be shot.write_failed:* (got %)', v;
  end if;

  -- confidence out of range
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'low_confidence', '{"confidence": 1.5}'));
  if v not like 'shot.write_failed:%' then
    raise exception 'R6e: confidence > 1 must be shot.write_failed:* (got %)', v;
  end if;

  if (select status from public.analysis_permits where id = p) <> 'reserved' then
    raise exception 'R6: every write failure must leave the permit reserved';
  end if;
  if (select count(*) from public.shots where user_id = (select auth.uid())) <> 2 then
    raise exception 'R6: no failed shot may persist';
  end if;
end $$;

-- ────────────── R7: casts BEFORE the guarded block raise to the caller ──────
-- The Edge Function validates ids before calling; this records the RPC's own
-- behaviour for a malformed id (a raised error, not a status string).
do $$
declare v text;
begin
  begin
    v := public.apply_synced_shot('{"id":"not-a-uuid","analysisPermitId":"also-not"}'::jsonb);
    raise exception 'R7: malformed id must raise (got status %)', v;
  exception
    when invalid_text_representation then null;
  end;
  begin
    v := public.apply_synced_shot('{}'::jsonb);
    -- null id: idempotency lookup finds nothing, permit lookup finds nothing.
    if v <> 'access.permit_not_found' then
      raise exception 'R7b: empty payload must be access.permit_not_found (got %)', v;
    end if;
  end;
end $$;

-- ────────────── R8: empty and duplicated detail arrays ──────────────────────
do $$
declare v text; p uuid; sid uuid := gen_random_uuid();
begin
  select permit_id into p from public.reserve_analysis_permit('u1-k4');
  v := public.apply_synced_shot(pg_temp.shot_json(sid, p, null, 'low_confidence',
        jsonb_build_object(
          'phases', jsonb_build_array(
            jsonb_build_object('key','setup','startMs',0,'representativeMs',1,'endMs',2,'confidence',0.5),
            jsonb_build_object('key','setup','startMs',5,'representativeMs',6,'endMs',7,'confidence',0.6)),
          'checkpoints', '[]'::jsonb)));
  if v <> 'accepted' then raise exception 'R8a: duplicate phase keys must still sync (got %)', v; end if;
  if (select count(*) from public.shot_phases where shot_id = sid) <> 1 then
    raise exception 'R8a: duplicate phase keys must collapse to one row';
  end if;
  if (select start_ms from public.shot_phases where shot_id = sid) <> 0 then
    raise exception 'R8a: the FIRST phase entry must win (do nothing on conflict)';
  end if;
  if exists (select 1 from public.shot_checkpoints where shot_id = sid) then
    raise exception 'R8a: empty checkpoints must write nothing';
  end if;
  -- phases/checkpoints keys absent entirely
  select permit_id into p from public.reserve_analysis_permit('u1-k5');
  sid := gen_random_uuid();
  v := public.apply_synced_shot((pg_temp.shot_json(sid, p, null, 'low_confidence') - 'phases') - 'checkpoints');
  if v <> 'accepted' then raise exception 'R8b: absent detail arrays must sync (got %)', v; end if;
end $$;

-- ────────────── R9: replay with a DIFFERENT permit leaves it reserved ────────
do $$
declare v text; p uuid; sid uuid;
begin
  select id into sid from public.shots where user_id = (select auth.uid()) and result_kind = 'scored' limit 1;
  select permit_id into p from public.reserve_analysis_permit('u1-k6');
  v := public.apply_synced_shot(pg_temp.shot_json(sid, p, null, 'scored'));
  if v <> 'accepted' then raise exception 'R9: replay must be accepted (got %)', v; end if;
  if (select status from public.analysis_permits where id = p) <> 'reserved' then
    raise exception 'R9: a replayed shot must not touch the permit it presents';
  end if;
  -- That reserved permit now occupies an allowance slot until the sweep.
  if (select reserved_count from public.access_state()) <> 1 then
    raise exception 'R9: the untouched permit must show as reserved';
  end if;
end $$;

-- ────────────── R10: second free rating, then the paywall ────────────────────
do $$
declare v text; p uuid; r record; rec record;
begin
  select permit_id into p from public.reserve_analysis_permit('u1-k6');   -- reuse the reserved slot
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'scored', '{"shotType":"drive","overallScore":5.5}'));
  if v <> 'accepted' then raise exception 'R10a: second free rating must sync (got %)', v; end if;
  select * into rec from public.access_state();
  if rec.scored_count <> 2 or rec.reserved_count <> 0 then
    raise exception 'R10a: access must read 2 scored / 0 reserved (got %,%)', rec.scored_count, rec.reserved_count;
  end if;
  select * into r from public.reserve_analysis_permit('u1-k7');
  if r.result <> 'access.paywall_required' then
    raise exception 'R10b: third reserve must be paywall_required (got %)', r.result;
  end if;
  -- an abstention still needs a permit; none can be reserved now, so the
  -- only remaining path is a permit that already exists — u1-k5 released
  -- earlier: not reserved → refused as such, never as a paywall.
  select id into p from public.analysis_permits where idempotency_key = 'u1-k5';
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'low_confidence'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'R10c: a released permit must be permit_not_reserved (got %)', v;
  end if;
  -- rank state: two techniques, two scored shots
  if (select technique_count || '/' || scored_shot_count from public.player_rank_state
      where user_id = (select auth.uid())) <> '2/2' then
    raise exception 'R10d: rank state must reflect two techniques over two scored shots';
  end if;
end $$;

-- ────────────── R11: premium — expired vs active entitlement ────────────────
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000003';
do $$
declare rec record; r record; v text; p uuid; i int;
begin
  select * into rec from public.access_state();
  if rec.premium then raise exception 'R11a: an expired entitlement must read premium=false'; end if;
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('u3-k' || i);
    v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'scored'));
    if v <> 'accepted' then raise exception 'R11b: expired-premium free rating % must sync (got %)', i, v; end if;
  end loop;
  select * into r from public.reserve_analysis_permit('u3-k3');
  if r.result <> 'access.paywall_required' then
    raise exception 'R11c: an expired entitlement must hit the paywall like a free account (got %)', r.result;
  end if;
end $$;

set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000004';
do $$
declare rec record; v text; p uuid; i int;
begin
  select * into rec from public.access_state();
  if not rec.premium then raise exception 'R11d: an active entitlement must read premium=true'; end if;
  for i in 1..4 loop
    select permit_id into p from public.reserve_analysis_permit('u4-k' || i);
    if p is null then raise exception 'R11e: premium reserve % must succeed', i; end if;
    v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'scored'));
    if v <> 'accepted' then raise exception 'R11e: premium scored sync % must be accepted (got %)', i, v; end if;
  end loop;
  select * into rec from public.access_state();
  if rec.scored_count <> 4 then
    raise exception 'R11f: premium lifetime count must keep growing (got %)', rec.scored_count;
  end if;
end $$;

-- premium lapses after 4 ratings: every decision point flips closed at once
reset role;
update public.billing_entitlements set expires_at = now() - interval '1 second'
 where user_id = '00000000-0000-4000-9000-000000000004';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000004';
do $$
declare rec record; r record;
begin
  select * into rec from public.access_state();
  if rec.premium or rec.scored_count <> 4 then
    raise exception 'R11g: lapsed premium must read (false, 4) (got %, %)', rec.premium, rec.scored_count;
  end if;
  select * into r from public.reserve_analysis_permit('u4-k5');
  if r.result <> 'access.paywall_required' then
    raise exception 'R11h: lapsed premium at 4 scored must be paywall_required (got %)', r.result;
  end if;
end $$;

-- ────────────── R12: ledger — two linked identities move together ────────────
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000005';
do $$
declare v text; p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('u5-k1');
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'scored'));
  if v <> 'accepted' then raise exception 'R12: u5 first rating must sync (got %)', v; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.free_rating_ledger
      where identity_hash in (public.free_rating_identity_hash('google', 'g-u5'),
                              public.free_rating_identity_hash('apple', 'a-u5'))
        and scored_count = 1) <> 2 then
    raise exception 'R12: both linked identities must carry the same ledger count';
  end if;
end $$;

-- u5 unlinks the apple identity (auth.identities is unique on provider +
-- provider_id, exactly like hosted Supabase), then a NEW account signs in with
-- that same Apple ID: it inherits the identity's history.
delete from auth.identities where provider = 'apple' and provider_id = 'a-u5';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-9000-000000000007', 'u7@example.com', '{"full_name":"U7"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'a-u5', '00000000-0000-4000-9000-000000000007', '{"sub":"a-u5"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000007';
do $$
declare rec record; r record; v text; p uuid;
begin
  select * into rec from public.access_state();
  if rec.scored_count <> 1 then
    raise exception 'R12b: an identity shared with u5 must inherit 1 scored (got %)', rec.scored_count;
  end if;
  select permit_id into p from public.reserve_analysis_permit('u7-k1');
  if p is null then raise exception 'R12c: one rating must remain for the shared identity'; end if;
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'scored'));
  if v <> 'accepted' then raise exception 'R12c: the remaining rating must sync (got %)', v; end if;
  select * into r from public.reserve_analysis_permit('u7-k2');
  if r.result <> 'access.paywall_required' then
    raise exception 'R12d: the shared identity must now be at the limit (got %)', r.result;
  end if;
end $$;
-- ...and the write on u7 moved ONLY the apple identity to 2 (identity max + 1)
reset role;
do $$
begin
  if (select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('apple', 'a-u5')) <> 2 then
    raise exception 'R12e: the shared apple identity must be at 2';
  end if;
  if (select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('google', 'g-u5')) <> 1 then
    raise exception 'R12f: u5''s google identity is not u7''s and must stay at 1';
  end if;
end $$;
-- u5 (google only now) reads greatest(own 1, g-u5 = 1) = 1: the unlinked
-- identity's history no longer reaches it (the documented per-identity limit).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000005';
do $$
declare r record;
begin
  if public.lifetime_scored_count() <> 1 then
    raise exception 'R12g: u5 must read 1 after unlinking apple (got %)', public.lifetime_scored_count();
  end if;
  select * into r from public.reserve_analysis_permit('u5-k2');
  if r.result <> 'accepted' then
    raise exception 'R12h: u5 keeps one rating on its remaining identity (got %)', r.result;
  end if;
end $$;

-- ────────────── R13: no identity row — ledger is silent, own count rules ────
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000006';
do $$
declare v text; p uuid; i int; r record;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('u6-k' || i);
    v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), p, null, 'scored'));
    if v <> 'accepted' then raise exception 'R13: identity-less rating % must sync (got %)', i, v; end if;
  end loop;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'R13: own count must still bound an identity-less account';
  end if;
  select * into r from public.reserve_analysis_permit('u6-k3');
  if r.result <> 'access.paywall_required' then
    raise exception 'R13: identity-less account must hit the paywall at 2 (got %)', r.result;
  end if;
end $$;
reset role;
do $$
begin
  -- ledger rows exist only for identities; u6 has none, so the ledger holds
  -- exactly the five identity hashes that scored so far.
  if (select array_agg(identity_hash order by identity_hash) from public.free_rating_ledger) is distinct from
     (select array_agg(h order by h) from unnest(array[
        public.free_rating_identity_hash('google', 'g-u1'),
        public.free_rating_identity_hash('google', 'g-u3'),
        public.free_rating_identity_hash('google', 'g-u4'),
        public.free_rating_identity_hash('google', 'g-u5'),
        public.free_rating_identity_hash('apple',  'a-u5')]) h) then
    raise exception 'R13: ledger must hold exactly the five scoring identities (got % rows)',
      (select count(*) from public.free_rating_ledger);
  end if;
end $$;

-- ────────────── R14: reserve — key bounds and replay across states ──────────
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000002';
do $$
declare r record;
begin
  -- 129-char key: the NOT VALID check binds new writes and is NOT caught by
  -- the RPC (only unique_violation is) — it raises to the caller.
  begin
    select * into r from public.reserve_analysis_permit(repeat('k', 129));
    raise exception 'R14a: an oversized key must raise (got %)', r.result;
  exception
    when check_violation then null;
  end;
  -- 128 chars is the bound and works
  select * into r from public.reserve_analysis_permit(repeat('k', 128));
  if r.result <> 'accepted' then raise exception 'R14b: a 128-char key must reserve (got %)', r.result; end if;
  -- empty string is accepted by the RPC (the Edge Function rejects it first)
  select * into r from public.reserve_analysis_permit('');
  if r.result <> 'accepted' then raise exception 'R14c: empty key is not refused by the RPC (got %)', r.result; end if;
  -- limit reached for u2: 2 reserved
  select * into r from public.reserve_analysis_permit('u2-k3');
  if r.result <> 'access.paywall_required' then
    raise exception 'R14d: two live reservations must block a third (got %)', r.result;
  end if;
  -- client-side release (the finalize route's PostgREST update) frees the slot
  update public.analysis_permits set status = 'released', outcome = 'cancelled'
   where idempotency_key = '' and user_id = (select auth.uid());
  select * into r from public.reserve_analysis_permit('u2-k3');
  if r.result <> 'accepted' then
    raise exception 'R14e: releasing a permit must free its slot (got %)', r.result;
  end if;
end $$;

-- ────────────── R15: pg_cron sweep bodies, executed verbatim ─────────────────
-- The cron block in 20260831000000 is skipped on a server without pg_cron
-- (every Linux run so far). The three job bodies are executed here directly
-- against seeded rows so the SQL itself is proven, not just scheduled.
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-9000-0000000000c1', '00000000-0000-4000-9000-000000000002', 'sweep-stale', now() - interval '25 hours'),
  ('00000000-0000-4000-9000-0000000000c2', '00000000-0000-4000-9000-000000000002', 'sweep-fresh', now() - interval '23 hours');
insert into public.account_deletion_requests (user_id, expires_at) values
  ('00000000-0000-4000-9000-000000000006', now() - interval '2 days');
insert into public.account_deletion_requests (user_id, expires_at) values
  ('00000000-0000-4000-9000-000000000003', now() - interval '2 hours');
insert into public.webhook_events (id, event_type, payload, received_at) values
  ('evt-old', 'INITIAL_PURCHASE', '{}', now() - interval '91 days'),
  ('evt-recent', 'RENEWAL', '{}', now() - interval '89 days');

update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours';
delete from public.account_deletion_requests where expires_at < now() - interval '1 day';
delete from public.webhook_events where received_at < now() - interval '90 days';

do $$
begin
  if (select status || '/' || outcome from public.analysis_permits where id = '00000000-0000-4000-9000-0000000000c1') <> 'released/expired' then
    raise exception 'R15a: the sweep must release a 25h reserved permit as expired';
  end if;
  if (select status from public.analysis_permits where id = '00000000-0000-4000-9000-0000000000c2') <> 'reserved' then
    raise exception 'R15b: the sweep must leave a 23h reserved permit alone';
  end if;
  -- the sweep is a plain UPDATE: set_updated_at fires (updated_at moves)
  if (select updated_at from public.analysis_permits where id = '00000000-0000-4000-9000-0000000000c1')
     < now() - interval '1 minute' then
    raise exception 'R15a: updated_at must be stamped by the sweep';
  end if;
  if exists (select 1 from public.account_deletion_requests where user_id = '00000000-0000-4000-9000-000000000006') then
    raise exception 'R15c: a deletion request expired >1 day ago must be purged';
  end if;
  if not exists (select 1 from public.account_deletion_requests where user_id = '00000000-0000-4000-9000-000000000003') then
    raise exception 'R15d: a deletion request expired 2h ago must be kept (grace day)';
  end if;
  if exists (select 1 from public.webhook_events where id = 'evt-old')
     or not exists (select 1 from public.webhook_events where id = 'evt-recent') then
    raise exception 'R15e: webhook purge must remove >90d rows and keep the rest';
  end if;
end $$;

-- Late sync after the sweep: the SAME stale permit now reads as
-- permit_not_reserved (the sweep got there first), not permit_expired.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-9000-000000000002';
do $$
declare v text;
begin
  v := public.apply_synced_shot(pg_temp.shot_json(gen_random_uuid(), '00000000-0000-4000-9000-0000000000c1', null, 'low_confidence'));
  if v <> 'access.permit_not_reserved' then
    raise exception 'R15f: a swept permit must read permit_not_reserved (got %)', v;
  end if;
end $$;

-- ────────────── R16: access_state / lifetime count are STABLE and pure ───────
reset role;
do $$
declare p1 record; p2 record;
begin
  select provolatile, prosecdef, proconfig::text as cfg into p1 from pg_proc where proname = 'access_state' and pronamespace = 'public'::regnamespace;
  select provolatile, prosecdef, proconfig::text as cfg into p2 from pg_proc where proname = 'lifetime_scored_count' and pronamespace = 'public'::regnamespace;
  if p1.provolatile <> 's' or p1.prosecdef or p1.cfg not like '%search_path=%' then
    raise exception 'R16: access_state must be stable, invoker, pinned search_path (got %/%/%)', p1.provolatile, p1.prosecdef, p1.cfg;
  end if;
  if p2.provolatile <> 's' or p2.prosecdef or p2.cfg not like '%search_path=%' then
    raise exception 'R16: lifetime_scored_count must be stable, invoker, pinned search_path';
  end if;
  if not (select prosecdef from pg_proc where proname = 'identity_scored_count' and pronamespace = 'public'::regnamespace) then
    raise exception 'R16: identity_scored_count must be SECURITY DEFINER';
  end if;
  if not (select prosecdef from pg_proc where proname = 'record_scored_shot_in_ledger' and pronamespace = 'public'::regnamespace) then
    raise exception 'R16: record_scored_shot_in_ledger must be SECURITY DEFINER';
  end if;
  -- anon must not execute any identity helper
  if has_function_privilege('anon', 'public.identity_scored_count()', 'execute')
     or has_function_privilege('anon', 'public.lifetime_scored_count()', 'execute')
     or has_function_privilege('authenticated', 'public.free_rating_identity_hash(text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.record_scored_shot_in_ledger()', 'execute')
     or has_function_privilege('anon', 'public.access_lock_key(uuid)', 'execute') then
    raise exception 'R16: identity helper EXECUTE grants are wider than documented';
  end if;
end $$;

rollback;
\echo RPC STATE MATRIX: ALL CASES PASSED
