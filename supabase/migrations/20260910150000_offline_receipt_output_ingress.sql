-- W04-04 (round 7): the output a receipt carries is judged and STORED like a
-- synced shot — for the ticket path in the frozen wire shape, and for the Pro
-- lease path at all.
--
-- Three defects in the round-6 settlement, all on the output side:
--   * the frozen 1.0 wire `output` is the shot.sync payload without
--     analysisPermitId — timestamps NESTED under `timestamps` and
--     `source: "real"` — but consume_offline_ticket() reads the offsets flat
--     (p_shot ->> 'startMs' …), so every honest ticketed receipt failed the
--     NOT NULL start_ms and was HELD as evidence_ambiguous for good;
--   * the Pro (no-ticket) branch answered result_recorded / settled for a
--     complete scored output and wrote it NOWHERE: the receipt is the only
--     channel that carries an offline-rated shot (the device writes no
--     shot.sync outbox row and marks the local shot synced on result_recorded),
--     so a subscriber's offline rating existed only on the device;
--   * nothing on the offline write applied the field rules the shots:sync
--     ingress applies (negative / INT_MIN / fractional / string offsets, score
--     and confidence ranges, phase and checkpoint shapes), so a ticket and a
--     free rating could be consumed for a row the online path refuses.
--
-- Now:
--   * api_private.offline_receipt_shot(jsonb) is the one ingress judge for a
--     delivered output: it accepts the frozen nested shape AND the pre-contract
--     flat shape (never both at once), applies the parseSyncShot field rules,
--     and returns the FLAT object consume_offline_ticket() reads — or NULL,
--     which settle_offline_receipt() records as a durable evidence_ambiguous
--     HOLD (ticket untouched, nothing stored), decided BEFORE any reversible
--     freeze short-circuit: the freeze does not make evidence better or worse;
--   * a chargeable Pro receipt is recorded ONLY once its rating is durable in
--     public.shots (+ phases / checkpoints), written by
--     api_private.record_offline_lease_shot() under a THIRD vouch the shots
--     gate verifies — pickle.offline_lease_grant_id must name a verified_store
--     grant of the caller — after the settlement has checked that the grant the
--     receipt names is that lease, issued to the caller for the installation
--     the receipt names. A no-ticket chargeable receipt under a FREE grant (an
--     identity_lifetime_free grant always allocates tickets) is ambiguous
--     evidence, never a stored rating: a free identity gets no third rating by
--     omitting its ticket. financial_disposition stays not_applicable on every
--     lease path; the allocation ledger is never touched. A rating the server
--     already holds for the caller under this id is already durable — recorded,
--     nothing written twice; another owner's row under the id is a
--     conflicting_receipt HOLD; a session that has not synced is pending
--     (nothing durable, the identical redelivery settles once it exists).
--
-- The rest of settle_offline_receipt() is byte-for-byte 20260910130000: the
-- shape checks, the lock order, the durable replay / conflict decision before
-- the freeze, every hold reason, the ticket lineage read, the ledger's terminal
-- verdict, p_defer_new default false. The signature is unchanged (the 4-argument
-- call still resolves) and the exact grants/revokes are re-applied. The
-- applied migrations are not edited.

