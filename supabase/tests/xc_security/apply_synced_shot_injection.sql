-- xc-security-injection-sanitization: direct-RPC adversarial matrix for
-- public.apply_synced_shot(jsonb), executed as the `authenticated` role under
-- RLS against a throwaway Postgres that has tests/shim_auth.sql + every
-- migration applied (run via run_xc_security_pg.sh).
--
-- The edge function validates each shot before calling the RPC; this file
-- deliberately bypasses that layer to measure what the SQL boundary itself
-- accepts, rejects, echoes or mangles. Every case, payload, result, SQLSTATE
-- and observed row effect is recorded in xcsec.results and exported as JSON
-- by the runner. Contract expectations the current revision does NOT meet are
-- written to xcsec.observations; with -v strict=1 they abort the run.
--
-- Additive: no production object is modified.

\set ON_ERROR_STOP on
\if :{?strict}
\else
\set strict 0
\endif

create schema xcsec;
grant usage on schema xcsec to authenticated;

create table xcsec.results (
  seq            serial primary key,
  case_name      text not null,
  category       text not null,
  shot_id        text,
  permit_id      uuid,
  payload        text not null,          -- exact jsonb text sent (truncated for the artifact when > 4000 chars)
  payload_len    int not null,
  payload_sha256 text not null,
  result         text,                   -- RPC return value; null when it raised
  sqlstate       text,
  sqlerrm        text,
  sqlerrm_len    int,
  shot_rows      int,
  phase_rows     int,
  checkpoint_rows int,
  permit_status  text,
  permit_outcome text,
  stored_shot_type text,
  stored_captured_at text,
  progress_day   text,
  echoed_input   boolean,                -- did the RPC return/raise text contain the payload's canary?
  duration_ms    numeric
);
grant insert, select on xcsec.results to authenticated;
grant usage, select on sequence xcsec.results_seq_seq to authenticated;

create table xcsec.observations (
  seq serial primary key,
  test text not null,
  expectation text not null,
  detail jsonb
);
grant insert, select on xcsec.observations to authenticated;
grant usage, select on sequence xcsec.observations_seq_seq to authenticated;

-- ───────────────────────────── fixtures ─────────────────────────────────────
-- alice = attacker-controlled account (premium, so the free-limit backstop
-- does not mask injection results), bob = victim with one shot, session and
-- reserved permit that must be untouched at the end.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  ('a0000000-0000-4000-8000-00000000000a', 'alice@example.com', '{"full_name":"Alice"}', '{"provider":"google"}'),
  ('b0000000-0000-4000-8000-00000000000b', 'bob@example.com',   '{"full_name":"Bob"}',   '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values
  ('google', 'google-sub-alice-xcsec', 'a0000000-0000-4000-8000-00000000000a', '{"sub":"google-sub-alice-xcsec","email":"alice@example.com"}'),
  ('apple',  'apple-sub-bob-xcsec',    'b0000000-0000-4000-8000-00000000000b', '{"sub":"apple-sub-bob-xcsec","email":"bob@example.com"}');

insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values ('a0000000-0000-4000-8000-00000000000a', true, 'pickle_sensei_pro_lifetime', null);

insert into public.sessions (id, user_id, kind, started_at)
values
  ('b0000000-0000-4000-8000-0000000000b5', 'b0000000-0000-4000-8000-00000000000b', 'practice', now()),
  ('a0000000-0000-4000-8000-0000000000a5', 'a0000000-0000-4000-8000-00000000000a', 'practice', now());

insert into public.analysis_permits (id, user_id, idempotency_key, status)
values ('b0000000-0000-4000-8000-0000000000b7', 'b0000000-0000-4000-8000-00000000000b', 'bob-permit', 'reserved');

insert into public.shots (
  id, user_id, session_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
  overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
  pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
  scoring_model_version, shot_config_version
) values (
  'b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-00000000000b',
  'b0000000-0000-4000-8000-0000000000b5', 'dink', 'side', '2026-09-01T00:00:00Z', 0, 100, 200,
  7.5, 0.9, 'scored', '1', '1', '1', '1', '1', '1', '1', '1'
);

-- One fresh reserved permit per case, created as the platform (the edge fn
-- reserves through reserve_analysis_permit; the RPC under test only consumes).
create table xcsec.cases (
  seq        serial primary key,
  case_name  text not null,
  category   text not null,
  overrides  jsonb,          -- shallow-merged over the canonical shot
  remove     text[],         -- keys deleted from the canonical shot
  raw        text,           -- verbatim jsonb text (bypasses templating); may be invalid jsonb
  permit_id  uuid not null default gen_random_uuid(),
  shot_id    uuid not null default gen_random_uuid()
);
grant select on xcsec.cases to authenticated;

create function xcsec.add(p_name text, p_category text, p_overrides jsonb default null, p_remove text[] default null, p_raw text default null)
returns void language sql as $$
  insert into xcsec.cases (case_name, category, overrides, remove, raw) values (p_name, p_category, p_overrides, p_remove, p_raw);
$$;

-- canonical shot (what the edge forwards after parseSyncShot)
create function xcsec.base_shot(p_id uuid, p_permit uuid) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', null,
    'shotType', 'dink',
    'cameraView', 'side',
    'capturedAt', '2026-09-01T10:00:00.000Z',
    'startMs', 0,
    'contactMs', 100,
    'endMs', 200,
    'overallScore', 7,
    'confidence', 0.9,
    'resultKind', 'scored',
    'phases', jsonb_build_array(
      jsonb_build_object('key','ready','startMs',0,'representativeMs',10,'endMs',50,'confidence',0.9),
      jsonb_build_object('key','contact','startMs',50,'representativeMs',100,'endMs',150,'confidence',0.8)
    ),
    'checkpoints', jsonb_build_array(
      jsonb_build_object('key','paddle_ready','score',80,'confidence',0.9,'band','green','direction','ok','severity',0.1,'applicable',true)
    ),
    'versionVector', jsonb_build_object(
      'appVersion','1.0.0','modelBundleVersion','2026.09','poseModelVersion','vision-1',
      'paddleModelVersion','paddle-1','strokeDetectorVersion','stroke-1','phaseModelVersion','phase-1',
      'scoringModelVersion','score-1','shotConfigVersion','cfg-1')
  );
