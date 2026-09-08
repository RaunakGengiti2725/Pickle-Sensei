-- W06-03 ADVERSARIAL (candidate 0dc89d1c): definition_version on the SQL rank
-- plane, attacked at its boundaries. Companion to scoring_parity.sql; runs
-- standalone against a database with every migration applied:
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/w06_03_attack_scoring_definition.sql
--
-- Sections (each `raise exception 'ATTACK-…'` is a confirmed break):
--   R  live role matrix: a signed-in player reads ONLY their own rank and
--      version, never writes derived state, never calls the version or
--      recompute functions; anon reads nothing;
--   L  label domain: the stamp refuses NULL and '' (candidate) — and what it
--      still admits (whitespace / control characters);
--   T  tier floors at the exact thresholds the shared definition pins
--      (3.5 / 5 / 6.5 / 7.5), through recompute, not just player_rank_tier;
--   D  delete / cascade paths: the row follows the evidence (one of two rows
--      deleted → recomputed + restamped; profile deleted → row gone);
--   V  the view's version literal equals the function on every path; a
--      version row exists iff a rank row exists (no half state).
\set ON_ERROR_STOP on
begin;

-- Confirmed breaks accumulate here; the file fails at the end if any exist,
-- so every section runs and the summary lists them all.
create temp table attack_breaks (section text, detail text) on commit drop;

create function pg_temp.new_player()
returns uuid
language plpgsql
as $$
declare
  v_user uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_user, v_user::text || '@attack.example');
  return v_user;
end $$;

create function pg_temp.store(p_user uuid, p_id uuid, p_type text, p_score numeric, p_at timestamptz)
returns void
language plpgsql
as $$
begin
  insert into public.shots
    (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
     overall_score, analysis_confidence, result_kind, source,
     app_version, model_bundle_version, pose_model_version, paddle_model_version,
     stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
  values (p_id, p_user, p_type, 'side', p_at, 0, 100, 200, p_score, 0.9, 'scored', 'real',
          '1', '1', '1', '1', '1', '1', '1', '1');
end $$;

-- ── R. Live role matrix ────────────────────────────────────────────────────
create temp table attack_users on commit drop as
  select pg_temp.new_player() as a, pg_temp.new_player() as b;
-- the ids as settings, readable after `set role` (the temp table is not)
select set_config('attack.a', a::text, true), set_config('attack.b', b::text, true) from attack_users;

do $$
declare
  u record;
begin
  select * into u from attack_users;
  perform pg_temp.store(u.a, '0a000000-0000-4000-8000-00000000000a', 'dink', 6.00, '2026-05-01T10:00:00Z');
  perform pg_temp.store(u.b, '0b000000-0000-4000-8000-00000000000b', 'dink', 9.00, '2026-05-01T10:00:00Z');
end $$;

do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('attack.a'), true);

do $$
declare
  u record;
  v_rows int;
begin
  select current_setting('attack.a')::uuid as a, current_setting('attack.b')::uuid as b into u;
  -- own rank + version readable
  if (select count(*) from public.player_rank_state) <> 1
     or (select definition_version from public.player_rank_state) <> 'rank-form-weighted-v2' then
    raise exception 'ATTACK-R1: a signed-in player must read exactly their own labelled rank';
  end if;
  if (select count(*) from public.player_technique_rating) <> 1
     or (select count(*) from public.player_technique_rating where user_id = u.b) <> 0 then
    raise exception 'ATTACK-R2: the version view leaks another player''s technique rows';
  end if;
  if exists (select 1 from public.player_rank_state where user_id = u.b) then
    raise exception 'ATTACK-R3: another player''s saved rank is visible';
  end if;
  -- no writes to derived state
  begin
    update public.player_rank_state set definition_version = 'rank-attacker-v9' where user_id = u.a;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      raise exception 'ATTACK-R4: a client rewrote its own definition_version';
    end if;
    raise exception 'ATTACK-R4: a client UPDATE on player_rank_state was not refused';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.player_rank_state
      (user_id, rating, tier, technique_count, scored_shot_count, definition_version)
    values (u.a, 9.99, 'diamond', 1, 1, 'rank-form-weighted-v2');
    raise exception 'ATTACK-R5: a client inserted a saved rank';
  exception when insufficient_privilege or unique_violation then null;
  end;
  begin
    delete from public.player_rank_state where user_id = u.a;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      raise exception 'ATTACK-R6: a client deleted its saved rank';
    end if;
    raise exception 'ATTACK-R6: a client DELETE on player_rank_state was not refused';
  exception when insufficient_privilege then null;
  end;
  -- no execution of the definition plumbing
  begin
    perform public.scoring_definition_version();
    raise exception 'ATTACK-R7: a client may call scoring_definition_version()';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.recompute_player_rank(u.b);
    raise exception 'ATTACK-R8: a client may recompute another player''s rank';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.recompute_player_rank(u.a);
    raise exception 'ATTACK-R9: a client may recompute their own rank';
  exception when insufficient_privilege then null;
  end;
