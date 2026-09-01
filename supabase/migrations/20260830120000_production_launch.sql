-- ============================================================================
-- Pickle Sensei — production launch changes.
--
-- 1. Player rank formula change (supersedes 20260829150000_player_rank.sql):
--    per technique the score is now the AVERAGE of ALL scored analyses
--    (previously: the latest one only). The single-source-of-truth formula,
--    shared verbatim with packages/shared-types/src/playerRank.ts and the
--    Edge Function's GET /v1/rank fallback:
--      1. per-technique score = round(avg(overall_score), 2) over every
--         source='real', result_kind='scored', overall_score-not-null shot;
--      2. rating = round(avg(per-technique rounded scores), 2);
--      3. tier   = public.player_rank_tier(rating)  (thresholds unchanged).
--    Rounding happens in the SAME two stages on both sides (technique first,
--    then rating over the rounded technique scores) so client integer-
--    hundredths math and Postgres round(numeric, 2) stay bit-identical.
--    All honesty rules are unchanged: abstentions never contribute, fixture
--    output never ranks a player, and no scored evidence means NO rank row.
--
-- 2. billing_entitlements — server-verified RevenueCat membership state,
--    written by POST /v1/billing/sync (which acts AS the user under RLS)
--    and read by every access computation.
--
-- 3. profiles.first_name / profiles.gender — optional onboarding fields
--    (PUT /v1/me/onboarding contract).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1a. Per-technique score view — now the AVERAGE of all scored analyses per
--     technique, stamped with the technique's latest capture. The column set
--     changes (scoring_model_version is dropped: an average spans model
--     versions), so the view is dropped and recreated rather than replaced.
--     security_invoker stays true: each user only ever sees their own rows.
-- ---------------------------------------------------------------------------
drop view if exists public.player_technique_rating;

create view public.player_technique_rating
with (security_invoker = true) as
select
  user_id,
  shot_type,
  round(avg(overall_score), 2) as score,
  max(captured_at) as captured_at
from public.shots
where source = 'real' and result_kind = 'scored' and overall_score is not null
group by user_id, shot_type;

comment on view public.player_technique_rating is
  'Per-technique average of ALL scored real analyses (0-10, 2 decimals) with the latest capture timestamp. Mirrors packages/shared-types/src/playerRank.ts computePlayerRank.';

-- Same grants as the original migration: authenticated may read (through
-- their own RLS on shots); anon gets nothing.
revoke all on public.player_technique_rating from anon;
grant select on public.player_technique_rating to authenticated;

-- ---------------------------------------------------------------------------
-- 1b. Recompute — identical to the original except the inner query now
--     averages every scored analysis per technique instead of taking the
--     latest one. Still SECURITY DEFINER with a pinned search_path; still the
--     only writer of player_rank_state.
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
  select round(avg(t.score), 2), count(*)::int
    into v_rating, v_technique_count
  from (
    select round(avg(overall_score), 2) as score
    from public.shots
    where user_id = p_user_id
      and source = 'real'
      and result_kind = 'scored'
      and overall_score is not null
    group by shot_type
  ) t;

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

-- create or replace preserves existing ACLs, but re-assert the lockdown from
-- the original migration for clarity: only the definer trigger (and
-- operators) may recompute.
revoke execute on function public.recompute_player_rank(uuid) from public;
revoke execute on function public.recompute_player_rank(uuid)
  from anon, authenticated;

comment on table public.player_rank_state is
  'Saved personal rank per user: average of each technique''s average scored-analysis score (0-10) mapped to bronze/silver/gold/platinum/diamond. Derived from public.shots by trigger; rebuildable via public.recompute_player_rank(user_id). Mirrors packages/shared-types/src/playerRank.ts.';

-- The shots trigger (handle_shot_rank_refresh → recompute_player_rank) is
-- unchanged and keeps pointing at the replaced function.

-- ---------------------------------------------------------------------------
-- 1c. Recompute every saved rank under the new formula — anyone with a saved
--     row OR any shots history (recompute also deletes rows that no longer
--     qualify, so the union is the complete affected set).
-- ---------------------------------------------------------------------------
do $$
declare
  u uuid;
begin
  for u in
    select user_id from public.player_rank_state
    union
    select user_id from public.shots where user_id is not null
  loop
    perform public.recompute_player_rank(u);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Billing entitlements — one row per user, written by POST
--    /v1/billing/sync after verifying the subscriber against RevenueCat's
--    REST API. premium is only honored while unexpired (expires_at null =
--    lifetime), so a stale row can never grant access forever.
-- ---------------------------------------------------------------------------
create table if not exists public.billing_entitlements (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  premium boolean not null default false,
  product_key text,
  expires_at timestamptz,
  verified_at timestamptz not null default now()
);

comment on table public.billing_entitlements is
  'Server-verified RevenueCat entitlement state per user (POST /v1/billing/sync). premium counts only while expires_at is null or in the future; verified_at is the moment the server last checked RevenueCat.';

-- Users may READ their own verified state (accessPayload runs as the user),
-- but NEVER write it: the only writer is the Edge Function's billing sync,
-- which verifies against RevenueCat and upserts with the service-role key
-- (bypasses RLS). Granting authenticated insert/update here would let any
-- signed-in user PostgREST themselves premium without paying.
alter table public.billing_entitlements enable row level security;

drop policy if exists "billing_entitlements_select_own" on public.billing_entitlements;
create policy "billing_entitlements_select_own"
  on public.billing_entitlements for select
  to authenticated using ((select auth.uid()) = user_id);

revoke all on public.billing_entitlements from anon;
grant select on public.billing_entitlements to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Onboarding profile fields — the user's own statements, stored verbatim
--    (PUT /v1/me/onboarding accepts optional firstName/gender; GET /v1/me
--    returns them). Both nullable: absent means the user never said.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists first_name text,
  add column if not exists gender text
    check (gender in ('female', 'male', 'nonbinary', 'prefer_not_to_say'));