$$;

-- ─────────────────────────────── cases ──────────────────────────────────────
select xcsec.add('baseline valid scored shot', 'control');
select xcsec.add('baseline low_confidence (null score)', 'control', '{"resultKind":"low_confidence","overallScore":null}');
select xcsec.add('sessionId empty string -> nullif', 'control', '{"sessionId":""}');
select xcsec.add('own session id', 'control', '{"sessionId":"a0000000-0000-4000-8000-0000000000a5"}');

-- id cast site (outside the RPC's exception block)
select xcsec.add('id: not a uuid', 'id', '{"id":"not-a-uuid"}');
select xcsec.add('id: sql meta', 'id', jsonb_build_object('id', ''';drop table public.shots;--'));
select xcsec.add('id: null', 'id', '{"id":null}');
select xcsec.add('id: missing', 'id', null, array['id']);
select xcsec.add('id: number', 'id', '{"id":1}');
select xcsec.add('id: object', 'id', '{"id":{"$ne":null}}');
select xcsec.add('id: array', 'id', '{"id":["a0000000-0000-4000-8000-0000000000a1"]}');
select xcsec.add('id: braces uuid', 'id', '{"id":"{a0000000-0000-4000-8000-0000000000a2}"}');
select xcsec.add('id: uppercase uuid', 'id', '{"id":"A0000000-0000-4000-8000-0000000000A3"}');
select xcsec.add('id: nil uuid', 'id', '{"id":"00000000-0000-4000-8000-000000000000"}');
select xcsec.add('id: victim''s existing shot id (cross-user unique_violation)', 'cross_user', '{"id":"b0000000-0000-4000-8000-0000000000b1"}');

-- permit cast + ownership
select xcsec.add('permit: not a uuid', 'permit', '{"analysisPermitId":"x"}');
select xcsec.add('permit: null', 'permit', '{"analysisPermitId":null}');
select xcsec.add('permit: missing', 'permit', null, array['analysisPermitId']);
select xcsec.add('permit: random uuid', 'permit', '{"analysisPermitId":"c0000000-0000-4000-8000-0000000000c7"}');
select xcsec.add('permit: victim''s reserved permit (cross-user)', 'cross_user', '{"analysisPermitId":"b0000000-0000-4000-8000-0000000000b7"}');

-- session ownership
select xcsec.add('session: victim''s session (cross-user)', 'cross_user', '{"sessionId":"b0000000-0000-4000-8000-0000000000b5"}');
select xcsec.add('session: not a uuid', 'session', '{"sessionId":"x"}');
select xcsec.add('session: random uuid', 'session', '{"sessionId":"c0000000-0000-4000-8000-0000000000c5"}');

-- capturedAt (mirrors the Deno DATE_STRINGS corpus + Postgres specials)
select xcsec.add('capturedAt: ' || v, 'captured_at', jsonb_build_object('capturedAt', v))
from unnest(array[
  '2026-09-04T00:00:00.000Z',
  'Thu Jan 01 2026 00:00:00 GMT+0000 (XCSEC_CANARY_DATE_COMMENT)',
  '9/4/2026',
  'Sep 4 2026',
  '2026-09-04 12:00:00 (XCSEC_CANARY_PAREN)',
  '(XCSEC_CANARY_LEAD) Jan 1 2026',
  '0000-01-01T00:00:00Z',
  '-000001-01-01T00:00:00Z',
  '+275760-09-13T00:00:00.000Z',
  '-271821-04-20T00:00:00.000Z',
  '2026-02-30',
  '1',
  '2026',
  'infinity',
  '-infinity',
  'now',
  'today',
  'tomorrow',
  'epoch',
  'allballs',
  '294277-01-01T00:00:00Z',
  '4714-01-01T00:00:00Z BC',
  '2026-09-04 12:00:00+25',
  '2026-09-04T12:00:00.000000001Z',
  'Jan 1 2026 (XCSEC_CANARY_CRLF' || chr(13) || chr(10) || '[api] forged log line)',
  'Jan 1 2026 (XCSEC_CANARY_ANSI' || chr(27) || '[31m)',
  'Jan 1 2026 (' || repeat('X', 100000) || 'XCSEC_CANARY_100K)',
  '',
  ' ',
  'null'
]) as v;
select xcsec.add('capturedAt: json null', 'captured_at', '{"capturedAt":null}');
select xcsec.add('capturedAt: missing', 'captured_at', null, array['capturedAt']);
select xcsec.add('capturedAt: number 0', 'captured_at', '{"capturedAt":0}');
select xcsec.add('capturedAt: number 1e12', 'captured_at', '{"capturedAt":1000000000000}');
select xcsec.add('capturedAt: object', 'captured_at', '{"capturedAt":{"$gt":"2026"}}');

-- int cast sites
select xcsec.add(format('%s: %s', f, v), 'ints', jsonb_build_object(f, to_jsonb(v)))
from unnest(array['startMs','contactMs','endMs']) f,
     unnest(array['2147483647','2147483648','-1','1.5','1e3','NaN','Infinity','', 'abc', '0x10', ' 7 ']) v;
select xcsec.add(format('%s: json number 2147483648', f), 'ints', jsonb_build_object(f, 2147483648))
from unnest(array['startMs','contactMs','endMs']) f;
select xcsec.add(format('%s: json number 1.5', f), 'ints', jsonb_build_object(f, 1.5))
from unnest(array['startMs','contactMs','endMs']) f;
select xcsec.add(format('%s: json null', f), 'ints', jsonb_build_object(f, null::text))
from unnest(array['startMs','contactMs','endMs']) f;
select xcsec.add(format('%s: missing', f), 'ints', null, array[f])
from unnest(array['startMs','contactMs','endMs']) f;
select xcsec.add('timestamps reversed (start>end)', 'ints', '{"startMs":200,"contactMs":100,"endMs":0}');

-- numeric cast sites + column constraints
select xcsec.add('overallScore: ' || v, 'numeric', jsonb_build_object('overallScore', to_jsonb(v)))
from unnest(array['10.005','9.995','10.01','-0','-0.001','NaN','Infinity','1e309','0x1','11','abc','']) v;
select xcsec.add('overallScore: json 10.005', 'numeric', '{"overallScore":10.005}');
select xcsec.add('overallScore: json 9.995', 'numeric', '{"overallScore":9.995}');
select xcsec.add('overallScore: null while scored', 'numeric', '{"overallScore":null}');
select xcsec.add('overallScore: 5 while low_confidence', 'numeric', '{"resultKind":"low_confidence","overallScore":5}');
select xcsec.add('confidence: ' || v, 'numeric', jsonb_build_object('confidence', to_jsonb(v)))
from unnest(array['1.5','-1','NaN','abc','','0.99999','1.00001']) v;
select xcsec.add('confidence: json 0.99999 (numeric(5,4) rounding)', 'numeric', '{"confidence":0.99999}');
select xcsec.add('confidence: json null', 'numeric', '{"confidence":null}');
select xcsec.add('confidence: missing', 'numeric', null, array['confidence']);

-- enum-ish text columns
select xcsec.add('resultKind: ' || coalesce(v, '<null>'), 'enum', jsonb_build_object('resultKind', to_jsonb(v)))
from unnest(array['SCORED','x','','scored ','constructor', null]) v;
select xcsec.add('cameraView: ' || v, 'enum', jsonb_build_object('cameraView', to_jsonb(v)))
from unnest(array['front','SIDE','side ','',''';--']) v;
select xcsec.add('cameraView: null', 'enum', '{"cameraView":null}');

-- free text -> text columns (must be stored verbatim, never interpreted)
select xcsec.add('shotType: ' || left(regexp_replace(v, '[^[:print:]]', '?', 'g'), 40), 'text_verbatim', jsonb_build_object('shotType', v))
from unnest(array[
  ''';drop table public.shots;--',
  '" or 1=1 --',
  ''') ; select pg_sleep(5); --',
  '$$ ; do $$ begin raise exception ''x''; end $$',
  'dink''||(select current_user)||''',
  'dink\''; --',
  '{"a":1}',
  '[1,2,3]',
  'null',
  'true',
  '%00',
  '\u0000',
  U&'\202Eknid',
  U&'\200Bdink\200B',
  'dink' || chr(13) || chr(10) || '{"evt":"api_request","status":500}',
  'dink' || chr(10) || '[api] forged log line',
  chr(27) || '[31mred' || chr(27) || '[0m',
  '../../etc/passwd',
  'http://169.254.169.254/latest/meta-data/',
  '__proto__',
  'constructor',
  'prototype',
  repeat('a', 64),
  repeat('a', 65),
  repeat(U&'\+01F4A5', 33),
  repeat('e' || U&'\0301', 32),
  repeat('x', 10000),
  ' ',
  ''
]) as v;
select xcsec.add('shotType: null', 'text_verbatim', '{"shotType":null}');
select xcsec.add('shotType: number', 'text_verbatim', '{"shotType":1}');
select xcsec.add('shotType: object', 'text_verbatim', '{"shotType":{"a":"b"}}');
select xcsec.add('shotType: array', 'text_verbatim', '{"shotType":["dink"]}');

-- phases / checkpoints shape
select xcsec.add('phases: string', 'shape', '{"phases":"ready"}');
select xcsec.add('phases: object', 'shape', '{"phases":{"key":"ready"}}');
select xcsec.add('phases: number', 'shape', '{"phases":1}');
select xcsec.add('phases: null', 'shape', '{"phases":null}');
select xcsec.add('phases: missing', 'shape', null, array['phases']);
select xcsec.add('phases: [null]', 'shape', '{"phases":[null]}');
select xcsec.add('phases: [[]]', 'shape', '{"phases":[[]]}');
select xcsec.add('phases: [1]', 'shape', '{"phases":[1]}');
select xcsec.add('phases: [{}]', 'shape', '{"phases":[{}]}');
select xcsec.add('phases: key only', 'shape', '{"phases":[{"key":"ready"}]}');
select xcsec.add('phases: duplicate keys (on conflict do nothing)', 'shape',
  '{"phases":[{"key":"ready","startMs":0,"representativeMs":1,"endMs":2,"confidence":0.5},{"key":"ready","startMs":9,"representativeMs":9,"endMs":9,"confidence":0.1}]}');
select xcsec.add('phases: 1000 entries', 'shape',
  jsonb_build_object('phases', (select jsonb_agg(jsonb_build_object('key','p'||i,'startMs',i,'representativeMs',i,'endMs',i,'confidence',0.5)) from generate_series(1,1000) i)));
select xcsec.add('phases: key 10k chars (size cap)', 'shape',
  jsonb_build_object('phases', jsonb_build_array(jsonb_build_object('key',repeat('k',10000),'startMs',0,'representativeMs',1,'endMs',2,'confidence',0.5))));
select xcsec.add('phases: key sql meta', 'shape',
  jsonb_build_object('phases', jsonb_build_array(jsonb_build_object('key',''';drop table public.shot_phases;--','startMs',0,'representativeMs',1,'endMs',2,'confidence',0.5))));
select xcsec.add('phases: startMs int overflow', 'shape',
  '{"phases":[{"key":"ready","startMs":2147483648,"representativeMs":1,"endMs":2,"confidence":0.5}]}');
select xcsec.add('phases: confidence 2', 'shape',
  '{"phases":[{"key":"ready","startMs":0,"representativeMs":1,"endMs":2,"confidence":2}]}');
select xcsec.add('checkpoints: string', 'shape', '{"checkpoints":"x"}');
select xcsec.add('checkpoints: [null]', 'shape', '{"checkpoints":[null]}');
select xcsec.add('checkpoints: [{}]', 'shape', '{"checkpoints":[{}]}');
select xcsec.add('checkpoints: score abc', 'shape',
  '{"checkpoints":[{"key":"x","score":"abc","confidence":0.5,"band":"green","direction":"ok","severity":0.1,"applicable":true}]}');
select xcsec.add('checkpoints: score 100.0005 (numeric(6,3))', 'shape',
  '{"checkpoints":[{"key":"x","score":100.0005,"confidence":0.5,"band":"green","direction":"ok","severity":0.1,"applicable":true}]}');
select xcsec.add('checkpoints: score -0.0001', 'shape',
  '{"checkpoints":[{"key":"x","score":-0.0001,"confidence":0.5,"band":"green","direction":"ok","severity":0.1,"applicable":true}]}');
select xcsec.add('checkpoints: band invalid', 'shape',
  '{"checkpoints":[{"key":"x","score":50,"confidence":0.5,"band":"purple","direction":"ok","severity":0.1,"applicable":true}]}');
select xcsec.add('checkpoints: applicable "yes"', 'shape',
  '{"checkpoints":[{"key":"x","score":50,"confidence":0.5,"band":"green","direction":"ok","severity":0.1,"applicable":"yes"}]}');
select xcsec.add('checkpoints: applicable "t" (pg boolean literal)', 'shape',
  '{"checkpoints":[{"key":"x","score":50,"confidence":0.5,"band":"green","direction":"ok","severity":0.1,"applicable":"t"}]}');
select xcsec.add('checkpoints: applicable 1', 'shape',
  '{"checkpoints":[{"key":"x","score":50,"confidence":0.5,"band":"green","direction":"ok","severity":0.1,"applicable":1}]}');
select xcsec.add('checkpoints: direction 65 chars (size cap)', 'shape',
  jsonb_build_object('checkpoints', jsonb_build_array(jsonb_build_object('key','x','score',50,'confidence',0.5,'band','green','direction',repeat('d',65),'severity',0.1,'applicable',true))));
select xcsec.add('checkpoints: 1000 entries', 'shape',
  jsonb_build_object('checkpoints', (select jsonb_agg(jsonb_build_object('key','c'||i,'score',50,'confidence',0.5,'band','green','direction','ok','severity',0.1,'applicable',true)) from generate_series(1,1000) i)));

-- versionVector
select xcsec.add('versionVector: missing', 'version_vector', null, array['versionVector']);
select xcsec.add('versionVector: null', 'version_vector', '{"versionVector":null}');
select xcsec.add('versionVector: string', 'version_vector', '{"versionVector":"1.0"}');
select xcsec.add('versionVector: array', 'version_vector', '{"versionVector":["1.0"]}');
select xcsec.add('versionVector: nested object values (->> yields json text)', 'version_vector',
  '{"versionVector":{"appVersion":{"x":1},"modelBundleVersion":[1],"poseModelVersion":true,"paddleModelVersion":1,"strokeDetectorVersion":null,"phaseModelVersion":"p","scoringModelVersion":"s","shotConfigVersion":"c"}}');
select xcsec.add('versionVector: appVersion 65 chars (size cap)', 'version_vector',
  jsonb_build_object('versionVector', xcsec.base_shot(gen_random_uuid(), gen_random_uuid()) -> 'versionVector' || jsonb_build_object('appVersion', repeat('v', 65))));
select xcsec.add('versionVector: appVersion sql meta', 'version_vector',
  jsonb_build_object('versionVector', xcsec.base_shot(gen_random_uuid(), gen_random_uuid()) -> 'versionVector' || jsonb_build_object('appVersion', ''';drop table public.shots;--')));

-- prototype-pollution / unknown keys / duplicate keys
select xcsec.add('extra key: __proto__', 'proto', '{"__proto__":{"polluted":true}}');
select xcsec.add('extra key: constructor', 'proto', '{"constructor":{"prototype":{"polluted":true}}}');
select xcsec.add('extra key: prototype', 'proto', '{"prototype":{"polluted":true}}');
select xcsec.add('extra key: source=fixture (RPC hardcodes real)', 'proto', '{"source":"fixture"}');
select xcsec.add('extra key: user_id victim (ignored by RPC)', 'proto', '{"user_id":"b0000000-0000-4000-8000-00000000000b","userId":"b0000000-0000-4000-8000-00000000000b"}');
select xcsec.add('extra key: favorite/declared_stroke (not in RPC)', 'proto', '{"favorite":true,"declared_stroke":"x","declaredStroke":"x"}');
select xcsec.add('extra 500 junk keys', 'proto',
  (select jsonb_object_agg('junk_'||i, i) from generate_series(1,500) i));

-- top-level shape (raw jsonb text; PostgREST would deliver these as the `shot` argument)
select xcsec.add('raw: empty object', 'raw', null, null, '{}');
select xcsec.add('raw: array', 'raw', null, null, '[]');
select xcsec.add('raw: string', 'raw', null, null, '"dink"');
select xcsec.add('raw: number', 'raw', null, null, '1');
select xcsec.add('raw: json null', 'raw', null, null, 'null');
select xcsec.add('raw: duplicate id key (jsonb keeps last)', 'raw', null, null,
  '{"id":"b0000000-0000-4000-8000-0000000000b1","id":"c0000000-0000-4000-8000-0000000000c1","analysisPermitId":"c0000000-0000-4000-8000-0000000000c7"}');
select xcsec.add('raw: deep nesting 5000', 'raw', null, null, repeat('[', 5000) || repeat(']', 5000));
-- These are NOT valid jsonb: PostgREST/jsonb parsing rejects them before the RPC runs.
select xcsec.add('raw: \u0000 in string (jsonb rejects)', 'jsonb_parse', null, null, '{"id":"x","shotType":"dink\u0000x"}');
select xcsec.add('raw: lone surrogate \ud800 (jsonb rejects)', 'jsonb_parse', null, null, '{"id":"x","shotType":"\ud800"}');
select xcsec.add('raw: trailing garbage', 'jsonb_parse', null, null, '{"id":"x"} x');
select xcsec.add('raw: single quotes', 'jsonb_parse', null, null, '{''id'':''x''}');
select xcsec.add('raw: 1e400 number', 'jsonb_parse', null, null, '{"id":"x","overallScore":1e400}');

-- ─────────────────────────────── runner ─────────────────────────────────────
create function xcsec.run_case(p_seq int) returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  c xcsec.cases%rowtype;
  payload jsonb;
  payload_text text;
  r text;
  st text;
  em text;
  t0 timestamptz;
  v_shot uuid;
  v_shot_text text;
  n_shots int; n_phases int; n_cps int;
  p_status text; p_outcome text;
  s_type text; s_captured text; s_day text;
  canary text;
begin
  select * into c from xcsec.cases where seq = p_seq;
  if c.raw is not null then
    payload_text := c.raw;
    begin
      payload := c.raw::jsonb;
    exception when others then
      insert into xcsec.results (case_name, category, shot_id, permit_id, payload, payload_len, payload_sha256,
        result, sqlstate, sqlerrm, sqlerrm_len, echoed_input, duration_ms)
      values (c.case_name, c.category, null, c.permit_id, left(payload_text, 4000), length(payload_text),
        encode(sha256(convert_to(payload_text, 'UTF8')), 'hex'),
        null, sqlstate, left(sqlerrm, 500), length(sqlerrm), false, 0);
      return;
    end;
  else
    payload := xcsec.base_shot(c.shot_id, c.permit_id);
    if c.remove is not null then
      payload := payload - c.remove;
    end if;
    if c.overrides is not null then
      payload := payload || c.overrides;
    end if;
    payload_text := payload::text;
  end if;

  -- The shot id the RPC will (try to) use — text, because it may be garbage.
  v_shot_text := case when jsonb_typeof(payload) = 'object' then payload ->> 'id' else null end;
  begin
    v_shot := v_shot_text::uuid;
  exception when others then
    v_shot := null;
  end;
  canary := substring(payload_text from 'XCSEC_CANARY_[A-Z0-9_]+');

  t0 := clock_timestamp();
  begin
    r := public.apply_synced_shot(payload);
  exception when others then
    st := sqlstate;
    em := sqlerrm;
  end;

  if v_shot is not null then
    select count(*) into n_shots from public.shots s where s.id = v_shot;
    select count(*) into n_phases from public.shot_phases p where p.shot_id = v_shot;
    select count(*) into n_cps from public.shot_checkpoints k where k.shot_id = v_shot;
    select s.shot_type, s.captured_at::text into s_type, s_captured from public.shots s where s.id = v_shot;
    select d.day::text into s_day from public.progress_daily d
      where d.user_id = (select auth.uid()) and d.shot_type = s_type
        and d.day = (select (s.captured_at at time zone 'UTC')::date from public.shots s where s.id = v_shot)
      limit 1;
  end if;
  select p.status, p.outcome into p_status, p_outcome from public.analysis_permits p where p.id = c.permit_id;

  insert into xcsec.results (case_name, category, shot_id, permit_id, payload, payload_len, payload_sha256,
    result, sqlstate, sqlerrm, sqlerrm_len, shot_rows, phase_rows, checkpoint_rows,
    permit_status, permit_outcome, stored_shot_type, stored_captured_at, progress_day, echoed_input, duration_ms)
  values (c.case_name, c.category, v_shot_text, c.permit_id, left(payload_text, 4000), length(payload_text),
    encode(sha256(convert_to(payload_text, 'UTF8')), 'hex'),
    r, st, left(em, 500), length(em), n_shots, n_phases, n_cps,
    p_status, p_outcome, left(s_type, 200), s_captured, s_day,
    canary is not null and (coalesce(r, '') like '%' || canary || '%' or coalesce(em, '') like '%' || canary || '%'),
    round(extract(epoch from clock_timestamp() - t0) * 1000, 3));
end;
$$;
grant execute on function xcsec.run_case(int) to authenticated;

-- permits: one per case, owned by alice, reserved
insert into public.analysis_permits (id, user_id, idempotency_key, status)
select permit_id, 'a0000000-0000-4000-8000-00000000000a', 'xcsec-' || seq, 'reserved' from xcsec.cases;

-- snapshot victim state
create table xcsec.victim_before as
select (select count(*) from public.shots where user_id = 'b0000000-0000-4000-8000-00000000000b') as shots,
       (select count(*) from public.shot_phases where user_id = 'b0000000-0000-4000-8000-00000000000b') as phases,
       (select status from public.analysis_permits where id = 'b0000000-0000-4000-8000-0000000000b7') as permit_status,
       (select count(*) from public.shots) as all_shots;

-- ───────────────────────── execute as the attacker ──────────────────────────
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-4000-8000-00000000000a';

do $$
declare s int;
begin
  for s in select seq from xcsec.cases order by seq loop
    perform xcsec.run_case(s);
  end loop;
  -- replay of the baseline: idempotent accept, no duplicate rows
  perform xcsec.run_case(1);
end $$;

-- seeded hostile batch: 200 shots with 0-3 mutated fields drawn from the
-- corpora above (deterministic via setseed) — the SQL-side twin of the Deno
-- seeded run. Replay: -v seed=<float in [-1,1]>
\if :{?seed}
\else
\set seed 0.20260904
\endif
select setseed(:seed);
create temp table seeded_cases (seq int, payload jsonb, mutations jsonb);
do $$
declare
  i int;
  base jsonb;
  m jsonb;
  k int;
  field text;
  val jsonb;
  hostile_text text[] := array[''';drop table public.shots;--', '" or 1=1 --', 'null', '', repeat('a',65), U&'\202Eknid',
                              'dink' || chr(10) || 'forged', 'infinity', '2026-02-30', 'Jan 1 2026 (XCSEC_CANARY_SEEDED)', 'NaN', '1e400', '-1', '2147483648'];
  fields text[] := array['id','analysisPermitId','sessionId','shotType','cameraView','capturedAt','startMs','contactMs','endMs','overallScore','confidence','resultKind','phases','checkpoints','versionVector'];
  permit uuid;
begin
  for i in 1..200 loop
    permit := gen_random_uuid();
    base := xcsec.base_shot(gen_random_uuid(), permit);
    m := '[]'::jsonb;
    for k in 1..floor(random() * 4)::int loop
      field := fields[1 + floor(random() * array_length(fields, 1))::int];
      val := to_jsonb(hostile_text[1 + floor(random() * array_length(hostile_text, 1))::int]);
      base := jsonb_set(base, array[field], val);
      m := m || jsonb_build_object('field', field, 'value', val);
    end loop;
    insert into seeded_cases values (i, base, m);
  end loop;
end $$;
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key, status)
select (payload ->> 'analysisPermitId')::uuid, 'a0000000-0000-4000-8000-00000000000a', 'xcsec-seeded-' || seq, 'reserved'
from seeded_cases where (payload ->> 'analysisPermitId') ~ '^[0-9a-f-]{36}$';
create table xcsec.seeded_results (seq int, mutations jsonb, result text, sqlstate text, sqlerrm text, duration_ms numeric);
grant insert, select on xcsec.seeded_results to authenticated;
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-4000-8000-00000000000a';
do $$
declare
  c record; r text; st text; em text; t0 timestamptz;
begin
  for c in select * from seeded_cases order by seq loop
    r := null; st := null; em := null; t0 := clock_timestamp();
    begin
      r := public.apply_synced_shot(c.payload);
    exception when others then
      st := sqlstate; em := sqlerrm;
    end;
    insert into xcsec.seeded_results values (c.seq, c.mutations, r, st, left(em, 300), round(extract(epoch from clock_timestamp() - t0) * 1000, 3));
  end loop;
end $$;
reset role;
-- the seeded payloads themselves (replayable inputs)
create table xcsec.seeded_inputs as select seq, payload::text as payload, mutations from seeded_cases;

-- ───────────────────────── hard invariants (fail the run) ───────────────────
do $$
declare
  b xcsec.victim_before%rowtype;
  bad int;
  msg text;
begin
  select * into b from xcsec.victim_before;

  -- 1. victim untouched
  if (select count(*) from public.shots where user_id = 'b0000000-0000-4000-8000-00000000000b') <> b.shots
     or (select status from public.analysis_permits where id = 'b0000000-0000-4000-8000-0000000000b7') <> b.permit_status then
    raise exception 'XCSEC FAIL: victim rows changed';
  end if;
  -- 2. no shot row belongs to anyone but its writer; nothing landed under bob
  if exists (select 1 from public.shots s where s.user_id not in ('a0000000-0000-4000-8000-00000000000a','b0000000-0000-4000-8000-00000000000b')) then
    raise exception 'XCSEC FAIL: shot row with foreign user_id';
  end if;
  if (select count(*) from public.shots where user_id = 'b0000000-0000-4000-8000-00000000000b') <> 1 then
    raise exception 'XCSEC FAIL: attacker wrote a row under the victim';
  end if;
  -- 3. atomicity: non-accepted cases left no shot/phase/checkpoint rows and kept the permit reserved
  --    (except the access.* outcomes that release it on purpose)
  select count(*), string_agg(case_name, ' | ') into bad, msg from xcsec.results
   where result is distinct from 'accepted' and (coalesce(shot_rows, 0) > 0 or coalesce(phase_rows, 0) > 0 or coalesce(checkpoint_rows, 0) > 0);
  if bad > 0 then raise exception 'XCSEC FAIL: partial write on rejected case(s): %', msg; end if;
  select count(*), string_agg(case_name, ' | ') into bad, msg from xcsec.results
   where result is distinct from 'accepted' and result not like 'access.%' and permit_status is distinct from 'reserved'
     and category <> 'jsonb_parse';
  if bad > 0 then raise exception 'XCSEC FAIL: permit consumed by a rejected case: %', msg; end if;
  -- 4. every accepted case has exactly one shot row owned by alice
  select count(*), string_agg(case_name, ' | ') into bad, msg from xcsec.results r
   where r.result = 'accepted' and r.shot_id is not null
     and (select count(*) from public.shots s where s.id = r.shot_id::uuid and s.user_id = 'a0000000-0000-4000-8000-00000000000a') <> 1;
  if bad > 0 then raise exception 'XCSEC FAIL: accepted without exactly one owned row: %', msg; end if;
  -- 5. text columns hold the payload verbatim (no interpretation, no truncation)
  select count(*), string_agg(case_name, ' | ') into bad, msg from xcsec.results r
   where r.category = 'text_verbatim' and r.result = 'accepted' and r.payload_len <= 4000
     and r.stored_shot_type is distinct from (r.payload::jsonb ->> 'shotType');
  if bad > 0 then raise exception 'XCSEC FAIL: shotType not stored verbatim: %', msg; end if;
  -- 6. tables named in the payloads still exist
  perform 1 from public.shots limit 1;
  perform 1 from public.shot_phases limit 1;
  -- 7. every result is a known contract status, a write_failed detail, or a raised error
  select count(*), string_agg(case_name || '=' || coalesce(result, '<raise>'), ' | ') into bad, msg from xcsec.results
   where result is not null and result not in ('accepted','auth.required','access.permit_not_found','access.permit_not_reserved',
     'access.permit_expired','access.paywall_required','shot.session_not_found','shot.id_conflict')
     and result not like 'shot.write_failed:%';
  if bad > 0 then raise exception 'XCSEC FAIL: unknown RPC status: %', msg; end if;
  -- 8. cross-user cases never accepted
  select count(*), string_agg(case_name, ' | ') into bad, msg from xcsec.results where category = 'cross_user' and result = 'accepted';
  if bad > 0 then raise exception 'XCSEC FAIL: cross-user payload accepted: %', msg; end if;
  -- 9. the RPC hardcodes source=real regardless of payload
  if exists (select 1 from public.shots where source <> 'real') then raise exception 'XCSEC FAIL: non-real source stored'; end if;
  -- 10. replay accepted without duplicating rows
  if (select count(*) from xcsec.results where case_name = 'baseline valid scored shot' and result = 'accepted') <> 2
     or (select count(*) from public.shots s join xcsec.cases c on c.shot_id = s.id where c.seq = 1) <> 1 then
    raise exception 'XCSEC FAIL: replay semantics';
  end if;
  -- 11. seeded batch: every row has a verdict
  if (select count(*) from xcsec.seeded_results where result is null and sqlstate is null) > 0 then
    raise exception 'XCSEC FAIL: seeded case without verdict';
  end if;
end $$;

-- ───────────────────── contract observations (strict mode fails) ────────────
insert into xcsec.observations (test, expectation, detail)
select 'captured_at', 'timestamptz specials must not be storable as captured_at (infinite day breaks progress bucketing)',
       jsonb_build_object('case', case_name, 'stored_captured_at', stored_captured_at, 'progress_day', progress_day)
from xcsec.results where result = 'accepted' and stored_captured_at in ('infinity', '-infinity');
insert into xcsec.observations (test, expectation, detail)
select 'captured_at', 'relative timestamp literals (now/today/tomorrow/epoch) must not be accepted as a client-supplied capture time',
       jsonb_build_object('case', case_name, 'stored_captured_at', stored_captured_at)
from xcsec.results where result = 'accepted' and case_name in ('capturedAt: now','capturedAt: today','capturedAt: tomorrow','capturedAt: epoch','capturedAt: allballs');
insert into xcsec.observations (test, expectation, detail)
select 'echo', 'RPC return value / error must not echo user-controlled input verbatim (it is written to function logs by the edge: index.ts console.error("[api] shot sync write failed:", status))',
       jsonb_build_object('case', case_name, 'result_head', left(coalesce(result, sqlerrm), 160), 'result_len', coalesce(length(result), sqlerrm_len), 'payload_len', payload_len)
from xcsec.results where echoed_input;

\if :strict
do $$
declare n int; d text;
begin
  select count(*), string_agg(test || ': ' || expectation, E'\n') into n, d from xcsec.observations;
  if n > 0 then raise exception E'XCSEC STRICT: % contract observation(s)\n%', n, d; end if;
end $$;
\endif

select category, count(*) filter (where result = 'accepted') as accepted,
       count(*) filter (where result like 'shot.write_failed:%') as write_failed,
       count(*) filter (where result like 'access.%' or result like 'shot.%' and result not like 'shot.write_failed:%') as contract_reject,
       count(*) filter (where result is null) as raised,
       count(*) as total
from xcsec.results group by category order by category;
select result, count(*) from xcsec.seeded_results group by 1 order by 2 desc;
select test, count(*) from xcsec.observations group by 1;
