-- ============================================================================
-- Attack-suite helpers (adversarial pass on db-schema-migrations, PASS 3).
--
-- Loaded by every scenario INSIDE its transaction, so the schema and the
-- helper functions vanish with the surrounding ROLLBACK: no scenario can
-- leave state behind for the next one, and nothing here exists in a real
-- database. Helpers only build fixtures — never assertions — so a scenario's
-- verdict always comes from the migrations' own code paths.
--
-- Seeding goes through the production path: insert into auth.users fires
-- handle_new_user(), exactly as hosted Supabase does, and auth.identities
-- carries the provider identity the free-rating ledger is keyed by.
-- ============================================================================

create schema attack;
-- Scenarios call attack.note()/attack.shot_payload() from inside an
-- authenticated session; the fixture functions stay owner-only in effect
-- because auth.users is not writable by client roles anyway.
grant usage on schema attack to anon, authenticated;
alter default privileges in schema attack grant execute on functions to anon, authenticated;

-- One signed-in-able account: auth user + provider identity (+ the profile
-- the handle_new_user trigger provisions).
create function attack.new_user(
  p_id uuid,
  p_email text,
  p_provider text default 'google',
  p_sub text default null
) returns uuid
language plpgsql
as $fn$
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (p_id, p_email, jsonb_build_object('full_name', p_email),
          jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, coalesce(p_sub, p_provider || '-sub-' || p_id::text), p_id,
          jsonb_build_object('sub', coalesce(p_sub, p_provider || '-sub-' || p_id::text),
                             'email', p_email));
  return p_id;
end;
$fn$;

-- A complete, valid POST /v1/shots:sync payload for apply_synced_shot().
create function attack.shot_payload(
  p_shot_id uuid,
  p_permit_id uuid,
  p_result_kind text default 'scored',
  p_score numeric default 7.1,
  p_shot_type text default 'dink',
  p_captured_at timestamptz default now(),
  p_phase_count int default 0
) returns jsonb
language sql
as $fn$
  select jsonb_build_object(
    'id', p_shot_id,
    'analysisPermitId', p_permit_id,
    'sessionId', null,
    'resultKind', p_result_kind,
    'shotType', p_shot_type,
    'cameraView', 'side',
    'capturedAt', p_captured_at,
    'startMs', 0,
    'contactMs', 500,
    'endMs', 1000,
    'overallScore', case when p_result_kind = 'scored' then p_score else null end,
    'confidence', case when p_result_kind = 'scored' then 0.9 else 0.2 end,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', 'phase-' || g, 'startMs', g * 10,
        'representativeMs', g * 10 + 5, 'endMs', g * 10 + 9, 'confidence', 0.9))
      from generate_series(1, p_phase_count) g), '[]'::jsonb)
  );
$fn$;

-- Report helper: a single labelled key/value line in the artifact log.
create function attack.note(p_label text, p_value text)
returns void
language plpgsql
as $fn$
begin
  raise notice 'OBSERVED % = %', p_label, p_value;
end;
$fn$;
