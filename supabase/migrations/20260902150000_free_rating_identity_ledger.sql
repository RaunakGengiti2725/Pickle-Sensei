-- ============================================================================
-- Free ratings are bound to the SIGN-IN IDENTITY, not to the account row.
--
-- THE HOLE. The two lifetime free ratings were derived from the count of a
-- user's scored shots (access_state(), reserve_analysis_permit(),
-- apply_synced_shot()). Every one of those rows hangs off auth.users through
-- the profiles cascade, so account deletion — a right the app must offer
-- (App Review 5.1.1(v)) — also reset the counter: delete, sign in again with
-- the SAME Apple ID or Google account, run the onboarding once more, and the
-- fresh auth.users row started at zero with two new free ratings. The paywall
-- was defeated by the account-deletion flow itself.
--
-- THE FIX. public.free_rating_ledger keeps the lifetime scored-shot count per
-- sign-in identity — keyed by a one-way SHA-256 of `provider:provider_id`
-- (the Apple team-scoped `sub` / the Google account `sub` that Supabase Auth
-- records in auth.identities; both are stable for the same Apple ID / Google
-- account across app-account deletions, and Apple's is stable even after the
-- Sign in with Apple authorization is revoked during deletion). The table has
-- NO foreign key to auth.users or profiles, so the deletion cascade cannot
-- touch it. A definer trigger increments it on every scored shot INSERT (so
-- the ledger is complete at all times and no deletion-path hook is needed),
-- and every free-rating decision now uses
--
--     lifetime_scored_count() = greatest(this account's scored shots,
--                                        this identity's ledger count)
--
-- in all three places. A re-created account therefore inherits its identity's
-- history: used = min(2, ledger) = 2 → canStartRating false, reserve refused,
-- and the sync backstop refuses a scored shot even with a forged permit.
-- Premium still bypasses the free limit exactly as before. A genuinely new
-- identity has no ledger row and is unaffected.
--
-- PRIVACY. After deletion the row is a hash of an opaque provider identifier
-- plus a small integer — no email, name, or account id — retained on the
-- legitimate-interest basis of preventing free-tier abuse (disclosed in the
-- privacy policy, legal.ts §7/§8, and in the in-app deletion confirmation).
-- It is SERVICE-ONLY: RLS is on with no policies and every client grant is
-- revoked; the only readers are the definer helpers, which report the
-- CALLER's identities and nothing else.
--
-- Deploy order: `supabase db push` before `functions deploy` (the Edge
-- Function is unchanged in shape — access_state() keeps its three columns).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The identity ledger. Deliberately no FK anywhere: outliving the account
--    is the point. identity_hash is hex SHA-256 (64 chars).
-- ---------------------------------------------------------------------------
create table if not exists public.free_rating_ledger (
  identity_hash text primary key
    check (identity_hash ~ '^[0-9a-f]{64}$'),
  scored_count integer not null default 0 check (scored_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.free_rating_ledger is
  'Lifetime scored-shot count per sign-in identity (SHA-256 of provider:provider_id from auth.identities). Survives account deletion on purpose so the two free ratings cannot be re-earned by deleting and re-creating the account. Service-only: no client grants, no policies; read through identity_scored_count() (caller-scoped) and written by the shots trigger.';

alter table public.free_rating_ledger enable row level security;
revoke all on public.free_rating_ledger from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Hash helper — the ONE definition of the ledger key. Not client-callable.
-- ---------------------------------------------------------------------------
create or replace function public.free_rating_identity_hash(p_provider text, p_provider_id text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(sha256(convert_to(p_provider || ':' || p_provider_id, 'UTF8')), 'hex')
$$;

comment on function public.free_rating_identity_hash(text, text) is
  'Ledger key for one auth.identities row: hex SHA-256 of "provider:provider_id". Change nothing here without re-keying public.free_rating_ledger.';

revoke execute on function public.free_rating_identity_hash(text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. identity_scored_count() — SECURITY DEFINER because auth.identities and
--    the ledger are not client-readable. Scoped to auth.uid() internally (no
--    parameters), so a caller can only ever learn its own identities' count.
--    max(): every identity of a user is kept at the same value by the trigger
--    below, and an identity inherited from an earlier account carries the
--    higher history.
-- ---------------------------------------------------------------------------
create or replace function public.identity_scored_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(l.scored_count), 0)::int
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = (select auth.uid())
$$;

comment on function public.identity_scored_count() is
  'Highest free_rating_ledger count across the CALLER''s auth.identities rows (0 when none). Definer so it can read the service-only ledger; takes no arguments so it can never be pointed at another user.';

revoke all on function public.identity_scored_count() from public, anon;
grant execute on function public.identity_scored_count() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. lifetime_scored_count() — THE count every free-rating decision uses.
--    SECURITY INVOKER: the shots half runs under the caller's RLS exactly as
--    before; the identity half is the caller-scoped definer helper. greatest()
--    keeps the account-local count as a floor (an account with no identity
--    row still cannot exceed its own two ratings).
-- ---------------------------------------------------------------------------
create or replace function public.lifetime_scored_count()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select greatest(
    (
      select count(*)::int from public.shots s
      where s.user_id = (select auth.uid()) and s.result_kind = 'scored'
    ),
    public.identity_scored_count()
  )
$$;

comment on function public.lifetime_scored_count() is
  'Scored-shot count that the two-lifetime-free-ratings rule is applied to: greatest(caller''s own scored shots, caller''s identity ledger). access_state(), reserve_analysis_permit() and apply_synced_shot() MUST all use this — a copy of the raw shots count anywhere reopens the delete-and-recreate hole.';

revoke all on function public.lifetime_scored_count() from public, anon;
grant execute on function public.lifetime_scored_count() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Ledger writer — fires on every scored shot INSERT (and on the
--    never-expected UPDATE that turns a row scored), whichever path wrote it.
--    Definer: the caller (authenticated, inside apply_synced_shot) has no
--    grant on auth.identities or the ledger. Every identity of the user is
--    written to (identity max) + 1, so linked identities stay in step and an
--    identity that arrived with history pulls the others up to it. Nothing
--    ever decrements: the account-deletion cascade DELETEs shots, and this
--    trigger does not listen to DELETE.
-- ---------------------------------------------------------------------------
create or replace function public.record_scored_shot_in_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next integer;
begin
  if new.result_kind <> 'scored'
     or (tg_op = 'UPDATE' and old.result_kind = 'scored') then
    return new;
  end if;

  select coalesce(max(l.scored_count), 0) + 1 into v_next
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = new.user_id;

  insert into public.free_rating_ledger as led (identity_hash, scored_count)
  select public.free_rating_identity_hash(i.provider, i.provider_id), v_next
  from auth.identities i
  where i.user_id = new.user_id
  on conflict (identity_hash) do update
    set scored_count = greatest(led.scored_count + 1, excluded.scored_count),
        updated_at = now();

  return new;
end;
$$;

revoke execute on function public.record_scored_shot_in_ledger()
  from public, anon, authenticated;

drop trigger if exists shots_record_free_rating_ledger on public.shots;
create trigger shots_record_free_rating_ledger
  after insert or update of result_kind on public.shots
  for each row execute function public.record_scored_shot_in_ledger();

-- ---------------------------------------------------------------------------
-- 6. Backfill from the shots that exist today, so nobody's current count
--    drops when the ledger becomes the floor. Idempotent (greatest).
-- ---------------------------------------------------------------------------
insert into public.free_rating_ledger as led (identity_hash, scored_count)
select public.free_rating_identity_hash(i.provider, i.provider_id), c.scored
from (
  select s.user_id, count(*)::int as scored
  from public.shots s
  where s.result_kind = 'scored'
  group by s.user_id
) c
join auth.identities i on i.user_id = c.user_id
on conflict (identity_hash) do update
  set scored_count = greatest(led.scored_count, excluded.scored_count),
      updated_at = now();

-- ---------------------------------------------------------------------------
-- 7. access_state() — scored_count is now the identity-aware count. Same
--    three columns, so the Edge Function's accessPayload() is unchanged
--    (it already clamps used = min(2, scored_count)).
-- ---------------------------------------------------------------------------
create or replace function public.access_state()
returns table (premium boolean, scored_count integer, reserved_count integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = (select auth.uid())
    ), false) as premium,
    public.lifetime_scored_count() as scored_count,
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = (select auth.uid())
        and p.status = 'reserved'
        and p.created_at > now() - interval '24 hours'
    ) as reserved_count
$$;

comment on function public.access_state() is
  'Single-round-trip access computation for GET /v1/me/access: verified premium (unexpired), lifetime scored count (this account OR its sign-in identity''s ledger, whichever is higher — survives account deletion), and fresh reserved permit count. SECURITY INVOKER — RLS scopes every subquery to the caller.';

-- ---------------------------------------------------------------------------
-- 8. reserve_analysis_permit(idempotency_key) — unchanged except the scored
--    count (marked IDENTITY LEDGER below). Recreated in full because Postgres
--    has no partial function replace.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_analysis_permit(p_idempotency_key text)
returns table (
  result text,
  permit_id uuid,
  permit_status text,
  permit_outcome text,
  permit_created_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
  v_scored int;
  v_reserved int;
  v_remaining int;
  v_row public.analysis_permits%rowtype;
begin
  if v_uid is null then
    result := 'auth.required';
    return next;
    return;
  end if;

  -- Fast path: an idempotent replay of a key we already hold never contends
  -- for the lock. This is the overwhelmingly common retry shape.
  select * into v_row
  from public.analysis_permits p
  where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
  if found then
    result := 'accepted';
    permit_id := v_row.id;
    permit_status := v_row.status;
    permit_outcome := v_row.outcome;
    permit_created_at := v_row.created_at;
    return next;
    return;
  end if;

  -- Serialize the check-then-insert for this user. This is the fix.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Re-check under the lock: a concurrent request with the SAME key may have
  -- inserted between the fast-path read above and acquiring the lock.
  select * into v_row
  from public.analysis_permits p
  where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
  if found then
    result := 'accepted';
    permit_id := v_row.id;
    permit_status := v_row.status;
    permit_outcome := v_row.outcome;
    permit_created_at := v_row.created_at;
    return next;
    return;
  end if;

  -- IDENTITY LEDGER: the scored count is the identity-aware
  -- lifetime_scored_count(), never the raw shots count of this account row.
  select
    coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false),
    public.lifetime_scored_count(),
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = v_uid
        and p.status = 'reserved'
        and p.created_at > now() - interval '24 hours'
    )
  into v_premium, v_scored, v_reserved;

  v_remaining := 2 - least(v_scored, 2);

  if not v_premium and v_remaining <= v_reserved then
    result := 'access.paywall_required';
    return next;
    return;
  end if;

  insert into public.analysis_permits (user_id, idempotency_key)
  values (v_uid, p_idempotency_key)
  returning * into v_row;

  result := 'accepted';
  permit_id := v_row.id;
  permit_status := v_row.status;
  permit_outcome := v_row.outcome;
  permit_created_at := v_row.created_at;
  return next;
  return;
exception
  when unique_violation then
    -- Same-key insert settled concurrently despite the lock (possible only if
    -- a caller bypasses this function). Return the winner — idempotent by
    -- contract, never a spurious 402.
    select * into v_row
    from public.analysis_permits p
    where p.user_id = v_uid and p.idempotency_key = p_idempotency_key;
    if found then
      result := 'accepted';
      permit_id := v_row.id;
      permit_status := v_row.status;
      permit_outcome := v_row.outcome;
      permit_created_at := v_row.created_at;
      return next;
      return;
    end if;
    raise;
end;
$$;

comment on function public.reserve_analysis_permit(text) is
  'Atomic POST /v1/analysis-permits reserve: idempotent lookup, lifetime free-rating check (identity-aware via lifetime_scored_count(), so it survives account deletion), and insert in one statement under a per-user advisory lock.';

-- ---------------------------------------------------------------------------
-- 9. apply_synced_shot(shot jsonb) — unchanged except the FREE-LIMIT BACKSTOP
--    count (marked IDENTITY LEDGER below). Recreated in full.
-- ---------------------------------------------------------------------------
create or replace function public.apply_synced_shot(shot jsonb)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_permit_id uuid;
  v_session_id uuid;
  v_result_kind text;
  v_permit public.analysis_permits%rowtype;
  v_premium boolean;
  entry jsonb;
begin
  if v_uid is null then
    return 'auth.required';
  end if;

  v_id := (shot ->> 'id')::uuid;
  v_permit_id := (shot ->> 'analysisPermitId')::uuid;
  v_session_id := nullif(shot ->> 'sessionId', '')::uuid;
  v_result_kind := shot ->> 'resultKind';

  -- Idempotent replay: this user already owns the row. Checked before the
  -- lock so replays never contend.
  if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
    return 'accepted';
  end if;

  -- FREE-LIMIT BACKSTOP (1/2): take the same per-user lock reserve_analysis_
  -- permit uses, so the scored-shot count below cannot change under us and
  -- two concurrent syncs holding DIFFERENT permits cannot both pass it.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- Lock the permit so a concurrent retry of the same sync serializes here.
  select * into v_permit
  from public.analysis_permits p
  where p.id = v_permit_id and p.user_id = v_uid
  for update;
  if not found then
    return 'access.permit_not_found';
  end if;
  if v_permit.status <> 'reserved' then
    return 'access.permit_not_reserved';
  end if;
  if v_permit.created_at <= now() - interval '24 hours' then
    update public.analysis_permits
       set status = 'released', outcome = 'expired'
     where id = v_permit_id and user_id = v_uid and status = 'reserved';
    return 'access.permit_expired';
  end if;

  -- FREE-LIMIT BACKSTOP (2/2): holding a reserved permit is not by itself
  -- authority to record a scored shot. If an extra permit was ever issued
  -- (every build before reserve_analysis_permit could do this), a non-premium
  -- account still may not exceed two lifetime scored ratings. The permit is
  -- released rather than left reserved so it stops occupying an allowance
  -- slot and the sweep has nothing to collect.
  -- IDENTITY LEDGER: the count is lifetime_scored_count(), so a re-created
  -- account whose identity already spent both ratings is refused here too.
  if v_result_kind = 'scored' then
    select coalesce((
      select b.premium and (b.expires_at is null or b.expires_at > now())
      from public.billing_entitlements b
      where b.user_id = v_uid
    ), false) into v_premium;

    if not v_premium and public.lifetime_scored_count() >= 2 then
      update public.analysis_permits
         set status = 'released', outcome = 'free_limit_exceeded'
       where id = v_permit_id and user_id = v_uid and status = 'reserved';
      return 'access.paywall_required';
    end if;
  end if;

  if v_session_id is not null and not exists (
    select 1 from public.sessions se
    where se.id = v_session_id and se.user_id = v_uid
  ) then
    return 'shot.session_not_found';
  end if;

  -- Atomic write block: any failure rolls back the shot, its details, AND
  -- leaves the permit untouched (still reserved for a clean retry).
  begin
    insert into public.shots (
      id, user_id, session_id, shot_type, camera_view, captured_at,
      start_ms, contact_ms, end_ms, overall_score, analysis_confidence,
      result_kind, app_version, model_bundle_version, pose_model_version,
      paddle_model_version, stroke_detector_version, phase_model_version,
      scoring_model_version, shot_config_version, source
    ) values (
      v_id,
      v_uid,
      v_session_id,
      shot ->> 'shotType',
      shot ->> 'cameraView',
      (shot ->> 'capturedAt')::timestamptz,
      (shot ->> 'startMs')::int,
      (shot ->> 'contactMs')::int,
      (shot ->> 'endMs')::int,
      (shot ->> 'overallScore')::numeric,
      (shot ->> 'confidence')::numeric,
      v_result_kind,
      shot -> 'versionVector' ->> 'appVersion',
      shot -> 'versionVector' ->> 'modelBundleVersion',
      shot -> 'versionVector' ->> 'poseModelVersion',
      shot -> 'versionVector' ->> 'paddleModelVersion',
      shot -> 'versionVector' ->> 'strokeDetectorVersion',
      shot -> 'versionVector' ->> 'phaseModelVersion',
      shot -> 'versionVector' ->> 'scoringModelVersion',
      shot -> 'versionVector' ->> 'shotConfigVersion',
      'real'
    );

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'phases', '[]'::jsonb))
    loop
      insert into public.shot_phases (
        shot_id, user_id, phase_key, start_ms, representative_ms, end_ms, confidence
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'startMs')::int,
        (entry ->> 'representativeMs')::int,
        (entry ->> 'endMs')::int,
        (entry ->> 'confidence')::numeric
      )
      on conflict (shot_id, phase_key) do nothing;
    end loop;

    for entry in select * from jsonb_array_elements(coalesce(shot -> 'checkpoints', '[]'::jsonb))
    loop
      insert into public.shot_checkpoints (
        shot_id, user_id, checkpoint_key, score, confidence, band,
        direction, severity, applicable
      ) values (
        v_id,
        v_uid,
        entry ->> 'key',
        (entry ->> 'score')::numeric,
        (entry ->> 'confidence')::numeric,
        entry ->> 'band',
        entry ->> 'direction',
        (entry ->> 'severity')::numeric,
        (entry ->> 'applicable')::boolean
      )
      on conflict (shot_id, checkpoint_key) do nothing;
    end loop;

    -- A scored shot finalizes its permit; an abstention releases it — in the
    -- SAME transaction as the shot write (the atomicity services/api had).
    update public.analysis_permits
       set status = case when v_result_kind = 'scored' then 'finalized' else 'released' end,
           outcome = v_result_kind
     where id = v_permit_id and user_id = v_uid and status = 'reserved';

    return 'accepted';
  exception
    when unique_violation then
      -- The shot id settled concurrently. Ours → replay-accept; a different
      -- user's id (invisible under RLS) → permanent conflict.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      return 'shot.id_conflict';
    when others then
      return 'shot.write_failed:' || sqlerrm;
  end;
end;
$$;

comment on function public.apply_synced_shot(jsonb) is
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Also enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(), so neither an over-issued permit nor a deleted-and-recreated account can become an extra free rating.';
