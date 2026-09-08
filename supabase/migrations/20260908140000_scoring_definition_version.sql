-- ============================================================================
-- Pickle Sensei — the SQL rank plane states the scoring definition it
-- computes under (W06-03).
--
-- packages/shared-types/src/scoringDefinition.ts is the canonical scoring
-- definition (`rank-form-weighted-v2`); packages/shared-types/fixtures/
-- scoring/player-rank.golden.json pins its outputs, and every fixture
-- expectation carries `definitionVersion`. The SQL plane mirrors the formula
-- (20260831130000_form_weighted_rank.sql) but had no way to say WHICH
-- definition a saved rank or a live technique row was computed under, so a
-- reader could not tell whether two numbers are comparable — the partition
-- W06 requires across SQL, Edge and shared types. supabase/tests/
-- scoring_parity.sql feeds the fixture through this plane and demands the
-- version alongside every number.
--
--   public.scoring_definition_version()              what recompute stamps
--   public.player_rank_state.definition_version      stamped on every write
--   public.player_technique_rating.definition_version the live view's
--
-- The literal appears twice — in the function and in the view — because the
-- view runs as its invoker and clients hold no function EXECUTE beyond the
-- RPC allowlist (20260905190106_api_only_database_access.sql); the parity
-- test pins both to the fixture, so they cannot drift apart unnoticed.
--
-- Historical rows are NOT reinterpreted: every row of player_rank_state was
-- built by public.recompute_player_rank under the form-weighted v2 formula
-- (20260831130000 §3 rebuilt every saved row, and that function has been
-- the only writer since), so existing rows are labelled v2 and nothing else
-- about them (rating, tier, counts, updated_at) is touched. The column
-- default exists only for that backfill and is dropped at once: every
-- future writer states the definition it computed under, and a future
-- definition is a new version label plus a new migration — never a rewrite
-- of the numbers saved under this one.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The definition version this plane computes under. Read by the definer
--    recompute and by operators/service; clients read the version from the
--    rows instead (the RPC allowlist stays as it is).
-- ---------------------------------------------------------------------------
create or replace function public.scoring_definition_version()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 'rank-form-weighted-v2'::text
$$;

comment on function public.scoring_definition_version() is
  'The scoring definition version the SQL rank plane computes under; must equal packages/shared-types/src/scoringDefinition.ts SCORING_DEFINITION.version (pinned by supabase/tests/scoring_parity.sql against the golden fixture).';

revoke execute on function public.scoring_definition_version()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Saved rank rows carry the definition they were built under.
-- ---------------------------------------------------------------------------
alter table public.player_rank_state
  add column if not exists definition_version text not null default 'rank-form-weighted-v2';
alter table public.player_rank_state
  alter column definition_version drop default;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'player_rank_state_definition_version_nonempty'
  ) then
    alter table public.player_rank_state
      add constraint player_rank_state_definition_version_nonempty
      check (definition_version <> '');
  end if;
end $$;

comment on column public.player_rank_state.definition_version is
  'Scoring definition version this row was computed under (public.scoring_definition_version() at write time). A row saved under another version is comparable to nothing computed under this one and is only ever replaced by a recompute from new evidence, never patched.';

-- ---------------------------------------------------------------------------
-- 3. The live view states the definition it computes under. Column APPENDED
--    (create or replace stays legal; grants survive); security_invoker stays
--    true.
-- ---------------------------------------------------------------------------
create or replace view public.player_technique_rating
with (security_invoker = true) as
with countable as (
  select
    user_id,
    shot_type,
    captured_at,
    round(overall_score::numeric * 100) as score_hundredths,
    row_number() over (
      partition by user_id, shot_type
      order by captured_at desc, id desc
    ) as rn,
    count(*) over (partition by user_id, shot_type) as total_count
  from public.shots
  where source = 'real' and result_kind = 'scored' and overall_score is not null
)
select
  user_id,
  shot_type,
  round(sum((9 - rn) * score_hundredths) / sum(9 - rn)) / 100.0 as score,
  max(captured_at) as captured_at,
  count(*)::int as sampled_count,
  least(max(total_count), 5)::int as confidence_weight,
  'rank-form-weighted-v2'::text as definition_version
from countable
where rn <= 8
group by user_id, shot_type;

revoke all on public.player_technique_rating from anon, public;
grant select on public.player_technique_rating to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Recompute — same signature, SECURITY DEFINER, pinned search_path and
--    formula as 20260831130000; the only change is the version stamp on
--    every insert/update. Still the only writer of player_rank_state; still
--    deletes the row when no evidence remains.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_player_rank(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rating numeric(4, 2);
  v_technique_count int;
  v_scored_shot_count int;
  v_definition_version text := public.scoring_definition_version();
begin
  with countable as (
    select
      shot_type,
      round(overall_score::numeric * 100) as score_hundredths,
      row_number() over (
        partition by shot_type
        order by captured_at desc, id desc
      ) as rn,
      count(*) over (partition by shot_type) as total_count
    from public.shots
    where user_id = p_user_id
      and source = 'real'
      and result_kind = 'scored'
      and overall_score is not null
  ),
  technique as (
    select
      round(sum((9 - rn) * score_hundredths) / sum(9 - rn)) / 100.0 as score,
      least(max(total_count), 5) as confidence_weight
    from countable
    where rn <= 8
    group by shot_type
  )
  select
    round(sum(t.confidence_weight * round(t.score * 100))
          / sum(t.confidence_weight)) / 100.0,
    count(*)::int
    into v_rating, v_technique_count
  from technique t;

  if v_rating is null then
    delete from public.player_rank_state where user_id = p_user_id;
    return;
  end if;

  select count(*)::int into v_scored_shot_count
  from public.shots
  where user_id = p_user_id
    and source = 'real'
    and result_kind = 'scored'
    and overall_score is not null;

  insert into public.player_rank_state
    (user_id, rating, tier, technique_count, scored_shot_count, definition_version, updated_at)
  values (
    p_user_id,
    v_rating,
    public.player_rank_tier(v_rating),
    v_technique_count,
    v_scored_shot_count,
    v_definition_version,
    now()
  )
  on conflict (user_id) do update
    set rating = excluded.rating,
        tier = excluded.tier,
        technique_count = excluded.technique_count,
        scored_shot_count = excluded.scored_shot_count,
        definition_version = excluded.definition_version,
        updated_at = now();
end;
$$;

revoke execute on function public.recompute_player_rank(uuid) from public;
revoke execute on function public.recompute_player_rank(uuid)
  from anon, authenticated;
