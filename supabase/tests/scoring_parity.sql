-- W06-03: the golden scoring fixture through the SQL rank plane.
--
-- packages/shared-types/fixtures/scoring/player-rank.golden.json pins the
-- outputs of the canonical scoring definition
-- (packages/shared-types/src/scoringDefinition.ts, `definitionVersion`).
-- This file feeds every fixture row through the shipping SQL path — an
-- owner insert into public.shots → shots_player_rank_refresh →
-- public.recompute_player_rank → public.player_rank_state, read back with
-- public.player_technique_rating — and demands the identical projection the
-- fixture expects, including the definition version the plane computed
-- under. run_rls_tests.sh passes the fixture path as :golden_fixture.
--
-- Sections:
--   A  the fixture and the SQL plane name the same scoring definition;
--   B  every ranked/unranked case reproduces bit for bit;
--   C  every replay case stores exactly the first storable arrival per id;
--   D  every rejected input is refused by exactly the SQL check it names,
--      or stored when it names none;
--   E  a saved row computed under another definition is never rewritten by
--      anything but new evidence for that player.
\set ON_ERROR_STOP on
begin;

-- The fixture as `json` (jsonb refuses \u0000 outright, and json's text
-- operators refuse any object containing it). The one row carrying U+0000
-- is fed to Postgres as the bytes a driver would send — see
-- pg_temp.golden_text — so the raw escape is mapped to U+E000 (private use,
-- provably absent from the fixture) only while the document is parsed.
create temp table golden on commit drop as
  select replace(raw, '\u0000', '\ue000')::json as doc
  from (select pg_read_file(:'golden_fixture') as raw) source
  where position('\ue000' in raw) = 0
    and position('\uE000' in raw) = 0
    and position(chr(57344) in raw) = 0;

do $$
begin
  if (select count(*) from golden) <> 1 then
    raise exception 'PARITY: golden fixture unreadable or already uses U+E000';
  end if;
end $$;

-- A fixture string, as the bytes the sync wire would carry: U+E000 stands
-- for the escaped U+0000, which UTF-8 text cannot hold — convert_from
-- refuses it with sqlstate 22021 exactly as the wire does.
create function pg_temp.golden_text(a json, k text)
returns text
language plpgsql
as $$
declare
  v text := a ->> k;
  b bytea;
  p int;
begin
  if v is null or position(chr(57344) in v) = 0 then
    return v;
  end if;
  b := convert_to(v, 'UTF8');
  loop
    p := position('\xee8080'::bytea in b);
    exit when p = 0;
    b := substring(b from 1 for p - 1) || '\x00'::bytea || substring(b from p + 3);
  end loop;
  return convert_from(b, 'UTF8');
end $$;

-- One fixture analysis as the owner writes it (no permit gate, no free
-- limit): the score and the instant are bound as their JSON text so
-- Postgres performs both casts. Returns the constraint (or `sqlstate <code>`)
-- that refused the row, or null when it was stored.
create function pg_temp.store_analysis(p_user uuid, a json)
returns text
language plpgsql
as $$
declare
  v_constraint text;
  v_state text;
begin
  insert into public.shots (
    id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
    overall_score, analysis_confidence, result_kind, source,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
  ) values (
    (a ->> 'id')::uuid, p_user, pg_temp.golden_text(a, 'shotType'), 'side',
    (a ->> 'capturedAt')::text::timestamptz, 0, 100, 200,
    (a ->> 'overallScore')::numeric, 0.9, a ->> 'resultKind',
    -- countability.absentSourceCountsAs: a row without a source is real.
    coalesce(a ->> 'source', 'real'),
    '1', '1', '1', '1', '1', '1', '1', '1'
  );
  return null;
exception when others then
  get stacked diagnostics
    v_constraint = constraint_name,
    v_state = returned_sqlstate;
  return case when v_constraint <> '' then v_constraint else 'sqlstate ' || v_state end;
end $$;

-- The subset of `expected` the SQL plane materialises, from the fixture.
create function pg_temp.expected_projection(e json)
returns jsonb
language sql
as $$
  select case
    when e is null or json_typeof(e) = 'null' then null
    else jsonb_build_object(
      'definitionVersion', e ->> 'definitionVersion',
      'rating', (e ->> 'rating')::numeric,
      'tier', e ->> 'tier',
      'techniqueCount', (e ->> 'techniqueCount')::int,
      'scoredAnalysisCount', (e ->> 'scoredAnalysisCount')::int,
      'techniques', coalesce((
        select jsonb_agg(jsonb_build_object(
          'shotType', t.value ->> 'shotType',
          'score', (t.value ->> 'score')::numeric,
          'capturedAt', t.value ->> 'capturedAt',
          'sampledCount', (t.value ->> 'sampledCount')::int
        ) order by t.ordinality)
        from json_array_elements(e -> 'techniques') with ordinality t
      ), '[]'::jsonb)
    )
  end
