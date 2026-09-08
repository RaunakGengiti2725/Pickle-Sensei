-- Shared helpers for the W04-01 r5 adversary matrix. Included by every
-- aNN_*.sql via \ir; runs as the database owner inside the attack's own
-- transaction. Nothing here touches candidate migrations or candidate tests.
\set ON_ERROR_STOP on
\set QUIET on

-- A free account with one sign-in identity and one live API session.
create function pg_temp.mk_user(p_uid uuid, p_provider text, p_sub text, p_session uuid)
returns void language plpgsql as $$
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (p_uid, p_sub || '@example.test', jsonb_build_object('full_name', p_sub),
          jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_sub, p_uid, jsonb_build_object('sub', p_sub, 'email', p_sub || '@example.test'));
  insert into auth.sessions (id, user_id) values (p_session, p_uid);
end $$;

-- The API proof the edge function presents on every request.
create function pg_temp.api_header() returns text language sql as $$
  select jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text;
$$;

-- Owner-side readers (definer: the client cannot read other accounts' rows).
create function pg_temp.events(p_uid uuid) returns text
language sql security definer as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
grant execute on function pg_temp.events(uuid) to authenticated;

create function pg_temp.tickets_ever_allocated(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.offline_allocation_ledger
  where user_id = p_uid and event = 'allocated';
$$;
grant execute on function pg_temp.tickets_ever_allocated(uuid) to authenticated;

create function pg_temp.outstanding(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.offline_allocation_ledger a
  where a.user_id = p_uid and a.event = 'allocated'
    and not exists (select 1 from public.offline_allocation_ledger t
                    where t.ticket_id = a.ticket_id and t.event = 'consumed');
$$;
grant execute on function pg_temp.outstanding(uuid) to authenticated;

create function pg_temp.scored(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.shots where user_id = p_uid and result_kind = 'scored';
$$;
grant execute on function pg_temp.scored(uuid) to authenticated;

create function pg_temp.syncable_permits(p_uid uuid) returns integer
language sql security definer as $$
  select count(*)::int from public.analysis_permits p
  where p.user_id = p_uid
    and public.permit_backs_sync(p.status, p.outcome)
    and not exists (select 1 from public.shots s where s.analysis_permit_id = p.id);
$$;
grant execute on function pg_temp.syncable_permits(uuid) to authenticated;

-- The candidate's own conservation reading (security_regression.sql
-- pg_temp.t_conserved): tickets not consumed + scored ratings + online permits
-- that can still back a sync never exceed the 2 lifetime free ratings.
create function pg_temp.conserved(p_uid uuid) returns boolean
language sql security definer as $$
  select pg_temp.outstanding(p_uid) + pg_temp.scored(p_uid) + pg_temp.syncable_permits(p_uid) <= 2;
$$;
grant execute on function pg_temp.conserved(uuid) to authenticated;

-- The work-package metric the implementer used for A01: tickets ever
-- allocated + scored ratings NOT charged to a ticket ≤ 2. Every ticket is one
-- rating the device may render offline; a scored row that settled no ticket
-- is a rating paid another way.
create function pg_temp.budget_units(p_uid uuid) returns integer
language sql security definer as $$
  select pg_temp.tickets_ever_allocated(p_uid)
    + (select count(*)::int from public.shots s
       where s.user_id = p_uid and s.result_kind = 'scored'
         and not exists (select 1 from public.offline_allocation_ledger c
                         where c.event = 'consumed' and c.shot_id = s.id));
$$;
grant execute on function pg_temp.budget_units(uuid) to authenticated;

-- The sync payload the edge function hands apply_synced_shot().
create function pg_temp.n_shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 7.1 else null end,
    'confidence', case when p_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;
grant execute on function pg_temp.n_shot(uuid, uuid, text) to authenticated;

-- A scored row written straight to public.shots by the client role (the
-- INSERT grant the app holds), with the permit link left NULL exactly as the
-- table gate requires of a direct write. p_created_at is client-controlled:
-- the column has no gate and no bound.
create function pg_temp.direct_scored_insert(p_id uuid, p_created_at timestamptz default now())
returns void language plpgsql as $$
begin
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms,
    overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version,
    paddle_model_version, stroke_detector_version, phase_model_version,
    scoring_model_version, shot_config_version, created_at
  ) values (
    p_id, (select auth.uid()),
    'drive', now(), 0, 1000, 7.1, 0.9, 'scored',
    '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
    'scoring-1', 'config-1', p_created_at
  );
end $$;
grant execute on function pg_temp.direct_scored_insert(uuid, timestamptz) to authenticated;
