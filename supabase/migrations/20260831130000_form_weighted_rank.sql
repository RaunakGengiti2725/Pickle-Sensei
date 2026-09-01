-- ============================================================================
-- Pickle Sensei — form-weighted player rank (v2).
--
-- Supersedes the lifetime-average formula of
-- 20260830120000_production_launch.sql. The single source of truth is
-- packages/shared-types/src/playerRank.ts (computePlayerRank); this migration
-- mirrors it bit for bit, and the Edge Function's GET /v1/rank fallback
-- (supabase/functions/api/index.ts) mirrors both. All three MUST stay in
-- agreement.
--
-- THE FORMULA (form-weighted rank v2):
--   0. Countable rows (unchanged): public.shots where source = 'real' AND
--      result_kind = 'scored' AND overall_score IS NOT NULL. Abstentions
--      never contribute; fixture output never ranks a player.
--   1. PER TECHNIQUE (user_id, shot_type) — CURRENT FORM. Order countable
--      rows newest first (captured_at desc, id desc) and keep only the first
--      8 (RANK_FORM_WINDOW). Window position p = 1..8 (1 = newest) gets
--      linear weight w = 9 - p, i.e. 8, 7, … 1: recent swings lead, but one
--      outlier rep is still smoothed by the window.
--        technique score
--          = round( sum(w * round(overall_score * 100)) / sum(w) ) / 100.0
--      (Integer-hundredths math: each score is rounded to hundredths FIRST,
--      then weighted-averaged, then the quotient is rounded to a whole
--      number of hundredths. Postgres round(numeric) rounds half away from
--      zero, which equals TS Math.round for the non-negative values here —
--      that is what keeps both sides bit-identical.)
--      Also per technique:
--        sampled_count     = rows inside the window (<= 8);
--        confidence_weight = least(total countable rows, 5)
--                            (RANK_CONFIDENCE_CAP — and because the window
--                            (8) >= the cap (5), least(total, 5) ==
--                            least(sampled_count, 5)).
--   2. RATING — EVIDENCE-WEIGHTED BREADTH. Confidence-weighted average of
--      the per-technique ROUNDED scores, again in integer hundredths:
--        rating = round( sum(confidence_weight * round(score * 100))
--                        / sum(confidence_weight) ) / 100.0
--      A technique analyzed once cannot move the rating as hard as one
--      proven five times.
--   3. tier = public.player_rank_tier(rating) — thresholds UNCHANGED from
--      20260829150000_player_rank.sql (bronze < 3.5 <= silver < 5 <= gold
--      < 6.5 <= platinum < 7.5 <= diamond); that function is not touched.
--   4. scored_shot_count is UNCHANGED: ALL countable rows for the user,
--      not window-limited — history outside the window still proves
--      evidence volume.
--
-- Honesty rules are unchanged: no scored evidence → NO rank row (an honest
-- "unranked", never a fabricated Bronze).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-technique score view — now the form-weighted average of the
--    technique's most recent 8 scored analyses. The first four columns keep
--    the exact names, types, and order of the previous definition
--    (user_id, shot_type, score, captured_at) and two columns are APPENDED
--    (sampled_count, confidence_weight), so `create or replace` is legal —
--    no drop, and existing grants survive. security_invoker stays true:
--    each user only ever sees their own rows.
--
--    captured_at stays max(captured_at) over ALL countable rows of the
--    technique. Computing it from the rn <= 8 window is still correct:
--    rn orders by captured_at desc, so the newest row is always rn = 1 —
--    the window can only drop OLDER rows, never the maximum.
-- ---------------------------------------------------------------------------
create or replace view public.player_technique_rating
with (security_invoker = true) as
with countable as (
  select
    user_id,
    shot_type,
    captured_at,
    -- Integer hundredths, rounded FIRST — mirrors the TS
    -- Math.round(overallScore * 100) so both sides feed identical integers
    -- into the weighted average. (overall_score is numeric(4,2); the cast
    -- is belt-and-braces against future column-type drift.)
    round(overall_score::numeric * 100) as score_hundredths,
    -- Newest first; ties break by id desc (uuid byte order == canonical
    -- lowercase text order, matching the TS comparator).
    row_number() over (
      partition by user_id, shot_type
      order by captured_at desc, id desc
    ) as rn,
    -- Total countable rows for the technique (NOT window-limited) — the
    -- evidence base behind confidence_weight.
    count(*) over (partition by user_id, shot_type) as total_count
  from public.shots
  where source = 'real' and result_kind = 'scored' and overall_score is not null
)
select
  user_id,
  shot_type,
  -- Linear recency weights w = 9 - rn (rn 1..8 → w 8..1). The numerator is
  -- numeric, so `/` is exact numeric division (never integer truncation),
  -- and round(numeric) rounds half away from zero — TS Math.round parity.
  round(sum((9 - rn) * score_hundredths) / sum(9 - rn)) / 100.0 as score,
  -- Max over the window == max over all countable rows (see note above).
  max(captured_at) as captured_at,
  count(*)::int as sampled_count,
  least(max(total_count), 5)::int as confidence_weight