end $$;

-- the same player WITHOUT the API header: derived state is invisible
select set_config('request.headers', '', true);
do $$
begin
  if exists (select 1 from public.player_rank_state) or exists (select 1 from public.player_technique_rating) then
    raise exception 'ATTACK-R10: rank/version rows are readable outside an API request';
  end if;
end $$;

reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.player_rank_state;
    raise exception 'ATTACK-R11: anon can read player_rank_state';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.player_technique_rating;
    raise exception 'ATTACK-R12: anon can read player_technique_rating';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.scoring_definition_version();
    raise exception 'ATTACK-R13: anon can call scoring_definition_version()';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
-- back to an owner session: no JWT subject (the transaction-local claim
-- would otherwise make every later owner insert look like a client write)
select set_config('request.jwt.claim.sub', '', true);

-- ── L. Label domain ────────────────────────────────────────────────────────
do $$
declare
  u record;
  v_admitted text[] := '{}';
  v_label text;
begin
  select * into u from attack_users;
  foreach v_label in array array[' ', E'\t', E'\n', '   ', chr(1), 'rank-form-weighted-v2' || chr(1), E'\u200b'] loop
    begin
      update public.player_rank_state set definition_version = v_label where user_id = u.a;
      v_admitted := v_admitted || format('%L', v_label);
    exception when check_violation or not_null_violation or character_not_in_repertoire or untranslatable_character then
      null;
    end;
  end loop;
  -- restore
  perform public.recompute_player_rank(u.a);
  if array_length(v_admitted, 1) > 0 then
    insert into attack_breaks values ('L1',
      'player_rank_state_definition_version_nonempty admits blank/control labels: '
      || array_to_string(v_admitted, ', '));
  end if;
end $$;

-- ── T. Tier floors through recompute at the exact thresholds ───────────────
-- scoringDefinition.ts tiers: bronze ≥0, silver ≥3.5, gold ≥5, platinum ≥6.5,
-- diamond ≥7.5. One scored analysis → technique score = that score → rating.
do $$
declare
  v_case record;
  v_user uuid;
  v_state public.player_rank_state%rowtype;
