-- 20260905000000_shots_insert_only_via_rpc.sql
--
-- A client session may only create public.shots rows through
-- apply_synced_shot(jsonb). Until now the INSERT grant that the SECURITY
-- INVOKER RPC needs for its own write was equally usable by PostgREST
-- (`POST /rest/v1/shots` with the user's access token), so an authenticated
-- session could record a scored shot with no analysis permit, past the two
-- lifetime free ratings, with client-chosen overall_score / result_kind /
-- *_version columns — under its own user_id, but outside every quota and
-- integrity check the RPC performs (AGENTS.md: "sync is INSERT-only via the
-- RPC"; docs/SECURITY_CERTIFICATION_2026-08-30.md: score/version columns are
-- not client-writable).
--
-- Root-cause fix, in two halves that only work together:
--
--   1. A BEFORE INSERT trigger on public.shots (shots_insert_only_via_rpc)
--      refuses every row written by the client roles (anon, authenticated)
--      unless the transaction-local setting `pickle.apply_synced_shot` holds
--      exactly the id of the row being inserted. The setting is consumed by
--      the trigger, so one arm admits one row. Owner/service/definer writes
--      (postgres, service_role, FK cascades, the rank + ledger triggers) are
--      untouched: they never ran under a client role.
--   2. apply_synced_shot() — recreated below, byte-for-byte the 20260902150000
--      body plus the arm/disarm around its single INSERT — sets that setting
--      immediately before the insert, after the permit, expiry, free-limit
--      and session checks have passed.
--
-- Why not revoke INSERT and make the RPC SECURITY DEFINER: the RPC is
-- SECURITY INVOKER on purpose (RLS and the caller's grants apply to every
-- statement in it, see 20260831000000), and the identity ledger + rank
-- triggers already run as definer with their own pins. Keeping INVOKER and
-- gating the table itself is the smaller change and leaves the grant layer
-- exactly as the certification describes it.
--
-- Why a GUC is safe as the token: PostgREST exposes only functions in the
-- exposed schema, so a client can neither run SET nor call
-- pg_catalog.set_config; request.* GUCs it does set live in another
-- namespace; and the value must equal the row's own id, so a leaked arm from
-- another statement cannot be reused. The arm is transaction-local
-- (set_config(..., true)) and cleared by the trigger on first use.
--
-- Static pin: supabase/functions/api/__wf__/db_migrations_rls_indexes.test.ts
-- ("shots: a client session can only INSERT through apply_synced_shot()").
-- Live: supabase/tests/security_regression.sql E0 (denied direct insert,
-- counters unchanged) and every section that syncs through the RPC;
-- supabase/tests/adjudication_db_rls_grants_isolation.sql ADJ-C1..C4.

-- ---------------------------------------------------------------------------
-- 1. The guard.
-- ---------------------------------------------------------------------------
create or replace function public.shots_insert_only_via_rpc()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_armed text := pg_catalog.current_setting('pickle.apply_synced_shot', true);
begin
  if current_user in ('anon', 'authenticated')
     and (v_armed is null or v_armed <> new.id::text) then
    raise exception 'shots are written only by apply_synced_shot() (POST /v1/shots:sync)'
      using errcode = 'insufficient_privilege';
  end if;
  -- One arm admits exactly one row.
  if v_armed is not null and v_armed <> '' then
    perform pg_catalog.set_config('pickle.apply_synced_shot', '', true);
  end if;
  return new;
end;
$$;

revoke all on function public.shots_insert_only_via_rpc() from public, anon, authenticated;

comment on function public.shots_insert_only_via_rpc() is
  'BEFORE INSERT guard on public.shots: client roles (anon, authenticated) may only insert the row apply_synced_shot() armed via the transaction-local setting pickle.apply_synced_shot (= the row id); the arm is consumed on use. Raises 42501 otherwise.';

drop trigger if exists shots_insert_only_via_rpc on public.shots;
create trigger shots_insert_only_via_rpc
  before insert on public.shots
  for each row execute function public.shots_insert_only_via_rpc();

-- ---------------------------------------------------------------------------
-- 2. apply_synced_shot(shot jsonb) — the 20260902150000 body, recreated in
--    full, with the arm/disarm around its INSERT (marked INSERT GUARD).
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
    -- INSERT GUARD: admit exactly this row through shots_insert_only_via_rpc.
    -- Every check above has passed; the trigger consumes the arm on use and
    -- the explicit disarm below covers an insert that never reached it.
    perform pg_catalog.set_config('pickle.apply_synced_shot', v_id::text, true);
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
    perform pg_catalog.set_config('pickle.apply_synced_shot', '', true);

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
      perform pg_catalog.set_config('pickle.apply_synced_shot', '', true);
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      return 'shot.id_conflict';
    when others then
      perform pg_catalog.set_config('pickle.apply_synced_shot', '', true);
      return 'shot.write_failed:' || sqlerrm;
  end;
end;
$$;

revoke all on function public.apply_synced_shot(jsonb) from public, anon;

comment on function public.apply_synced_shot(jsonb) is
  'Atomic POST /v1/shots:sync write: shot + phases + checkpoints + permit consumption in one transaction under the caller''s RLS. Enforces the lifetime free-rating limit for scored shots (access.paywall_required) under the shared per-user advisory lock using the identity-aware lifetime_scored_count(), and is the ONLY path a client session can insert a public.shots row through (it arms the shots_insert_only_via_rpc guard for exactly the row it writes).';