$$;

-- The same projection from the SQL plane: the saved row plus the live view
-- in GET /v1/rank order (score desc, shot type by code unit). Null when the
-- player is honestly unranked — in which case the view must be empty too.
create function pg_temp.sql_projection(p_user uuid)
returns jsonb
language plpgsql
as $$
declare
  s record;
  v_techniques jsonb;
  v_rows int;
  v_foreign int;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'shotType', shot_type,
           'score', score,
           'capturedAt', to_char(captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'sampledCount', sampled_count
         ) order by score desc, shot_type collate "C" asc), '[]'::jsonb),
         count(*),
         count(*) filter (where definition_version is distinct from public.scoring_definition_version())
    into v_techniques, v_rows, v_foreign
  from public.player_technique_rating
  where user_id = p_user;
  if v_foreign > 0 then
    raise exception 'PARITY: % live technique rows do not state the current definition', v_foreign;
  end if;
  select * into s from public.player_rank_state where user_id = p_user;
  if not found then
    if v_rows > 0 then
      raise exception 'PARITY: % technique rows without saved rank state', v_rows;
    end if;
    return null;
  end if;
  return jsonb_build_object(
    'definitionVersion', s.definition_version,
    'rating', s.rating,
    'tier', s.tier,
    'techniqueCount', s.technique_count,
    'scoredAnalysisCount', s.scored_shot_count,
    'techniques', v_techniques
  );
end $$;

create function pg_temp.new_player()
returns uuid
language plpgsql
as $$
declare
  v_user uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_user, v_user::text || '@example.com');
  return v_user;
end $$;

-- Fixture cases reuse analysis ids; each case gets a player of its own that
-- is gone (with every shot and saved rank) before the next case starts.
create function pg_temp.forget_player(p_user uuid)
returns void
language plpgsql
as $$
begin
  delete from auth.users where id = p_user;
  if exists (select 1 from public.shots where user_id = p_user)
     or exists (select 1 from public.player_rank_state where user_id = p_user) then
    raise exception 'PARITY: a deleted player left shots or a saved rank behind';
  end if;
end $$;

-- ── A. One definition version ──────────────────────────────────────────────
do $$
declare
  doc json := (select doc from golden);
begin
  if doc ->> 'schemaVersion' <> 'player-rank-golden-v4' then
    raise exception 'PARITY: unexpected golden schema %', doc ->> 'schemaVersion';
  end if;
  if public.scoring_definition_version() is distinct from doc ->> 'definitionVersion' then
    raise exception 'PARITY: SQL computes under % but the golden fixture pins %',
      public.scoring_definition_version(), doc ->> 'definitionVersion';
  end if;
  if exists (
    select 1 from json_array_elements(doc -> 'cases') c
    where json_typeof(c -> 'expected') <> 'null'
      and c -> 'expected' ->> 'definitionVersion' is distinct from doc ->> 'definitionVersion'
  ) then
    raise exception 'PARITY: a golden case expects a definition other than the fixture''s';
  end if;
end $$;

-- ── B. Every case reproduces ───────────────────────────────────────────────
do $$
declare
  doc json := (select doc from golden);
  c json;
  a json;
  v_user uuid;
  v_refusal text;
  v_actual jsonb;
  v_expected jsonb;
  v_cases int := 0;
  v_problems text[] := '{}';
begin
  for c in select value from json_array_elements(doc -> 'cases') loop
    v_cases := v_cases + 1;
    v_user := pg_temp.new_player();
    for a in select value from json_array_elements(c -> 'analyses') loop
      v_refusal := pg_temp.store_analysis(v_user, a);
      if v_refusal is not null then
        v_problems := v_problems || format('%s: row %s refused by %s', c ->> 'id', a ->> 'id', v_refusal);
      end if;
    end loop;
    v_actual := pg_temp.sql_projection(v_user);
    v_expected := pg_temp.expected_projection(c -> 'expected');
    if v_actual is distinct from v_expected then
      v_problems := v_problems || format(E'%s: MISMATCH\n  sql      = %s\n  expected = %s',
        c ->> 'id', coalesce(v_actual::text, 'null'), coalesce(v_expected::text, 'null'));
    end if;
    perform pg_temp.forget_player(v_user);
  end loop;
  if v_cases = 0 then
    raise exception 'PARITY: the golden fixture has no cases';
  end if;
  if cardinality(v_problems) > 0 then
    raise exception E'PARITY: golden cases the SQL plane does not reproduce:\n%',
      array_to_string(v_problems, E'\n');
  end if;
  raise notice 'W06-03 golden cases reproduced on the SQL plane: %', v_cases;