begin
  for v_case in
    select * from (values
      (0.00::numeric, 'bronze'), (3.49, 'bronze'), (3.50, 'silver'), (4.99, 'silver'),
      (5.00, 'gold'), (6.49, 'gold'), (6.50, 'platinum'), (7.49, 'platinum'),
      (7.50, 'diamond'), (10.00, 'diamond')) t(score, tier)
  loop
    v_user := pg_temp.new_player();
    perform pg_temp.store(v_user, gen_random_uuid(), 'serve', v_case.score, '2026-05-02T10:00:00Z');
    select * into v_state from public.player_rank_state where user_id = v_user;
    if v_state.user_id is null then
      insert into attack_breaks values ('T1', format('score %s produced no saved rank', v_case.score));
    elsif v_state.rating <> v_case.score or v_state.tier <> v_case.tier
       or v_state.definition_version <> public.scoring_definition_version() then
      insert into attack_breaks values ('T1', format('score %s → %s/%s/%s, expected %s/%s',
        v_case.score, v_state.rating, v_state.tier, v_state.definition_version, v_case.score, v_case.tier));
    end if;
  end loop;
  -- half-away rounding lands ON a floor: 3.495 is not representable in
  -- numeric(4,2); the wire text '3.495' must become 3.50 → silver on every plane
  v_user := pg_temp.new_player();
  perform pg_temp.store(v_user, gen_random_uuid(), 'serve', '3.495'::numeric, '2026-05-02T10:00:00Z');
  select * into v_state from public.player_rank_state where user_id = v_user;
  if v_state.rating <> 3.50 or v_state.tier <> 'silver' then
    insert into attack_breaks values ('T2', format('3.495 → %s/%s', v_state.rating, v_state.tier));
  end if;
  -- weighted average exactly at a floor: 7 (x8) + 8 (x7) → 105600/15 = 7040 → 70.40? no:
  -- (8*700 + 7*800) / 15 = 11200/15 = 746.67 → 7.47 platinum; and 8,7 order
  -- reversed: (8*800 + 7*700) / 15 = 11300/15 = 753.33 → 7.53 diamond.
  v_user := pg_temp.new_player();
  perform pg_temp.store(v_user, gen_random_uuid(), 'serve', 8, '2026-05-02T10:00:00Z');
  perform pg_temp.store(v_user, gen_random_uuid(), 'serve', 7, '2026-05-02T10:00:01Z');
  select * into v_state from public.player_rank_state where user_id = v_user;
  if v_state.rating <> 7.47 or v_state.tier <> 'platinum' then
    insert into attack_breaks values ('T3', format('8 then 7 → %s/%s, expected 7.47/platinum', v_state.rating, v_state.tier));
  end if;
  v_user := pg_temp.new_player();
  perform pg_temp.store(v_user, gen_random_uuid(), 'serve', 7, '2026-05-02T10:00:00Z');
  perform pg_temp.store(v_user, gen_random_uuid(), 'serve', 8, '2026-05-02T10:00:01Z');
  select * into v_state from public.player_rank_state where user_id = v_user;
  if v_state.rating <> 7.53 or v_state.tier <> 'diamond' then
    insert into attack_breaks values ('T3', format('7 then 8 → %s/%s, expected 7.53/diamond', v_state.rating, v_state.tier));
  end if;
end $$;

-- ── D. Delete / cascade paths ──────────────────────────────────────────────
do $$
declare
  v_user uuid := pg_temp.new_player();
  v_state public.player_rank_state%rowtype;
  v_updated timestamptz;
begin
  perform pg_temp.store(v_user, '0d000000-0000-4000-8000-000000000001', 'dink', 4, '2026-05-03T10:00:00Z');
  perform pg_temp.store(v_user, '0d000000-0000-4000-8000-000000000002', 'serve', 8, '2026-05-03T10:00:01Z');
  select * into v_state from public.player_rank_state where user_id = v_user;
  if v_state.rating <> 6.00 or v_state.technique_count <> 2 or v_state.scored_shot_count <> 2 then
    insert into attack_breaks values ('D0', format('two rows → %s', v_state));
  end if;
  -- forge a foreign label, then delete one row: the survivor must be
  -- recomputed AND restamped (a stale label on fresh numbers is a lie)
  update public.player_rank_state set definition_version = 'rank-attack-legacy' where user_id = v_user;
  delete from public.shots where id = '0d000000-0000-4000-8000-000000000002';
  select * into v_state from public.player_rank_state where user_id = v_user;
  if v_state.rating <> 4.00 or v_state.technique_count <> 1 or v_state.scored_shot_count <> 1
     or v_state.definition_version <> public.scoring_definition_version() then
    insert into attack_breaks values ('D1', format('delete left %s', v_state));
  end if;
  -- update of the surviving row's score recomputes + restamps
  update public.player_rank_state set definition_version = 'rank-attack-legacy' where user_id = v_user;
  update public.shots set overall_score = 9 where id = '0d000000-0000-4000-8000-000000000001';
  select * into v_state from public.player_rank_state where user_id = v_user;
  if v_state.rating <> 9.00 or v_state.definition_version <> public.scoring_definition_version() then
    insert into attack_breaks values ('D2', format('score update left %s', v_state));
  end if;
  -- demoting the last scored row to an abstention removes the rank entirely
  update public.shots set result_kind = 'low_confidence', overall_score = null
    where id = '0d000000-0000-4000-8000-000000000001';
  if exists (select 1 from public.player_rank_state where user_id = v_user) then
    insert into attack_breaks values ('D3', 'a saved rank survives with no countable evidence');
  end if;
  if exists (select 1 from public.player_technique_rating where user_id = v_user) then
    insert into attack_breaks values ('D3', 'the view ranks an abstention');
  end if;
  -- re-scoring brings it back, stamped
  update public.shots set result_kind = 'scored', overall_score = 2
    where id = '0d000000-0000-4000-8000-000000000001';
  select * into v_state from public.player_rank_state where user_id = v_user;
  if v_state.rating <> 2.00 or v_state.definition_version <> public.scoring_definition_version() then
    insert into attack_breaks values ('D4', format('re-score left %s', v_state));
  end if;
  -- the table admits only source = 'real' (shots_source_check), so a
  -- non-countable source cannot reach the plane at all
  begin
    update public.shots set source = 'sample' where id = '0d000000-0000-4000-8000-000000000001';
    insert into attack_breaks values ('D5', 'a non-real source row was stored');
  exception when check_violation then null;
  end;
  -- account deletion cascades the saved rank
  delete from public.profiles where id = v_user;
  if exists (select 1 from public.player_rank_state where user_id = v_user) then
    insert into attack_breaks values ('D6', 'saved rank survives profile deletion');
  end if;
