-- ============================================================================
-- Pickle Sensei — scale + security hardening for launch.
--
-- 1. access_state() RPC        — the access computation (billing + scored
--                                count + reserved holds) in ONE round trip
--                                instead of three sequential PostgREST calls.
-- 2. apply_synced_shot() RPC   — the whole shot-sync write (shot + phases +
--                                checkpoints + permit consumption) as ONE
--                                ATOMIC transaction instead of ~7 sequential
--                                client round trips with compensating deletes.
-- 3. Indexes                   — partial indexes matching the access counter
--                                and the rank view's aggregate exactly.
-- 4. account_deletion_requests — server side of the two-step account
--                                deletion (request → challenge → confirm).
-- 5. webhook_events            — RevenueCat webhook audit/idempotency log,
--                                service-role only.
-- 6. Payload size guards       — DB-level caps behind the API's own limits
--                                (defense in depth for jsonb intake).
-- 7. Anon hygiene              — revoke anon on the derived views.
-- 8. pg_cron maintenance jobs  — async cleanup so no request path ever pays
--                                for housekeeping (stale permits, expired
--                                deletion requests, old webhook events).
--
-- Everything here is additive; RLS posture is unchanged: owner-only user
-- tables, service-role-only billing/webhook writes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. access_state() — SECURITY INVOKER: runs under the calling user's RLS,
--    so it can only ever count that user's own rows.
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
    (
      select count(*)::int from public.shots s
      where s.user_id = (select auth.uid()) and s.result_kind = 'scored'
    ) as scored_count,
    (
      select count(*)::int from public.analysis_permits p
      where p.user_id = (select auth.uid())
        and p.status = 'reserved'
        and p.created_at > now() - interval '24 hours'
    ) as reserved_count
$$;

comment on function public.access_state() is
  'Single-round-trip access computation for GET /v1/me/access: verified premium (unexpired), lifetime scored-shot count, and fresh reserved permit count. SECURITY INVOKER — RLS scopes every subquery to the caller.';

revoke all on function public.access_state() from public, anon;
grant execute on function public.access_state() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. apply_synced_shot(shot jsonb) — one atomic transaction per synced shot.
--    SECURITY INVOKER: every statement runs under the caller's RLS (insert
--    policies force user_id = auth.uid(); the permit row lock only ever finds
--    the caller's own permit). The Edge Function fully validates the payload
--    shape BEFORE calling; this function enforces ownership, permit state,
--    and atomicity. Returns a status code string the API maps verbatim:
--      accepted | access.permit_not_found | access.permit_not_reserved |
--      access.permit_expired | shot.session_not_found | shot.id_conflict |
--      shot.write_failed:<detail>   (detail is logged server-side only)
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
  entry jsonb;
begin
  if v_uid is null then
    return 'auth.required';
  end if;

  v_id := (shot ->> 'id')::uuid;
  v_permit_id := (shot ->> 'analysisPermitId')::uuid;
  v_session_id := nullif(shot ->> 'sessionId', '')::uuid;
  v_result_kind := shot ->> 'resultKind';

  -- Idempotent replay: this user already owns the row.
  if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
    return 'accepted';
  end if;

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
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Replaces the Edge Function''s sequential writes with compensating deletes.';