end $$;

-- ── C. Replays: the first storable arrival holds the id ───────────────────
do $$
declare
  doc json := (select doc from golden);
  c json;
  a json;
  v_user uuid;
  v_refusal text;
  v_held uuid[];
  v_stored int;
  v_total int;
  v_actual jsonb;
  v_expected jsonb;
  v_cases int := 0;
  v_problems text[] := '{}';
begin
  for c in select value from json_array_elements(doc -> 'replays') loop
    v_cases := v_cases + 1;
    v_user := pg_temp.new_player();
    v_held := '{}';
    v_stored := 0;
    v_total := 0;
    for a in select value from json_array_elements(c -> 'analyses') loop
      v_total := v_total + 1;
      v_refusal := pg_temp.store_analysis(v_user, a);
      if (a ->> 'id')::uuid = any (v_held) then
        -- A replayed id is acknowledged by the primary key, never re-read.
        if v_refusal is distinct from 'shots_pkey' then
          v_problems := v_problems || format('%s: replay of %s expected shots_pkey, got %s',
            c ->> 'id', a ->> 'id', coalesce(v_refusal, 'stored'));
        end if;
      elsif v_refusal is null then
        v_held := v_held || (a ->> 'id')::uuid;
        v_stored := v_stored + 1;
      elsif v_refusal = 'shots_pkey' then
        v_problems := v_problems || format('%s: %s was never stored yet shots_pkey refused it',
          c ->> 'id', a ->> 'id');
      end if;
      -- Any other refusal is a row no plane stores: it holds nothing, and the
      -- expected summary below pins that it never counted.
    end loop;
    if v_stored >= v_total then
      v_problems := v_problems || format('%s: no arrival was a replay', c ->> 'id');
    end if;
    v_actual := pg_temp.sql_projection(v_user);
    v_expected := pg_temp.expected_projection(c -> 'expected');
    if v_actual is distinct from v_expected then
      v_problems := v_problems || format(E'%s: MISMATCH\n  sql      = %s\n  expected = %s',
        c ->> 'id', coalesce(v_actual::text, 'null'), coalesce(v_expected::text, 'null'));
    end if;
    perform pg_temp.forget_player(v_user);
  end loop;
  if v_cases = 0 then
    raise exception 'PARITY: the golden fixture has no replay cases';
  end if;
  if cardinality(v_problems) > 0 then
    raise exception E'PARITY: replay cases the SQL plane does not reproduce:\n%',
      array_to_string(v_problems, E'\n');
  end if;
  raise notice 'W06-03 golden replays reproduced on the SQL plane: %', v_cases;
end $$;

-- ── D. Rejected inputs: refused by exactly the named SQL check ────────────
do $$
declare
  doc json := (select doc from golden);
  r json;
  v_user uuid;
  v_refusal text;
  v_named text;
  v_cases int := 0;
  v_problems text[] := '{}';
begin
  for r in select value from json_array_elements(doc -> 'rejectedInputs') loop
    v_cases := v_cases + 1;
    v_user := pg_temp.new_player();
    v_refusal := pg_temp.store_analysis(v_user, r -> 'analysis');
    select f ->> 'check' into v_named
    from json_array_elements(r -> 'refusedBy') f
    where f ->> 'layer' = 'sql';
    if v_named is not null then
      if v_refusal is distinct from v_named then
        v_problems := v_problems || format('%s: expected %s, got %s',
          r ->> 'id', v_named, coalesce(v_refusal, 'stored'));
      end if;
      if pg_temp.sql_projection(v_user) is not null then
        v_problems := v_problems || format('%s: SQL ranked a refused row', r ->> 'id');
      end if;
    elsif v_refusal is not null then
      v_problems := v_problems || format(
        '%s: names no SQL check but SQL refused it (%s) — the fixture must name it',
        r ->> 'id', v_refusal);
    end if;
    perform pg_temp.forget_player(v_user);
  end loop;
  if v_cases = 0 then
    raise exception 'PARITY: the golden fixture has no rejected inputs';
  end if;
  if cardinality(v_problems) > 0 then
    raise exception E'PARITY: rejected inputs the SQL plane handles differently:\n%',
      array_to_string(v_problems, E'\n');
  end if;
  raise notice 'W06-03 golden rejected inputs agree with the SQL checks: %', v_cases;
end $$;

