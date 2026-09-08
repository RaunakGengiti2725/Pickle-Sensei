-- ADV-06 — a client forges permit rows in settled states through the INSERT
-- grant, bypassing reserve_analysis_permit() and the state machine.
--
-- Boundary: the only supported way to create an analysis permit is the
-- reserve_analysis_permit() RPC (SECURITY INVOKER, so it needs an INSERT grant
-- on analysis_permits for `authenticated`). The defense-in-depth migration
-- sizes UPDATE to exactly (status, outcome), and the lifecycle trigger pins the
-- reserved → settled transitions. The INSERT grant however is table-wide, so a
-- client with a valid bearer + API key can write a permit row that is ALREADY
-- finalized/scored (looks like a consumed rating that never happened),
-- released/expired (a state that permit_backs_sync() accepts, minting a
-- sync-backing permit without the reservation quota) or a fresh `reserved`
-- row beyond the reservation allowance. Expected: every direct INSERT that
-- names a status/outcome is refused; a direct `reserved` insert either is
-- refused or at least cannot back a scored sync past the free allowance.
\set ON_ERROR_STOP on
\set QUIET on
begin;

insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad61', 'adv06@example.com', '{"provider":"google"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad62', '00000000-0000-4000-8000-00000000ad61', 'google', 'adv06-google-sub');

create function pg_temp.adv06_shot(p_id uuid, p_permit uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.adv06_shot(uuid, uuid) to authenticated, anon;

do $$ begin perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad61';

do $$
declare
  uid uuid := '00000000-0000-4000-8000-00000000ad61';
  forged uuid; r text; breaks text[] := '{}'; n int;
begin
  -- Attack 1: forge a consumed rating (finalized/scored) with no shot behind it.
  begin
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (uid, 'adv06-forged-finalized', 'finalized', 'scored') returning id into forged;
    breaks := breaks || format('client INSERT created a finalized/scored permit %s with no shot (sqlstate none)', forged);
  exception when others then
    if sqlstate not in ('42501', '23514') then
      breaks := breaks || format('finalized/scored insert failed with unexpected %s: %s', sqlstate, sqlerrm);
    end if;
  end;

  -- Attack 2: forge a released/partial permit (a withheld result the client never had).
  begin
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (uid, 'adv06-forged-partial', 'released', 'partial');
    breaks := breaks || 'client INSERT created a released/partial permit directly'::text;
  exception when others then
    if sqlstate not in ('42501', '23514') then
      breaks := breaks || format('released/partial insert failed with unexpected %s: %s', sqlstate, sqlerrm);
    end if;
  end;

  -- Attack 3: forge released/expired — the state permit_backs_sync() accepts —
  -- and try to spend it as a scored sync. The lifetime backstop must still hold.
  forged := null;
  begin
    insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
    values (uid, 'adv06-forged-expired', 'released', 'expired') returning id into forged;
    breaks := breaks || 'client INSERT created a released/expired permit (sync-backing state) without reserving'::text;
  exception when others then
    if sqlstate not in ('42501', '23514') then
      breaks := breaks || format('released/expired insert failed with unexpected %s: %s', sqlstate, sqlerrm);
    end if;
  end;
  if forged is not null then
    r := public.apply_synced_shot(pg_temp.adv06_shot('00000000-0000-4000-8000-00000000ad63', forged));
    -- Allowance still has room (0 spent), so acceptance here is not a money
    -- loss by itself; it is recorded because it proves the forged permit
    -- backs a sync exactly like a real reservation.
    if r = 'accepted' then
      breaks := breaks || 'a forged released/expired permit backed a scored sync (reservation quota bypassed)'::text;
    end if;
  end if;

  -- Attack 4: forge extra `reserved` rows past the reservation allowance and
  -- spend them. With one rating possibly spent above, spend until refused: the
  -- lifetime count must never exceed 2 for a free identity.
  for n in 1..4 loop
    forged := null;
    begin
      insert into public.analysis_permits (user_id, idempotency_key)
      values (uid, 'adv06-forged-reserved-' || n) returning id into forged;
    exception when others then
      if sqlstate not in ('42501', '23514') then
        breaks := breaks || format('reserved insert %s failed with unexpected %s: %s', n, sqlstate, sqlerrm);
      end if;
    end;
    exit when forged is null;
    r := public.apply_synced_shot(pg_temp.adv06_shot(('00000000-0000-4000-8000-00000000ad7' || n)::uuid, forged));
  end loop;
  if public.lifetime_scored_count() > 2 then
    breaks := breaks || format('forged reserved permits let a free identity record %s scored ratings', public.lifetime_scored_count());
  end if;

  if array_length(breaks, 1) > 0 then
    raise exception 'ADV-06 BREAK: %', array_to_string(breaks, ' | ');
  end if;
end $$;

rollback;
\echo 'ADV-06 forged permit states via INSERT: PASS'
