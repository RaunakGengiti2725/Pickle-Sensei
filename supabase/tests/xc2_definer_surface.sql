-- ============================================================================
-- Pickle Sensei — cross-user isolation audit #2: SECURITY DEFINER / RPC
-- PARAMETER SURFACES (independent of security_regression.sql).
--
-- Runs after shim_auth.sql + every migration (see xc2_run_definer_surface.sh).
-- Unlike security_regression.sql this file does NOT abort on the first
-- failing case: every probe records {case, passed, detail} into xc2.results
-- and every fuzz iteration records {seed, iteration, mutation, payload,
-- result, sqlstate, problems} into xc2.fuzz, both of which the runner dumps
-- as JSON. The final block raises if anything failed, so the exit code is
-- still a verdict.
--
-- Threat model: Bob is an AUTHENTICATED user who can call any RPC PostgREST
-- exposes with any argument he likes (the Edge Function's input validation is
-- out of the picture here — this is the surface a client with the anon key
-- and its own bearer reaches directly). Alice is the victim. Carol is a
-- paying user whose premium must never bleed. The audit asks: can Bob read,
-- mutate, reserve, finalize, spend, or count against Alice through
--   X1  direct EXECUTE on the definer / trigger / helper functions
--   X2  identity_scored_count() / lifetime_scored_count() (auth.uid()-scoped)
--   X3  access_state() (premium / scored / reserved must be caller-only)
--   X4  reserve_analysis_permit(text) with Alice's idempotency key
--   X5  apply_synced_shot(jsonb) with foreign ids / ownership-shaped fields /
--       malformed values, including what the RETURN VALUE discloses
--   X6  the definer triggers (ledger writer, rank refresh, new-user
--       provisioning) fed hostile row data
--   X7  a seeded, replayable fuzz over apply_synced_shot + reserve with a
--       per-iteration byte-identical snapshot of everything Alice owns
-- Existing coverage is NOT repeated: B5 (foreign reserved permit → sync),
-- G1 (recompute_player_rank as Alice), H5 (colliding key), J* (ledger
-- follows identity across deletion).
-- ============================================================================

\set ON_ERROR_STOP on
\set QUIET on

begin;

-- ───────────────────────── recording infrastructure ─────────────────────────

create schema xc2;
grant usage on schema xc2 to anon, authenticated, service_role;

create table xc2.results (
  seq serial primary key,
  case_id text not null,
  passed boolean not null,
  detail text not null
);

create table xc2.fuzz (
  seq serial primary key,
  seed double precision not null,
  iteration int not null,
  attacker uuid not null,
  victim uuid not null,
  mutation text not null,
  payload jsonb,
  result text,
  sqlstate text,
  passed boolean not null,
  problems text not null
);