end $$;

-- ── V. View literal == function; no half state ─────────────────────────────
do $$
declare
  v_user uuid := pg_temp.new_player();
  v_view_def text := pg_get_viewdef('public.player_technique_rating'::regclass);
begin
  perform pg_temp.store(v_user, gen_random_uuid(), 'lob', 5.55, '2026-05-04T10:00:00Z');
  if (select definition_version from public.player_technique_rating where user_id = v_user)
     is distinct from public.scoring_definition_version() then
    insert into attack_breaks values ('V1', 'view version differs from scoring_definition_version()');
  end if;
  if position('scoring_definition_version()' in v_view_def) = 0 then
    insert into attack_breaks values ('V2',
      'player_technique_rating hard-codes the version literal instead of calling '
      || 'public.scoring_definition_version(): two sources of truth for the label');
  end if;
  -- every saved row is reproducible from its evidence under the label it carries
  insert into attack_breaks
  select 'V3', format('saved %s/%s/%s but v2 computes %s from %s technique rows (%s shots)',
           s.user_id, s.rating, s.scored_shot_count, live.rating, live.techniques, live.shots)
  from public.player_rank_state s
  cross join lateral (
    select round(sum(v.confidence_weight * round(v.score * 100)) / sum(v.confidence_weight)) / 100.0 as rating,
           count(*) as techniques,
           (select count(*) from public.shots x where x.user_id = s.user_id) as shots
    from public.player_technique_rating v where v.user_id = s.user_id) live
  where s.definition_version = public.scoring_definition_version()
    and s.rating is distinct from live.rating;
  if exists (
    select 1 from public.player_rank_state s
    where not exists (select 1 from public.player_technique_rating v where v.user_id = s.user_id)
  ) or exists (
    select distinct v.user_id from public.player_technique_rating v
    where not exists (select 1 from public.player_rank_state s where s.user_id = v.user_id)
  ) then
    insert into attack_breaks values ('V4', 'saved rank and technique view disagree on who is ranked');
  end if;
end $$;

-- ── Summary ────────────────────────────────────────────────────────────────
do $$
declare
  v_breaks text;
begin
  select string_agg(format('[%s] %s', section, detail), E'\n' order by section)
    into v_breaks from attack_breaks;
  if v_breaks is not null then
    raise exception E'W06-03 ATTACK: confirmed breaks\n%', v_breaks;
  end if;
end $$;

rollback;
\echo 'W06-03 ATTACK (scoring definition SQL plane): no break'
