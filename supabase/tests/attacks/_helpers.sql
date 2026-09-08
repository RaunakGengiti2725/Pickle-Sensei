-- Shared helpers for the P0-04 attack files. Included with \ir from each
-- attack_*.sql after `begin;`, so everything lives in pg_temp and is rolled
-- back with the attack. Not a test file itself (the harness globs attack_*).

create table pg_temp.attack_assertions (n integer not null);
insert into pg_temp.attack_assertions values (0);

create function pg_temp.check(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_ok is not true then
    raise exception 'ATTACK ASSERTION FAILED: %', p_msg;
  end if;
  update pg_temp.attack_assertions set n = n + 1;
end $$;

create function pg_temp.check_eq(p_got text, p_want text, p_msg text) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'ATTACK ASSERTION FAILED: % (got %, want %)', p_msg, coalesce(p_got, 'NULL'), coalesce(p_want, 'NULL');
  end if;
  update pg_temp.attack_assertions set n = n + 1;
end $$;

create function pg_temp.assertions() returns integer
language sql as $$ select n from pg_temp.attack_assertions $$;

-- Run a statement, report 'allowed <rows>' or '<SQLSTATE>:<hint>'.
create function pg_temp.q_try(p_sql text) returns text
language plpgsql as $$
declare n integer; v_state text; v_hint text;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'allowed ' || n;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end $$;

-- Run a scalar query, report its text or '<SQLSTATE>:<hint>'.
create function pg_temp.q_scalar(p_sql text) returns text
language plpgsql as $$
declare v text; v_state text; v_hint text;
begin
  execute p_sql into v;
  return coalesce(v, 'NULL');
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end $$;

create function pg_temp.p_move(p_id uuid, p_status text, p_outcome text) returns text
language plpgsql as $$
declare v_state text; v_hint text; n integer;
begin
  update public.analysis_permits set status = p_status, outcome = p_outcome where id = p_id;
  get diagnostics n = row_count;
  return 'allowed ' || n;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || ':' || coalesce(v_hint, '');
end $$;

create function pg_temp.r_permit(p_id uuid) returns text
language sql as $$
  select coalesce((select status || '/' || coalesce(outcome, 'NULL')
                   from public.analysis_permits where id = p_id), 'MISSING');
$$;

create function pg_temp.r_tomb(p_id uuid) returns text
language sql as $$
  select coalesce((select user_id::text || ':' || status || '/' || coalesce(outcome, 'NULL')
                   from public.analysis_permit_tombstones where permit_id = p_id), 'NONE');
$$;

create function pg_temp.s_shot(p_id uuid) returns text
language sql as $$
  select coalesce((select result_kind || '/' || coalesce(overall_score::text, 'NULL')
                          || '/' || coalesce(analysis_permit_id::text, 'NULL')
                   from public.shots where id = p_id), 'MISSING');
$$;

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

-- Client-role access is gated on the server request header
-- (api_private.is_api_request); the owner stamps it for the transaction.
create function pg_temp.api_headers() returns text
language sql as $$
  select jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text
$$;
select set_config('request.headers', pg_temp.api_headers(), true);

grant execute on function
  pg_temp.check(boolean, text), pg_temp.check_eq(text, text, text), pg_temp.assertions(),
  pg_temp.q_try(text), pg_temp.q_scalar(text), pg_temp.p_move(uuid, text, text),
  pg_temp.r_permit(uuid), pg_temp.r_tomb(uuid), pg_temp.s_shot(uuid),
  pg_temp.n_shot(uuid, uuid, text)
  to anon, authenticated, service_role;
grant update on pg_temp.attack_assertions to anon, authenticated, service_role;
grant select on pg_temp.attack_assertions to anon, authenticated, service_role;
