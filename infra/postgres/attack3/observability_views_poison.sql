-- Adversarial pass 3 — infra/observability/views.sql under poisoned events.
-- Runs on a THROWAWAY database: installs the documented analytics_event DDL
-- (the contract comment at the top of views.sql), then views.sql (via \i),
-- then asks: does ONE malformed event row take a whole dashboard view down?
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

begin;

create table analytics_event (
  id          bigserial primary key,
  name        text        not null,
  at          timestamptz not null,
  ingested_at timestamptz not null default now(),
  session_id  text,
  props       jsonb       not null
);
create index analytics_event_name_at on analytics_event (name, at);

\i /views.sql

create temp table attack3_results (k text primary key, v jsonb);

create or replace function pg_temp.probe(k text, q text) returns void language plpgsql as $$
declare n bigint;
begin
  -- to_jsonb forces every output column to be computed (count(*) alone lets
  -- the planner skip the casts under test)
  execute 'select count(to_jsonb(s)) from (' || q || ') s' into n;
  insert into attack3_results values (k, jsonb_build_object('rows', n));
exception when others then
  insert into attack3_results values (k, jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate));
end $$;

-- healthy baseline rows
insert into analytics_event (name, at, session_id, props) values
  ('analysis_started',   '2026-01-01T10:00:00Z', 's1', '{}'),
  ('analysis_completed', '2026-01-01T10:00:05Z', 's1', '{"latencyMs": 5000, "modelVersion": "m1", "deviceClass": "a17"}'),
  ('app_opened',         '2026-01-01T10:00:00Z', 's1', '{"appBuild": "100"}'),
  ('app_crash',          '2026-01-01T10:01:00Z', 's1', '{"appBuild": "100", "fatal": true}'),
  ('api_failure',        '2026-01-01T10:02:00Z', 's1', '{"route": "/v1/x", "statusCode": 503, "errorCode": "upstream"}'),
  ('queue_backlog',      '2026-01-01T10:03:00Z', null, '{"queue": "sync", "depth": 12}');

select pg_temp.probe('baseline_latency', 'select * from obs_analysis_latency');
select pg_temp.probe('baseline_crash',   'select * from obs_crash_rate');
select pg_temp.probe('baseline_api',     'select * from obs_api_failures');
select pg_temp.probe('baseline_backlog', 'select * from obs_queue_backlog');

-- ONE poisoned row per view
insert into analytics_event (name, at, session_id, props) values
  ('analysis_completed', '2026-01-01T11:00:00Z', 's2', '{"latencyMs": "fast", "modelVersion": "m1", "deviceClass": "a17"}');
select pg_temp.probe('poisoned_latency_string', 'select * from obs_analysis_latency');

insert into analytics_event (name, at, session_id, props) values
  ('app_crash', '2026-01-01T11:00:00Z', 's2', '{"appBuild": "100", "fatal": "maybe"}');
select pg_temp.probe('poisoned_crash_fatal_string', 'select * from obs_crash_rate');

insert into analytics_event (name, at, session_id, props) values
  ('api_failure', '2026-01-01T11:00:00Z', 's2', '{"route": "/v1/x", "statusCode": "5xx", "errorCode": "e"}');
select pg_temp.probe('poisoned_api_status_string', 'select * from obs_api_failures');

insert into analytics_event (name, at, session_id, props) values
  ('queue_backlog', '2026-01-01T11:00:00Z', null, '{"queue": "sync", "depth": 4294967296}');
select pg_temp.probe('poisoned_backlog_depth_int_overflow', 'select * from obs_queue_backlog');

-- clock skew: client `at` far in the future / epoch 0 must not error, just bucket
insert into analytics_event (name, at, session_id, props) values
  ('analysis_started', '2999-12-31T23:59:59Z', 's3', '{}'),
  ('analysis_started', '1970-01-01T00:00:00Z', 's3', '{}');
select pg_temp.probe('clock_skew_funnel', 'select * from obs_analysis_hourly');

-- unicode / huge props must not error
insert into analytics_event (name, at, session_id, props) values
  ('analysis_abstained', '2026-01-01T12:00:00Z', 's4', jsonb_build_object('reasonCategory', repeat('🥒', 10000)));
select pg_temp.probe('unicode_abstention', 'select * from obs_abstention_reasons');

select jsonb_pretty(jsonb_object_agg(k, v)) from attack3_results;

rollback;