-- 1. The ingress judge. Field rules mirror parseSyncShot() in
--    supabase/functions/api/index.ts: uuid id; sessionId null or uuid;
--    shotType 1-64 chars; cameraView side|rear_oblique; capturedAt a timestamp;
--    startMs/endMs integers in [0, 2147483647], contactMs the same or null;
--    resultKind scored|low_confidence|partial; overallScore in [0, 10] for a
--    scored row and null otherwise; confidence in [0, 1]; ≤ 32 phases with
--    unique 1-64 char keys, bounded offsets and unit confidence; ≤ 64
--    checkpoints with unique keys, score null or in [0, 100], unit confidence
--    and severity, band green|yellow|red|unscored, direction ≤ 64 chars,
--    boolean applicable; all eight versionVector labels 1-64 chars. A receipt
--    carries no permit: analysisPermitId must be absent or null. `source`
--    must be absent or 'real' (the row is written as real). The offsets are
--    named once: nested `timestamps` OR flat startMs/contactMs/endMs.
create or replace function api_private.offline_ms(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
    and jsonb_typeof(p) = 'number'
    and (p #>> '{}') ~ '^[0-9]+$'
    and (p #>> '{}')::numeric <= 2147483647
$$;

create or replace function api_private.offline_unit(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
    and jsonb_typeof(p) = 'number'
    and (p #>> '{}')::numeric >= 0
    and (p #>> '{}')::numeric <= 1
$$;

create or replace function api_private.offline_label(p jsonb, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
    and jsonb_typeof(p) = 'string'
    and btrim(p #>> '{}') <> ''
    and length(p #>> '{}') <= p_max
$$;

create or replace function api_private.offline_receipt_shot(p_output jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ts jsonb;
  v_kind text;
  v_score jsonb;
  v_list jsonb;
  entry jsonb;
  v_keys text[];
  v_label text;
begin
  if p_output is null or jsonb_typeof(p_output) <> 'object' then
    return null;
  end if;
  if (p_output ->> 'id') is null
     or (p_output ->> 'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  if p_output ? 'source' and p_output -> 'source' <> '"real"'::jsonb then
    return null;
  end if;
  if p_output ? 'analysisPermitId' and jsonb_typeof(p_output -> 'analysisPermitId') <> 'null' then
    return null;
  end if;
  if p_output ? 'sessionId' and jsonb_typeof(p_output -> 'sessionId') <> 'null'
     and ((p_output ->> 'sessionId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
    return null;
  end if;
  if not api_private.offline_label(p_output -> 'shotType', 64) then
    return null;
  end if;
  if (p_output ->> 'cameraView') is null or (p_output ->> 'cameraView') not in ('side', 'rear_oblique') then
    return null;
  end if;
  if jsonb_typeof(p_output -> 'capturedAt') is distinct from 'string' then
    return null;
  end if;
  begin
    perform (p_output ->> 'capturedAt')::timestamptz;
  exception when others then
    return null;
  end;

  -- The offsets: nested (frozen wire shape) or flat (pre-contract), never both.
  if p_output ? 'timestamps' then
    if p_output ? 'startMs' or p_output ? 'contactMs' or p_output ? 'endMs'
       or jsonb_typeof(p_output -> 'timestamps') <> 'object' then
      return null;
    end if;
    v_ts := p_output -> 'timestamps';
  else
    v_ts := jsonb_build_object(
      'startMs', p_output -> 'startMs',
      'contactMs', p_output -> 'contactMs',
      'endMs', p_output -> 'endMs');
  end if;
  if not api_private.offline_ms(v_ts -> 'startMs')
     or not api_private.offline_ms(v_ts -> 'endMs')
     or (jsonb_typeof(v_ts -> 'contactMs') is distinct from 'null'
         and not api_private.offline_ms(v_ts -> 'contactMs')) then
    return null;
  end if;

  v_kind := p_output ->> 'resultKind';
  if v_kind is null or v_kind not in ('scored', 'low_confidence', 'partial') then
    return null;
  end if;
  v_score := p_output -> 'overallScore';
  if v_kind = 'scored' then
    if v_score is null or jsonb_typeof(v_score) <> 'number'
       or (v_score #>> '{}')::numeric < 0 or (v_score #>> '{}')::numeric > 10 then
      return null;
    end if;
  elsif v_score is not null and jsonb_typeof(v_score) <> 'null' then
    return null;
  end if;
  if not api_private.offline_unit(p_output -> 'confidence') then
    return null;
  end if;

  v_list := coalesce(p_output -> 'phases', '[]'::jsonb);
  if jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) > 32 then
    return null;
  end if;
  v_keys := '{}';
  for entry in select * from jsonb_array_elements(v_list)
  loop
    if jsonb_typeof(entry) <> 'object'
       or not api_private.offline_label(entry -> 'key', 64)
       or not api_private.offline_ms(entry -> 'startMs')
       or not api_private.offline_ms(entry -> 'representativeMs')
       or not api_private.offline_ms(entry -> 'endMs')
       or not api_private.offline_unit(entry -> 'confidence') then
      return null;
    end if;
    v_label := entry ->> 'key';
    if v_label = any (v_keys) then
      return null;
    end if;
    v_keys := v_keys || v_label;
  end loop;

  v_list := coalesce(p_output -> 'checkpoints', '[]'::jsonb);
  if jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) > 64 then
    return null;
  end if;
  v_keys := '{}';
  for entry in select * from jsonb_array_elements(v_list)
  loop
    if jsonb_typeof(entry) <> 'object'
       or not api_private.offline_label(entry -> 'key', 64)
       or (jsonb_typeof(entry -> 'score') is distinct from 'null'
           and (jsonb_typeof(entry -> 'score') is distinct from 'number'
                or (entry ->> 'score')::numeric < 0 or (entry ->> 'score')::numeric > 100))
       or not api_private.offline_unit(entry -> 'confidence')
       or (entry ->> 'band') is null or (entry ->> 'band') not in ('green', 'yellow', 'red', 'unscored')
       or jsonb_typeof(entry -> 'direction') is distinct from 'string'
       or length(entry ->> 'direction') > 64
       or not api_private.offline_unit(entry -> 'severity')
       or jsonb_typeof(entry -> 'applicable') is distinct from 'boolean' then
      return null;
    end if;
    v_label := entry ->> 'key';
    if v_label = any (v_keys) then
      return null;
    end if;
    v_keys := v_keys || v_label;
  end loop;

  if jsonb_typeof(p_output -> 'versionVector') is distinct from 'object' then
    return null;
  end if;
  foreach v_label in array array[
    'appVersion', 'modelBundleVersion', 'poseModelVersion', 'paddleModelVersion',
    'strokeDetectorVersion', 'phaseModelVersion', 'scoringModelVersion', 'shotConfigVersion']
  loop
    if not api_private.offline_label(p_output -> 'versionVector' -> v_label, 64) then
      return null;
    end if;
  end loop;

  return (p_output - 'timestamps') || jsonb_build_object(
    'startMs', v_ts -> 'startMs',
    'contactMs', coalesce(v_ts -> 'contactMs', 'null'::jsonb),
    'endMs', v_ts -> 'endMs',
    'phases', coalesce(p_output -> 'phases', '[]'::jsonb),
    'checkpoints', coalesce(p_output -> 'checkpoints', '[]'::jsonb));
end;
$$;

comment on function api_private.offline_receipt_shot(jsonb) is
  'The ingress judge for the output a delayed offline receipt carries: the frozen 1.0 wire shape (shot.sync payload without analysisPermitId, timestamps nested) or the pre-contract flat shape, never both, under the parseSyncShot field rules (uuid id, bounded non-negative integer offsets, score/confidence ranges, phase/checkpoint shapes and unique keys, version vector labels; no permit; source absent or real). Returns the FLAT object consume_offline_ticket() and record_offline_lease_shot() read, or NULL when the online ingress would refuse the shot — settle_offline_receipt() holds that as evidence_ambiguous.';

revoke all on function api_private.offline_ms(jsonb) from public, anon, authenticated, service_role;
revoke all on function api_private.offline_unit(jsonb) from public, anon, authenticated, service_role;
revoke all on function api_private.offline_label(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function api_private.offline_receipt_shot(jsonb) from public, anon, authenticated, service_role;

-- 2. The shots gate learns the lease vouch. pickle.offline_lease_grant_id is
--    set only by record_offline_lease_shot() (not client-executable; PostgREST
--    exposes no set_config) around its one insert; the gate re-verifies that
--    the grant is a verified_store lease of the caller. A row under the lease
--    vouch names neither a permit nor a ticket. Everything else — the permit
--    and ticket vouches, the direct-INSERT budget, the lock — is byte-for-byte
--    20260908160000.
create or replace function public.enforce_scored_shot_permit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
  v_vouched uuid;
  v_ticket uuid;
  v_lease uuid;
begin
  if v_uid is null then
    return new;
  end if;

  -- apply_synced_shot() names the permit, consume_offline_ticket() the
  -- ticket, record_offline_lease_shot() the lease, each locked and validated
  -- for this insert. Nothing else can set any of them (PostgREST exposes no
  -- set_config and the schema-exposed RPCs never take them from input).
  v_vouched := nullif(pg_catalog.current_setting('pickle.sync_permit_id', true), '')::uuid;
  v_ticket := nullif(pg_catalog.current_setting('pickle.offline_ticket_id', true), '')::uuid;
  v_lease := nullif(pg_catalog.current_setting('pickle.offline_lease_grant_id', true), '')::uuid;

  -- The settlement links are the vouches' to write: a direct INSERT may not
  -- claim a permit or a ticket, a vouched insert records exactly its vouch.
  if new.analysis_permit_id is not null
     and (v_vouched is null or new.analysis_permit_id <> v_vouched) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: analysis_permit_id is written only by apply_synced_shot for the permit it consumed',
      hint = 'access.permit_not_reserved';
  end if;
  if new.offline_ticket_id is not null
     and (v_ticket is null or new.offline_ticket_id <> v_ticket) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: offline_ticket_id is written only by consume_offline_ticket for the ticket it settled',
      hint = 'offline.shot_not_chargeable';
  end if;
  if (v_vouched is not null and v_ticket is not null)
     or (v_lease is not null and (v_vouched is not null or v_ticket is not null)) then
    raise exception using
      errcode = 'check_violation',
      message = 'shots: a rating is settled by one permit, one ticket or one lease, never more',
      hint = 'offline.shot_not_chargeable';
  end if;
  new.analysis_permit_id := v_vouched;
  new.offline_ticket_id := v_ticket;

  if new.result_kind <> 'scored' then
    return new;
  end if;

  -- Same key as reserve_analysis_permit() / apply_synced_shot() /
  -- issue_offline_grant() / consume_offline_ticket(): a direct writer racing
  -- itself (or a sync, or an allocation) serializes here. Re-entrant inside
  -- the RPCs, which already hold it for this transaction.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  select coalesce((
    select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b
    where b.user_id = v_uid
  ), false) into v_premium;

  if v_ticket is not null then
    -- Settlement path: the ONE ticket the row names must be an outstanding
    -- allocation owned by the caller's account or sign-in identities. The
    -- budget was decided when the ticket was allocated; consuming it turns
    -- a hold into a rating and moves the identity's total by zero.
    if not exists (
      select 1 from public.offline_allocation_ledger a
      where a.ticket_id = v_ticket
        and a.event = 'allocated'
        and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid)
        and not exists (
          select 1 from public.offline_allocation_ledger t
          where t.ticket_id = a.ticket_id and t.event in ('consumed', 'released')
        )
    ) then
      raise exception using
        errcode = 'check_violation',
        message = 'shots: the ticket named for this settled shot is not an outstanding allocation of the caller',
        hint = 'offline.shot_not_chargeable';
    end if;
    return new;
  end if;

  if v_lease is not null then
    -- Lease path: the ONE grant the settlement vouches for must be a
    -- verified_store lease the server issued to the caller. The lease WAS the
    -- verified entitlement when the rating was rendered; it never allocates
    -- tickets, so a free identity's grant is never a lease.
    if not exists (
      select 1 from public.offline_grants g
      where g.id = v_lease
        and g.user_id = v_uid
        and g.entitlement_source = 'verified_store'
    ) then
      raise exception using
        errcode = 'check_violation',
        message = 'shots: the lease named for this settled shot is not a verified subscription lease of the caller',
        hint = 'offline.shot_not_chargeable';
    end if;
    return new;
  end if;

  if v_vouched is not null then
    -- Sync path: the ONE permit the shot names must back it. No fallback to
    -- any other reservation the caller may hold.
    if not exists (
      select 1 from public.analysis_permits p
      where p.user_id = v_uid
        and p.id = v_vouched
        and public.permit_backs_sync(p.status, p.outcome)
    ) then
      raise exception using
        errcode = 'PKP01',
        message = 'shots: the permit named for this synced shot is not acceptable backing',
        hint = 'access.permit_not_reserved';
    end if;
    -- FREE-LIMIT BACKSTOP: the permit being consumed is this rating's
    -- reservation; every outstanding offline ticket is a rating the device
    -- renders offline and will settle — the two together may not exceed the
    -- lifetime allowance.
    if not v_premium
       and public.lifetime_scored_count() + public.offline_hold_count() >= 2 then
      raise exception using
        errcode = 'PKP02',
        message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)',
        hint = 'access.paywall_required';
    end if;
    return new;
  end if;

  -- Direct client INSERT: a live reserved permit younger than 24h, as before.
  if not exists (
    select 1 from public.analysis_permits p
    where p.user_id = v_uid
      and p.status = 'reserved'
      and p.created_at > now() - interval '24 hours'
  ) then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: a scored shot requires a live reserved analysis permit (use apply_synced_shot)',
      hint = 'access.permit_not_reserved';
  end if;

  -- The live permit that admits this row is the slot the row spends; every
  -- OTHER live reservation and every outstanding offline ticket is a rating
  -- already promised elsewhere. The row fits only if scored + those + this
  -- one stay within the allowance — so one live permit backs one direct
  -- rating, and never one beside a ticket that already holds the last unit
  -- (round-5 A01: this gate used to see only the lifetime count and a live
  -- permit, so a free identity kept an outstanding ticket beside two scored
  -- ratings).
  if not v_premium
     and public.lifetime_scored_count()
       + (public.online_reservation_count() - 1)
       + public.offline_hold_count() >= 2 then
    raise exception using
      errcode = 'insufficient_privilege',
      message = 'shots: the lifetime free-rating limit is spent (access.paywall_required)',
      hint = 'access.paywall_required';
  end if;

  return new;
end;
$$;

comment on function public.enforce_scored_shot_permit() is
  'BEFORE INSERT gate on public.shots. analysis_permit_id may only be the permit apply_synced_shot() vouches for (pickle.sync_permit_id) and offline_ticket_id only the ticket consume_offline_ticket() vouches for (pickle.offline_ticket_id); a direct client INSERT must leave both NULL (42501 otherwise), and no row carries both. A scored row written from a client session must be backed by: under the ticket vouch, THAT outstanding ticket of the caller (check_violation otherwise — the budget was decided at allocation); under the lease vouch record_offline_lease_shot() sets (pickle.offline_lease_grant_id), THAT verified_store grant of the caller (check_violation otherwise; the row names neither permit nor ticket); under the permit vouch, THAT permit alone (permit_backs_sync; PKP01) and lifetime scored + outstanding offline tickets < 2 (PKP02); as a direct INSERT, a live reserved permit (< 24h) and lifetime scored + other live online reservations + outstanding offline tickets < 2 (42501). At most one vouch per insert. Premium bypasses the allowance, never a permit, a ticket or a lease. Runs under the same per-user advisory lock as every other free-rating decision point.';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

-- 3. The lease write: the scored rating a Pro receipt carries becomes a
--    public.shots row (+ phases / checkpoints) under the lease vouch, in the
--    caller's name, with no permit and no ticket; the allocation ledger is not
--    involved. Mirrors consume_offline_ticket()'s atomic write block (any
--    failure rolls back the row, its details and the vouch together). Not
--    client-executable: settle_offline_receipt() calls it after verifying the
--    receipt's grant is the caller's lease.
create or replace function api_private.record_offline_lease_shot(p_grant_id uuid, p_shot jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_id uuid;
  v_session_id uuid;
  entry jsonb;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;
  if p_grant_id is null or p_shot is null or jsonb_typeof(p_shot) <> 'object'
     or p_shot ->> 'resultKind' is distinct from 'scored' then
    return 'offline.invalid_input';
  end if;
  begin
    v_id := (p_shot ->> 'id')::uuid;
    v_session_id := nullif(p_shot ->> 'sessionId', '')::uuid;
  exception when others then
    return 'offline.invalid_input';
  end;
  if v_id is null then
    return 'offline.invalid_input';
  end if;

  -- Same key as every other free-rating decision point; the settlement
  -- already holds it for this transaction.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  -- A rating the server already holds under this id: the caller's own row is
  -- already durable (nothing to write twice); another owner's row means the
  -- id is not this caller's to settle.
  if exists (select 1 from public.shots s where s.id = v_id) then
    return case
      when exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid)
        then 'accepted'
      else 'shot.id_conflict'
    end;
  end if;

  if v_session_id is not null and not exists (
    select 1 from public.sessions se
    where se.id = v_session_id and se.user_id = v_uid
  ) then
    return 'shot.session_not_found';
  end if;

  begin
    perform pg_catalog.set_config('pickle.offline_lease_grant_id', p_grant_id::text, true);

    insert into public.shots (
      id, user_id, session_id, shot_type, camera_view,
      captured_at, start_ms, contact_ms, end_ms, overall_score,
      analysis_confidence, result_kind, app_version, model_bundle_version,
      pose_model_version, paddle_model_version, stroke_detector_version,
      phase_model_version, scoring_model_version, shot_config_version, source
    ) values (
      v_id,
      v_uid,
      v_session_id,
      p_shot ->> 'shotType',
      p_shot ->> 'cameraView',
      (p_shot ->> 'capturedAt')::timestamptz,
      (p_shot ->> 'startMs')::int,
      (p_shot ->> 'contactMs')::int,
      (p_shot ->> 'endMs')::int,
      (p_shot ->> 'overallScore')::numeric,
      (p_shot ->> 'confidence')::numeric,
      'scored',
      p_shot -> 'versionVector' ->> 'appVersion',
      p_shot -> 'versionVector' ->> 'modelBundleVersion',
      p_shot -> 'versionVector' ->> 'poseModelVersion',
      p_shot -> 'versionVector' ->> 'paddleModelVersion',
      p_shot -> 'versionVector' ->> 'strokeDetectorVersion',
      p_shot -> 'versionVector' ->> 'phaseModelVersion',
      p_shot -> 'versionVector' ->> 'scoringModelVersion',
      p_shot -> 'versionVector' ->> 'shotConfigVersion',
      'real'
    );

    perform pg_catalog.set_config('pickle.offline_lease_grant_id', '', true);

    for entry in select * from jsonb_array_elements(coalesce(p_shot -> 'phases', '[]'::jsonb))
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

    for entry in select * from jsonb_array_elements(coalesce(p_shot -> 'checkpoints', '[]'::jsonb))
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

    return 'accepted';
  exception
    when unique_violation then
      -- The id landed concurrently despite the lock (a writer that did not
      -- hold it): the caller's own row is the rating, anyone else's is a
      -- collision.
      if exists (select 1 from public.shots s where s.id = v_id and s.user_id = v_uid) then
        return 'accepted';
      end if;
      return 'shot.id_conflict';
    when others then
      -- SQLSTATE ONLY: sqlerrm echoes the client's input for cast failures
      -- and would carry it into the edge function's logs.
      return 'shot.write_failed:' || sqlstate;
  end;
end;
$$;

comment on function api_private.record_offline_lease_shot(uuid, jsonb) is
  'Writes the scored rating a Pro (no-ticket) offline receipt carries as the caller''s public.shots row (+ phases/checkpoints) under the lease vouch pickle.offline_lease_grant_id the shots gate verifies against the caller''s verified_store grant; no permit, no ticket, no ledger event. Called only by settle_offline_receipt() after it verified the receipt names that lease (live API session required). Idempotent for a row the caller already holds under the id. Returns accepted | shot.id_conflict | shot.session_not_found | offline.invalid_input | shot.write_failed:<SQLSTATE>.';

revoke all on function api_private.record_offline_lease_shot(uuid, jsonb) from public, anon, authenticated, service_role;

-- 4. The settlement: the output is judged by the ingress judge before any
--    freeze short-circuit; the ticket branch consumes with the FLAT object;
--    the Pro branch requires the caller's lease and records the result only
--    once the rating is durable.
create or replace function public.settle_offline_receipt(
  p_receipt jsonb,
  p_receipt_sha256 text,
  p_output jsonb,
  p_hold_reason text,
  p_defer_new boolean default false
)
returns table (
  result text,
  delivery text,
  status text,
  reason_code text,
  financial_disposition text,
  result_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_defer boolean := coalesce(p_defer_new, false);
  v_receipt_id text;
  v_owner_id uuid;
  v_installation_key_id text;
  v_grant_id uuid;
  v_grant_jws_sha256 text;
  v_allocation_id uuid;
  v_generation bigint;
  v_ticket_id uuid;
  v_operation_id text;
  v_result_id text;
  v_output_sha256 text;
  v_billing text;
  v_sequence bigint;
  v_ticket jsonb;
  v_known public.offline_receipt_settlements%rowtype;
  v_allocation public.offline_allocation_ledger%rowtype;
  v_status text := 'result_recorded';
  v_reason text := null;
  v_financial text;
  v_recorded_result text := null;
  v_verdict text;
  v_shot jsonb;
begin
  if v_uid is null or not api_private.is_active_session() then
    raise exception 'API session authorization required' using errcode = 'insufficient_privilege';
  end if;

  -- Shape: every identity the settlement rests on must be present and well
  -- formed, or nothing is recorded (a malformed receipt is a client defect,
  -- not evidence to hold).
  if p_receipt is null or jsonb_typeof(p_receipt) <> 'object'
     or p_receipt_sha256 is null or p_receipt_sha256 !~ '^[0-9a-f]{64}$'
     or (p_output is not null and jsonb_typeof(p_output) <> 'object')
     or (p_hold_reason is not null and p_hold_reason not in (
       'evidence_missing', 'evidence_ambiguous', 'conflicting_receipt',
       'owner_mismatch', 'account_deleted', 'grant_revoked')) then
    return query select 'offline.invalid_input'::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  begin
    v_receipt_id := p_receipt ->> 'receiptId';
    v_owner_id := (p_receipt ->> 'ownerId')::uuid;
    v_installation_key_id := p_receipt ->> 'installationKeyId';
    v_grant_id := (p_receipt ->> 'grantId')::uuid;
    v_grant_jws_sha256 := p_receipt ->> 'grantJwsSha256';
    v_operation_id := p_receipt ->> 'operationId';
    v_result_id := p_receipt ->> 'resultId';
    v_output_sha256 := p_receipt ->> 'fullOutputSha256';
    v_billing := p_receipt ->> 'billingDisposition';
    v_sequence := (p_receipt ->> 'lifecycleSequence')::bigint;
    v_ticket := p_receipt -> 'ticket';
    if v_ticket is not null and jsonb_typeof(v_ticket) = 'object' then
      v_allocation_id := (v_ticket ->> 'allocationId')::uuid;
      v_generation := (v_ticket ->> 'generation')::bigint;
      v_ticket_id := (v_ticket ->> 'ticketId')::uuid;
    end if;
  exception when others then
    return query select 'offline.invalid_input'::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end;
  if v_receipt_id is null or v_receipt_id !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
     or v_owner_id is null
     or v_installation_key_id is null or v_installation_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
     or v_grant_id is null
     or v_grant_jws_sha256 is null or v_grant_jws_sha256 !~ '^[0-9a-f]{64}$'
     or v_operation_id is null or v_operation_id !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
     or v_result_id is null or v_result_id !~ '^[A-Za-z0-9._:/+=-]{1,128}$'
     or v_output_sha256 is null or v_output_sha256 !~ '^[0-9a-f]{64}$'
     or v_billing is null or v_billing not in ('joint_verification_required', 'not_chargeable')
     or v_sequence is null or v_sequence < 1 or v_sequence > 9007199254740991
     or jsonb_typeof(p_receipt -> 'lifecycleSequence') <> 'number'
     or v_ticket is null
     or (jsonb_typeof(v_ticket) <> 'null' and (
       jsonb_typeof(v_ticket) <> 'object'
       or v_allocation_id is null or v_ticket_id is null
       or v_generation is null or v_generation < 1 or v_generation > 9007199254740991
       or jsonb_typeof(v_ticket -> 'generation') <> 'number')) then
    return query select 'offline.invalid_input'::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if jsonb_typeof(v_ticket) = 'null' then
    v_allocation_id := null;
    v_generation := null;
    v_ticket_id := null;
  end if;
  v_financial := case when v_ticket_id is null then 'not_applicable' else 'reserved' end;

  -- Caller lock first (the receipt namespace and the budget), ticket lock
  -- second — the one order every offline path uses.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));
  if v_ticket_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(api_private.offline_ticket_lock_key(v_ticket_id));
  end if;

  -- A receipt this caller already delivered: replay its verdict (same body)
  -- or report the conflict (same id, other body). Nothing settles twice, and
  -- nothing about a freeze is consulted before this — the durable verdict is
  -- the verdict.
  select * into v_known
  from public.offline_receipt_settlements s
  where s.user_id = v_uid and s.receipt_id = v_receipt_id;
  if found then
    if v_known.receipt_sha256 = p_receipt_sha256 then
      return query select 'accepted'::text, 'replayed'::text, v_known.status, v_known.reason_code,
        v_known.financial_disposition,
        case when v_known.status = 'result_recorded' then v_known.result_id end;
    else
      return query select 'offline.receipt_conflict'::text, null::text, null::text, null::text, null::text, null::text;
    end if;
    return;
  end if;

  if p_hold_reason is not null then
    -- The edge could not verify the evidence (signature, binding, digest,
    -- output): hold with its reason, ticket untouched.
    v_status := 'reconciliation_required';
    v_reason := p_hold_reason;
  elsif v_owner_id <> v_uid then
    v_status := 'reconciliation_required';
    v_reason := 'owner_mismatch';
  elsif exists (
    select 1 from public.offline_receipt_settlements s
    where s.user_id = v_uid and (s.operation_id = v_operation_id or s.result_id = v_result_id)
  ) then
    -- One operation, one result, one receipt: a second receipt for the same
    -- operation or the same result is a conflict to reconcile, never a
    -- second result.
    v_status := 'reconciliation_required';
    v_reason := 'conflicting_receipt';
  elsif v_ticket_id is null then
    -- Pro lease: no ticket to consume, but the receipt and the output beside
    -- it must still tell one story before the result is recorded as
    -- delivered. Judged exactly as the ticket branch judges evidence:
    -- not_chargeable + no output / a non-scored output naming this result
    -- → recorded; chargeable + a scored output naming this result that the
    -- ingress admits, under the caller's verified_store lease for this
    -- installation → the rating is written, then recorded (pending under a
    -- reversible freeze); chargeable + no output → HOLD evidence_missing;
    -- anything else (a scored output the receipt says was not chargeable, an
    -- abstention the receipt says to charge, an output naming another result
    -- or one the ingress refuses, a grant that is not the caller's lease) →
    -- HOLD evidence_ambiguous. Nothing financial either way.
    if v_billing = 'not_chargeable' then
      if p_output is null
         or (p_output ->> 'id' is not distinct from v_result_id
             and p_output ->> 'resultKind' is distinct from 'scored') then
        v_recorded_result := v_result_id;
      else
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      end if;
    elsif p_output is null then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_missing';
    elsif p_output ->> 'id' is distinct from v_result_id
          or p_output ->> 'resultKind' is distinct from 'scored' then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    else
      v_shot := api_private.offline_receipt_shot(p_output);
      if v_shot is null
         or not exists (
           select 1
           from public.offline_grants g
           join public.offline_devices d on d.id = g.device_id
           where g.id = v_grant_id
             and g.user_id = v_uid
             and g.entitlement_source = 'verified_store'
             and d.installation_key_id = v_installation_key_id
         ) then
        -- The online ingress would refuse this shot, or the grant the receipt
        -- names is not a lease the server issued to the caller for this
        -- installation (a free grant always carries tickets): the evidence
        -- cannot be settled as delivered.
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      elsif v_defer then
        -- Complete, bound chargeable evidence under a release the operator has
        -- frozen but not withdrawn: nothing durable is decided (the freeze may
        -- lift, or become a withdrawal) — the identical redelivery is judged
        -- then.
        return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
          v_financial, null::text;
        return;
      else
        v_verdict := api_private.record_offline_lease_shot(v_grant_id, v_shot);
        if v_verdict = 'accepted' then
          v_recorded_result := v_result_id;
        elsif v_verdict = 'shot.id_conflict' then
          -- Another owner's rating already holds this id: hold, nothing written.
          v_status := 'reconciliation_required';
          v_reason := 'conflicting_receipt';
        elsif v_verdict = 'shot.session_not_found' then
          -- The session the rating belongs to has not synced yet: transient,
          -- no verdict is recorded — the identical redelivery settles once the
          -- session exists.
          return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
            v_financial, null::text;
          return;
        elsif v_verdict = 'offline.invalid_input' or v_verdict ~ '^shot\.write_failed:2[23]' then
          -- An output the shots table refuses (SQLSTATE class 22 data / 23
          -- integrity): the evidence cannot be settled as delivered, and
          -- redelivering it would not change that.
          v_status := 'reconciliation_required';
          v_reason := 'evidence_ambiguous';
        else
          raise exception 'offline receipt settlement failed: %', v_verdict
            using errcode = 'internal_error';
        end if;
      end if;
    end if;
  else
    -- The ticket's allocation must be owned by the caller and made to the
    -- installation the receipt names, and the grant the receipt claims must
    -- belong to that ticket's lineage: a grant of the caller for that same
    -- installation, issued at or after the allocation, at the generation the
    -- receipt claims — the allocating grant itself or a later one that
    -- restated the outstanding ticket (lease refresh, original-owner
    -- recovery). Anything else is evidence about some other allocation.
    select * into v_allocation
    from public.offline_allocation_ledger a
    where a.ticket_id = v_ticket_id
      and a.event = 'allocated'
      and api_private.offline_ticket_owned_by(a.user_id, a.identity_hashes, a.ticket_id, v_uid);
    if not found
       or v_allocation.installation_key_id <> v_installation_key_id
       or v_allocation_id <> v_grant_id
       or not exists (
         select 1
         from public.offline_grants g
         join public.offline_devices d on d.id = g.device_id
         where g.id = v_grant_id
           and g.user_id = v_uid
           and g.entitlement_source = 'identity_lifetime_free'
           and g.generation = v_generation
           and g.issued_at >= v_allocation.created_at
           and d.installation_key_id = v_allocation.installation_key_id
       ) then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    elsif exists (
      select 1 from public.offline_allocation_ledger t
      where t.ticket_id = v_ticket_id and t.event in ('consumed', 'released')
    ) then
      -- The ledger already closed this ticket (another rating consumed it,
      -- or the device returned it): whatever the receipt claims under it —
      -- a charge or an abstention — tells another story than the ledger.
      -- Held, ticket left as it is. Decided before any freeze: the ledger
      -- does not change when a freeze lifts.
      v_status := 'reconciliation_required';
      v_reason := 'conflicting_receipt';
    elsif v_billing = 'not_chargeable' then
      if p_output is null
         or (p_output ->> 'id' is not distinct from v_result_id
             and p_output ->> 'resultKind' is distinct from 'scored') then
        -- An abstention: the result is recorded, the ticket stays outstanding
        -- (the device returns it explicitly; nothing here releases it).
        v_recorded_result := v_result_id;
      else
        -- The output names another result, or claims a scored rating the
        -- receipt says was not chargeable: the evidence contradicts the
        -- receipt. Held, ticket reserved — never recorded as reconciled.
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      end if;
    elsif p_output is null then
      v_status := 'reconciliation_required';
      v_reason := 'evidence_missing';
    elsif p_output ->> 'id' is distinct from v_result_id
          or v_result_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or p_output ->> 'resultKind' is distinct from 'scored' then
      -- The output does not name this result, or claims a charge for an
      -- abstention: the evidence contradicts the receipt.
      v_status := 'reconciliation_required';
      v_reason := 'evidence_ambiguous';
    else
      v_shot := api_private.offline_receipt_shot(p_output);
      if v_shot is null then
        -- The online ingress would refuse this shot: the evidence cannot be
        -- settled as delivered, frozen or not.
        v_status := 'reconciliation_required';
        v_reason := 'evidence_ambiguous';
      elsif v_defer then
        -- Complete, bound chargeable evidence for an outstanding ticket under a
        -- release the operator has frozen but not withdrawn: nothing durable
        -- is decided and nothing is consumed — the ticket stays reserved and
        -- the identical redelivery is judged once the freeze lifts (settles)
        -- or the release is withdrawn (grant_revoked HOLD).
        return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
          v_financial, null::text;
        return;
      else
        v_verdict := public.consume_offline_ticket(v_ticket_id, v_shot);
        if v_verdict = 'accepted' then
          v_financial := 'consumed';
          v_recorded_result := v_result_id;
        elsif v_verdict in ('offline.ticket_consumed', 'offline.ticket_released', 'shot.id_conflict',
                            'offline.shot_not_chargeable') then
          -- The ledger or the shots table already tells another story about
          -- this ticket or this rating: hold, leave the ticket as it is.
          v_status := 'reconciliation_required';
          v_reason := 'conflicting_receipt';
        elsif v_verdict = 'shot.session_not_found' then
          -- The session the rating belongs to has not synced yet (the app's
          -- session outbox may land after the receipt): transient, so no
          -- verdict is recorded — the ticket stays reserved and the identical
          -- redelivery settles once the session exists.
          return query select 'accepted'::text, 'pending'::text, 'pending'::text, null::text,
            v_financial, null::text;
          return;
        elsif v_verdict in ('offline.ticket_not_found', 'offline.invalid_input')
              or v_verdict ~ '^shot\.write_failed:2[23]' then
          -- Unknown ticket, unparseable output or an output the shots table
          -- refuses (SQLSTATE class 22 data / 23 integrity): the evidence
          -- cannot be settled as delivered, and redelivering it would not
          -- change that.
          v_status := 'reconciliation_required';
          v_reason := 'evidence_ambiguous';
        else
          -- Any other shot.write_failed:<SQLSTATE> is a server-side failure,
          -- not evidence: nothing durable is written and the device
          -- redelivers the same receipt.
          raise exception 'offline receipt settlement failed: %', v_verdict
            using errcode = 'internal_error';
        end if;
      end if;
    end if;
  end if;

  insert into public.offline_receipt_settlements (
    user_id, receipt_id, receipt_sha256, owner_id, installation_key_id, grant_id, grant_jws_sha256,
    allocation_id, generation, ticket_id, operation_id, result_id, full_output_sha256,
    billing_disposition, lifecycle_sequence, status, reason_code, financial_disposition, receipt
  ) values (
    v_uid, v_receipt_id, p_receipt_sha256, v_owner_id, v_installation_key_id, v_grant_id, v_grant_jws_sha256,
    v_allocation_id, v_generation, v_ticket_id, v_operation_id, v_result_id, v_output_sha256,
    v_billing, v_sequence, v_status, v_reason, v_financial, p_receipt
  );

  return query select 'accepted'::text,
    case when v_status = 'result_recorded' then 'settled'::text else 'held'::text end,
    v_status, v_reason, v_financial, v_recorded_result;
end;
$$;

comment on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) is
  'Settles ONE delayed offline consumption receipt at most once for the caller (live API session required), under access_lock_key(uid) then offline_ticket_lock_key(ticket): a receipt this caller already delivered replays its durable verdict (same id + same canonical digest) or is offline.receipt_conflict (same id, other body) — decided BEFORE p_defer_new is consulted; an edge hold reason, another owner, a second receipt for the same operation or result, a ticket outside the claimed grant''s lineage, a ticket the ledger already closed (consumed or released — a conflicting_receipt HOLD even for not_chargeable), missing or contradictory output, or an output the shots:sync ingress would refuse (api_private.offline_receipt_shot: nested or flat offsets, bounded integers, ranges, shapes) is HELD as reconciliation_required with the ticket left exactly as it was; a not_chargeable abstention is recorded and leaves the ticket outstanding; a chargeable scored receipt for an outstanding ticket consumes it through consume_offline_ticket() with the normalized shot; a chargeable scored Pro (no-ticket) receipt is recorded only once its rating is durable in public.shots under the caller''s verified_store lease for the installation the receipt names (api_private.record_offline_lease_shot; a free grant without its ticket is evidence_ambiguous), financial_disposition not_applicable; a session that has not synced is pending (nothing durable). p_defer_new (default false; a reversible deny-new freeze) turns ONLY a genuinely new chargeable receipt that would settle now into pending — nothing written, ticket reserved. Returns result accepted | offline.invalid_input | offline.receipt_conflict with delivery settled | replayed | held | pending.';

revoke all on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) from public, anon, service_role;
grant execute on function public.settle_offline_receipt(jsonb, text, jsonb, text, boolean) to authenticated;