-- ── E. A saved row under another definition is only ever replaced by ──────
--       new evidence for that player, never reinterpreted or patched.
do $$
declare
  v_legacy uuid := pg_temp.new_player();
  v_other uuid := pg_temp.new_player();
  v_before public.player_rank_state%rowtype;
  v_after public.player_rank_state%rowtype;
  v_current text := public.scoring_definition_version();
begin
  if pg_temp.store_analysis(v_legacy, json_build_object(
       'id', '00000000-0000-4000-8000-0000000000e1', 'shotType', 'drive', 'overallScore', 6,
       'resultKind', 'scored', 'capturedAt', '2026-08-01T10:00:00.000Z', 'source', 'real')) is not null
  then
    raise exception 'PARITY: fixture-shaped evidence must be storable';
  end if;
  select * into v_before from public.player_rank_state where user_id = v_legacy;
  if v_before.definition_version is distinct from v_current then
    raise exception 'PARITY: a fresh rank must state the current definition, got %',
      v_before.definition_version;
  end if;

  -- Stand in for a row saved under an earlier definition.
  update public.player_rank_state
    set definition_version = 'rank-golden-parity-legacy'
    where user_id = v_legacy;
  select * into v_before from public.player_rank_state where user_id = v_legacy;

  -- Another player's evidence leaves it byte-identical (updated_at included).
  perform pg_temp.store_analysis(v_other, json_build_object(
    'id', '00000000-0000-4000-8000-0000000000e2', 'shotType', 'dink', 'overallScore', 9,
    'resultKind', 'scored', 'capturedAt', '2026-08-02T10:00:00.000Z', 'source', 'real'));
  select * into v_after from public.player_rank_state where user_id = v_legacy;
  if v_after is distinct from v_before then
    raise exception 'PARITY: another player''s evidence rewrote a saved row: % -> %', v_before, v_after;
  end if;

  -- The live view always computes under the current definition; the saved
  -- row keeps saying which one it was built under, so a reader can tell
  -- the two numbers are not comparable.
  if (select definition_version from public.player_technique_rating where user_id = v_legacy)
     is distinct from v_current then
    raise exception 'PARITY: the live view must state the current definition';
  end if;
  if (select definition_version from public.player_rank_state where user_id = v_legacy)
     <> 'rank-golden-parity-legacy' then
    raise exception 'PARITY: the saved row must keep the definition it was built under';
  end if;

  -- New evidence for this player rebuilds the row from the evidence under
  -- the current definition: 8 (x8) and 6 (x7) → round(10600 / 15) / 100 =
  -- 7.07, Platinum (≥ 6.5, < 7.5).
  perform pg_temp.store_analysis(v_legacy, json_build_object(
    'id', '00000000-0000-4000-8000-0000000000e3', 'shotType', 'drive', 'overallScore', 8,
    'resultKind', 'scored', 'capturedAt', '2026-08-03T10:00:00.000Z', 'source', 'real'));
  select * into v_after from public.player_rank_state where user_id = v_legacy;
  if v_after.definition_version is distinct from v_current
     or v_after.rating <> 7.07 or v_after.tier <> 'platinum'
     or v_after.technique_count <> 1 or v_after.scored_shot_count <> 2 then
    raise exception 'PARITY: new evidence must rebuild the row under the current definition, got %', v_after;
  end if;

  -- No evidence → no row under any definition (never a stale saved rank).
  delete from public.shots where user_id = v_legacy;
  if exists (select 1 from public.player_rank_state where user_id = v_legacy) then
    raise exception 'PARITY: a player without evidence must have no saved rank';
  end if;

  -- The stamp is mandatory: no writer may save an unlabelled rank.
  begin
    update public.player_rank_state set definition_version = null where user_id = v_other;
    raise exception 'PARITY: a saved rank without a definition version must be refused';
  exception when not_null_violation then null;
  end;
  begin
    update public.player_rank_state set definition_version = '' where user_id = v_other;
    raise exception 'PARITY: a saved rank with an empty definition version must be refused';
  exception when check_violation then null;
  end;

  -- Clients read the version but never write it (derived state stays
  -- trigger-owned).
  if has_column_privilege('authenticated', 'public.player_rank_state', 'definition_version', 'UPDATE')
     or has_column_privilege('anon', 'public.player_rank_state', 'definition_version', 'SELECT') then
    raise exception 'PARITY: definition_version grants must match the rest of player_rank_state';
  end if;
  if not has_column_privilege('authenticated', 'public.player_rank_state', 'definition_version', 'SELECT')
     or not has_column_privilege('authenticated', 'public.player_technique_rating', 'definition_version', 'SELECT') then
    raise exception 'PARITY: signed-in players must be able to read the definition version';
  end if;
end $$;

rollback;
\echo 'W06-03 SCORING PARITY (golden fixture through SQL): PASS'
