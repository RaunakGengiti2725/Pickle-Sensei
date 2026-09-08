-- Shared fixture for the W04-01 attacks (included with \ir; the including
-- file owns BEGIN/ROLLBACK). Three free accounts with one sign-in identity
-- each and a live API session, plus pg_temp helpers to switch caller.
\set ON_ERROR_STOP on
do $$
begin
  perform set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key()
  )::text, true);
end $$;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000e1', 'e1@example.com', '{"full_name":"E1"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-0000000000e2', 'e2@example.com', '{"full_name":"E2"}', '{"provider":"apple"}'),
  ('00000000-0000-4000-8000-0000000000e3', 'e3@example.com', '{"full_name":"E3"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'google-sub-e1', '00000000-0000-4000-8000-0000000000e1', '{"sub":"google-sub-e1","email":"e1@example.com"}'),
  ('apple', 'apple-sub-e2', '00000000-0000-4000-8000-0000000000e2', '{"sub":"apple-sub-e2","email":"e2@example.com"}'),
  ('apple', 'apple-sub-e3', '00000000-0000-4000-8000-0000000000e3', '{"sub":"apple-sub-e3","email":"e3@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000000e101', '00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-00000000e201', '00000000-0000-4000-8000-0000000000e2'),
  ('00000000-0000-4000-8000-00000000e301', '00000000-0000-4000-8000-0000000000e3');

-- Become an authenticated caller with a live API session (the shape the edge
-- function's connection has), or the owner again.
create function pg_temp.as_user(p_uid uuid, p_session uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('session_id', p_session)::text, true);
end $$;
create function pg_temp.as_owner() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid), pg_temp.as_owner() to authenticated, anon, service_role;

-- Owner-side views of the ledger (RLS hides other accounts' rows from clients).
create function pg_temp.events(p_uid uuid) returns text
language sql security definer as $$
  select coalesce(
    (select string_agg(e.event || ':' || e.n, ',' order by e.event)
     from (select event, count(*) n from public.offline_allocation_ledger
           where user_id = p_uid group by event) e), '');
$$;
create function pg_temp.tickets_ever(p_installation_key text) returns integer
language sql security definer as $$
  select count(distinct ticket_id)::int from public.offline_allocation_ledger
  where installation_key_id = p_installation_key and event = 'allocated';
$$;
create function pg_temp.first_ticket(p_uid uuid) returns uuid
language sql security definer as $$
  select ticket_id from public.offline_allocation_ledger
  where user_id = p_uid and event = 'allocated' order by created_at, id limit 1;
$$;
grant execute on function pg_temp.events(uuid), pg_temp.tickets_ever(text), pg_temp.first_ticket(uuid)
  to authenticated, anon, service_role;

-- A durably delivered scored shot written by the server (owner role).
create function pg_temp.owner_scored_shot(p_id uuid, p_uid uuid, p_captured timestamptz) returns void
language sql as $$
  insert into public.shots (
    id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
  ) values (
    p_id, p_uid, 'drive', p_captured, 0, 1000, 7, 1, 'scored',
    'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1');
$$;
