-- ============================================================================
-- Pickle Sensei — STRESS harness: db-free-rating-ledger / lens boundary-malformed
--
-- Installs schema `stress_bm` on a DISPOSABLE Postgres that already has
-- supabase/tests/shim_auth.sql + every supabase/migrations/*.sql applied
-- (run_boundary_malformed.sh does that). Nothing here touches production code:
-- it only DRIVES the shipped objects (apply_synced_shot, reserve_analysis_permit,
-- free_rating_ledger, lifetime/identity_scored_count, the ledger triggers,
-- reject_ledger_mutation, enforce_scored_shot_permit) with seeded hostile input.
--
-- Determinism: every random draw is hashtextextended(seed || '/' || k), so an
-- iteration is fully replayable from its seed alone:
--     select * from stress_bm.run_one(<seed>, 0, 0);
--
-- Verdict vocabulary (stress_bm.results.verdict):
--   HELD          graceful: typed status / SQLSTATE at the boundary, no write
--   RAISED        the RPC threw a SQLSTATE out of the function instead of
--                 returning a categorical status (PostgREST → 400, no write)
--   BROKEN        a write leaked, a must-reject payload was accepted, the free
--                 limit / ledger invariant broke, or an unknown status appeared
--   COLLISION     two distinct (provider, provider_id) pairs share a ledger row
--   HARNESS_ERROR the harness itself failed for this seed (not a product verdict)
-- ============================================================================

create schema if not exists stress_bm;
-- The harness switches role mid-function (SET ROLE authenticated/anon/service_role)
-- and must still be able to call its own helpers to switch back.
grant usage on schema stress_bm to public;
alter default privileges in schema stress_bm grant execute on functions to public;

create table if not exists stress_bm.results (
  seed         bigint primary key,
  gen_seed     bigint not null,
  worker       int not null,
  iteration    int not null,
  category     text not null,
  subcategory  text not null,
  user_key     text,
  premium      boolean,
  mode         text,
  payload      text,
  payload_len  int,
  json_ok      boolean,
  must_reject  boolean,
  status       text,
  sqlstate     text,
  sqlmsg       text,
  deltas       jsonb,
  verdict      text not null,
  note         text,
  elapsed_ms   numeric,
  recorded_at  timestamptz not null default now()
);

create table if not exists stress_bm.pool (
  idx      int primary key,
  user_id  uuid not null,
  premium  boolean not null
);

-- ────────────────────────────── seeded RNG ──────────────────────────────────
create or replace function stress_bm.rnd(p_seed bigint, p_k int)
returns bigint language sql immutable as $fn$
  select hashtextextended(p_seed::text || '/' || p_k::text, 0) & 9223372036854775807
$fn$;

create or replace function stress_bm.pick(p_seed bigint, p_k int, p_n int)
returns int language sql immutable as $fn$
  select (stress_bm.rnd(p_seed, p_k) % greatest(p_n, 1))::int
$fn$;

create or replace function stress_bm.det_uuid(p_seed bigint, p_tag text)
returns uuid language sql immutable as $fn$
  select md5(p_seed::text || ':' || p_tag)::uuid
$fn$;

-- ───────────────────────── hostile primitive generators ─────────────────────
create or replace function stress_bm.hstr_count() returns int language sql immutable as $fn$ select 34 $fn$;

create or replace function stress_bm.hstr(p_seed bigint, p_k int, out kind text, out val text)
language plpgsql immutable as $fn$
declare v int := stress_bm.pick(p_seed, p_k, stress_bm.hstr_count());
begin
  kind := 'hstr#' || v;
  val := case v
    when 0 then ''
    when 1 then repeat('a', 64)
    when 2 then repeat('a', 65)
    when 3 then repeat('é', 64)                                     -- 64 codepoints, 128 bytes
    when 4 then repeat('é', 65)
    when 5 then repeat(U&'\+01F600', 64)                            -- 64 astral codepoints, 256 bytes
    when 6 then repeat(U&'\+01F468\200D\+01F469\200D\+01F467\200D\+01F466', 16) -- 16 graphemes, 112 codepoints
    when 7 then repeat('x', 65536)
    when 8 then repeat('x', 1048576)
    when 9 then '../../etc/passwd'
    when 10 then '..\..\windows\system32\config\sam'
    when 11 then '%2e%2e%2f%2e%2e%2fetc%2fpasswd'
    when 12 then 'drive''; drop table public.shots; --'
    when 13 then U&'\00E9'                                          -- é NFC
    when 14 then U&'e\0301'                                         -- é NFD
    when 15 then U&'\FEFF' || 'drive'
    when 16 then 'dr' || U&'\200D' || 'ive'
    when 17 then '   '
    when 18 then chr(1) || chr(31) || chr(127)
    when 19 then U&'\FB03'                                          -- ﬃ ligature (NFKC-unstable)
    when 20 then U&'\D55C\AD6D'
    when 21 then U&'\202E' || 'evird'
    when 22 then '{"__proto__":{"polluted":true}}'
    when 23 then 'null'
    when 24 then 'NaN'
    when 25 then U&'\+01D7D8'
    when 26 then repeat('é', 32) || repeat('a', 32)
    when 27 then 'Drive'
    when 28 then 'drive '
    when 29 then '\u0000'
    when 30 then repeat('a', 63)
    when 31 then repeat('0', 4096)
    when 32 then '<script>alert(1)</script>'
    when 33 then '${jndi:ldap://127.0.0.1/a}'
  end;
end;
$fn$;

create or replace function stress_bm.hnum_count() returns int language sql immutable as $fn$ select 36 $fn$;

create or replace function stress_bm.hnum(p_seed bigint, p_k int, out kind text, out val jsonb)
language plpgsql immutable as $fn$
declare v int := stress_bm.pick(p_seed, p_k, stress_bm.hnum_count());
begin
  kind := 'hnum#' || v;
  val := case v
    when 0 then '2147483647'::jsonb
    when 1 then '2147483648'::jsonb
    when 2 then '-2147483648'::jsonb
    when 3 then '-2147483649'::jsonb
    when 4 then '9223372036854775807'::jsonb
    when 5 then '9223372036854775808'::jsonb
    when 6 then '1e19'::jsonb
    when 7 then '1e400'::jsonb
    when 8 then '-1e400'::jsonb
    when 9 then '-0'::jsonb
    when 10 then '0.5'::jsonb
    when 11 then '1.9999999'::jsonb
    when 12 then '1e-400'::jsonb
    when 13 then '0'::jsonb
    when 14 then '-1'::jsonb
    when 15 then '10'::jsonb
    when 16 then '10.005'::jsonb
    when 17 then '10.004'::jsonb
    when 18 then '9.999'::jsonb
    when 19 then '99.99'::jsonb
    when 20 then '100'::jsonb
    when 21 then '1.00005'::jsonb
    when 22 then '2'::jsonb
    when 23 then '"NaN"'::jsonb
    when 24 then '"Infinity"'::jsonb
    when 25 then '"-Infinity"'::jsonb
    when 26 then '"1e5"'::jsonb
    when 27 then '"0x10"'::jsonb
    when 28 then '" 5"'::jsonb
    when 29 then '"5abc"'::jsonb
    when 30 then 'true'::jsonb
    when 31 then 'null'::jsonb
    when 32 then '[]'::jsonb
    when 33 then '{}'::jsonb
    when 34 then '""'::jsonb
    when 35 then '0.1'::jsonb
  end;
end;
$fn$;

-- Oracle for numeric fields: mirrors the column coercion + CHECK the shipped
-- table applies, so must_reject is exact. NULL = "either outcome acceptable".
create or replace function stress_bm.num_expect(p_field text, p_val jsonb, p_kind text)
returns boolean language plpgsql immutable as $fn$
declare
  t text := jsonb_typeof(p_val);
  s text;
  n numeric;
  i int;
begin
  if t in ('boolean', 'array', 'object') then return true; end if;
  if t = 'null' then
    return case p_field
      when 'contactMs' then false
      when 'checkpoints.score' then false
      when 'overallScore' then (p_kind = 'scored')
      else true end;
  end if;
  s := p_val #>> '{}';
  if p_field in ('startMs', 'contactMs', 'endMs', 'phases.startMs', 'phases.representativeMs', 'phases.endMs') then
    begin
      i := s::int;
      return false;
    exception when others then
      return true;
    end;
  end if;
  begin
    n := s::numeric;
  exception when others then
    return true;
  end;
  if p_field = 'overallScore' then
    if p_kind <> 'scored' then return true; end if;   -- low_confidence ⇒ score must be null
    begin n := n::numeric(4,2); exception when others then return true; end;
    return not (n >= 0 and n <= 10);
  elsif p_field in ('confidence', 'phases.confidence', 'checkpoints.confidence', 'checkpoints.severity') then
    begin n := n::numeric(5,4); exception when others then return true; end;
    return not (n >= 0 and n <= 1);
  elsif p_field = 'checkpoints.score' then
    begin n := n::numeric(6,3); exception when others then return true; end;
    return not (n >= 0 and n <= 100);
  end if;
  return null;
end;
$fn$;

-- ────────────────────────────── base payload ────────────────────────────────
create or replace function stress_bm.base_payload(
  p_shot uuid, p_permit text, p_session text, p_kind text, p_shot_type text default 'drive'
) returns jsonb language sql immutable as $fn$
  select jsonb_build_object(
    'id', p_shot::text,
    'analysisPermitId', p_permit,
    'sessionId', p_session,
    'resultKind', p_kind,
    'shotType', p_shot_type,
    'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then to_jsonb(7.1) else 'null'::jsonb end,
    'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'),
    'phases', jsonb_build_array(jsonb_build_object(
      'key', 'contact', 'startMs', 400, 'representativeMs', 500, 'endMs', 600, 'confidence', 0.9)),
    'checkpoints', jsonb_build_array(jsonb_build_object(
      'key', 'contact_position', 'score', 71, 'confidence', 0.9,
      'band', 'green', 'direction', 'ok', 'severity', 0.1, 'applicable', true))
  )
$fn$;

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'stress_bm' and t.typname = 'gen') then
    create type stress_bm.gen as (subcategory text, payload text, must_reject boolean, note text);
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'stress_bm' and t.typname = 'outcome') then
    create type stress_bm.outcome as (
      subcategory text, user_key text, premium boolean, mode text, payload text, json_ok boolean,
      must_reject boolean, status text, sqlstate text, sqlmsg text, deltas jsonb, verdict text, note text
    );
  end if;
end $$;

-- ───────────────────────── payload generator per category ───────────────────
create or replace function stress_bm.gen_rpc(
  p_seed bigint, p_cat int, p_shot uuid, p_permit text, p_session text, p_kind text
) returns stress_bm.gen language plpgsql immutable as $fn$
declare
  b jsonb := stress_bm.base_payload(p_shot, p_permit, p_session, p_kind);
  bt text := b::text;
  v int := stress_bm.pick(p_seed, 10, 1000000);
  g stress_bm.gen;
  hs record;
  hn record;
  fld text;
  tv text;
begin
  g.must_reject := null;
  g.note := null;

  if p_cat = 0 then -- raw malformed / truncated JSON
    v := v % 24;
    g.subcategory := 'raw_malformed#' || v;
    g.must_reject := true;
    g.payload := case v
      when 0 then left(bt, 1 + stress_bm.pick(p_seed, 11, length(bt) - 2))     -- truncated anywhere inside
      when 1 then bt || '}'
      when 2 then bt || ' garbage'
      when 3 then replace(bt, '"', '''')
      when 4 then replace(bt, '7.1', 'NaN')
      when 5 then replace(bt, '7.1', 'Infinity')
      when 6 then replace(bt, '7.1', '-Infinity')
      when 7 then replace(bt, '"drive"', '"dr\u0000ive"')
      when 8 then '{"id":'
      when 9 then ''
      when 10 then '   '
      when 11 then replace(bt, '"confidence": 0.9}', '"confidence": 0.9,}')
      when 12 then replace(bt, '"drive"', '"dr\x41ive"')
      when 13 then replace(bt, '"drive"', '"dr' || chr(1) || 'ive"')
      when 14 then '/* c */' || bt
      when 15 then replace(bt, 'true', 'True')
      when 16 then replace(bt, '"startMs": 0', '"startMs": 0x10')
      when 17 then replace(bt, '"startMs": 0', '"startMs": +0')
      when 18 then replace(bt, '7.1', '7.')
      when 19 then replace(bt, '7.1', '.71')
      when 20 then replace(bt, '"startMs": 0', '"startMs": 01')
      when 21 then bt || bt
      when 22 then replace(bt, '"drive"', 'undefined')
      when 23 then repeat('[', 100000) || repeat(']', 100000)
    end;
    if v = 23 then g.must_reject := null; g.note := 'deep nesting: parse error or non-object'; end if;
    if g.payload = bt then
      -- the mutated token is absent from this base payload (e.g. overallScore is
      -- null for an abstention): the payload is the untouched valid one
      g.must_reject := false; g.note := 'mutation no-op: token absent, payload is the valid base';
    end if;

  elsif p_cat = 1 then -- wrong JSON types
    v := v % 40;
    g.subcategory := 'wrong_type#' || v;
    g.must_reject := true;
    g.payload := case v
      when 0 then '"a string"'
      when 1 then '123'
      when 2 then 'null'
      when 3 then 'true'
      when 4 then '[]'
      when 5 then '[{}]'
      when 6 then '[' || bt || ']'
      when 7 then (b || '{"id": 123}')::text
      when 8 then (b || '{"id": true}')::text
      when 9 then (b || '{"id": {}}')::text
      when 10 then (b || '{"id": []}')::text
      when 11 then (b || jsonb_build_object('id', jsonb_build_object('id', p_shot::text)))::text
      when 12 then (b || '{"analysisPermitId": 123}')::text
      when 13 then (b || jsonb_build_object('analysisPermitId', jsonb_build_array(p_permit)))::text
      when 14 then (b || jsonb_build_object('analysisPermitId', jsonb_build_object('$oid', p_permit)))::text
      when 15 then (b || '{"sessionId": 123}')::text
      when 16 then (b || '{"sessionId": {}}')::text
      when 17 then (b || '{"phases": {}}')::text
      when 18 then (b || '{"phases": "x"}')::text
      when 19 then (b || '{"phases": 1}')::text
      when 20 then (b || '{"phases": true}')::text
      when 21 then (b || '{"phases": [1,2,3]}')::text
      when 22 then (b || '{"phases": ["a"]}')::text
      when 23 then (b || '{"phases": [null]}')::text
      when 24 then (b || '{"phases": [[]]}')::text
      when 25 then (b || '{"checkpoints": {}}')::text
      when 26 then (b || '{"checkpoints": [1]}')::text
      when 27 then (b || '{"versionVector": []}')::text
      when 28 then (b || '{"versionVector": "x"}')::text
      when 29 then (b || '{"versionVector": 1}')::text
      when 30 then (b || '{"versionVector": null}')::text
      when 31 then (b || '{"versionVector": [{"appVersion":"1"}]}')::text
      when 32 then (b || '{"overallScore": "abc"}')::text
      when 33 then (b || '{"overallScore": [7.1]}')::text
      when 34 then (b || '{"startMs": "12abc"}')::text
      when 35 then (b || '{"startMs": {}}')::text
      when 36 then (b || '{"resultKind": 1}')::text
      when 37 then (b || '{"resultKind": ["scored"]}')::text
      when 38 then (b || '{"capturedAt": []}')::text
      when 39 then (b || '{"phases": null}')::text
    end;
    if v = 39 then g.must_reject := false; g.note := 'phases:null is coalesced to []'; end if;

  elsif p_cat = 2 then -- prototype-pollution / duplicate keys
    v := v % 12;
    g.subcategory := 'proto_keys#' || v;
    g.must_reject := false;
    g.payload := case v
      when 0 then (b || '{"__proto__": {"polluted": true}}')::text
      when 1 then (b || '{"constructor": {"prototype": {"polluted": true}}}')::text
      when 2 then (b || '{"prototype": {"polluted": true}}')::text
      when 3 then (b || '{"toString": 1, "valueOf": 2, "hasOwnProperty": null}')::text
      when 4 then jsonb_set(b, '{versionVector,__proto__}', '{"polluted":true}')::text
      when 5 then jsonb_set(b, '{phases,0,__proto__}', '{"polluted":true}')::text
      when 6 then jsonb_set(b, '{checkpoints,0,constructor}', '"x"')::text
      when 7 then '{"resultKind":"low_confidence",' || substr(bt, 2)   -- dup key, base kind wins
      when 8 then left(bt, length(bt) - 1) || ',"resultKind":"low_confidence"}'  -- dup key, last wins
      when 9 then left(bt, length(bt) - 1) || ',"overallScore":null}'
      when 10 then left(bt, length(bt) - 1) || ',"id":"' || stress_bm.det_uuid(p_seed, 'dup-id') || '"}'
      when 11 then (b || '{"__proto__": null, "constructor": null}')::text
    end;
    if v = 8 and p_kind = 'scored' then g.must_reject := true; g.note := 'last dup wins → low_confidence with a score'; end if;
    if v = 9 and p_kind = 'scored' then g.must_reject := true; g.note := 'scored with null score'; end if;

  elsif p_cat = 3 then -- numeric overflow / NaN / Infinity / -0
    select * into hn from stress_bm.hnum(p_seed, 12);
    v := v % 9;
    fld := (array['startMs','contactMs','endMs','overallScore','confidence',
                  'phases.startMs','phases.confidence','checkpoints.score','checkpoints.severity'])[v + 1];
    g.subcategory := 'numeric_edge:' || fld || ':' || hn.kind;
    g.payload := case fld
      when 'phases.startMs' then jsonb_set(b, '{phases,0,startMs}', hn.val)
      when 'phases.confidence' then jsonb_set(b, '{phases,0,confidence}', hn.val)
      when 'checkpoints.score' then jsonb_set(b, '{checkpoints,0,score}', hn.val)
      when 'checkpoints.severity' then jsonb_set(b, '{checkpoints,0,severity}', hn.val)
      else b || jsonb_build_object(fld, hn.val)
    end::text;
    g.must_reject := stress_bm.num_expect(fld, hn.val, p_kind);

  elsif p_cat = 4 then -- 64KB+ strings vs byte/codepoint/grapheme caps
    select * into hs from stress_bm.hstr(p_seed, 12);
    v := v % 8;
    fld := (array['shotType','versionVector.appVersion','versionVector.shotConfigVersion','phases.key',
                  'checkpoints.key','checkpoints.direction','cameraView','unknownKey'])[v + 1];
    g.subcategory := 'big_strings:' || fld || ':' || hs.kind;
    g.payload := case fld
      when 'versionVector.appVersion' then jsonb_set(b, '{versionVector,appVersion}', to_jsonb(hs.val))
      when 'versionVector.shotConfigVersion' then jsonb_set(b, '{versionVector,shotConfigVersion}', to_jsonb(hs.val))
      when 'phases.key' then jsonb_set(b, '{phases,0,key}', to_jsonb(hs.val))
      when 'checkpoints.key' then jsonb_set(b, '{checkpoints,0,key}', to_jsonb(hs.val))
      when 'checkpoints.direction' then jsonb_set(b, '{checkpoints,0,direction}', to_jsonb(hs.val))
      else b || jsonb_build_object(fld, hs.val)
    end::text;
    g.must_reject := case
      when fld = 'unknownKey' then false
      when fld = 'cameraView' then hs.val not in ('side', 'rear_oblique')
      else length(hs.val) > 64
    end;
    g.note := format('chars=%s bytes=%s', length(hs.val), octet_length(hs.val));

  elsif p_cat = 5 then -- null bytes
    v := v % 8;
    g.subcategory := 'null_bytes#' || v;
    g.must_reject := true;
    g.payload := case v
      when 0 then replace(bt, '"drive"', '"dr\u0000ive"')
      when 1 then replace(bt, '"id": "', '"id": "\u0000')
      when 2 then replace(bt, '"shotType"', '"shot\u0000Type"')
      when 3 then replace(bt, '"1.0.0"', '"1.0.0\u0000"')
      when 4 then replace(bt, '"contact"', '"con\u0000tact"')
      when 5 then left(bt, length(bt) - 1) || ',"\u0000":1}'
      when 6 then left(bt, length(bt) - 1) || ',"nul":"\u0000"}'
      when 7 then replace(bt, '"drive"', '"dr\\u0000ive"')     -- escaped backslash: legal 10-char string
    end;
    if v = 7 then g.must_reject := false; g.note := 'literal backslash-u0000 text, not a NUL'; end if;

  elsif p_cat = 6 then -- path traversal / injection in ids and slugs
    v := v % 7;
    fld := (array['id','analysisPermitId','sessionId','shotType','phases.key','checkpoints.key','versionVector.appVersion'])[v + 1];
    tv := (array[
      '../../etc/passwd', '..\..\', '%2e%2e/%2e%2e/', '/etc/passwd', 'file:///etc/passwd', '..;/',
      p_shot::text || '/../' || p_shot::text, '\\server\share', '$(rm -rf /)', '`id`', '{{7*7}}',
      '${jndi:ldap://x/a}', ''' or 1=1 --', '<script>alert(1)</script>', '{' || p_shot::text || '}',
      upper(p_shot::text), replace(p_shot::text, '-', ''), 'urn:uuid:' || p_shot::text
    ])[1 + stress_bm.pick(p_seed, 13, 18)];
    g.subcategory := 'path_traversal:' || fld || ':' || left(tv, 20);
    g.payload := case fld
      when 'phases.key' then jsonb_set(b, '{phases,0,key}', to_jsonb(tv))
      when 'checkpoints.key' then jsonb_set(b, '{checkpoints,0,key}', to_jsonb(tv))
      when 'versionVector.appVersion' then jsonb_set(b, '{versionVector,appVersion}', to_jsonb(tv))
      else b || jsonb_build_object(fld, tv)
    end::text;
    g.must_reject := case
      when fld in ('id', 'analysisPermitId', 'sessionId') then
        case when tv in ('{' || p_shot::text || '}', upper(p_shot::text), replace(p_shot::text, '-', ''))
             then null else true end
      -- >64 codepoints trips the NOT VALID size caps (shot_type / phase_key /
      -- checkpoint_key / app_version <= 64): a categorical write_failed:23514
      -- is the correct outcome; the edge parser refuses these earlier anyway
      when length(tv) > 64 then null
      else false
    end;

  elsif p_cat = 7 then -- future schema versions / unknown enum members
    v := v % 22;
    g.subcategory := 'future_schema#' || v;
    g.payload := case v
      when 0 then (b || '{"schemaVersion": 2}')::text
      when 1 then (b || '{"schemaVersion": "99.0", "v": 99}')::text
      when 2 then jsonb_set(b, '{versionVector}', (b -> 'versionVector') || '{"schema":"v9","futureField":[1,2]}')::text
      when 3 then (b || '{"resultKind": "scored_v2"}')::text
      when 4 then (b || '{"resultKind": "SCORED"}')::text
      when 5 then (b || '{"resultKind": "Scored"}')::text
      when 6 then (b || '{"resultKind": "scored "}')::text
      when 7 then (b || '{"resultKind": " scored"}')::text
      when 8 then (b || '{"resultKind": "low-confidence"}')::text
      when 9 then (b || '{"resultKind": "LOW_CONFIDENCE"}')::text
      when 10 then (b || '{"resultKind": "abstained"}')::text
      when 11 then (b || '{"resultKind": ""}')::text
      when 12 then (b || '{"cameraView": "front"}')::text
      when 13 then (b || '{"cameraView": "SIDE"}')::text
      when 14 then (b || '{"cameraView": "rear-oblique"}')::text
      when 15 then (b || '{"cameraView": "rear_oblique"}')::text
      when 16 then jsonb_set(b, '{checkpoints,0,band}', '"ultraviolet"')::text
      when 17 then jsonb_set(b, '{checkpoints,0,band}', '"GREEN"')::text
      when 18 then jsonb_set(b, '{checkpoints,0,applicable}', '"yes"')::text
      when 19 then jsonb_set(b, '{checkpoints,0,applicable}', '"maybe"')::text
      when 20 then jsonb_set(b, '{phases,0}', (b -> 'phases' -> 0) || '{"future":{"deep":[1]}}')::text
      when 21 then (b || (select jsonb_object_agg('future_key_' || i, i) from generate_series(1, 50) i))::text
    end;
    g.must_reject := case
      when v in (3,4,5,6,7,8,9,10,11,12,13,14,16,17,19) then true
      when v in (0,1,2,15,18,20,21) then false
    end;

  elsif p_cat = 8 then -- empty arrays / objects / strings
    v := v % 18;
    g.subcategory := 'empty_shapes#' || v;
    g.payload := case v
      when 0 then '{}'
      when 1 then '[]'
      when 2 then '""'
      when 3 then '0'
      when 4 then 'false'
      when 5 then (b || '{"phases": []}')::text
      when 6 then (b || '{"phases": [{}]}')::text
      when 7 then (b || '{"checkpoints": [{}]}')::text
      when 8 then (b || '{"versionVector": {}}')::text
      when 9 then (select jsonb_object_agg(k, case when jsonb_typeof(val) = 'string' then '""'::jsonb else val end)
                   from jsonb_each(b) e(k, val))::text
      when 10 then (b || '{"id": ""}')::text
      when 11 then (b || '{"resultKind": ""}')::text
      when 12 then (b || '{"shotType": ""}')::text
      when 13 then (b || '{"capturedAt": ""}')::text
      when 14 then (b || '{"phases": [[]]}')::text
      when 15 then (b || '{"checkpoints": [null]}')::text
      when 16 then (b || '{"sessionId": ""}')::text
      when 17 then (b || '{"analysisPermitId": ""}')::text
    end;
    g.must_reject := case
      when v in (5, 12, 16) then false
      else true
    end;

  elsif p_cat = 9 then -- unicode normalization pairs (two shots per iteration)
    v := v % 6;
    g.subcategory := 'unicode_norm#' || v;
    g.must_reject := false;
    -- payload = JSON array [formA, formB]; run_rpc syncs both as distinct shots
    g.payload := jsonb_build_array(
      (array[U&'\00E9', U&'\FB01', U&'\00C5', U&'\AC00', U&'\FF44\FF52\FF49\FF56\FF45', U&'\0130'])[v + 1],
      (array[U&'e\0301', 'fi', U&'\212B', U&'\1100\1161', 'drive', U&'i\0307'])[v + 1]
    )::text;

  elsif p_cat = 10 then -- replay with alternate uuid text forms / different content
    v := v % 6;
    g.subcategory := 'replay_altform#' || v;
    g.must_reject := false;
    g.payload := case v
      when 0 then (b || jsonb_build_object('id', upper(p_shot::text)))::text
      when 1 then (b || jsonb_build_object('id', '{' || p_shot::text || '}'))::text
      when 2 then (b || jsonb_build_object('id', replace(p_shot::text, '-', '')))::text
      when 3 then (b || jsonb_build_object('id', p_shot::text, 'resultKind', 'low_confidence', 'overallScore', null))::text
      when 4 then (b || jsonb_build_object('id', p_shot::text, 'analysisPermitId', stress_bm.det_uuid(p_seed, 'other-permit')::text))::text
      when 5 then (b || jsonb_build_object('id', 'urn:uuid:' || p_shot::text))::text
    end;
    if v = 5 then g.must_reject := null; g.note := 'urn:uuid: prefix is not a Postgres uuid literal'; end if;
  end if;

  return g;
end;
$fn$;

-- ────────────────────────────── snapshots ───────────────────────────────────
create or replace function stress_bm.snap(p_uid uuid) returns jsonb language sql stable as $fn$
  select jsonb_build_object(
    'shots', (select count(*) from public.shots where user_id = p_uid),
    'scored', (select count(*) from public.shots where user_id = p_uid and result_kind = 'scored'),
    'phases', (select count(*) from public.shot_phases where user_id = p_uid),
    'checkpoints', (select count(*) from public.shot_checkpoints where user_id = p_uid),
    'permits', (select count(*) from public.analysis_permits where user_id = p_uid),
    'permits_reserved', (select count(*) from public.analysis_permits where user_id = p_uid and status = 'reserved'),
    'permits_finalized', (select count(*) from public.analysis_permits where user_id = p_uid and status = 'finalized'),
    'permits_released', (select count(*) from public.analysis_permits where user_id = p_uid and status = 'released'),
    'identities', (select count(*) from auth.identities where user_id = p_uid),
    'ledger_max', (select coalesce(max(l.scored_count), 0)
                   from auth.identities i
                   join public.free_rating_ledger l
                     on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
                   where i.user_id = p_uid),
    'ledger_min', (select coalesce(min(l.scored_count), 0)
                   from auth.identities i
                   join public.free_rating_ledger l
                     on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
                   where i.user_id = p_uid),
    'ledger_ident_rows', (select count(*)
                   from auth.identities i
                   join public.free_rating_ledger l
                     on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
                   where i.user_id = p_uid),
    'ledger_sum', (select coalesce(sum(scored_count), 0) from public.free_rating_ledger),
    'ledger_rows', (select count(*) from public.free_rating_ledger),
    'ledger_bad', (select count(*) from public.free_rating_ledger
                   where identity_hash !~ '^[0-9a-f]{64}$' or scored_count < 0),
    'consent', (select count(*) from public.consent_records where user_id = p_uid),
    'trials', (select count(*) from public.evaluation_trials where user_id = p_uid),
    'feedback', (select count(*) from public.analysis_feedback where user_id = p_uid)
  )
$fn$;

create or replace function stress_bm.delta(p_before jsonb, p_after jsonb) returns jsonb language sql immutable as $fn$
  select coalesce(jsonb_object_agg(a.key, (a.value::numeric - (p_before ->> a.key)::numeric)), '{}'::jsonb)
  from jsonb_each_text(p_after) a
$fn$;

create or replace function stress_bm.d(p_deltas jsonb, p_key text) returns numeric language sql immutable as $fn$
  select coalesce((p_deltas ->> p_key)::numeric, 0)
$fn$;

-- ─────────────────────────── role switching helpers ─────────────────────────
create or replace function stress_bm.as_user(p_uid uuid) returns void language plpgsql as $fn$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  perform set_config('role', 'authenticated', true);
end;
$fn$;

create or replace function stress_bm.as_role(p_role text, p_sub text) returns void language plpgsql as $fn$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
  perform set_config('role', p_role, true);
end;
$fn$;

create or replace function stress_bm.as_owner() returns void language plpgsql as $fn$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$fn$;

-- ─────────────────────────────── user pool ──────────────────────────────────
create or replace function stress_bm.create_user(p_uid uuid, p_provider text, p_provider_id text, p_premium boolean)
returns void language plpgsql as $fn$
begin
  insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values (p_uid, 'stress-' || replace(p_uid::text, '-', '') || '@example.com',
          '{"full_name":"Stress"}', jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_provider_id, p_uid, jsonb_build_object('sub', p_provider_id));
  if p_premium then
    insert into public.billing_entitlements (user_id, premium) values (p_uid, true);
  end if;
end;
$fn$;

create or replace function stress_bm.setup(p_free int default 4, p_premium int default 4) returns void language plpgsql as $fn$
declare i int; u uuid;
begin
  for i in 0 .. p_free + p_premium - 1 loop
    u := ('a0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid;
    if not exists (select 1 from stress_bm.pool where idx = i) then
      perform stress_bm.create_user(u, case when i % 2 = 0 then 'google' else 'apple' end,
                                    'stress-pool-sub-' || i, i >= p_free);
      insert into stress_bm.pool (idx, user_id, premium) values (i, u, i >= p_free);
    end if;
  end loop;
end;
$fn$;

-- ───────────────────────── reserve a legit permit ───────────────────────────
-- Runs AS the user. Returns permit id or NULL (paywalled / refused).
create or replace function stress_bm.reserve(p_uid uuid, p_key text, out permit uuid, out result text)
language plpgsql as $fn$
declare r record;
begin
  perform stress_bm.as_user(p_uid);
  select * into r from public.reserve_analysis_permit(p_key);
  result := r.result;
  permit := case when r.result = 'accepted' then r.permit_id else null end;
  perform stress_bm.as_owner();
end;
$fn$;

create or replace function stress_bm.known_status(p_status text) returns boolean language sql immutable as $fn$
  select p_status in ('accepted', 'auth.required', 'access.permit_not_found', 'access.permit_not_reserved',
                      'access.permit_expired', 'access.paywall_required', 'shot.session_not_found',
                      'shot.id_conflict')
      or p_status ~ '^shot\.write_failed:[0-9A-Z]{5}$'
$fn$;

-- Invoke apply_synced_shot AS p_uid with a text payload; never raises.
create or replace function stress_bm.call_rpc(
  p_uid uuid, p_payload text,
  out json_ok boolean, out status text, out err_state text, out sqlmsg text
) language plpgsql as $fn$
declare j jsonb;
begin
  json_ok := true;
  begin
    j := p_payload::jsonb;
  exception when others then
    json_ok := false;
    err_state := SQLSTATE;
    sqlmsg := left(SQLERRM, 200);
    return;
  end;
  perform stress_bm.as_user(p_uid);
  begin
    status := public.apply_synced_shot(j);
  exception when others then
    err_state := SQLSTATE;
    sqlmsg := left(SQLERRM, 200);
  end;
  perform stress_bm.as_owner();
end;
$fn$;

-- ───────────────────────── category runners ─────────────────────────────────

-- Generic write-consistency judgement for one apply_synced_shot call.
create or replace function stress_bm.judge_rpc(
  p_uid uuid, p_premium boolean, p_shot uuid, p_status text, p_sqlstate text, p_json_ok boolean,
  p_must_reject boolean, p_before jsonb, p_after jsonb, p_legit_permit boolean, p_replay boolean
) returns text language plpgsql as $fn$
declare
  dl jsonb := stress_bm.delta(p_before, p_after);
  kind text;
begin
  if (p_after ->> 'ledger_bad')::int > 0 then return 'BROKEN: ledger row violates hash/count check'; end if;
  if stress_bm.d(dl, 'ledger_sum') < 0 then return 'BROKEN: ledger sum decreased'; end if;

  if not p_json_ok then
    if p_sqlstate in ('22P02', '22P05', '22023', '54001') then return 'HELD'; end if;
    return 'RAISED: unexpected parse SQLSTATE ' || coalesce(p_sqlstate, '?');
  end if;

  if p_status is null then
    -- RPC threw. Sub-transaction rolled back ⇒ deltas must be zero.
    if stress_bm.d(dl, 'shots') <> 0 or stress_bm.d(dl, 'phases') <> 0 or stress_bm.d(dl, 'checkpoints') <> 0
       or stress_bm.d(dl, 'ledger_max') <> 0 or stress_bm.d(dl, 'ledger_ident_rows') <> 0
       or stress_bm.d(dl, 'permits') <> 0 or stress_bm.d(dl, 'permits_reserved') <> 0 then
      return 'BROKEN: RPC raised ' || coalesce(p_sqlstate, '?') || ' but a write survived';
    end if;
    return 'RAISED: ' || coalesce(p_sqlstate, '?');
  end if;

  if not stress_bm.known_status(p_status) then return 'BROKEN: unknown status ' || left(p_status, 60); end if;

  if p_status = 'accepted' then
    if p_must_reject then return 'BROKEN: accepted a must-reject payload'; end if;
    if p_replay or stress_bm.d(dl, 'shots') = 0 then
      if stress_bm.d(dl, 'shots') <> 0 or stress_bm.d(dl, 'phases') <> 0 or stress_bm.d(dl, 'checkpoints') <> 0
         or stress_bm.d(dl, 'ledger_max') <> 0 or stress_bm.d(dl, 'ledger_ident_rows') <> 0
         or stress_bm.d(dl, 'permits_reserved') <> 0 or stress_bm.d(dl, 'permits_finalized') <> 0 then
        return 'BROKEN: replay-accepted but state changed';
      end if;
      return 'HELD';
    end if;
    if stress_bm.d(dl, 'shots') <> 1 then return 'BROKEN: accepted wrote ' || stress_bm.d(dl, 'shots') || ' shots'; end if;
    select s.result_kind into kind from public.shots s where s.id = p_shot;
    if kind = 'scored' then
      if stress_bm.d(dl, 'scored') <> 1 then return 'BROKEN: scored delta ' || stress_bm.d(dl, 'scored'); end if;
      if (p_after ->> 'identities')::int > 0 and stress_bm.d(dl, 'ledger_max') <> 1 then
        return 'BROKEN: scored shot but ledger_max delta ' || stress_bm.d(dl, 'ledger_max');
      end if;
      if (p_after ->> 'identities')::int > 0 and (p_after ->> 'ledger_min') <> (p_after ->> 'ledger_max') then
        return 'BROKEN: identities of one account diverged (' || (p_after ->> 'ledger_min') || '≠' || (p_after ->> 'ledger_max') || ')';
      end if;
      if not p_premium and (p_after ->> 'scored')::int > 2 then return 'BROKEN: non-premium exceeded 2 lifetime scored'; end if;
      if not p_premium and (p_after ->> 'ledger_max')::int > 2 then return 'BROKEN: non-premium ledger above 2'; end if;
      if not p_legit_permit then return 'BROKEN: scored shot accepted without a legit permit'; end if;
      if stress_bm.d(dl, 'permits_finalized') <> 1 or stress_bm.d(dl, 'permits_reserved') <> -1 then
        return 'BROKEN: scored accepted but permit not finalized';
      end if;
    elsif kind = 'low_confidence' then
      if stress_bm.d(dl, 'scored') <> 0 or stress_bm.d(dl, 'ledger_max') <> 0 or stress_bm.d(dl, 'ledger_ident_rows') <> 0 then
        return 'BROKEN: abstention touched ledger/scored count';
      end if;
      if not p_legit_permit then return 'BROKEN: abstention accepted without a legit permit'; end if;
      if stress_bm.d(dl, 'permits_released') <> 1 or stress_bm.d(dl, 'permits_reserved') <> -1 then
        return 'BROKEN: abstention accepted but permit not released';
      end if;
    else
      return 'BROKEN: accepted row has result_kind ' || coalesce(kind, 'NULL');
    end if;
    return 'HELD';
  end if;

  -- Any non-accepted status: nothing may have been written.
  if stress_bm.d(dl, 'shots') <> 0 or stress_bm.d(dl, 'phases') <> 0 or stress_bm.d(dl, 'checkpoints') <> 0
     or stress_bm.d(dl, 'ledger_max') <> 0 or stress_bm.d(dl, 'ledger_ident_rows') <> 0 or stress_bm.d(dl, 'permits') <> 0 then
    return 'BROKEN: status ' || p_status || ' but a write leaked';
  end if;
  if p_status in ('access.paywall_required', 'access.permit_expired') then
    if stress_bm.d(dl, 'permits_reserved') not in (0, -1) or stress_bm.d(dl, 'permits_released') not in (0, 1)
       or stress_bm.d(dl, 'permits_finalized') <> 0 then
      return 'BROKEN: ' || p_status || ' changed permits unexpectedly';
    end if;
  elsif stress_bm.d(dl, 'permits_reserved') <> 0 or stress_bm.d(dl, 'permits_released') <> 0
        or stress_bm.d(dl, 'permits_finalized') <> 0 then
    return 'BROKEN: status ' || p_status || ' mutated permits';
  end if;
  if p_must_reject is false and p_legit_permit and p_status like 'shot.write_failed:%' then
    return 'BROKEN: valid payload refused with ' || p_status;
  end if;
  return 'HELD';
end;
$fn$;

-- Categories 0-10: one hostile apply_synced_shot payload against a pool user.
create or replace function stress_bm.run_rpc(p_seed bigint, p_cat int) returns stress_bm.outcome language plpgsql as $fn$
declare
  o stress_bm.outcome;
  p stress_bm.pool%rowtype;
  n_pool int := (select count(*) from stress_bm.pool);
  shot uuid := stress_bm.det_uuid(p_seed, 'shot');
  kind text := case when stress_bm.pick(p_seed, 3, 4) = 0 then 'low_confidence' else 'scored' end;
  mode_i int := stress_bm.pick(p_seed, 4, 10);
  permit uuid;
  permit_txt text;
  legit boolean := false;
  session_txt text := null;
  g stress_bm.gen;
  r record;
  before jsonb; after jsonb;
  forms jsonb;
  st_a text; st_b text; sq_a text; sq_b text;
  n_rows int;
  eff_shot uuid;
begin
  -- unicode/replay categories need the write path: prefer premium users
  if p_cat in (9, 10) then
    select * into p from stress_bm.pool where premium order by idx
      offset stress_bm.pick(p_seed, 1, (select count(*)::int from stress_bm.pool where premium)) limit 1;
  else
    select * into p from stress_bm.pool order by idx offset stress_bm.pick(p_seed, 1, n_pool) limit 1;
  end if;
  o.user_key := 'pool#' || p.idx; o.premium := p.premium;

  perform pg_advisory_xact_lock(424242, hashtext(p.user_id::text));

  if mode_i < 6 then
    select * into r from stress_bm.reserve(p.user_id, 'stress-' || p_seed);
    permit := r.permit; legit := permit is not null;
    o.mode := 'legit_permit(' || r.result || ')';
    permit_txt := permit::text;
  elsif mode_i < 8 then
    permit_txt := stress_bm.det_uuid(p_seed, 'forged')::text;
    o.mode := 'forged_permit';
  else
    select a.id::text into permit_txt from public.analysis_permits a where a.user_id <> p.user_id order by a.created_at limit 1;
    o.mode := 'other_users_permit';
  end if;
  if stress_bm.pick(p_seed, 5, 5) = 0 then session_txt := stress_bm.det_uuid(p_seed, 'sess')::text; end if;

  g := stress_bm.gen_rpc(p_seed, p_cat, shot, permit_txt, session_txt, kind);
  o.subcategory := g.subcategory; o.payload := g.payload; o.must_reject := g.must_reject; o.note := g.note;

  if p_cat = 9 then
    -- two shots, one per normalization form; both must behave identically and be stored byte-exact
    forms := g.payload::jsonb;
    before := stress_bm.snap(p.user_id);
    select * into r from stress_bm.call_rpc(p.user_id, stress_bm.base_payload(shot, permit_txt, session_txt, kind, forms ->> 0)::text);
    st_a := r.status; sq_a := r.err_state;
    if legit then
      select * into r from stress_bm.reserve(p.user_id, 'stress-b-' || p_seed);
      permit_txt := r.permit::text;
    end if;
    select * into r from stress_bm.call_rpc(p.user_id, stress_bm.base_payload(stress_bm.det_uuid(p_seed, 'shot-b'), permit_txt, session_txt, kind, forms ->> 1)::text);
    st_b := r.status; sq_b := r.err_state;
    after := stress_bm.snap(p.user_id);
    o.json_ok := true; o.status := coalesce(st_a, 'RAISED') || ' / ' || coalesce(st_b, 'RAISED');
    o.sqlstate := coalesce(sq_a, sq_b); o.deltas := stress_bm.delta(before, after);
    if st_a is null or st_b is null then
      o.verdict := 'RAISED: ' || coalesce(sq_a, sq_b);
    elsif st_a <> st_b then
      o.verdict := 'BROKEN: normalization forms diverged ' || st_a || ' vs ' || st_b;
    elsif st_a = 'accepted' then
      select count(*) into n_rows from public.shots s
      where s.id in (shot, stress_bm.det_uuid(p_seed, 'shot-b'))
        and s.shot_type in (forms ->> 0, forms ->> 1);
      if n_rows <> 2 or stress_bm.d(o.deltas, 'shots') <> 2 then
        o.verdict := 'BROKEN: normalization forms not stored byte-exact / distinct';
      elsif kind = 'scored' and stress_bm.d(o.deltas, 'ledger_max') <> 2 then
        o.verdict := 'BROKEN: two scored shots but ledger_max delta ' || stress_bm.d(o.deltas, 'ledger_max');
      else
        o.verdict := 'HELD';
      end if;
    else
      o.verdict := case when stress_bm.d(o.deltas, 'shots') = 0 then 'HELD' else 'BROKEN: refused but wrote' end;
    end if;
    return o;
  end if;

  if p_cat = 10 then
    -- first a legit sync, then the alternate-form replay
    before := stress_bm.snap(p.user_id);
    select * into r from stress_bm.call_rpc(p.user_id, stress_bm.base_payload(shot, permit_txt, session_txt, kind)::text);
    st_a := r.status;
    if st_a is distinct from 'accepted' then
      o.status := 'first:' || coalesce(st_a, 'RAISED:' || r.err_state);
      o.verdict := case when r.status is null then 'RAISED: ' || r.err_state else 'HELD' end;
      o.note := 'replay skipped: first sync not accepted';
      o.deltas := stress_bm.delta(before, stress_bm.snap(p.user_id));
      return o;
    end if;
    before := stress_bm.snap(p.user_id);
    select * into r from stress_bm.call_rpc(p.user_id, g.payload);
    after := stress_bm.snap(p.user_id);
    o.json_ok := r.json_ok; o.status := r.status; o.sqlstate := r.err_state; o.sqlmsg := r.sqlmsg;
    o.deltas := stress_bm.delta(before, after);
    o.verdict := stress_bm.judge_rpc(p.user_id, p.premium, shot, r.status, r.err_state, r.json_ok, false, before, after, legit, true);
    if o.verdict = 'HELD' and r.status is distinct from 'accepted' and g.must_reject is false then
      o.verdict := 'BROKEN: replay of an owned shot id returned ' || r.status;
    end if;
    return o;
  end if;

  -- duplicate "id" keys: jsonb (like JSON.parse) keeps the last one, so judge
  -- the row that the RPC actually wrote
  begin
    eff_shot := coalesce((g.payload::jsonb ->> 'id')::uuid, shot);
  exception when others then
    eff_shot := shot;
  end;
  before := stress_bm.snap(p.user_id);
  select * into r from stress_bm.call_rpc(p.user_id, g.payload);
  after := stress_bm.snap(p.user_id);
  o.json_ok := r.json_ok; o.status := r.status; o.sqlstate := r.err_state; o.sqlmsg := r.sqlmsg;
  o.deltas := stress_bm.delta(before, after);
  o.verdict := stress_bm.judge_rpc(p.user_id, p.premium, eff_shot, r.status, r.err_state, r.json_ok, g.must_reject, before, after, legit, false);
  return o;
end;
$fn$;

-- Category 11: hostile idempotency keys into reserve_analysis_permit().
create or replace function stress_bm.run_reserve(p_seed bigint) returns stress_bm.outcome language plpgsql as $fn$
declare
  o stress_bm.outcome;
  p stress_bm.pool%rowtype;
  hs record;
  key text;
  r1 record; r2 record;
  before jsonb; after jsonb;
  v int := stress_bm.pick(p_seed, 10, 6);
begin
  select * into p from stress_bm.pool order by idx offset stress_bm.pick(p_seed, 1, (select count(*)::int from stress_bm.pool)) limit 1;
  o.user_key := 'pool#' || p.idx; o.premium := p.premium; o.mode := 'reserve';
  perform pg_advisory_xact_lock(424242, hashtext(p.user_id::text));
  select * into hs from stress_bm.hstr(p_seed, 12);
  key := case v when 0 then null when 1 then repeat('k', 128) when 2 then repeat('k', 129)
                when 3 then repeat('é', 128) else hs.val end;
  o.subcategory := 'reserve_key:' || case v when 0 then 'null' when 1 then 'len128' when 2 then 'len129' when 3 then 'é×128' else hs.kind end;
  o.payload := left(key, 2000); o.json_ok := true;
  o.must_reject := case when key is null or length(key) > 128 then true else false end;
  before := stress_bm.snap(p.user_id);
  perform stress_bm.as_user(p.user_id);
  begin
    select * into r1 from public.reserve_analysis_permit(key);
    select * into r2 from public.reserve_analysis_permit(key);   -- idempotent replay
  exception when others then
    o.sqlstate := SQLSTATE; o.sqlmsg := left(SQLERRM, 200);
  end;
  perform stress_bm.as_owner();
  after := stress_bm.snap(p.user_id);
  o.deltas := stress_bm.delta(before, after);
  if o.sqlstate is not null then
    o.status := null;
    o.verdict := case when stress_bm.d(o.deltas, 'permits') <> 0 then 'BROKEN: raised but permit written'
                      else 'RAISED: ' || o.sqlstate end;
    return o;
  end if;
  o.status := r1.result || ' / ' || r2.result;
  if r1.result not in ('accepted', 'access.paywall_required', 'auth.required') then
    o.verdict := 'BROKEN: unknown reserve result ' || r1.result;
  elsif r1.result = 'accepted' then
    if o.must_reject then o.verdict := 'BROKEN: accepted must-reject key';
    elsif r2.result <> 'accepted' or r2.permit_id <> r1.permit_id then o.verdict := 'BROKEN: idempotent replay returned a different permit';
    elsif stress_bm.d(o.deltas, 'permits') <> 1 then o.verdict := 'BROKEN: replay created ' || stress_bm.d(o.deltas, 'permits') || ' permits';
    elsif stress_bm.d(o.deltas, 'ledger_max') <> 0 then o.verdict := 'BROKEN: reserve touched the ledger';
    else o.verdict := 'HELD'; end if;
  else
    o.verdict := case when stress_bm.d(o.deltas, 'permits') <> 0 or stress_bm.d(o.deltas, 'ledger_max') <> 0
                      then 'BROKEN: refused but wrote' else 'HELD' end;
  end if;
  return o;
end;
$fn$;

-- One legit scored sync AS the user; returns the RPC status (or 'RAISED:<state>').
create or replace function stress_bm.legit_scored(p_uid uuid, p_seed bigint, p_tag text) returns text language plpgsql as $fn$
declare r record; permit uuid;
begin
  select * into r from stress_bm.reserve(p_uid, 'stress-' || p_tag || '-' || p_seed);
  if r.permit is null then return 'reserve:' || r.result; end if;
  permit := r.permit;
  select * into r from stress_bm.call_rpc(p_uid, stress_bm.base_payload(stress_bm.det_uuid(p_seed, p_tag), permit::text, null, 'scored')::text);
  return coalesce(r.status, 'RAISED:' || r.err_state);
end;
$fn$;

-- Category 12: hostile identity strings through the whole ledger lifecycle
-- (GoTrue-side writes are simulated as owner; the app paths run as the user).
create or replace function stress_bm.run_identity(p_seed bigint) returns stress_bm.outcome language plpgsql as $fn$
declare
  o stress_bm.outcome;
  v int := stress_bm.pick(p_seed, 10, 8);
  hs record;
  prov text; pid text; prov2 text; pid2 text;
  u1 uuid := stress_bm.det_uuid(p_seed, 'u1');
  u2 uuid := stress_bm.det_uuid(p_seed, 'u2');
  h1 text; h2 text;
  s1 text; s2 text; s3 text; s4 text;
  c int; ledger_before int; rows_before int;
begin
  select * into hs from stress_bm.hstr(p_seed, 12);
  o.user_key := 'fresh:' || u1::text; o.premium := false; o.mode := 'identity_lifecycle'; o.json_ok := true;
  prov := (array['apple', 'google', 'APPLE', '', 'apple:x', repeat('p', 65536), U&'\00E9', '../apple'])[1 + stress_bm.pick(p_seed, 14, 8)];
  pid := case v when 0 then hs.val when 1 then U&'\00E9' || '-' || p_seed when 2 then U&'e\0301' || '-' || p_seed
                when 3 then '' when 4 then 'b:c' when 5 then repeat('s', 1048576) when 6 then 'sub-' || p_seed else hs.val end;
  o.subcategory := 'identity:' || left(prov, 8) || ':' || case v when 0 then hs.kind when 7 then hs.kind else 'v' || v end;
  o.payload := left(prov || ' | ' || pid, 2000);
  o.must_reject := false;

  -- serialize flows that reuse the same hostile pair across seeds
  perform pg_advisory_xact_lock(424243, hashtext(prov || ':' || pid));
  rows_before := (select count(*) from public.free_rating_ledger);
  ledger_before := coalesce((select l.scored_count from public.free_rating_ledger l
                             where l.identity_hash = public.free_rating_identity_hash(prov, pid)), 0);

  begin
    perform stress_bm.create_user(u1, prov, pid, false);
  exception when others then
    o.sqlstate := SQLSTATE; o.sqlmsg := left(SQLERRM, 200);
    o.status := 'create_user refused';
    o.verdict := case when SQLSTATE in ('22021', '23505', '23514', '54000') then 'HELD' else 'RAISED: ' || SQLSTATE end;
    o.note := 'GoTrue-side insert refused by Postgres; ledger untouched=' ||
              ((select count(*) from public.free_rating_ledger) = rows_before)::text;
    return o;
  end;
  perform stress_bm.as_owner();
  h1 := public.free_rating_identity_hash(prov, pid);
  if h1 !~ '^[0-9a-f]{64}$' then o.verdict := 'BROKEN: hash not 64 hex'; return o; end if;

  -- spend both free ratings, then the third must be refused
  s1 := stress_bm.legit_scored(u1, p_seed, 'i1');
  s2 := stress_bm.legit_scored(u1, p_seed, 'i2');
  s3 := stress_bm.legit_scored(u1, p_seed, 'i3');
  select coalesce(scored_count, -1) into c from public.free_rating_ledger where identity_hash = h1;
  o.status := s1 || ' / ' || s2 || ' / ' || s3;
  if ledger_before >= 2 then
    -- identity already spent (e.g. an earlier seed with the same hostile pair): must be refused from the start
    if s1 not in ('reserve:access.paywall_required', 'access.paywall_required') then
      o.verdict := 'BROKEN: spent identity got a fresh rating (' || s1 || ')'; return o;
    end if;
  else
    if s1 <> 'accepted' or s2 <> 'accepted' then o.verdict := 'BROKEN: fresh identity could not use free ratings: ' || o.status; return o; end if;
    if s3 not in ('reserve:access.paywall_required', 'access.paywall_required') then o.verdict := 'BROKEN: third rating not refused: ' || s3; return o; end if;
    if c <> 2 then o.verdict := 'BROKEN: ledger=' || c || ' after two scored'; return o; end if;
  end if;

  -- delete the account: the ledger row must survive
  delete from auth.users where id = u1;
  if not exists (select 1 from public.free_rating_ledger where identity_hash = h1 and scored_count >= 2) then
    o.verdict := 'BROKEN: ledger row lost on account deletion'; return o;
  end if;

  -- sign in again with the SAME identity → still paywalled
  perform stress_bm.create_user(u2, prov, pid, false);
  perform stress_bm.as_owner();
  s4 := stress_bm.legit_scored(u2, p_seed, 'i4');
  if s4 not in ('reserve:access.paywall_required', 'access.paywall_required') then
    o.verdict := 'BROKEN: recreated account got a free rating (' || s4 || ')'; return o;
  end if;
  perform stress_bm.as_user(u2);
  c := public.lifetime_scored_count();
  perform stress_bm.as_owner();
  if c < 2 then o.verdict := 'BROKEN: lifetime_scored_count()=' || c || ' for recreated account'; return o; end if;

  -- late-link a second hostile identity → inherits
  prov2 := case when prov = 'apple' then 'google' else 'apple' end;
  pid2 := case v when 1 then U&'e\0301' when 2 then U&'\00E9' else 'late-' || p_seed || '-' || left(hs.val, 100) end;
  begin
    insert into auth.identities (provider, provider_id, user_id, identity_data)
    values (prov2, pid2, u2, jsonb_build_object('sub', pid2));
  exception when others then
    o.note := 'late link refused ' || SQLSTATE; o.verdict := 'HELD'; delete from auth.users where id = u2; return o;
  end;
  h2 := public.free_rating_identity_hash(prov2, pid2);
  if h2 = h1 then
    o.verdict := 'COLLISION: (' || left(prov, 20) || ',' || left(pid, 20) || ') and (' || left(prov2, 20) || ',' || left(pid2, 20) || ') share a ledger row';
    delete from auth.users where id = u2; return o;
  end if;
  select coalesce(scored_count, -1) into c from public.free_rating_ledger where identity_hash = h2;
  if c < 2 then o.verdict := 'BROKEN: late-linked identity did not inherit (ledger=' || c || ')'; delete from auth.users where id = u2; return o; end if;
  perform stress_bm.as_user(u2);
  c := public.identity_scored_count();
  perform stress_bm.as_owner();
  if c < 2 then o.verdict := 'BROKEN: identity_scored_count()=' || c || ' after inheritance'; delete from auth.users where id = u2; return o; end if;

  delete from auth.users where id = u2;
  o.deltas := jsonb_build_object('ledger_rows', (select count(*) from public.free_rating_ledger) - rows_before);
  o.verdict := 'HELD';
  return o;
end;
$fn$;

-- Category 13: delimiter-collision probe for free_rating_identity_hash — two
-- DIFFERENT (provider, provider_id) pairs whose 'provider:provider_id' text
-- coincides. Records COLLISION when user B is paywalled by user A's ratings.
create or replace function stress_bm.run_collision(p_seed bigint) returns stress_bm.outcome language plpgsql as $fn$
declare
  o stress_bm.outcome;
  ua uuid := stress_bm.det_uuid(p_seed, 'ca');
  ub uuid := stress_bm.det_uuid(p_seed, 'cb');
  t text := 'x' || p_seed;
  sa1 text; sa2 text; sb text;
begin
  o.user_key := 'fresh:' || ua::text; o.premium := false; o.mode := 'identity_collision'; o.json_ok := true; o.must_reject := false;
  o.subcategory := 'identity_collision';
  o.payload := format('(%L,%L) vs (%L,%L)', 'a:' || t, 'c', 'a', t || ':c');
  perform stress_bm.create_user(ua, 'a:' || t, 'c', false);
  perform stress_bm.create_user(ub, 'a', t || ':c', false);
  perform stress_bm.as_owner();
  sa1 := stress_bm.legit_scored(ua, p_seed, 'ca1');
  sa2 := stress_bm.legit_scored(ua, p_seed, 'ca2');
  sb := stress_bm.legit_scored(ub, p_seed, 'cb1');
  o.status := sa1 || ' / ' || sa2 || ' / B:' || sb;
  if sb = 'accepted' then o.verdict := 'HELD';
  elsif sb in ('reserve:access.paywall_required', 'access.paywall_required') then
    o.verdict := 'COLLISION: distinct identities share hash ' || public.free_rating_identity_hash('a:' || t, 'c');
  else o.verdict := 'RAISED: ' || sb; end if;
  delete from auth.users where id in (ua, ub);
  return o;
end;
$fn$;

-- Category 14: the ledger from the client roles — every DML shape, hostile values.
create or replace function stress_bm.run_ledger_access(p_seed bigint) returns stress_bm.outcome language plpgsql as $fn$
declare
  o stress_bm.outcome;
  p stress_bm.pool%rowtype;
  v int := stress_bm.pick(p_seed, 10, 16);
  role_i int := stress_bm.pick(p_seed, 11, 3);
  hs record;
  hex text := encode(sha256(convert_to('stress' || p_seed, 'UTF8')), 'hex');
  stmt text;
  before jsonb; after jsonb;
  got int;
  fresh uuid;
  r record;
begin
  select * into p from stress_bm.pool order by idx offset stress_bm.pick(p_seed, 1, (select count(*)::int from stress_bm.pool)) limit 1;
  select * into hs from stress_bm.hstr(p_seed, 12);
  o.user_key := 'pool#' || p.idx; o.premium := p.premium; o.json_ok := true; o.must_reject := true;
  perform pg_advisory_xact_lock(424242, hashtext(p.user_id::text));
  o.mode := (array['authenticated', 'anon', 'authenticated(sub=other)'])[role_i + 1];

  if v = 15 then
    -- owner-side boundary: ledger at INT_MAX, then a premium scored sync must fail closed
    fresh := stress_bm.det_uuid(p_seed, 'maxint');
    perform stress_bm.create_user(fresh, 'google', 'maxint-' || p_seed, true);
    perform stress_bm.as_owner();
    insert into public.free_rating_ledger (identity_hash, scored_count)
    values (public.free_rating_identity_hash('google', 'maxint-' || p_seed), 2147483647);
    o.subcategory := 'ledger_owner:scored_count=INT_MAX then scored sync'; o.mode := 'owner+premium';
    o.payload := 'scored_count=2147483647';
    before := stress_bm.snap(fresh);
    o.status := stress_bm.legit_scored(fresh, p_seed, 'mx');
    after := stress_bm.snap(fresh);
    o.deltas := stress_bm.delta(before, after);
    o.verdict := case
      when o.status = 'accepted' then 'BROKEN: ledger overflowed/wrapped yet shot accepted'
      when o.status like 'shot.write_failed:%' and stress_bm.d(o.deltas, 'shots') = 0 then 'HELD'
      when o.status like 'RAISED:%' then o.status
      else 'BROKEN: ' || o.status end;
    o.note := 'fail-closed: ledger at INT_MAX refuses the (premium) scored write';
    delete from auth.users where id = fresh;
    return o;
  end if;

  stmt := case v
    when 0 then 'select count(*) from public.free_rating_ledger'
    when 1 then 'select * from public.free_rating_ledger limit 1'
    when 2 then format('insert into public.free_rating_ledger (identity_hash, scored_count) values (%L, 0)', hex)
    when 3 then format('insert into public.free_rating_ledger (identity_hash, scored_count) values (%L, 0)', hs.val)
    when 4 then 'update public.free_rating_ledger set scored_count = 0'
    when 5 then format('update public.free_rating_ledger set scored_count = -1 where identity_hash = %L', hex)
    when 6 then 'delete from public.free_rating_ledger'
    when 7 then 'truncate public.free_rating_ledger'
    when 8 then format('select public.free_rating_identity_hash(%L, %L)', 'google', hs.val)
    when 9 then 'select public.record_scored_shot_in_ledger()'
    when 10 then 'select public.inherit_free_rating_ledger()'
    when 11 then 'select public.reject_ledger_mutation()'
    when 12 then 'select public.enforce_scored_shot_permit()'
    when 13 then 'select * from public.free_rating_ledger for update'
    when 14 then 'select public.identity_scored_count()'
  end;
  o.subcategory := 'ledger_access#' || v || ':' || split_part(stmt, ' ', 1);
  o.payload := left(stmt, 2000);
  before := stress_bm.snap(p.user_id);
  if role_i = 0 then perform stress_bm.as_user(p.user_id);
  elsif role_i = 1 then perform stress_bm.as_role('anon', null);
  else perform stress_bm.as_role('authenticated', (select user_id::text from stress_bm.pool where idx <> p.idx order by idx limit 1)); end if;
  begin
    if v in (0, 14) then
      execute stmt into got;
      o.status := 'returned ' || got;
    else
      execute stmt;
      o.status := 'executed';
    end if;
  exception when others then
    o.sqlstate := SQLSTATE; o.sqlmsg := left(SQLERRM, 200);
  end;
  perform stress_bm.as_owner();
  after := stress_bm.snap(p.user_id);
  o.deltas := stress_bm.delta(before, after);
  if o.sqlstate is not null then
    -- only this user's ledger rows are stable under the per-user lock; global
    -- counters move as other workers sync legitimately
    o.verdict := case
      when stress_bm.d(o.deltas, 'ledger_ident_rows') <> 0 or stress_bm.d(o.deltas, 'ledger_max') <> 0
           or stress_bm.d(o.deltas, 'ledger_min') <> 0 or stress_bm.d(o.deltas, 'ledger_bad') <> 0
           or stress_bm.d(o.deltas, 'ledger_sum') < 0 then 'BROKEN: raised yet ledger changed'
      when o.sqlstate in ('42501', '0A000', '39P01', '42883', '2F005', '42P01') then 'HELD'
      else 'RAISED: ' || o.sqlstate end;
    return o;
  end if;
  if v = 14 then
    -- identity_scored_count() is the one client-executable reader: uid-scoped, own count only
    o.must_reject := false;
    o.verdict := case
      when role_i = 1 then 'BROKEN: anon executed identity_scored_count()'
      when role_i = 0 and got <> (before ->> 'ledger_max')::int then 'BROKEN: identity_scored_count()=' || got || ' ≠ own ledger ' || (before ->> 'ledger_max')
      else 'HELD' end;
    return o;
  end if;
  o.verdict := 'BROKEN: ' || o.mode || ' ran "' || left(stmt, 40) || '" (ledger_rows Δ=' || stress_bm.d(o.deltas, 'ledger_rows') || ')';
  return o;
end;
$fn$;

-- Category 15: append-only ledgers (reject_ledger_mutation) from every role, hostile values.
create or replace function stress_bm.run_append_only(p_seed bigint) returns stress_bm.outcome language plpgsql as $fn$
declare
  o stress_bm.outcome;
  p stress_bm.pool%rowtype;
  tbl text := (array['consent_records', 'evaluation_trials', 'analysis_feedback'])[1 + stress_bm.pick(p_seed, 10, 3)];
  op text := (array['update', 'delete', 'update_hostile', 'cascade'])[1 + stress_bm.pick(p_seed, 11, 4)];
  who text := (array['authenticated', 'service_role', 'owner'])[1 + stress_bm.pick(p_seed, 13, 3)];
  hs record;
  rid uuid := stress_bm.det_uuid(p_seed, 'row');
  fresh uuid := stress_bm.det_uuid(p_seed, 'ao');
  stmt text;
  n int;
  before jsonb; after jsonb;
begin
  select * into p from stress_bm.pool order by idx offset stress_bm.pick(p_seed, 1, (select count(*)::int from stress_bm.pool)) limit 1;
  select * into hs from stress_bm.hstr(p_seed, 12);
  o.user_key := 'pool#' || p.idx; o.premium := p.premium; o.json_ok := true; o.must_reject := (op <> 'cascade');
  o.mode := who; o.subcategory := 'append_only:' || tbl || ':' || op;
  perform pg_advisory_xact_lock(424242, hashtext(p.user_id::text));

  if op = 'cascade' then
    -- account deletion: parent cascade is the ONE legitimate delete path
    perform stress_bm.create_user(fresh, 'google', 'ao-' || p_seed, false);
    perform stress_bm.as_owner();
    perform stress_bm.as_user(fresh);
    if tbl = 'consent_records' then
      insert into public.consent_records (id, user_id, scope, action) values (rid, fresh, 'analysis', 'grant');
    elsif tbl = 'evaluation_trials' then
      insert into public.evaluation_trials (id, user_id, payload) values (rid, fresh, '{"k":1}');
    else
      insert into public.analysis_feedback (id, user_id, analysis_id, rating) values (rid, fresh, gen_random_uuid(), 'up');
    end if;
    perform stress_bm.as_owner();
    o.payload := 'delete from auth.users where id = ' || fresh;
    begin
      delete from auth.users where id = fresh;
      execute format('select count(*) from public.%I where id = %L', tbl, rid) into n;
      o.status := 'cascade removed=' || (n = 0)::text;
      o.verdict := case when n = 0 then 'HELD' else 'BROKEN: cascade left an orphan ledger row' end;
    exception when others then
      o.sqlstate := SQLSTATE; o.sqlmsg := left(SQLERRM, 200);
      o.verdict := 'BROKEN: account deletion cascade blocked by ' || SQLSTATE;
    end;
    return o;
  end if;

  -- seed one row as the owner user (the legit append path)
  perform stress_bm.as_user(p.user_id);
  if tbl = 'consent_records' then
    insert into public.consent_records (id, user_id, scope, action) values (rid, p.user_id, 'analysis', 'grant');
    stmt := case op
      when 'update' then format('update public.consent_records set action = %L where id = %L', 'withdraw', rid)
      when 'update_hostile' then format('update public.consent_records set scope = %L where id = %L', hs.val, rid)
      else format('delete from public.consent_records where id = %L', rid) end;
  elsif tbl = 'evaluation_trials' then
    insert into public.evaluation_trials (id, user_id, payload) values (rid, p.user_id, '{"k":1}');
    stmt := case op
      when 'update' then format('update public.evaluation_trials set payload = %L where id = %L', '{"k":2}', rid)
      when 'update_hostile' then format('update public.evaluation_trials set payload = %L where id = %L', to_jsonb(hs.val)::text, rid)
      else format('delete from public.evaluation_trials where id = %L', rid) end;
  else
    insert into public.analysis_feedback (id, user_id, analysis_id, rating) values (rid, p.user_id, gen_random_uuid(), 'up');
    stmt := case op
      when 'update' then format('update public.analysis_feedback set rating = %L where id = %L', 'down', rid)
      when 'update_hostile' then format('update public.analysis_feedback set category = %L where id = %L', hs.val, rid)
      else format('delete from public.analysis_feedback where id = %L', rid) end;
  end if;
  perform stress_bm.as_owner();
  o.payload := left(stmt, 2000);
  before := stress_bm.snap(p.user_id);
  if who = 'authenticated' then perform stress_bm.as_user(p.user_id);
  elsif who = 'service_role' then perform stress_bm.as_role('service_role', null); end if;
  begin
    execute stmt;
    get diagnostics n = row_count;
    o.status := 'executed rows=' || n;
  exception when others then
    o.sqlstate := SQLSTATE; o.sqlmsg := left(SQLERRM, 200);
  end;
  perform stress_bm.as_owner();
  after := stress_bm.snap(p.user_id);
  o.deltas := stress_bm.delta(before, after);
  if o.sqlstate is not null then
    execute format('select count(*) from public.%I where id = %L', tbl, rid) into n;
    o.verdict := case
      when n <> 1 then 'BROKEN: raised ' || o.sqlstate || ' yet row count is ' || n
      when o.sqlstate = '42501' then 'HELD'
      else 'RAISED: ' || o.sqlstate end;
  else
    o.verdict := 'BROKEN: ' || who || ' mutated ' || tbl || ' (' || op || ')';
  end if;
  return o;
end;
$fn$;

-- Category 16: direct INSERT into public.shots as the client role, hostile result_kind/score.
create or replace function stress_bm.run_direct_insert(p_seed bigint) returns stress_bm.outcome language plpgsql as $fn$
declare
  o stress_bm.outcome;
  p stress_bm.pool%rowtype;
  kinds text[] := array['scored', 'low_confidence', 'SCORED', 'scored ', 'Scored', '', 'scored_v2', 'low-confidence'];
  scores text[] := array['7.1', 'null', 'NaN', 'Infinity', '-0', '10.005', '99.99', '-1', '0'];
  kind text := kinds[1 + stress_bm.pick(p_seed, 10, 8)];
  score text := scores[1 + stress_bm.pick(p_seed, 11, 9)];
  with_permit boolean := stress_bm.pick(p_seed, 12, 2) = 0;
  hs record;
  shot uuid := stress_bm.det_uuid(p_seed, 'direct');
  r record;
  before jsonb; after jsonb;
  score_sql text := case when score = 'null' then 'null' else format('%L::numeric', score) end;
  kind_sql text := case when kind = '' and stress_bm.pick(p_seed, 14, 2) = 0 then 'null' else format('%L', kind) end;
  expect_reject boolean;
  live_permit boolean;
begin
  select * into p from stress_bm.pool order by idx offset stress_bm.pick(p_seed, 1, (select count(*)::int from stress_bm.pool)) limit 1;
  select * into hs from stress_bm.hstr(p_seed, 13);
  o.user_key := 'pool#' || p.idx; o.premium := p.premium; o.json_ok := true;
  perform pg_advisory_xact_lock(424242, hashtext(p.user_id::text));
  o.mode := case when with_permit then 'legit_permit' else 'no_permit' end;
  if with_permit then
    select * into r from stress_bm.reserve(p.user_id, 'stress-direct-' || p_seed);
    with_permit := r.permit is not null;
    o.mode := o.mode || '(' || r.result || ')';
  end if;
  -- The gate's contract is "backed by a LIVE reserved permit", not "by this
  -- permit": a permit reserved by an earlier seed whose sync was refused is
  -- still live for 24h, so expectation follows the table state, not the mode.
  live_permit := exists (select 1 from public.analysis_permits a where a.user_id = p.user_id
                         and a.status = 'reserved' and a.created_at > now() - interval '24 hours');
  o.mode := o.mode || case when live_permit then '+live' else '-nolive' end;
  o.subcategory := 'direct_insert:kind=' || coalesce(nullif(kind, ''), '<empty>') || ':score=' || score;
  expect_reject := not (
    (kind = 'scored' and score not in ('null', 'NaN', 'Infinity', '-1', '99.99', '10.005') and live_permit
       and (p.premium or (select count(*) from public.shots s where s.user_id = p.user_id and s.result_kind = 'scored') < 2))
    or (kind = 'low_confidence' and score = 'null')
  );
  o.must_reject := expect_reject;
  o.payload := format('insert into public.shots (... result_kind=%s, overall_score=%s, shot_type=%s)', kind_sql, score_sql, left(hs.val, 40));
  before := stress_bm.snap(p.user_id);
  perform stress_bm.as_user(p.user_id);
  begin
    execute format($q$
      insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
        overall_score, analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
        paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
      values (%L, %L, %L, 'side', '2026-08-31T10:00:00Z', 0, 500, 1000, %s, 0.9, %s,
        '1.0.0', 'b', 'p', 'pa', 's', 'ph', 'sc', 'c')$q$,
      shot, p.user_id, left(hs.val, 64), score_sql, kind_sql);
    o.status := 'inserted';
  exception when others then
    o.sqlstate := SQLSTATE; o.sqlmsg := left(SQLERRM, 200);
  end;
  perform stress_bm.as_owner();
  after := stress_bm.snap(p.user_id);
  o.deltas := stress_bm.delta(before, after);
  if o.sqlstate is not null then
    if stress_bm.d(o.deltas, 'shots') <> 0 or stress_bm.d(o.deltas, 'ledger_max') <> 0 then
      o.verdict := 'BROKEN: insert raised but wrote';
    elsif o.sqlstate in ('42501', '23514', '23502', '22P02', '22003', '22001') then
      o.verdict := case when expect_reject then 'HELD' else 'HELD' end;
      if not expect_reject then o.verdict := 'BROKEN: valid direct insert refused with ' || o.sqlstate; end if;
    else
      o.verdict := 'RAISED: ' || o.sqlstate;
    end if;
    return o;
  end if;
  -- inserted
  if expect_reject then o.verdict := 'BROKEN: direct insert accepted a must-reject row'; return o; end if;
  if kind = 'scored' then
    if stress_bm.d(o.deltas, 'ledger_max') <> 1 then o.verdict := 'BROKEN: direct scored insert, ledger Δ=' || stress_bm.d(o.deltas, 'ledger_max'); return o; end if;
    if not p.premium and (after ->> 'scored')::int > 2 then o.verdict := 'BROKEN: direct insert exceeded free limit'; return o; end if;
  else
    if stress_bm.d(o.deltas, 'ledger_max') <> 0 then o.verdict := 'BROKEN: abstention insert touched ledger'; return o; end if;
  end if;
  o.verdict := 'HELD';
  return o;
end;
$fn$;

-- ─────────────────────────────── dispatcher ─────────────────────────────────
create or replace function stress_bm.category_name(p_cat int) returns text language sql immutable as $fn$
  select (array['raw_malformed', 'wrong_type', 'proto_keys', 'numeric_edge', 'big_strings', 'null_bytes',
                'path_traversal', 'future_schema', 'empty_shapes', 'unicode_norm', 'replay_altform',
                'reserve_key_hostile', 'identity_hostile', 'identity_collision', 'ledger_direct_access',
                'append_only', 'direct_shot_insert'])[p_cat + 1]
$fn$;

-- Weighted category choice: the RPC payload lens gets most of the budget.
create or replace function stress_bm.choose_category(p_seed bigint) returns int language sql immutable as $fn$
  select case
    when r < 10 then 0 when r < 22 then 1 when r < 28 then 2 when r < 40 then 3 when r < 50 then 4
    when r < 55 then 5 when r < 63 then 6 when r < 71 then 7 when r < 78 then 8 when r < 82 then 9
    when r < 86 then 10 when r < 89 then 11 when r < 92 then 12 when r < 93 then 13 when r < 96 then 14
    when r < 98 then 15 else 16 end
  from (select stress_bm.pick(p_seed, 0, 100) as r) s
$fn$;

-- p_record_seed is the results PK; p_seed drives every random choice. They
-- differ only for repeat runs (flake-rate measurement) via run_one_repeat().
create or replace function stress_bm.run_one_keyed(p_seed bigint, p_record_seed bigint, p_worker int, p_iteration int)
returns stress_bm.results language plpgsql as $fn$
declare
  cat int := stress_bm.choose_category(p_seed);
  o stress_bm.outcome;
  t0 timestamptz := clock_timestamp();
  res stress_bm.results;
begin
  begin
    o := case
      when cat <= 10 then stress_bm.run_rpc(p_seed, cat)
      when cat = 11 then stress_bm.run_reserve(p_seed)
      when cat = 12 then stress_bm.run_identity(p_seed)
      when cat = 13 then stress_bm.run_collision(p_seed)
      when cat = 14 then stress_bm.run_ledger_access(p_seed)
      when cat = 15 then stress_bm.run_append_only(p_seed)
      else stress_bm.run_direct_insert(p_seed)
    end;
  exception when others then
    perform stress_bm.as_owner();
    o.verdict := 'HARNESS_ERROR: ' || SQLSTATE;
    o.sqlstate := SQLSTATE; o.sqlmsg := left(SQLERRM, 400);
    o.subcategory := coalesce(o.subcategory, 'n/a');
  end;
  perform stress_bm.as_owner();
  insert into stress_bm.results (seed, gen_seed, worker, iteration, category, subcategory, user_key, premium, mode, payload,
    payload_len, json_ok, must_reject, status, sqlstate, sqlmsg, deltas, verdict, note, elapsed_ms)
  values (p_record_seed, p_seed, p_worker, p_iteration, stress_bm.category_name(cat), coalesce(o.subcategory, 'n/a'), o.user_key,
    o.premium, o.mode, left(o.payload, 2000), length(o.payload), o.json_ok, o.must_reject, o.status, o.sqlstate,
    o.sqlmsg, o.deltas, o.verdict, o.note, extract(epoch from clock_timestamp() - t0) * 1000)
  on conflict (seed) do update set verdict = excluded.verdict, status = excluded.status, sqlstate = excluded.sqlstate,
    sqlmsg = excluded.sqlmsg, deltas = excluded.deltas, note = excluded.note, elapsed_ms = excluded.elapsed_ms,
    recorded_at = now()
  returning * into res;
  return res;
end;
$fn$;

create or replace function stress_bm.run_one(p_seed bigint, p_worker int, p_iteration int)
returns stress_bm.results language plpgsql as $fn$
begin
  return stress_bm.run_one_keyed(p_seed, p_seed, p_worker, p_iteration);
end;
$fn$;

-- Repeat attempt p_rep (1-based) of p_seed, recorded under a negative key so
-- every attempt is kept: -(seed * 1000 + rep).
create or replace function stress_bm.run_one_repeat(p_seed bigint, p_rep int, p_worker int, p_iteration int)
returns stress_bm.results language plpgsql as $fn$
begin
  return stress_bm.run_one_keyed(p_seed, -(p_seed * 1000 + p_rep), p_worker, p_iteration);
end;
$fn$;

-- ───────────────────────── campaign-wide invariants ─────────────────────────
-- Checked once at the end: the ledger must equal the scored-shot history of
-- every pool identity, never exceed 2 for a non-premium pool account, and every
-- row must satisfy the hash/count shape.
create or replace function stress_bm.final_invariants() returns table (invariant text, ok boolean, detail text)
language plpgsql as $fn$
begin
  return query
  select 'ledger rows match ^[0-9a-f]{64}$ and scored_count >= 0', count(*) = 0, 'violations=' || count(*)
  from public.free_rating_ledger where identity_hash !~ '^[0-9a-f]{64}$' or scored_count < 0;

  return query
  select 'pool identity ledger == account scored shots', bool_and(l.scored_count = s.n), string_agg(format('pool#%s ledger=%s shots=%s', p.idx, l.scored_count, s.n), '; ')
  from stress_bm.pool p
  join auth.identities i on i.user_id = p.user_id
  join public.free_rating_ledger l on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  cross join lateral (select count(*) n from public.shots sh where sh.user_id = p.user_id and sh.result_kind = 'scored') s;

  return query
  select 'non-premium pool accounts hold <= 2 scored shots', coalesce(bool_and(s.n <= 2), true), string_agg(format('pool#%s=%s', p.idx, s.n), '; ')
  from stress_bm.pool p
  cross join lateral (select count(*) n from public.shots sh where sh.user_id = p.user_id and sh.result_kind = 'scored') s
  where not p.premium;

  return query
  select 'lifetime_scored_count() as each pool user == ledger', coalesce(bool_and(x.is_ok), true), string_agg(x.dd, '; ')
  from (
    select p.idx, stress_bm.lifetime_as(p.user_id) = coalesce(l.scored_count, 0) as is_ok,
           format('pool#%s fn=%s ledger=%s', p.idx, stress_bm.lifetime_as(p.user_id), l.scored_count) as dd
    from stress_bm.pool p
    join auth.identities i on i.user_id = p.user_id
    left join public.free_rating_ledger l on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  ) x;

  return query
  select 'every scored pool row belongs to an account that reserved a permit',
         count(*) = 0, 'scored shots whose account never held a permit=' || count(*)
  from public.shots sh
  join stress_bm.pool p on p.user_id = sh.user_id
  where sh.result_kind = 'scored'
    and not exists (select 1 from public.analysis_permits a where a.user_id = sh.user_id);
end;
$fn$;

create or replace function stress_bm.lifetime_as(p_uid uuid) returns int language plpgsql as $fn$
declare c int;
begin
  perform stress_bm.as_user(p_uid);
  c := public.lifetime_scored_count();
  perform stress_bm.as_owner();
  return c;
end;
$fn$;

-- ────────────────────────────── reporting ───────────────────────────────────
create or replace function stress_bm.report() returns jsonb language sql stable as $fn$
  select jsonb_build_object(
    'executed', (select count(*) from stress_bm.results),
    'by_verdict', (select coalesce(jsonb_object_agg(v, n), '{}') from (select split_part(verdict, ':', 1) v, count(*) n from stress_bm.results group by 1) t),
    'by_category', (select coalesce(jsonb_object_agg(category, o), '{}') from (
        select category, jsonb_build_object('n', count(*),
          'held', count(*) filter (where verdict = 'HELD'),
          'raised', count(*) filter (where verdict like 'RAISED%'),
          'broken', count(*) filter (where verdict like 'BROKEN%'),
          'collision', count(*) filter (where verdict like 'COLLISION%'),
          'harness_error', count(*) filter (where verdict like 'HARNESS_ERROR%')) o
        from stress_bm.results group by category) t),
    'raised_sqlstates', (select coalesce(jsonb_object_agg(s, n), '{}') from (select coalesce(sqlstate, '?') s, count(*) n from stress_bm.results where verdict like 'RAISED%' group by 1) t),
    'raised_examples', (select coalesce(jsonb_agg(jsonb_build_object('seed', seed, 'subcategory', subcategory, 'sqlstate', sqlstate)), '[]') from (
        select distinct on (subcategory) seed, subcategory, sqlstate from stress_bm.results where verdict like 'RAISED%' order by subcategory, seed) t),
    'statuses', (select coalesce(jsonb_object_agg(s, n), '{}') from (select coalesce(status, '<raised>') s, count(*) n from stress_bm.results where category not in ('identity_hostile','identity_collision','unicode_norm') group by 1) t),
    'non_held_seeds', (select coalesce(jsonb_agg(jsonb_build_object('seed', seed, 'category', category, 'subcategory', subcategory, 'verdict', verdict) order by seed), '[]')
        from stress_bm.results where verdict <> 'HELD' and verdict not like 'RAISED%'),
    'max_payload_len', (select max(payload_len) from stress_bm.results),
    'p50_ms', (select percentile_cont(0.5) within group (order by elapsed_ms) from stress_bm.results),
    'p99_ms', (select percentile_cont(0.99) within group (order by elapsed_ms) from stress_bm.results)
  )
$fn$;