-- Definer so every role in the matrix (anon, authenticated) can record.
create function xc2.record(p_case text, p_passed boolean, p_detail text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into xc2.results (case_id, passed, detail) values (p_case, p_passed, p_detail);
$$;
grant execute on function xc2.record(text, boolean, text) to anon, authenticated, service_role;

create function xc2.record_fuzz(
  p_seed double precision, p_iteration int, p_attacker uuid, p_victim uuid, p_mutation text,
  p_payload jsonb, p_result text, p_sqlstate text, p_passed boolean, p_problems text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into xc2.fuzz (seed, iteration, attacker, victim, mutation, payload, result, sqlstate, passed, problems)
  values (p_seed, p_iteration, p_attacker, p_victim, p_mutation, p_payload, p_result, p_sqlstate, p_passed, p_problems);
$$;
grant execute on function xc2.record_fuzz(double precision, int, uuid, uuid, text, jsonb, text, text, boolean, text)
  to anon, authenticated, service_role;

create function xc2.fuzz_failures()
returns int
language sql
security definer
set search_path = ''
as $$
  select count(*)::int from xc2.fuzz where not passed
$$;
grant execute on function xc2.fuzz_failures() to anon, authenticated, service_role;

-- Byte-identical snapshot of everything one user owns + the ledger rows of
-- every identity of that user + their saved rank. Definer: it must see rows
-- the CALLER (Bob) cannot, or a mutation of Alice's rows would be invisible
-- to the very check that is supposed to detect it.
create function xc2.snapshot(p_uid uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select md5(coalesce((
    select string_agg(t, E'\n' order by t) from (
      select 'profiles:' || row_to_json(p)::text as t from public.profiles p where p.id = p_uid
      union all
      select 'sessions:' || row_to_json(s)::text from public.sessions s where s.user_id = p_uid
      union all
      select 'shots:' || row_to_json(s)::text from public.shots s where s.user_id = p_uid
      union all
      select 'shot_phases:' || row_to_json(s)::text from public.shot_phases s where s.user_id = p_uid
      union all
      select 'shot_checkpoints:' || row_to_json(s)::text from public.shot_checkpoints s where s.user_id = p_uid
      union all
      select 'analysis_permits:' || row_to_json(s)::text from public.analysis_permits s where s.user_id = p_uid
      union all
      select 'billing_entitlements:' || row_to_json(s)::text from public.billing_entitlements s where s.user_id = p_uid
      union all
      select 'player_rank_state:' || row_to_json(s)::text from public.player_rank_state s where s.user_id = p_uid
      union all
      select 'free_rating_ledger:' || row_to_json(l)::text
      from auth.identities i
      join public.free_rating_ledger l
        on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = p_uid
    ) rows
  ), ''))
$$;
grant execute on function xc2.snapshot(uuid) to anon, authenticated, service_role;

-- Rows that belong to NOBODY in the cast (a write that landed under a
-- forged/foreign user_id would show up here).
create function xc2.orphan_rows(p_known uuid[])
returns int
language sql
security definer
set search_path = ''
as $$
  select (select count(*) from public.shots where not (user_id = any (p_known)))::int
       + (select count(*) from public.shot_phases where not (user_id = any (p_known)))::int
       + (select count(*) from public.shot_checkpoints where not (user_id = any (p_known)))::int
       + (select count(*) from public.analysis_permits where not (user_id = any (p_known)))::int
       + (select count(*) from public.sessions where not (user_id = any (p_known)))::int
$$;
grant execute on function xc2.orphan_rows(uuid[]) to anon, authenticated, service_role;

-- Ledger count for one identity, readable by the harness only.
create function xc2.ledger_count(p_provider text, p_provider_id text)
returns int
language sql
security definer
set search_path = ''
as $$
  select coalesce((
    select l.scored_count from public.free_rating_ledger l
    where l.identity_hash = public.free_rating_identity_hash(p_provider, p_provider_id)
  ), 0)
$$;
grant execute on function xc2.ledger_count(text, text) to anon, authenticated, service_role;

-- ───────────────────────────────── cast ─────────────────────────────────────
--
--   alice  1111…  google   non-premium, 1 scored shot, 1 reserved permit,
--                          1 finalized permit, 1 session, saved rank
--   bob    2222…  apple    THE ATTACKER; premium in X7 so scored writes pass
--                          the free limit and the fuzz reaches every branch
--   carol  3333…  google   premium, nothing else (her premium must not bleed)

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('11111111-1111-4111-8111-111111111111', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}'),
  ('33333333-3333-4333-8333-333333333333', 'carol@example.com', '{"full_name":"Carol"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'xc2-google-alice', '11111111-1111-4111-8111-111111111111', '{"sub":"xc2-google-alice","email":"alice@example.com"}'),
  ('apple',  'xc2-apple-bob',    '22222222-2222-4222-8222-222222222222', '{"sub":"xc2-apple-bob","email":"bob@example.com"}'),
  ('google', 'xc2-google-carol', '33333333-3333-4333-8333-333333333333', '{"sub":"xc2-google-carol","email":"carol@example.com"}');

insert into public.billing_entitlements (user_id, premium)
values ('33333333-3333-4333-8333-333333333333', true);

-- Alice's world, written the way the app writes it (as Alice, through the
-- RPCs) so the triggers fire exactly as in production.
set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
insert into public.sessions (id, user_id, started_at)
values ('aaaaaaaa-0000-4000-8000-00000000c0de', '11111111-1111-4111-8111-111111111111', now());
do $$
declare r record; v text;
begin
  select * into r from public.reserve_analysis_permit('alice-key-finalized');
  if r.result <> 'accepted' then raise exception 'SETUP: alice reserve 1 (%)', r.result; end if;
  v := public.apply_synced_shot(jsonb_build_object(
    'id', 'aaaaaaaa-0000-4000-8000-00000000a5c0',
    'analysisPermitId', r.permit_id,
    'sessionId', 'aaaaaaaa-0000-4000-8000-00000000c0de',
    'resultKind', 'scored', 'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-01T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.1, 'confidence', 0.9,
    'phases', jsonb_build_array(jsonb_build_object('key', 'prep', 'startMs', 0, 'representativeMs', 100, 'endMs', 400, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object('key', 'contact_point', 'score', 71, 'confidence', 0.9, 'band', 'green', 'direction', 'none', 'severity', 0, 'applicable', true)),
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')));
  if v <> 'accepted' then raise exception 'SETUP: alice scored sync (%)', v; end if;
  select * into r from public.reserve_analysis_permit('alice-key-reserved');
  if r.result <> 'accepted' then raise exception 'SETUP: alice reserve 2 (%)', r.result; end if;
end $$;
reset role;

-- Pin the ids the setup produced so later cases can reference them.
create table xc2.ids as
select
  '11111111-1111-4111-8111-111111111111'::uuid as alice,
  '22222222-2222-4222-8222-222222222222'::uuid as bob,
  '33333333-3333-4333-8333-333333333333'::uuid as carol,
  'aaaaaaaa-0000-4000-8000-00000000c0de'::uuid as alice_session,
  'aaaaaaaa-0000-4000-8000-00000000a5c0'::uuid as alice_shot,
  (select id from public.analysis_permits where idempotency_key = 'alice-key-reserved') as alice_reserved_permit,
  (select id from public.analysis_permits where idempotency_key = 'alice-key-finalized') as alice_finalized_permit;
grant select on xc2.ids to anon, authenticated, service_role;

do $$
begin
  if (select status from public.analysis_permits where idempotency_key = 'alice-key-finalized') <> 'finalized'
     or (select status from public.analysis_permits where idempotency_key = 'alice-key-reserved') <> 'reserved'
     or not exists (select 1 from public.player_rank_state where user_id = (select alice from xc2.ids))
     or xc2.ledger_count('google', 'xc2-google-alice') <> 1 then
    raise exception 'SETUP: alice world not as expected';
  end if;
end $$;

-- ═══════════ X1: direct EXECUTE on definer / trigger / helper functions ══════

set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare
  ids record;
  fn text;
  denied boolean;
  err text;
begin
  select * into ids from xc2.ids;
  -- (name, call) pairs; every one of these must raise insufficient_privilege.
  for fn in
    select unnest(array[
      format('select public.recompute_player_rank(%L::uuid)', ids.alice),
      format('select public.recompute_player_rank(%L::uuid)', ids.bob),
      'select public.recompute_player_rank(null::uuid)',
      'select public.record_scored_shot_in_ledger()',
      'select public.handle_shot_rank_refresh()',
      'select public.handle_user_email_updated()',
      'select public.free_rating_identity_hash(''google'', ''xc2-google-alice'')'
    ])
  loop
    denied := false; err := '';
    begin
      execute fn;
    exception
      when insufficient_privilege then denied := true;
      when others then err := sqlstate || ' ' || sqlerrm;
    end;
    perform xc2.record('X1 authenticated EXECUTE denied: ' || fn, denied,
      case when denied then 'insufficient_privilege' else coalesce(nullif(err, ''), 'EXECUTED WITHOUT ERROR') end);
  end loop;
end $$;
reset role;

set local role anon;
do $$
declare fn text; denied boolean; err text;
begin
  for fn in
    select unnest(array[
      'select public.identity_scored_count()',
      'select public.lifetime_scored_count()',
      'select public.access_lock_key(''11111111-1111-4111-8111-111111111111''::uuid)',
      'select * from public.reserve_analysis_permit(''anon'')',
      'select public.apply_synced_shot(''{}''::jsonb)',
      'select * from public.access_state()',
      'select public.recompute_player_rank(''11111111-1111-4111-8111-111111111111''::uuid)'
    ])
  loop
    denied := false; err := '';
    begin
      execute fn;
    exception
      when insufficient_privilege then denied := true;
      when others then err := sqlstate || ' ' || sqlerrm;
    end;
    perform xc2.record('X1 anon EXECUTE denied: ' || fn, denied,
      case when denied then 'insufficient_privilege' else coalesce(nullif(err, ''), 'EXECUTED WITHOUT ERROR') end);
  end loop;
end $$;
reset role;

-- The lock-key helper IS client-executable by design (invoker, pure hash).
-- Record what Bob learns from it about Alice: a deterministic bigint he
-- could compute himself from her uuid — and nothing else. Informational.
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare k bigint;
begin
  k := public.access_lock_key((select alice from xc2.ids));
  perform xc2.record('X1 info: access_lock_key(alice) callable by bob', true,
    'returns ' || k::text || ' = hashtextextended(''pickle.access:''||uuid,0); pg_advisory_* live in pg_catalog and are not an RPC surface');
end $$;
reset role;

-- ═══════════ X2: identity_scored_count() / lifetime_scored_count() ══════════

-- Bob (0 scored) must not see Alice's 1 — under his own sub, under an
-- absent sub, and under a sub that is not a uuid.
set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare ic int; lc int;
begin
  ic := public.identity_scored_count();
  lc := public.lifetime_scored_count();
  perform xc2.record('X2a bob identity_scored_count() sees only his identities', ic = 0, 'identity_scored_count=' || ic);
  perform xc2.record('X2b bob lifetime_scored_count() sees only his shots+identities', lc = 0, 'lifetime_scored_count=' || lc);
end $$;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
do $$
declare ic int; lc int;
begin
  ic := public.identity_scored_count();
  lc := public.lifetime_scored_count();
  perform xc2.record('X2c alice identity_scored_count() = 1 (control)', ic = 1, 'identity_scored_count=' || ic);
  perform xc2.record('X2d alice lifetime_scored_count() = 1 (control)', lc = 1, 'lifetime_scored_count=' || lc);
end $$;
set local request.jwt.claim.sub = '';
do $$
declare ic int; lc int; err text := '';
begin
  begin
    ic := public.identity_scored_count();
    lc := public.lifetime_scored_count();
  exception when others then err := sqlstate || ' ' || sqlerrm;
  end;
  perform xc2.record('X2e authenticated role with NO sub gets 0, never a global max', err = '' and ic = 0 and lc = 0,
    coalesce(nullif(err, ''), 'identity=' || ic || ' lifetime=' || lc));
end $$;
set local request.jwt.claim.sub = 'not-a-uuid';
do $$
declare ic int; err text := '';
begin
  begin
    ic := public.identity_scored_count();
  exception when others then err := sqlstate;
  end;
  -- Either a clean cast error or 0 is acceptable; a non-zero count is not.
  perform xc2.record('X2f malformed sub cannot resolve to any user''s count', err <> '' or ic = 0,
    coalesce(nullif(err, ''), 'identity=' || ic));
end $$;
reset role;

-- ═══════════════════════════ X3: access_state() ═════════════════════════════

set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare r record;
begin
  select * into r from public.access_state();
  perform xc2.record('X3a bob access_state().premium is not carol''s', r.premium = false, 'premium=' || r.premium);
  perform xc2.record('X3b bob access_state().scored_count is not alice''s', r.scored_count = 0, 'scored_count=' || r.scored_count);
  perform xc2.record('X3c bob access_state().reserved_count excludes alice''s reserved permit', r.reserved_count = 0, 'reserved_count=' || r.reserved_count);
end $$;
set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
do $$
declare r record;
begin
  select * into r from public.access_state();
  perform xc2.record('X3d alice access_state() control (false,1,1)', r.premium = false and r.scored_count = 1 and r.reserved_count = 1,
    format('premium=%s scored=%s reserved=%s', r.premium, r.scored_count, r.reserved_count));
end $$;
reset role;

-- ═══════════ X4: reserve_analysis_permit(text) with Alice's keys ════════════

set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare
  ids record; r record; before text; after text;
begin
  select * into ids from xc2.ids;
  before := xc2.snapshot(ids.alice);

  -- Alice's FINALIZED key: the fast path looks a key up by (user_id, key);
  -- Bob must get a fresh reserved permit of his own, never Alice's row or
  -- its finalized status.
  select * into r from public.reserve_analysis_permit('alice-key-finalized');
  perform xc2.record('X4a reserve(alice''s finalized key) as bob → bob''s own new permit',
    r.result = 'accepted' and r.permit_status = 'reserved' and r.permit_id <> ids.alice_finalized_permit
      and exists (select 1 from public.analysis_permits where id = r.permit_id and user_id = ids.bob),
    format('result=%s status=%s outcome=%s same_id_as_alice=%s', r.result, r.permit_status, r.permit_outcome, r.permit_id = ids.alice_finalized_permit));

  -- Alice's RESERVED key.
  select * into r from public.reserve_analysis_permit('alice-key-reserved');
  perform xc2.record('X4b reserve(alice''s reserved key) as bob → bob''s own new permit',
    r.result = 'accepted' and r.permit_id <> ids.alice_reserved_permit
      and exists (select 1 from public.analysis_permits where id = r.permit_id and user_id = ids.bob),
    format('result=%s permit_id_is_alices=%s', r.result, r.permit_id = ids.alice_reserved_permit));

  -- Bob (non-premium) now holds 2 reserved: a third must be refused on HIS
  -- count, and Alice's reserved permit must not have been counted or touched.
  select * into r from public.reserve_analysis_permit('bob-third');
  perform xc2.record('X4c bob''s third reserve refused on bob''s own count', r.result = 'access.paywall_required', 'result=' || r.result);

  -- Key shaped like a uuid / like Alice's permit id / hostile text.
  select * into r from public.reserve_analysis_permit(ids.alice_reserved_permit::text);
  perform xc2.record('X4d reserve(alice''s permit uuid as key) does not resolve to her permit',
    r.result = 'access.paywall_required' or (r.result = 'accepted' and r.permit_id <> ids.alice_reserved_permit),
    'result=' || r.result || ' permit_id=' || coalesce(r.permit_id::text, 'null'));
  begin
    select * into r from public.reserve_analysis_permit(null);
    perform xc2.record('X4e reserve(null key) is refused or errors, never a foreign row',
      r.result is distinct from 'accepted' or r.permit_id is null or exists (select 1 from public.analysis_permits where id = r.permit_id and user_id = ids.bob),
      'result=' || coalesce(r.result, 'null'));
  exception when others then
    perform xc2.record('X4e reserve(null key) is refused or errors, never a foreign row', true, 'raised ' || sqlstate);
  end;

  after := xc2.snapshot(ids.alice);
  perform xc2.record('X4f alice''s rows byte-identical after bob''s reserve attempts', before = after, 'snapshot_changed=' || (before <> after));
end $$;
reset role;

-- ═══════════ X5: apply_synced_shot(jsonb) parameter surface (Bob) ═══════════

-- Bob needs his own reserved permit for the "own permit + foreign X" shapes.
-- He has two from X4 (ids differ from Alice's).
create table xc2.bob_permits as
select id from public.analysis_permits
where user_id = (select bob from xc2.ids) and status = 'reserved'
order by created_at, id;
grant select on xc2.bob_permits to authenticated;

create function xc2.shot_payload(
  p_id text, p_permit text, p_session text, p_result_kind text, p_score text
) returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'resultKind', p_result_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-02T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', p_score, 'confidence', 0.9,
    'phases', jsonb_build_array(jsonb_build_object('key', 'prep', 'startMs', 0, 'representativeMs', 100, 'endMs', 400, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object('key', 'contact_point', 'score', 65, 'confidence', 0.9, 'band', 'green', 'direction', 'none', 'severity', 0, 'applicable', true)),
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
  )
$$;
grant execute on function xc2.shot_payload(text, text, text, text, text) to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare
  ids record;
  own_permit uuid;
  before text; after text;
  v text; err text;
  p jsonb;
  shots_before int; ledger_alice_before int;
begin
  select * into ids from xc2.ids;
  select id into own_permit from xc2.bob_permits limit 1;
  before := xc2.snapshot(ids.alice);
  ledger_alice_before := xc2.ledger_count('google', 'xc2-google-alice');

  -- X5a own permit + ALICE's session
  v := public.apply_synced_shot(xc2.shot_payload('bbbbbbbb-0000-4000-8000-000000000001', own_permit::text, ids.alice_session::text, 'scored', '6.5'));
  perform xc2.record('X5a own permit + alice''s sessionId → shot.session_not_found, nothing written',
    v = 'shot.session_not_found'
      and not exists (select 1 from public.shots where id = 'bbbbbbbb-0000-4000-8000-000000000001')
      and (select status from public.analysis_permits where id = own_permit) = 'reserved',
    'result=' || v);

  -- X5b own permit + ALICE's existing shot id (replay of a foreign row)
  v := public.apply_synced_shot(xc2.shot_payload(ids.alice_shot::text, own_permit::text, null, 'scored', '6.5'));
  perform xc2.record('X5b own permit + alice''s shot id → shot.id_conflict, alice''s row untouched, permit still reserved',
    v = 'shot.id_conflict'
      and (select user_id from public.shots where id = ids.alice_shot) is not distinct from null  -- invisible to bob under RLS
      and (select status from public.analysis_permits where id = own_permit) = 'reserved',
    'result=' || v || ' bob_can_see_alice_shot=' || exists (select 1 from public.shots where id = ids.alice_shot));

  -- X5c ALICE's FINALIZED permit: must be indistinguishable from "no such
  -- permit" (access.permit_not_found), never leak its state via
  -- access.permit_not_reserved.
  v := public.apply_synced_shot(xc2.shot_payload('bbbbbbbb-0000-4000-8000-000000000002', ids.alice_finalized_permit::text, null, 'scored', '6.5'));
  perform xc2.record('X5c alice''s FINALIZED permit → permit_not_found (no state oracle)', v = 'access.permit_not_found', 'result=' || v);

  -- X5d ownership-shaped extra keys: user_id/userId at the top level and
  -- inside phases/checkpoints must be ignored (rows land under Bob).
  p := xc2.shot_payload('bbbbbbbb-0000-4000-8000-000000000003', own_permit::text, null, 'low_confidence', null)
       || jsonb_build_object('user_id', ids.alice, 'userId', ids.alice, 'owner', ids.alice);
  p := jsonb_set(p, '{phases,0,user_id}', to_jsonb(ids.alice::text));
  p := jsonb_set(p, '{checkpoints,0,user_id}', to_jsonb(ids.alice::text));
  p := jsonb_set(p, '{checkpoints,0,shot_id}', to_jsonb(ids.alice_shot::text));
  v := public.apply_synced_shot(p);
  perform xc2.record('X5d foreign user_id/shot_id keys in payload are ignored; row lands under bob',
    v = 'accepted'
      and exists (select 1 from public.shots where id = 'bbbbbbbb-0000-4000-8000-000000000003' and user_id = ids.bob)
      and (select count(*) from public.shot_phases where shot_id = 'bbbbbbbb-0000-4000-8000-000000000003' and user_id = ids.bob) = 1
      and (select count(*) from public.shot_checkpoints where shot_id = 'bbbbbbbb-0000-4000-8000-000000000003' and user_id = ids.bob) = 1
      and xc2.orphan_rows(array[ids.alice, ids.bob, ids.carol]) = 0,
    'result=' || v || ' orphans=' || xc2.orphan_rows(array[ids.alice, ids.bob, ids.carol]));
  -- that low_confidence sync released own_permit; take the second one
  select id into own_permit from xc2.bob_permits order by id offset 1 limit 1;
  if (select status from public.analysis_permits where id = own_permit) <> 'reserved' then
    select id into own_permit from public.analysis_permits where user_id = ids.bob and status = 'reserved' limit 1;
  end if;

  -- X5e malformed id: the cast happens BEFORE the atomic block, so the
  -- whole call must raise (22P02) with nothing written and the permit kept.
  err := '';
  begin
    v := public.apply_synced_shot(xc2.shot_payload('not-a-uuid', own_permit::text, null, 'scored', '6.5'));
  exception when others then err := sqlstate;
  end;
  perform xc2.record('X5e malformed id raises 22P02, permit still reserved',
    err = '22P02' and (select status from public.analysis_permits where id = own_permit) = 'reserved', 'sqlstate=' || coalesce(nullif(err, ''), 'none result=' || coalesce(v, 'null')));

  err := '';
  begin
    v := public.apply_synced_shot(xc2.shot_payload('bbbbbbbb-0000-4000-8000-000000000004', 'not-a-uuid', null, 'scored', '6.5'));
  exception when others then err := sqlstate;
  end;
  perform xc2.record('X5f malformed analysisPermitId raises 22P02', err = '22P02', 'sqlstate=' || coalesce(nullif(err, ''), 'none result=' || coalesce(v, 'null')));

  -- X5g resultKind case variant: 'SCORED' skips the free-limit branch by
  -- string compare, so the CHECK constraint on shots.result_kind is the
  -- only thing standing between it and a row. Must not insert.
  shots_before := (select count(*) from public.shots where user_id = ids.bob);
  v := public.apply_synced_shot(xc2.shot_payload('bbbbbbbb-0000-4000-8000-000000000005', own_permit::text, null, 'SCORED', '6.5'));
  perform xc2.record('X5g resultKind=SCORED is rejected by the CHECK constraint (no row, permit kept)',
    v like 'shot.write_failed:%'
      and (select count(*) from public.shots where user_id = ids.bob) = shots_before
      and (select status from public.analysis_permits where id = own_permit) = 'reserved',
    'result=' || v);
  -- What the RETURN VALUE discloses to a direct RPC caller (the Edge fn
  -- swallows it; PostgREST does not). Informational, recorded verbatim.
  perform xc2.record('X5g info: raw sqlerrm returned to a direct RPC caller', true, v);

  -- X5h overallScore out of range
  v := public.apply_synced_shot(xc2.shot_payload('bbbbbbbb-0000-4000-8000-000000000006', own_permit::text, null, 'scored', '11'));
  perform xc2.record('X5h overallScore=11 rejected (no row)',
    v like 'shot.write_failed:%' and not exists (select 1 from public.shots where id = 'bbbbbbbb-0000-4000-8000-000000000006'), 'result=' || v);

  -- X5i degenerate payloads
  v := public.apply_synced_shot('null'::jsonb);
  perform xc2.record('X5i1 payload null → permit_not_found (no id, no permit)', v = 'access.permit_not_found', 'result=' || v);
  v := public.apply_synced_shot('[]'::jsonb);
  perform xc2.record('X5i2 payload [] → permit_not_found', v = 'access.permit_not_found', 'result=' || v);
  v := public.apply_synced_shot('{}'::jsonb);
  perform xc2.record('X5i3 payload {} → permit_not_found', v = 'access.permit_not_found', 'result=' || v);
  v := public.apply_synced_shot(jsonb_build_object('analysisPermitId', ids.alice_reserved_permit));
  perform xc2.record('X5i4 alice''s permit with no id → permit_not_found (not an oracle)', v = 'access.permit_not_found', 'result=' || v);

  -- X5j the permit id of a DIFFERENT user is indistinguishable from a random
  -- uuid: both must yield the same code.
  v := public.apply_synced_shot(xc2.shot_payload('bbbbbbbb-0000-4000-8000-000000000007', 'ffffffff-ffff-4fff-8fff-ffffffffffff', null, 'scored', '6.5'));
  perform xc2.record('X5j random permit uuid → same code as alice''s permit (permit_not_found)', v = 'access.permit_not_found', 'result=' || v);

  after := xc2.snapshot(ids.alice);
  perform xc2.record('X5k alice''s rows byte-identical after every X5 probe', before = after, 'snapshot_changed=' || (before <> after));
  perform xc2.record('X5l alice''s identity ledger unchanged by bob''s probes',
    xc2.ledger_count('google', 'xc2-google-alice') = ledger_alice_before,
    'alice_ledger=' || xc2.ledger_count('google', 'xc2-google-alice'));
  perform xc2.record('X5m no orphan rows under any unknown user_id', xc2.orphan_rows(array[ids.alice, ids.bob, ids.carol]) = 0,
    'orphans=' || xc2.orphan_rows(array[ids.alice, ids.bob, ids.carol]));
end $$;
reset role;

-- ═══════════ X6: definer TRIGGERS fed hostile row data ══════════════════════

-- X6a handle_new_user(): a fresh auth.users row whose metadata carries
-- Alice's id / email must provision ONLY its own profile.
do $$
declare before text; after text;
begin
  before := xc2.snapshot((select alice from xc2.ids));
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('44444444-4444-4444-8444-444444444444', 'dave@example.com',
          jsonb_build_object('full_name', 'Dave', 'id', '11111111-1111-4111-8111-111111111111', 'sub', 'xc2-google-alice', 'email', 'alice@example.com'),
          '{"provider":"google"}');
  after := xc2.snapshot((select alice from xc2.ids));
  perform xc2.record('X6a handle_new_user with alice-shaped metadata provisions only the new id',
    before = after
      and exists (select 1 from public.profiles where id = '44444444-4444-4444-8444-444444444444')
      and (select count(*) from public.profiles where id = (select alice from xc2.ids)) = 1,
    'alice_snapshot_changed=' || (before <> after));
end $$;

-- X6b the ledger trigger (definer) attributes a scored shot ONLY to the
-- identities of the row's user_id — a service-role insert for Dave (no
-- identity row yet) touches no ledger; giving Dave an identity then scoring
-- again writes only Dave's hash. Alice's count stays 1 throughout.
do $$
declare alice_before int; total_before int; total_after int;
begin
  alice_before := xc2.ledger_count('google', 'xc2-google-alice');
  total_before := (select count(*) from public.free_rating_ledger);
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
    phase_model_version, scoring_model_version, shot_config_version
  ) values (
    'dddddddd-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', 'drive', now(), 0, 1000, 5.0, 0.9, 'scored',
    '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
  total_after := (select count(*) from public.free_rating_ledger);
  perform xc2.record('X6b1 scored insert for an identity-less user writes no ledger row and leaves alice at 1',
    total_after = total_before and xc2.ledger_count('google', 'xc2-google-alice') = alice_before,
    format('ledger_rows %s→%s alice=%s', total_before, total_after, xc2.ledger_count('google', 'xc2-google-alice')));

  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values ('google', 'xc2-google-dave', '44444444-4444-4444-8444-444444444444', '{"sub":"xc2-google-dave"}');
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version, stroke_detector_version,
    phase_model_version, scoring_model_version, shot_config_version
  ) values (
    'dddddddd-0000-4000-8000-000000000002', '44444444-4444-4444-8444-444444444444', 'drive', now(), 0, 1000, 5.0, 0.9, 'scored',
    '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1');
  perform xc2.record('X6b2 scored insert writes ONLY the row owner''s identity hash',
    xc2.ledger_count('google', 'xc2-google-dave') = 1 and xc2.ledger_count('google', 'xc2-google-alice') = alice_before
      and xc2.ledger_count('apple', 'xc2-apple-bob') = (select count(*) from public.shots where user_id = (select bob from xc2.ids) and result_kind = 'scored'),
    format('dave=%s alice=%s bob=%s', xc2.ledger_count('google', 'xc2-google-dave'), xc2.ledger_count('google', 'xc2-google-alice'), xc2.ledger_count('apple', 'xc2-apple-bob')));
end $$;

-- X6c rank refresh trigger: Dave's inserts recomputed Dave only; Alice's
-- saved rank row is byte-identical to setup.
do $$
begin
  perform xc2.record('X6c rank trigger recomputed only the inserting row''s user',
    exists (select 1 from public.player_rank_state where user_id = '44444444-4444-4444-8444-444444444444')
      and (select rating from public.player_rank_state where user_id = (select alice from xc2.ids)) = 7.10,
    'alice_rating=' || (select rating from public.player_rank_state where user_id = (select alice from xc2.ids)));
end $$;

-- X6d the ledger trigger on UPDATE OF result_kind: a client has no UPDATE
-- grant on shots at all (E1 pins that); here we check the trigger itself
-- does not double-count when a superuser flips low_confidence→scored→scored.
do $$
declare before int;
begin
  before := xc2.ledger_count('google', 'xc2-google-dave');
  begin
    update public.shots set result_kind = 'scored' where id = 'dddddddd-0000-4000-8000-000000000002';
    perform xc2.record('X6d scored→scored UPDATE does not increment the ledger', xc2.ledger_count('google', 'xc2-google-dave') = before,
      format('dave %s→%s', before, xc2.ledger_count('google', 'xc2-google-dave')));
  exception when others then
    perform xc2.record('X6d scored→scored UPDATE does not increment the ledger', true, 'update refused for every role: ' || sqlstate || ' ' || left(sqlerrm, 120));
  end;
end $$;

-- ═══════════ X7: seeded, replayable fuzz over the RPC parameter surface ═════

-- Bob becomes premium so scored writes clear the free limit and the fuzz
-- reaches the atomic write block / permit finalize / ledger / rank paths.
insert into public.billing_entitlements (user_id, premium)
values ('22222222-2222-4222-8222-222222222222', true);

set local role authenticated;
set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
do $$
declare
  ids record;
  seed double precision := 0.20260904;
  iterations int := 2000;
  i int;
  mutation text;
  p jsonb;
  v text;
  st text;
  own_permit uuid;
  r record;
  before text; after text;
  alice_ledger_before int;
  ok boolean;
  problems text;
  known uuid[];
  accepted_ids uuid[] := '{}';
  new_id text;
  mutations text[] := array[
    'foreign_reserved_permit', 'foreign_finalized_permit', 'foreign_session', 'foreign_shot_id',
    'foreign_shot_id_and_permit', 'malformed_id', 'malformed_permit', 'malformed_session',
    'result_kind_upper', 'result_kind_garbage', 'score_high', 'score_negative', 'score_string',
    'foreign_owner_keys', 'null_payload', 'array_payload', 'empty_object', 'empty_session_string',
    'oversized_shot_type', 'bogus_band', 'negative_ms', 'valid_scored', 'valid_low_confidence',
    'replay_own_accepted', 'reserve_alice_key_variant', 'random_permit_uuid', 'foreign_permit_low_confidence'
  ];
  fk int;
begin
  select * into ids from xc2.ids;
  known := array[ids.alice, ids.bob, ids.carol, '44444444-4444-4444-8444-444444444444'::uuid];
  perform setseed(seed);
  alice_ledger_before := xc2.ledger_count('google', 'xc2-google-alice');

  for i in 1..iterations loop
    -- Keep Bob holding exactly one reserved permit of his own.
    select id into own_permit from public.analysis_permits
    where user_id = ids.bob and status = 'reserved' order by created_at desc, id limit 1;
    if own_permit is null then
      select * into r from public.reserve_analysis_permit('fuzz-' || i);
      if r.result <> 'accepted' then
        perform xc2.record('X7 setup: premium bob could not reserve at iteration ' || i, false, r.result);
        exit;
      end if;
      own_permit := r.permit_id;
    end if;

    mutation := mutations[1 + floor(random() * array_length(mutations, 1))::int];
    new_id := format('bbbbbbbb-f000-4000-8000-%s', lpad(to_hex(i), 12, '0'));
    before := xc2.snapshot(ids.alice);
    v := null; st := null;

    p := case mutation
      when 'foreign_reserved_permit'  then xc2.shot_payload(new_id, ids.alice_reserved_permit::text, null, 'scored', '6.5')
      when 'foreign_finalized_permit' then xc2.shot_payload(new_id, ids.alice_finalized_permit::text, null, 'scored', '6.5')
      when 'foreign_session'          then xc2.shot_payload(new_id, own_permit::text, ids.alice_session::text, 'scored', '6.5')
      when 'foreign_shot_id'          then xc2.shot_payload(ids.alice_shot::text, own_permit::text, null, 'scored', '6.5')
      when 'foreign_shot_id_and_permit' then xc2.shot_payload(ids.alice_shot::text, ids.alice_reserved_permit::text, ids.alice_session::text, 'scored', '6.5')
      when 'malformed_id'             then xc2.shot_payload('x' || i, own_permit::text, null, 'scored', '6.5')
      when 'malformed_permit'         then xc2.shot_payload(new_id, 'permit-' || i, null, 'scored', '6.5')
      when 'malformed_session'        then xc2.shot_payload(new_id, own_permit::text, 'session-' || i, 'scored', '6.5')
      when 'result_kind_upper'        then xc2.shot_payload(new_id, own_permit::text, null, 'SCORED', '6.5')
      when 'result_kind_garbage'      then xc2.shot_payload(new_id, own_permit::text, null, 'scored; drop table shots', '6.5')
      when 'score_high'               then xc2.shot_payload(new_id, own_permit::text, null, 'scored', (10 + random() * 1000)::text)
      when 'score_negative'           then xc2.shot_payload(new_id, own_permit::text, null, 'scored', (-random() * 1000)::text)
      when 'score_string'             then xc2.shot_payload(new_id, own_permit::text, null, 'scored', 'ten')
      when 'foreign_owner_keys'       then jsonb_set(jsonb_set(
                                             xc2.shot_payload(new_id, own_permit::text, null, 'scored', '6.5')
                                               || jsonb_build_object('user_id', ids.alice, 'userId', ids.alice, 'uid', ids.alice),
                                             '{phases,0,user_id}', to_jsonb(ids.alice::text)),
                                             '{checkpoints,0,user_id}', to_jsonb(ids.alice::text))
      when 'null_payload'             then 'null'::jsonb
      when 'array_payload'            then jsonb_build_array(xc2.shot_payload(new_id, ids.alice_reserved_permit::text, null, 'scored', '6.5'))
      when 'empty_object'             then '{}'::jsonb
      when 'empty_session_string'     then xc2.shot_payload(new_id, own_permit::text, '', 'low_confidence', null)
      when 'oversized_shot_type'      then jsonb_set(xc2.shot_payload(new_id, own_permit::text, null, 'scored', '6.5'), '{shotType}', to_jsonb(repeat('x', 5000)))
      when 'bogus_band'               then jsonb_set(xc2.shot_payload(new_id, own_permit::text, null, 'scored', '6.5'), '{checkpoints,0,band}', '"purple"'::jsonb)
      when 'negative_ms'              then jsonb_set(xc2.shot_payload(new_id, own_permit::text, null, 'scored', '6.5'), '{startMs}', '-5'::jsonb)
      when 'valid_scored'             then xc2.shot_payload(new_id, own_permit::text, null, 'scored', round((random() * 10)::numeric, 1)::text)
      when 'valid_low_confidence'     then xc2.shot_payload(new_id, own_permit::text, null, 'low_confidence', null)
      when 'replay_own_accepted'      then xc2.shot_payload(coalesce(accepted_ids[1]::text, new_id), own_permit::text, null, 'scored', '6.5')
      when 'reserve_alice_key_variant' then null
      when 'random_permit_uuid'       then xc2.shot_payload(new_id, gen_random_uuid()::text, null, 'scored', '6.5')
      when 'foreign_permit_low_confidence' then xc2.shot_payload(new_id, ids.alice_reserved_permit::text, null, 'low_confidence', null)
    end;

    begin
      if mutation = 'reserve_alice_key_variant' then
        fk := 1 + floor(random() * 3)::int;
        select * into r from public.reserve_analysis_permit(
          case fk when 1 then 'alice-key-reserved' when 2 then 'alice-key-finalized' else ids.alice_reserved_permit::text end);
        v := r.result || ' permit_id=' || coalesce(r.permit_id::text, 'null');
        p := jsonb_build_object('reserve_key_variant', fk);
        -- Any permit returned must be Bob's own, never one of Alice's ids.
        if r.permit_id is not null and (r.permit_id = ids.alice_reserved_permit or r.permit_id = ids.alice_finalized_permit) then
          v := v || ' RETURNED_ALICE_PERMIT';
        end if;
      else
        v := public.apply_synced_shot(p);
      end if;
    exception when others then
      st := sqlstate;
      v := 'RAISED ' || sqlstate || ' ' || left(sqlerrm, 160);
    end;

    -- Track Bob's accepted ids for later replay probes.
    if v = 'accepted' and mutation in ('valid_scored', 'valid_low_confidence', 'foreign_owner_keys', 'empty_session_string') then
      accepted_ids := array_append(accepted_ids, new_id::uuid);
    end if;

    after := xc2.snapshot(ids.alice);
    problems := '';
    if before <> after then problems := problems || 'ALICE_ROWS_CHANGED;'; end if;
    if xc2.ledger_count('google', 'xc2-google-alice') <> alice_ledger_before then problems := problems || 'ALICE_LEDGER_CHANGED;'; end if;
    if xc2.orphan_rows(known) <> 0 then problems := problems || 'ORPHAN_ROWS;'; end if;
    if v like '%RETURNED_ALICE_PERMIT%' then problems := problems || 'FOREIGN_PERMIT_RETURNED;'; end if;
    -- Per-mutation contract on the return value.
    ok := case mutation
      when 'foreign_reserved_permit'  then v = 'access.permit_not_found'
      when 'foreign_finalized_permit' then v = 'access.permit_not_found'
      when 'foreign_permit_low_confidence' then v = 'access.permit_not_found'
      when 'random_permit_uuid'       then v = 'access.permit_not_found'
      when 'foreign_session'          then v = 'shot.session_not_found'
      when 'foreign_shot_id'          then v = 'shot.id_conflict'
      when 'foreign_shot_id_and_permit' then v = 'access.permit_not_found'
      when 'malformed_id'             then st = '22P02'
      when 'malformed_permit'         then st = '22P02'
      when 'malformed_session'        then st = '22P02'
      when 'result_kind_upper'        then v like 'shot.write_failed:%'
      when 'result_kind_garbage'      then v like 'shot.write_failed:%'
      when 'score_high'               then v like 'shot.write_failed:%'
      when 'score_negative'           then v like 'shot.write_failed:%'
      when 'score_string'             then v like 'shot.write_failed:%'
      when 'oversized_shot_type'      then v like 'shot.write_failed:%'
      when 'bogus_band'               then v like 'shot.write_failed:%'
      -- shots has no CHECK on start_ms (the Edge fn's isMs() is the only gate);
      -- either outcome is recorded, neither is an isolation failure.
      when 'negative_ms'              then v = 'accepted' or v like 'shot.write_failed:%'
      when 'foreign_owner_keys'       then v = 'accepted'
      when 'null_payload'             then v = 'access.permit_not_found'
      when 'array_payload'            then v = 'access.permit_not_found'
      when 'empty_object'             then v = 'access.permit_not_found'
      when 'empty_session_string'     then v = 'accepted'
      when 'valid_scored'             then v = 'accepted'
      when 'valid_low_confidence'     then v = 'accepted'
      when 'replay_own_accepted'      then v = 'accepted'
      when 'reserve_alice_key_variant' then v like 'accepted permit_id=%' and v not like '%RETURNED_ALICE_PERMIT%'
    end;
    if not coalesce(ok, false) then problems := problems || 'RESULT_OUTSIDE_CONTRACT;'; end if;
    -- A foreign_owner_keys write must land under Bob (not Alice).
    if mutation = 'foreign_owner_keys' and v = 'accepted'
       and not exists (select 1 from public.shots where id = new_id::uuid and user_id = ids.bob) then
      problems := problems || 'FOREIGN_OWNER_KEY_HONOURED;';
    end if;

    perform xc2.record_fuzz(seed, i, ids.bob, ids.alice, mutation, p, v, st, problems = '', problems);
  end loop;

  perform xc2.record('X7 fuzz: ' || iterations || ' seeded iterations, seed ' || seed,
    xc2.fuzz_failures() = 0,
    format('failures=%s accepted_by_bob=%s alice_ledger=%s bob_ledger=%s',
      xc2.fuzz_failures(), coalesce(array_length(accepted_ids, 1), 0),
      xc2.ledger_count('google', 'xc2-google-alice'), xc2.ledger_count('apple', 'xc2-apple-bob')));
end $$;
reset role;

-- Post-fuzz cross-checks from the superuser vantage point.
do $$
declare ids record; bob_scored int;
begin
  select * into ids from xc2.ids;
  bob_scored := (select count(*) from public.shots where user_id = ids.bob and result_kind = 'scored');
  perform xc2.record('X7b bob''s identity ledger equals bob''s scored shots (trigger attributed every write to him)',
    xc2.ledger_count('apple', 'xc2-apple-bob') = bob_scored,
    format('bob_ledger=%s bob_scored=%s', xc2.ledger_count('apple', 'xc2-apple-bob'), bob_scored));
  perform xc2.record('X7c alice''s identity ledger still 1', xc2.ledger_count('google', 'xc2-google-alice') = 1,
    'alice_ledger=' || xc2.ledger_count('google', 'xc2-google-alice'));
  perform xc2.record('X7d alice''s reserved permit still reserved, finalized still finalized',
    (select status from public.analysis_permits where id = ids.alice_reserved_permit) = 'reserved'
      and (select status from public.analysis_permits where id = ids.alice_finalized_permit) = 'finalized',
    format('reserved=%s finalized=%s',
      (select status from public.analysis_permits where id = ids.alice_reserved_permit),
      (select status from public.analysis_permits where id = ids.alice_finalized_permit)));
  perform xc2.record('X7e alice''s rank row unchanged (7.10)',
    (select rating from public.player_rank_state where user_id = ids.alice) = 7.10,
    'alice_rating=' || (select rating from public.player_rank_state where user_id = ids.alice));
  perform xc2.record('X7f every shot/phase/checkpoint/permit/session row belongs to a cast member',
    xc2.orphan_rows(array[ids.alice, ids.bob, ids.carol, '44444444-4444-4444-8444-444444444444'::uuid]) = 0, 'orphans=' ||
    xc2.orphan_rows(array[ids.alice, ids.bob, ids.carol, '44444444-4444-4444-8444-444444444444'::uuid]));
end $$;

-- ───────────────────────────── artifacts + verdict ─────────────────────────

-- Unaligned tuples-only output writes the JSON verbatim (COPY's text format
-- would backslash-escape the quotes inside the payloads).
\pset tuples_only on
\pset format unaligned
\o /tmp/xc2_definer_results.json
select json_agg(json_build_object('seq', seq, 'case', case_id, 'passed', passed, 'detail', detail) order by seq) from xc2.results;
\o
\o /tmp/xc2_definer_fuzz.json
select json_agg(json_build_object('seed', seed, 'iteration', iteration, 'attacker', attacker, 'victim', victim, 'mutation', mutation, 'payload', payload, 'result', result, 'sqlstate', sqlstate, 'passed', passed, 'problems', problems) order by seq) from xc2.fuzz;
\o
\o /tmp/xc2_definer_fuzz_matrix.json
select json_agg(json_build_object('mutation', mutation, 'n', n, 'failed', failed, 'results', results) order by mutation) from (select mutation, count(*) as n, count(*) filter (where not passed) as failed, json_object_agg(res, cnt) as results from (select mutation, passed, coalesce(sqlstate, split_part(result, ':', 1)) as res, count(*) as cnt from xc2.fuzz group by 1, 2, 3) s group by mutation) m;
\o
\pset format aligned
\pset tuples_only off

\set QUIET off
select case_id, passed, left(detail, 140) as detail from xc2.results order by seq;
select mutation, count(*) as n, count(*) filter (where not passed) as failed,
       string_agg(distinct coalesce(sqlstate, split_part(result, ':', 1)), ' | ') as results
from xc2.fuzz group by mutation order by mutation;
\set QUIET on

do $$
declare failed int; names text;
begin
  select count(*), string_agg(case_id, E'\n  ') into failed, names from xc2.results where not passed;
  if failed > 0 then
    raise exception 'XC2 DEFINER SURFACE: % case(s) FAILED:%  %', failed, E'\n', names;
  end if;
end $$;

rollback;

\echo XC2 DEFINER SURFACE: ALL CASES PASSED