revoke all on function public.apply_synced_shot(jsonb) from public, anon;
grant execute on function public.apply_synced_shot(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Indexes matching the hot paths exactly.
-- ---------------------------------------------------------------------------
-- access_state(): count of scored shots per user.
create index if not exists shots_user_scored_idx
  on public.shots (user_id)
  where result_kind = 'scored';

-- player_technique_rating / recompute_player_rank: per-technique averages
-- over scored real shots (index-only scannable).
create index if not exists shots_user_type_scored_idx
  on public.shots (user_id, shot_type)
  include (overall_score, captured_at)
  where source = 'real' and result_kind = 'scored' and overall_score is not null;

-- ---------------------------------------------------------------------------
-- 4. Two-step account deletion. Step 1 (POST /v1/me/delete-request) writes a
--    short-lived challenge AS THE USER; step 2 (POST /v1/me/delete-confirm)
--    verifies the challenge and only then deletes the auth user with the
--    service role — the cascade (auth.users → profiles → every user table)
--    removes all data. A single accidental API call can never delete an
--    account: it takes the fresh challenge from a separate prior request.
-- ---------------------------------------------------------------------------
create table if not exists public.account_deletion_requests (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  challenge uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);

comment on table public.account_deletion_requests is
  'Pending two-step account deletions: POST /v1/me/delete-request upserts a 15-minute challenge; POST /v1/me/delete-confirm must present it before the service role deletes the auth user (cascading all data).';

alter table public.account_deletion_requests enable row level security;

drop policy if exists "deletion_requests_select_own" on public.account_deletion_requests;
create policy "deletion_requests_select_own"
  on public.account_deletion_requests for select
  to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "deletion_requests_insert_own" on public.account_deletion_requests;
create policy "deletion_requests_insert_own"
  on public.account_deletion_requests for insert
  to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "deletion_requests_update_own" on public.account_deletion_requests;
create policy "deletion_requests_update_own"
  on public.account_deletion_requests for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "deletion_requests_delete_own" on public.account_deletion_requests;
create policy "deletion_requests_delete_own"
  on public.account_deletion_requests for delete
  to authenticated using ((select auth.uid()) = user_id);

revoke all on public.account_deletion_requests from anon;
grant select, insert, update, delete
  on public.account_deletion_requests to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Webhook event log — audit + idempotency for the RevenueCat webhook.
--    Service-role only: RLS is enabled with NO policies and no client grants,
--    so neither anon nor authenticated can read or write a single row.
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_events (
  id text primary key,
  provider text not null default 'revenuecat',
  event_type text,
  app_user_id text,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

comment on table public.webhook_events is
  'Received billing webhook events (audit + replay-dedupe). Written only by the Edge Function''s service-role client after shared-secret verification; entitlement state itself is still re-verified against RevenueCat''s API, never trusted from the event body.';

alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Payload guards behind the API's own validation (defense in depth).
--    NOT VALID: enforced for all NEW writes without a table scan of history.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'evaluation_trials_payload_size'
  ) then
    alter table public.evaluation_trials
      add constraint evaluation_trials_payload_size
      check (pg_column_size(payload) <= 262144) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'consent_records_device_size'
  ) then
    alter table public.consent_records
      add constraint consent_records_device_size
      check (device is null or pg_column_size(device) <= 16384) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_first_name_length'
  ) then
    alter table public.profiles
      add constraint profiles_first_name_length
      check (first_name is null or char_length(first_name) <= 80) not valid;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Anon hygiene on derived views (underlying RLS already blocks anon; this
--    removes even the surface grant).
-- ---------------------------------------------------------------------------
revoke all on public.progress_daily from anon;
revoke all on public.practice_days from anon;

-- ---------------------------------------------------------------------------
-- 8. Async maintenance via pg_cron. Job names are stable, so re-running this
--    migration (or editing schedules later) replaces rather than duplicates.
--    Guarded: an environment without pg_cron logs a notice instead of
--    failing the deploy — every job here is cleanup, not correctness (the
--    request path already lazily expires stale permits).
-- ---------------------------------------------------------------------------
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension pg_cron;
    exception when others then
      raise notice 'pg_cron unavailable (%). Skipping maintenance schedules.', sqlerrm;
      return;
    end;
  end if;

  -- Stale reserved permits: the API already ignores/lazily releases them;
  -- this keeps the table itself truthful without user-facing writes.
  perform cron.schedule(
    'expire-stale-analysis-permits',
    '17 * * * *',
    'update public.analysis_permits set status = ''released'', outcome = ''expired'' where status = ''reserved'' and created_at < now() - interval ''24 hours'''
  );

  perform cron.schedule(
    'purge-expired-deletion-requests',
    '23 3 * * *',
    'delete from public.account_deletion_requests where expires_at < now() - interval ''1 day'''
  );

  perform cron.schedule(
    'purge-old-webhook-events',
    '41 4 * * *',
    'delete from public.webhook_events where received_at < now() - interval ''90 days'''
  );
end
$cron$;
