-- ============================================================================
-- Pickle Sensei — the permit gate binds every scored-shot INSERT (DB-02).
--
-- THE HOLE. authenticated holds INSERT on public.shots (the RLS insert policy
-- only forces user_id = auth.uid()), and the two-lifetime-free-ratings rule
-- lived entirely inside apply_synced_shot(). A client that skips the RPC and
-- writes the table directly through PostgREST (user JWT + public anon key)
-- could therefore record a scored shot with NO permit, past the free limit,
-- and the rank trigger happily recomputed on it. Reproduced: two ratings
-- spent through the RPCs, reserve #3 refused with access.paywall_required,
-- then a direct INSERT of a third result_kind='scored' row succeeded.
-- Companion gap: result_kind='low_confidence' rows could carry a non-null
-- overall_score (the edge parser refuses that shape; the table did not).
--
-- THE FIX. A BEFORE INSERT trigger on public.shots enforces, for every
-- scored row written from a client session (auth.uid() is not null), the
-- same two facts apply_synced_shot() checks — under the same per-user
-- advisory lock so a concurrent pair cannot both pass:
--   1. the owner holds a live reserved permit (status 'reserved', < 24 h);
--   2. the owner is premium OR lifetime_scored_count() < 2 (identity-aware,
--      so a deleted-and-recreated account is refused here too).
-- Inside apply_synced_shot() both already hold when the INSERT runs (the
-- permit flips to finalized AFTER the row is written, in the same
-- transaction), so the RPC path is unchanged and the trigger is pure defense
-- in depth there. Service-role / owner writes (auth.uid() is null) are not
-- client writes and are left alone — the free limit is a client rule.
-- Abstentions (low_confidence) stay free and need no permit, exactly as the
-- RPC treats them; they now MUST carry overall_score IS NULL (CHECK, NOT
-- VALID so the deploy never rescans the table).
--
-- Static pin: __wf__/db_migrations_rls_indexes.test.ts. Live: security
-- regression matrix section L.
-- New file only — applied migrations are never edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Abstentions carry no score (mirror of shots_result_kind_score_check).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shots_low_confidence_unscored') then
    alter table public.shots add constraint shots_low_confidence_unscored check (
      result_kind = 'scored' or overall_score is null
    ) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The gate. SECURITY INVOKER on purpose: the permit lookup runs under the
--    caller's RLS (it can only ever see the caller's permits) and
--    lifetime_scored_count() is the caller-scoped decision count every other
--    free-rating decision uses. Not client-executable directly.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_scored_shot_permit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
begin
  if new.result_kind <> 'scored' or v_uid is null then
    return new;
  end if;

  -- Same key as reserve_analysis_permit() / apply_synced_shot(): a direct
  -- writer racing itself (or a sync) serializes here. Re-entrant inside the
  -- RPC, which already holds it for this transaction.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  if not exists (
    select 1 from public.analysis_permits p
    where p.user_id = v_uid
      and p.status = 'reserved'
      and p.created_at > now() - interval '24 hours'
  ) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: a scored shot requires a live reserved analysis permit (use apply_synced_shot)';
  end if;

  select coalesce((
    select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b
    where b.user_id = v_uid
  ), false) into v_premium;

  if not v_premium and public.lifetime_scored_count() >= 2 then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)';
  end if;

  return new;
end;
$$;

comment on function public.enforce_scored_shot_permit() is
  'BEFORE INSERT gate on public.shots: a scored row written from a client session must be backed by a live reserved permit and fit the lifetime free-rating allowance (premium bypasses the allowance, never the permit). Runs under the same per-user advisory lock as reserve_analysis_permit()/apply_synced_shot(). Closes the direct-INSERT bypass of the permit gate.';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

drop trigger if exists shots_enforce_scored_permit on public.shots;
create trigger shots_enforce_scored_permit
  before insert on public.shots
  for each row execute function public.enforce_scored_shot_permit();
