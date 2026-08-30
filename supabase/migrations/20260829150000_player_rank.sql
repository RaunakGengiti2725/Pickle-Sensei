-- ============================================================================
-- Pickle Sensei — personal player rank (Bronze → Silver → Gold → Platinum
-- → Diamond). NOT a leaderboard: nothing here compares users to each other.
--
-- The formula (single source of truth shared verbatim with
-- packages/shared-types/src/playerRank.ts):
--   1. For each technique (shot_type) with at least one SCORED analysis,
--      take the LATEST scored analysis's overall_score (0-10).
--   2. rating = round(avg(those per-technique scores), 2).
--   3. tier   = public.player_rank_tier(rating):
--        bronze   [0.00, 3.50)
--        silver   [3.50, 5.00)
--        gold     [5.00, 6.50)
--        platinum [6.50, 7.50)
--        diamond  [7.50, 10.00]
--
-- What it creates:
--   player_technique_rating  VIEW — each technique's current (latest) score;
--                            reads through the caller's RLS.
--   player_rank_state        TABLE — the SAVED rank, one row per user,
--                            maintained transactionally by a trigger on
--                            public.shots. Because every write recomputes
--                            from the shots table itself, the saved state
--                            cannot drift from the evidence; and because it
--                            is derived, `select public.recompute_player_rank
--                            (<user_id>)` can always rebuild it.
--
-- Principles carried over from the app:
--   * Low-confidence (abstained) analyses never contribute — no score, no
--     rank movement. A user with no scored analyses has NO row here (an
--     honest "unranked", never a fabricated Bronze).
--   * source='real' only — fixture output can never rank a player.
--   * Owner-only RLS; clients can read their rank but never write it (the
--     definer trigger owns all writes).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Current per-technique score (latest scored analysis per shot_type).
--    security_invoker: each user only ever sees their own techniques.
-- ---------------------------------------------------------------------------
create or replace view public.player_technique_rating
with (security_invoker = true) as
select distinct on (user_id, shot_type)
  user_id,
  shot_type,
  overall_score as score,
  captured_at,
  scoring_model_version
from public.shots
where source = 'real' and result_kind = 'scored' and overall_score is not null
order by user_id, shot_type, captured_at desc, created_at desc, id desc;

-- ---------------------------------------------------------------------------
-- 2. Saved rank state — one row per ranked user.
-- ---------------------------------------------------------------------------
create table if not exists public.player_rank_state (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  rating numeric(4, 2) not null check (rating >= 0 and rating <= 10),
  tier text not null
    check (tier in ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
  technique_count int not null check (technique_count >= 1),
  scored_shot_count int not null check (scored_shot_count >= 1),
  updated_at timestamptz not null default now()
);

comment on table public.player_rank_state is
  'Saved personal rank per user: average of each technique''s latest scored analysis (0-10) mapped to bronze/silver/gold/platinum/diamond. Derived from public.shots by trigger; rebuildable via public.recompute_player_rank(user_id). Mirrors packages/shared-types/src/playerRank.ts.';

-- ---------------------------------------------------------------------------
-- 3. Rating → tier mapping. IMMUTABLE so it can never disagree with itself;
--    thresholds MUST stay identical to PLAYER_RANK_TIERS in
--    packages/shared-types/src/playerRank.ts.
-- ---------------------------------------------------------------------------
create or replace function public.player_rank_tier(rating numeric)
returns text
language sql
immutable
as $$
  select case
    when rating >= 7.5 then 'diamond'
    when rating >= 6.5 then 'platinum'
    when rating >= 5.0 then 'gold'
    when rating >= 3.5 then 'silver'
    else 'bronze'
  end
$$;

-- ---------------------------------------------------------------------------
-- 4. Full recompute for one user (cheap: per-user shot counts are small).
--    SECURITY DEFINER with a pinned search_path — the hardened pattern used
--    by handle_new_user(); it lets the shots trigger write the state table
--    that clients themselves cannot touch.
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
  select round(avg(latest.score), 2), count(*)::int
    into v_rating, v_technique_count
  from (
    select distinct on (shot_type) overall_score as score
    from public.shots
    where user_id = p_user_id
      and source = 'real'
      and result_kind = 'scored'
      and overall_score is not null
    order by shot_type, captured_at desc, created_at desc, id desc
  ) latest;

  if v_rating is null then
    -- No scored evidence → honestly unranked (no row), never a default tier.
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

-- Only the shots trigger (and operators running migrations/repairs) may
-- recompute; client sessions cannot call it, let alone write the table.
revoke execute on function public.recompute_player_rank(uuid) from public;
revoke execute on function public.recompute_player_rank(uuid)
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Keep the saved rank current on EVERY shots write, whichever path wrote
--    it (edge-function sync today, anything else tomorrow).
-- ---------------------------------------------------------------------------
create or replace function public.handle_shot_rank_refresh()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.recompute_player_rank(new.user_id);
  end if;
  if tg_op = 'DELETE'
     or (tg_op = 'UPDATE' and old.user_id is distinct from new.user_id) then
    perform public.recompute_player_rank(old.user_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists shots_player_rank_refresh on public.shots;
create trigger shots_player_rank_refresh
  after insert or update or delete on public.shots
  for each row execute function public.handle_shot_rank_refresh();

-- ---------------------------------------------------------------------------
-- 6. Backfill ranks for users whose shots predate this migration.
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid;
begin
  for u in
    select distinct user_id from public.shots
    where source = 'real' and result_kind = 'scored'
      and overall_score is not null
  loop
    perform public.recompute_player_rank(u);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Row Level Security — owners read their own rank; nobody writes from a
--    client session (no insert/update/delete policies on purpose: the
--    definer trigger owns every write).
-- ---------------------------------------------------------------------------
alter table public.player_rank_state enable row level security;

drop policy if exists "player_rank_state_select_own" on public.player_rank_state;
create policy "player_rank_state_select_own"
  on public.player_rank_state for select
  to authenticated using ((select auth.uid()) = user_id);

revoke all on public.player_rank_state from anon;
grant select on public.player_rank_state to authenticated;
grant select on public.player_technique_rating to authenticated;
