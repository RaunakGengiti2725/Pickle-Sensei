-- Attack helpers installed in the TEMPLATE database after all migrations.
-- Nothing here changes production objects; it only adds an `attack` schema
-- with fixture builders so scenario scripts stay short.
create schema if not exists attack;
grant usage on schema attack to anon, authenticated, service_role;

-- Create an auth user + one provider identity (fires handle_new_user →
-- profiles row). Returns the user id.
create or replace function attack.mk_user(
  p_uid uuid,
  p_email text,
  p_provider text default 'google',
  p_provider_id text default null,
  p_identity_id uuid default null
) returns uuid
language plpgsql
as $$
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (p_uid, p_email, jsonb_build_object('full_name', 'user ' || p_email));

  insert into auth.identities (id, provider_id, user_id, identity_data, provider)
  values (
    coalesce(p_identity_id, gen_random_uuid()),
    coalesce(p_provider_id, p_provider || '-sub-' || p_email),
    p_uid,
    jsonb_build_object('email', p_email, 'sub', coalesce(p_provider_id, p_provider || '-sub-' || p_email)),
    p_provider
  );
  return p_uid;
end;
$$;

-- Payload for apply_synced_shot(jsonb). result_kind 'scored' | 'low_confidence'.
create or replace function attack.shot_json(
  p_shot_id uuid,
  p_permit_id uuid,
  p_kind text default 'scored',
  p_score numeric default 7.5,
  p_shot_type text default 'dink',
  p_client_key text default null
) returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'id', p_shot_id,
    'analysisPermitId', p_permit_id,
    'shotType', p_shot_type,
    'cameraView', 'side',
    'capturedAt', clock_timestamp(),
    'startMs', 0,
    'contactMs', 400,
    'endMs', 900,
    'resultKind', p_kind,
    'overallScore', case when p_kind = 'scored' then p_score else null end,
    'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', 'attack', 'modelBundleVersion', 'attack',
      'poseModelVersion', 'attack', 'paddleModelVersion', 'attack',
      'strokeDetectorVersion', 'attack', 'phaseModelVersion', 'attack',
      'scoringModelVersion', 'attack-v1', 'shotConfigVersion', 'attack'
    ),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 300, 'representativeMs', 400, 'endMs', 500, 'confidence', 0.9
    )),
    'checkpoints', jsonb_build_array(jsonb_build_object(
      'key', 'paddle_up', 'score', 70, 'confidence', 0.9, 'band', 'green',
      'direction', 'raise', 'severity', 0.1, 'applicable', true
    ))
  )
$$;
grant execute on function attack.shot_json(uuid, uuid, text, numeric, text, text) to authenticated;

-- Ledger snapshot as one text row per identity (ordered), for before/after diffs.
create or replace function attack.ledger_snapshot() returns setof text
language sql
as $$
  select identity_hash || ':' || scored_count from public.free_rating_ledger order by 1
$$;