from countable
where rn <= 8
group by user_id, shot_type;

comment on view public.player_technique_rating is
  'Per-technique form score: linearly recency-weighted average (newest x8 … oldest-in-window x1) of the technique''s most recent 8 scored real analyses (0-10, 2 decimals), with the latest capture timestamp over ALL its scored analyses, sampled_count = rows in the window (<=8), and confidence_weight = least(total scored analyses, 5). Mirrors packages/shared-types/src/playerRank.ts computePlayerRank (form-weighted v2).';

-- create or replace preserves existing ACLs, but re-assert the grants from
-- the earlier migrations for clarity: authenticated may read (through their
-- own RLS on shots); anon gets nothing.
revoke all on public.player_technique_rating from anon;
grant select on public.player_technique_rating to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Recompute — same signature, SECURITY DEFINER, and pinned search_path as
--    20260830120000_production_launch.sql; still the only writer of
--    player_rank_state; still deletes the row when no evidence remains. The
--    body inlines the windowed CTE against public.shots (it must not depend
--    on the view: the definer function should not care about invoker-side
--    view semantics, and the inline form keeps the formula auditable here).
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
begin
  -- Stage 1 (technique CTE): per shot_type, the form-weighted score of the
  -- most recent 8 scored analyses — identical math to the
  -- player_technique_rating view above. Stage 2 (outer select): the
  -- confidence-weighted average of the per-technique ROUNDED scores. Both
  -- stages round half away from zero exactly once, in integer hundredths —
  -- bit-identical to computePlayerRank in
  -- packages/shared-types/src/playerRank.ts.
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
    -- No scored evidence → honestly unranked (no row), never a default tier.
    delete from public.player_rank_state where user_id = p_user_id;
    return;
  end if;

  -- Evidence volume: ALL countable rows, deliberately NOT window-limited.
  select count(*)::int into v_scored_shot_count
  from public.shots
  where user_id = p_user_id
    and source = 'real'
    and result_kind = 'scored'
    and overall_score is not null;

  insert into public.player_rank_state
    (user_id, rating, tier, technique_count, scored_shot_count, updated_at)
  values (
    p_user_id,
    v_rating,
    public.player_rank_tier(v_rating),
    v_technique_count,
    v_scored_shot_count,
    now()
  )
  on conflict (user_id) do update
    set rating = excluded.rating,
        tier = excluded.tier,
        technique_count = excluded.technique_count,
        scored_shot_count = excluded.scored_shot_count,
        updated_at = now();
end;
$$;

comment on function public.recompute_player_rank(uuid) is
  'Rebuilds public.player_rank_state for one user under the form-weighted v2 formula: per technique, round2 of the linearly recency-weighted average (weights 8..1) of its most recent 8 scored real analyses; rating = round2 of the confidence-weighted (least(total analyses, 5)) average of those rounded technique scores; tier via public.player_rank_tier. Deletes the row when no scored evidence exists. Mirrors packages/shared-types/src/playerRank.ts.';

-- create or replace preserves existing ACLs, but re-assert the lockdown from
-- the earlier migrations for clarity: only the definer trigger (and
-- operators) may recompute.
revoke execute on function public.recompute_player_rank(uuid) from public;
revoke execute on function public.recompute_player_rank(uuid)
  from anon, authenticated;

comment on table public.player_rank_state is
  'Saved personal rank per user under the form-weighted v2 formula (recent-8 window, linear recency weights, evidence-capped technique weighting; see packages/shared-types/src/playerRank.ts), mapped to bronze/silver/gold/platinum/diamond. Derived from public.shots by trigger; rebuildable via public.recompute_player_rank(user_id).';

-- The shots trigger (handle_shot_rank_refresh → recompute_player_rank) is
-- unchanged and keeps pointing at the replaced function; player_rank_tier
-- from 20260829150000_player_rank.sql is deliberately untouched.

-- ---------------------------------------------------------------------------
-- 3. Recompute every saved rank under the new formula — anyone with a saved
--    row OR any countable shots history (recompute also deletes rows that no
--    longer qualify, so the union is the complete affected set).
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid;
begin
  for u in
    select user_id from public.player_rank_state
    union
    select distinct user_id from public.shots
    where source = 'real' and result_kind = 'scored'
      and overall_score is not null
  loop
    perform public.recompute_player_rank(u);
  end loop;
end $$;
