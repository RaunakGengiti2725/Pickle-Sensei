-- W04-01 adversarial prelude (attack branch only — not part of the product
-- matrix). Included by every a*.sql via \ir. Each attack file opens its own
-- transaction, so everything here is transaction-local: pg_temp helpers plus
-- the API request header the migrations gate every client read/RPC on.
--
-- Fixture identity: pg_temp.atk_user(n, provider, sub) creates one auth user
-- through the production trigger path (auth.users insert → handle_new_user),
-- its provider identity and one live auth.sessions row, and returns the ids
-- the callers need: user 0000…00n0, session 0000…00n1.

do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;

create function pg_temp.atk_uid(p_n integer) returns uuid
language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000a' || lpad(to_hex(p_n), 3, '0') || '0')::uuid
$$;
create function pg_temp.atk_sid(p_n integer) returns uuid
language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000a' || lpad(to_hex(p_n), 3, '0') || '1')::uuid
$$;
grant execute on function pg_temp.atk_uid(integer), pg_temp.atk_sid(integer) to authenticated, anon;

create function pg_temp.atk_user(p_n integer, p_provider text, p_sub text) returns uuid
language plpgsql as $$
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (pg_temp.atk_uid(p_n), format('atk-%s@example.test', p_n),
          jsonb_build_object('full_name', format('Attacker %s', p_n)),
          jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_sub, pg_temp.atk_uid(p_n),
          jsonb_build_object('sub', p_sub, 'email', format('atk-%s@example.test', p_n)));
  insert into auth.sessions (id, user_id) values (pg_temp.atk_sid(p_n), pg_temp.atk_uid(p_n));
  return pg_temp.atk_uid(p_n);
end $$;

-- Become user n under a live API session (the shape every edge RPC runs in).
create function pg_temp.atk_become(p_n integer) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', pg_temp.atk_uid(p_n)::text, true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('session_id', pg_temp.atk_sid(p_n))::text, true);
end $$;
grant execute on function pg_temp.atk_become(integer) to authenticated;

create function pg_temp.atk_reset() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
grant execute on function pg_temp.atk_reset() to authenticated;

-- apply_synced_shot() payload for one scored shot backed by one permit.
create function pg_temp.atk_shot(p_id uuid, p_permit uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-09-01T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', 7.1,
    'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.atk_shot(uuid, uuid) to authenticated;

-- Run a statement, return NULL on success or the SQLSTATE on failure.
create function pg_temp.atk_try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;
grant execute on function pg_temp.atk_try(text) to authenticated, anon, service_role;

-- A permit-less scored row written the way the shipping edge function does
-- NOT (direct table INSERT under the 20260905000000 gate) — the only path
-- that yields a shot consume_offline_ticket() will accept.
create function pg_temp.atk_direct_shot(p_id uuid, p_user uuid) returns text
language plpgsql as $$
begin
  return pg_temp.atk_try(format(
    $q$insert into public.shots (
         id, user_id, shot_type, captured_at, created_at, start_ms, end_ms,
         overall_score, analysis_confidence, result_kind,
         app_version, model_bundle_version, pose_model_version,
         paddle_model_version, stroke_detector_version, phase_model_version,
         scoring_model_version, shot_config_version
       ) values (%L, %L, 'drive', now(), clock_timestamp(), 0, 1000, 8.0, 0.9, 'scored',
         '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
         'scoring-1', 'config-1')$q$, p_id, p_user));
end $$;
grant execute on function pg_temp.atk_direct_shot(uuid, uuid) to authenticated;

-- Ledger view for one account, e.g. 'allocated:2,consumed:1'.
create function pg_temp.atk_events(p_uid uuid) returns text
language sql security definer as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
grant execute on function pg_temp.atk_events(uuid) to authenticated;

-- Permits apply_synced_shot() would still honour that no shot has settled.
create function pg_temp.atk_syncable_permits(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.analysis_permits p
  where p.user_id = p_uid
    and public.permit_backs_sync(p.status, p.outcome)
    and not exists (select 1 from public.shots s where s.analysis_permit_id = p.id);
$$;
grant execute on function pg_temp.atk_syncable_permits(uuid) to authenticated;

-- Outstanding (allocated, not consumed) offline tickets of one account row.
create function pg_temp.atk_outstanding(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.offline_allocation_ledger a
  where a.user_id = p_uid and a.event = 'allocated'
    and not exists (select 1 from public.offline_allocation_ledger t
                    where t.ticket_id = a.ticket_id and t.event = 'consumed');
$$;
grant execute on function pg_temp.atk_outstanding(uuid) to authenticated;

create function pg_temp.atk_scored(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.shots where user_id = p_uid and result_kind = 'scored';
$$;
grant execute on function pg_temp.atk_scored(uuid) to authenticated;

-- The work-package conservation statement for a free identity, exactly as the
-- candidate's own matrix reads it (security_regression.sql t_conserved):
-- outstanding offline tickets + scored shots + late-syncable permits ≤ 2.
create function pg_temp.atk_budget_used(p_uid uuid) returns integer
language sql security definer as $$
  select pg_temp.atk_outstanding(p_uid) + pg_temp.atk_scored(p_uid) + pg_temp.atk_syncable_permits(p_uid);
$$;
grant execute on function pg_temp.atk_budget_used(uuid) to authenticated;
