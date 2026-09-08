-- ATTACK 04 — boundary values, replay and clock games against the release
-- authority (20260908020000_analysis_release_authority).
--
--   B1  digest boundaries: uppercase hex, 63/65 chars, right length wrong
--       bytes, bytes that differ only by trailing whitespace → all refused,
--       nothing installed.
--   B2  document boundaries: empty object, array, scalar, wrong/missing
--       schemaVersion, version '' / 129 chars / leading-space / 128 chars
--       (allowed), validFrom negative / string / fractional (allowed),
--       validUntil == validFrom, validUntil 253402300799 (allowed) vs
--       253402300800, validFrom == validUntil-1 (allowed), report hashes
--       uppercase / 63 chars / missing / nested null, canonical bytes of
--       65536 (allowed) vs 65537 octets.
--   B3  replay & duplicate identity: same bytes installed twice is a no-op
--       (one row, no decision); different bytes under the SAME version are
--       refused and the first stays; double approval by a second actor is a
--       no-op that records nothing new; approving mechanics with the
--       BENCHMARK report hash (distinct hashes) is refused.
--   B4  clock: a policy whose window is entirely in the past / future
--       cannot activate; one whose validFrom is now-1 can; withdrawal of the
--       NON-active policy leaves the switch open; withdrawal of the active
--       one closes it; the kill switch is idempotent and each call is
--       audited; a withdrawn policy can never come back; a fresh policy can.
--   B5  immutability against the owner itself: every column of an installed
--       policy is frozen, approvals cannot be un-set or moved, withdrawals
--       cannot be lifted, decisions cannot be edited or deleted, policies
--       cannot be deleted; a second control row cannot exist.
begin;
\ir _helpers.sql

create function pg_temp.lineage(p_report text) returns jsonb
language sql as $$
  select jsonb_object_agg(k, jsonb_build_object('version', 'fixture-1',
    'sha256', case when k = 'validationReport' then p_report else repeat('c', 64) end))
  from unnest(array['pipeline','definition','model','preprocessing','calibration','dataset','validationReport','supportedDomain']) k
$$;

create function pg_temp.doc(p_version text, p_from numeric, p_until numeric,
                            p_mech_report text default repeat('a', 64),
                            p_bench_report text default repeat('b', 64)) returns jsonb
language sql as $$
  select jsonb_build_object(
    'schemaVersion', 'analysis-release-policy-v1', 'version', p_version,
    'validFrom', p_from, 'validUntil', p_until,
    'mechanics', jsonb_build_object('lineage', pg_temp.lineage(p_mech_report)),
    'benchmark', jsonb_build_object('lineage', pg_temp.lineage(p_bench_report)))
$$;

create function pg_temp.sha(p text) returns text
language sql as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- install(bytes) with the correct digest of those bytes; returns q_try verdict
create function pg_temp.install(p_bytes text) returns text
language sql as $$
  select pg_temp.q_try(format('select public.install_analysis_release_policy(%L, %L)', p_bytes, pg_temp.sha(p_bytes)))
$$;

create function pg_temp.policies() returns integer
language sql as $$ select count(*)::integer from api_private.analysis_release_policies $$;

create function pg_temp.decisions(p_sha text) returns integer
language sql as $$ select count(*)::integer from api_private.analysis_release_decisions where policy_sha256 = p_sha $$;

-- --------------------------------------------------------------------------
-- B1: digest boundaries.
-- --------------------------------------------------------------------------
do $$
declare good text := pg_temp.doc('b1', 0, 100)::text; r text;
begin
  r := pg_temp.q_try(format('select public.install_analysis_release_policy(%L, %L)', good, upper(pg_temp.sha(good))));
  perform pg_temp.check_eq(r, '23514:', 'B1: uppercase digest refused');
  r := pg_temp.q_try(format('select public.install_analysis_release_policy(%L, %L)', good, left(pg_temp.sha(good), 63)));
  perform pg_temp.check_eq(r, '23514:', 'B1: 63-char digest refused');
  r := pg_temp.q_try(format('select public.install_analysis_release_policy(%L, %L)', good, pg_temp.sha(good) || '0'));
  perform pg_temp.check_eq(r, '23514:', 'B1: 65-char digest refused');
  r := pg_temp.q_try(format('select public.install_analysis_release_policy(%L, %L)', good, pg_temp.sha(good || ' ')));
  perform pg_temp.check_eq(r, '23514:', 'B1: digest of other bytes refused');
  r := pg_temp.q_try(format('select public.install_analysis_release_policy(%L, %L)', good || ' ', pg_temp.sha(good)));
  perform pg_temp.check_eq(r, '23514:', 'B1: bytes differing by trailing whitespace refused');
  r := pg_temp.q_try(format('select public.install_analysis_release_policy(%L, null)', good));
  perform pg_temp.check_eq(r, '23514:', 'B1: null digest refused');
  r := pg_temp.q_try(format('select public.install_analysis_release_policy(null, %L)', pg_temp.sha(good)));
  perform pg_temp.check_eq(r, '23514:', 'B1: null bytes refused');
  perform pg_temp.check_eq(pg_temp.policies()::text, '0', 'B1: nothing installed');
end $$;

-- --------------------------------------------------------------------------
-- B2: document boundaries.
-- --------------------------------------------------------------------------
do $$
declare r text; big text; base jsonb;
begin
  perform pg_temp.check_eq(pg_temp.install('{}'), '23514:', 'B2: empty object refused');
  perform pg_temp.check_eq(pg_temp.install('[]'), '23514:', 'B2: array refused');
  perform pg_temp.check_eq(pg_temp.install('"x"'), '23514:', 'B2: scalar refused');
  perform pg_temp.check_eq(pg_temp.install('null'), '23514:', 'B2: json null refused');
  perform pg_temp.check(pg_temp.install('not json') <> 'allowed 1', 'B2: non-JSON bytes refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2', 0, 100) - 'schemaVersion')::text), '23514:', 'B2: missing schemaVersion refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2', 0, 100) || '{"schemaVersion":"analysis-release-policy-v2"}')::text), '23514:', 'B2: other schemaVersion refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('', 0, 100)::text), '23514:', 'B2: empty version refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc(repeat('v', 129), 0, 100)::text), '23514:', 'B2: 129-char version refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc(' b2', 0, 100)::text), '23514:', 'B2: leading-space version refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2 ', 0, 100)::text), '23514:', 'B2: trailing-space version refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2', 0, 100) || '{"version":null}')::text), '23514:', 'B2: null version refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc(repeat('v', 128), 0, 100)::text), 'allowed 1', 'B2: 128-char version allowed');
  -- FINDING A04-P3 (documented, not a fix): the SQL authority types
  -- validFrom/validUntil (jsonb_typeof = 'number') but reads `version` through
  -- ->> without a jsonb_typeof = 'string' check, so a JSON number / boolean /
  -- object version is coerced to text and installed. The shared validator
  -- (packages/shared-types/src/analysisReleasePolicy.ts: typeof version !==
  -- "string") and the edge reader (releasePolicy.ts readVerifiedReleasePolicy)
  -- refuse such a row as an integrity failure -> `ineligible/unverified`, so the
  -- gap is fail-closed and owner-only, but the authority accepts bytes that can
  -- never activate and burns the unique `version` text ('7') for real releases.
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-num', 0, 100) || '{"version":7}')::text), 'allowed 1',
    'A04-P3 observed: numeric JSON version accepted by the SQL authority');
  perform pg_temp.check_eq((select version from api_private.analysis_release_policies where document -> 'version' = '7'::jsonb), '7',
    'A04-P3 observed: the numeric version is stored as text ''7''');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('7', 0, 100)::text), '23505:',
    'A04-P3 observed: a later real string version "7" is blocked by the coerced row');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-bool', 0, 100) || '{"version":true}')::text), 'allowed 1',
    'A04-P3 observed: boolean JSON version accepted by the SQL authority');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-obj', 0, 100) || '{"version":{"nested":1}}')::text), 'allowed 1',
    'A04-P3 observed: object JSON version accepted by the SQL authority');
  perform pg_temp.check_eq((select count(*) from api_private.analysis_release_policies where jsonb_typeof(document -> 'version') <> 'string')::text, '3',
    'A04-P3 observed: the three non-string versions are installed, append-only rows');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-neg', -1, 100)::text), '23514:', 'B2: negative validFrom refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-str', 0, 100) || '{"validFrom":"0"}')::text), '23514:', 'B2: string validFrom refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-str', 0, 100) || '{"validUntil":"100"}')::text), '23514:', 'B2: string validUntil refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-str', 0, 100) || '{"validUntil":null}')::text), '23514:', 'B2: null validUntil refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-str', 0, 100) || '{"validUntil":true}')::text), '23514:', 'B2: boolean validUntil refused');
  perform pg_temp.check_eq(pg_temp.install((pg_temp.doc('b2-str', 0, 100) - 'validUntil')::text), '23514:', 'B2: missing validUntil refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-eq', 100, 100)::text), '23514:', 'B2: validUntil == validFrom refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-lt', 100, 99)::text), '23514:', 'B2: validUntil < validFrom refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-max1', 0, 253402300800)::text), '23514:', 'B2: validUntil past year 9999 refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-max', 0, 253402300799)::text), 'allowed 1', 'B2: validUntil at the year-9999 bound allowed');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-frac', 0.5, 1.5)::text), 'allowed 1', 'B2: fractional epoch seconds allowed');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-huge', 0, 1e30)::text), '23514:', 'B2: 1e30 validUntil refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-hash-up', 0, 100, upper(repeat('a', 64)))::text), '23514:', 'B2: uppercase mechanics report hash refused');
  perform pg_temp.check_eq(pg_temp.install(pg_temp.doc('b2-hash-63', 0, 100, repeat('a', 64), repeat('b', 63))::text), '23514:', 'B2: 63-char benchmark report hash refused');
  base := pg_temp.doc('b2-hash-missing', 0, 100);
  perform pg_temp.check_eq(pg_temp.install(jsonb_set(base, '{mechanics,lineage}', (base #> '{mechanics,lineage}') - 'validationReport')::text), '23514:', 'B2: missing mechanics report refused');
  perform pg_temp.check_eq(pg_temp.install(jsonb_set(base, '{benchmark,lineage,validationReport,sha256}', 'null'::jsonb)::text), '23514:', 'B2: null benchmark report hash refused');
  perform pg_temp.check_eq(pg_temp.install((base - 'benchmark')::text), '23514:', 'B2: missing benchmark refused');
  perform pg_temp.check_eq(pg_temp.install((base - 'mechanics')::text), '23514:', 'B2: missing mechanics refused');
  -- octet cap: pad with a filler key so the canonical bytes hit exactly 65536 / 65537
  base := pg_temp.doc('b2-size', 0, 100);
  big := (base || jsonb_build_object('pad', repeat('x', 65536 - octet_length((base || '{"pad":""}'::jsonb)::text))))::text;
  perform pg_temp.check_eq(octet_length(big)::text, '65536', 'B2: fixture is exactly 65536 octets');
  perform pg_temp.check_eq(pg_temp.install(big), 'allowed 1', 'B2: 65536-octet document allowed');
  base := pg_temp.doc('b2-size2', 0, 100);
  big := (base || jsonb_build_object('pad', repeat('x', 65537 - octet_length((base || '{"pad":""}'::jsonb)::text))))::text;
  perform pg_temp.check_eq(octet_length(big)::text, '65537', 'B2: fixture is exactly 65537 octets');
  perform pg_temp.check_eq(pg_temp.install(big), '23514:', 'B2: 65537-octet document refused');
  perform pg_temp.check_eq((select count(*) from api_private.analysis_release_policies where jsonb_typeof(document -> 'version') = 'string')::text, '4',
    'B2: exactly the four allowed string-version fixtures installed');
end $$;

-- --------------------------------------------------------------------------
-- B3: replay & duplicate identity.
-- --------------------------------------------------------------------------
do $$
declare d text := pg_temp.doc('b3', 0, 253402300799)::text; h text := pg_temp.sha(pg_temp.doc('b3', 0, 253402300799)::text);
        d2 text := (pg_temp.doc('b3', 0, 253402300799) || '{"note":"different bytes, same version"}')::text; r text; before integer;
begin
  before := pg_temp.policies();
  perform pg_temp.check_eq(pg_temp.install(d), 'allowed 1', 'B3: install');
  perform pg_temp.check_eq(pg_temp.install(d), 'allowed 1', 'B3: identical replay is a no-op');
  perform pg_temp.check_eq((pg_temp.policies() - before)::text, '1', 'B3: one row after replay');
  r := pg_temp.install(d2);
  perform pg_temp.check(r <> 'allowed 1', 'B3: different bytes under the same version must be refused (got ' || r || ')');
  perform pg_temp.check_eq((pg_temp.policies() - before)::text, '1', 'B3: the first bytes stay the only ones for that version');
  perform pg_temp.check_eq((select canonical_document from api_private.analysis_release_policies where sha256 = h), d, 'B3: stored bytes are the first install');

  -- approval replay and cross-output report hash
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', ''m1'', %L)', h, repeat('b', 64)));
  perform pg_temp.check_eq(r, '23514:', 'B3: approving mechanics with the benchmark report hash refused');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''benchmark'', ''b1'', %L)', h, repeat('a', 64)));
  perform pg_temp.check_eq(r, '23514:', 'B3: approving benchmark with the mechanics report hash refused');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''Mechanics'', ''m1'', %L)', h, repeat('a', 64)));
  perform pg_temp.check_eq(r, '23514:', 'B3: output name is case-exact');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', %L, %L)', h, repeat(' ', 5), repeat('a', 64)));
  perform pg_temp.check_eq(r, '23514:', 'B3: blank actor refused');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', %L, %L)', h, repeat('a', 257), repeat('a', 64)));
  perform pg_temp.check_eq(r, '23514:', 'B3: 257-char actor refused');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', ''m1'', null)', h));
  perform pg_temp.check_eq(r, '23514:', 'B3: null report refused');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', ''m1'', %L)', upper(h), repeat('a', 64)));
  perform pg_temp.check_eq(r, '23514:', 'B3: uppercase policy digest identifies nothing');
  perform pg_temp.check_eq(pg_temp.decisions(h)::text, '0', 'B3: refused approvals leave no decision');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', ''m1'', %L)', h, repeat('a', 64)));
  perform pg_temp.check_eq(r, 'allowed 1', 'B3: mechanics approval with its own report allowed');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', ''m2-second-actor'', %L)', h, repeat('a', 64)));
  perform pg_temp.check_eq(r, 'allowed 1', 'B3: replayed mechanics approval is a no-op');
  perform pg_temp.check_eq(pg_temp.decisions(h)::text, '1', 'B3: exactly one mechanics decision recorded');
  perform pg_temp.check_eq((select actor from api_private.analysis_release_decisions where policy_sha256 = h), 'm1', 'B3: the first approver stays on record');
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, ''op'')', h));
  perform pg_temp.check_eq(r, '23514:', 'B3: mechanics alone cannot activate');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''benchmark'', ''b1'', %L)', h, repeat('b', 64)));
  perform pg_temp.check_eq(r, 'allowed 1', 'B3: benchmark approval with its own report allowed');
  perform pg_temp.check_eq(pg_temp.decisions(h)::text, '2', 'B3: two approvals recorded');
end $$;

-- --------------------------------------------------------------------------
-- B4: clock games and switch semantics.
-- --------------------------------------------------------------------------
do $$
declare now_s numeric := floor(extract(epoch from now()));
        past text := pg_temp.doc('b4-past', now_s - 7200, now_s - 3600)::text;
        future text := pg_temp.doc('b4-future', now_s + 3600, now_s + 7200)::text;
        edge_doc text := pg_temp.doc('b4-edge', now_s - 1, now_s + 3600)::text;
        other text := pg_temp.doc('b4-other', now_s - 1, now_s + 3600)::text;
        h_past text := pg_temp.sha(pg_temp.doc('b4-past', now_s - 7200, now_s - 3600)::text);
        h_future text := pg_temp.sha(pg_temp.doc('b4-future', now_s + 3600, now_s + 7200)::text);
        h_edge text := pg_temp.sha(pg_temp.doc('b4-edge', now_s - 1, now_s + 3600)::text);
        h_other text := pg_temp.sha(pg_temp.doc('b4-other', now_s - 1, now_s + 3600)::text);
        h text; r text; state jsonb; deny_before integer;
begin
  foreach h in array array[past, future, edge_doc, other] loop
    perform pg_temp.check_eq(pg_temp.install(h), 'allowed 1', 'B4: install ' || left(h, 40));
  end loop;
  foreach h in array array[h_past, h_future, h_edge, h_other] loop
    perform public.approve_analysis_release_output(h, 'mechanics', 'm', repeat('a', 64));
    perform public.approve_analysis_release_output(h, 'benchmark', 'b', repeat('b', 64));
  end loop;
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, ''op'')', h_past));
  perform pg_temp.check_eq(r, '23514:', 'B4: a policy whose window has closed cannot activate');
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, ''op'')', h_future));
  perform pg_temp.check_eq(r, '23514:', 'B4: a policy whose window has not opened cannot activate');
  state := public.read_analysis_release_policy();
  perform pg_temp.check((state ->> 'denyNewAuthorizations')::boolean and state -> 'document' = 'null'::jsonb,
    'B4: refused activations leave the switch closed and no document');
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, ''op'')', h_edge));
  perform pg_temp.check_eq(r, 'allowed 1', 'B4: a policy valid since one second ago activates');
  state := public.read_analysis_release_policy();
  perform pg_temp.check(not (state ->> 'denyNewAuthorizations')::boolean
    and state #>> '{approval,policy,sha256}' = h_edge
    and state #>> '{approval,withdrawnAt}' is null
    and (state #>> '{approval,mechanicsApprovedAt}') is not null
    and (state #>> '{approval,benchmarkApprovedAt}') is not null,
    'B4: active state reads open with both approvals stamped');

  -- withdrawing the NON-active policy must not touch the switch
  perform public.withdraw_analysis_release_policy(h_other, 'op');
  state := public.read_analysis_release_policy();
  perform pg_temp.check(not (state ->> 'denyNewAuthorizations')::boolean and state #>> '{approval,policy,sha256}' = h_edge,
    'B4: withdrawing a non-active policy leaves the active one open');
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, ''op'')', h_other));
  perform pg_temp.check_eq(r, '23514:', 'B4: the withdrawn non-active policy cannot be activated');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', ''m'', %L)', h_other, repeat('a', 64)));
  perform pg_temp.check_eq(r, '23514:', 'B4: a withdrawn policy accepts no approval, not even a replayed one');
  perform pg_temp.check_eq(pg_temp.decisions(h_other)::text, '3', 'B4: two approvals + one withdrawal audited for the non-active policy');

  -- kill switch: idempotent, audited every time, does not unbind the document
  deny_before := (select count(*) from api_private.analysis_release_decisions where action = 'deny_new');
  perform public.deny_new_analysis_authorizations('op');
  perform public.deny_new_analysis_authorizations('op');
  state := public.read_analysis_release_policy();
  perform pg_temp.check((state ->> 'denyNewAuthorizations')::boolean
    and (state #>> '{approval,denyNewAuthorizations}')::boolean
    and state #>> '{approval,policy,sha256}' = h_edge,
    'B4: the kill switch closes the gate, the bound document stays readable');
  perform pg_temp.check_eq(((select count(*) from api_private.analysis_release_decisions where action = 'deny_new') - deny_before)::text, '2',
    'B4: every kill-switch call is audited');
  r := pg_temp.q_try('select public.deny_new_analysis_authorizations(''   '')');
  perform pg_temp.check_eq(r, '23514:', 'B4: the kill switch needs a named operator');

  -- re-activation of the same, still valid policy re-opens (explicit operator act)
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, ''op'')', h_edge));
  perform pg_temp.check_eq(r, 'allowed 1', 'B4: an operator may re-activate the still-valid policy');
  perform pg_temp.check(not (public.read_analysis_release_policy() ->> 'denyNewAuthorizations')::boolean, 'B4: re-activation re-opens');

  -- withdrawing the ACTIVE policy closes the gate and is final
  perform public.withdraw_analysis_release_policy(h_edge, 'op');
  perform public.withdraw_analysis_release_policy(h_edge, 'op');
  state := public.read_analysis_release_policy();
  perform pg_temp.check((state ->> 'denyNewAuthorizations')::boolean and state #>> '{approval,withdrawnAt}' is not null,
    'B4: withdrawing the active policy closes the gate');
  perform pg_temp.check_eq(pg_temp.decisions(h_edge)::text, '7',
    'B4: 2 approvals + 2 activations + 2 deny_new (bound to the active policy) + 1 withdrawal; the replayed withdrawal records nothing');
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, ''op'')', h_edge));
  perform pg_temp.check_eq(r, '23514:', 'B4: a withdrawn policy never comes back');
  r := pg_temp.q_try(format('select public.approve_analysis_release_output(%L, ''mechanics'', ''m'', %L)', h_past, repeat('a', 64)));
  perform pg_temp.check_eq(r, 'allowed 1', 'B4: approvals are not time-gated (only activation is)');
  r := pg_temp.q_try('select public.withdraw_analysis_release_policy(repeat(''0'', 64), ''op'')');
  perform pg_temp.check_eq(r, '23514:', 'B4: withdrawing an unknown policy is refused');
  r := pg_temp.q_try('select public.activate_analysis_release_policy(repeat(''0'', 64), ''op'')');
  perform pg_temp.check_eq(r, '23514:', 'B4: activating an unknown policy is refused');
  r := pg_temp.q_try(format('select public.activate_analysis_release_policy(%L, null)', h_edge));
  perform pg_temp.check_eq(r, '23514:', 'B4: activation needs a named operator');
end $$;

-- --------------------------------------------------------------------------
-- B5: immutability against the owner itself.
-- --------------------------------------------------------------------------
do $$
declare h text; r text; col text; n_dec bigint;
begin
  select sha256 into h from api_private.analysis_release_policies where version = 'b4-edge';
  foreach col in array array[
    'sha256 = repeat(''f'', 64)', 'version = ''renamed''', 'canonical_document = ''{}''',
    'document = ''{}''::jsonb', 'installed_at = now() - interval ''1 year''',
    'mechanics_approved_at = null', 'mechanics_approved_at = now() - interval ''1 day''',
    'benchmark_approved_at = null', 'withdrawn_at = null', 'withdrawn_at = now() + interval ''1 day''']
  loop
    r := pg_temp.q_try(format('update api_private.analysis_release_policies set %s where sha256 = %L', col, h));
    perform pg_temp.check_eq(r, '23514:', 'B5: owner cannot rewrite ' || col);
  end loop;
  r := pg_temp.q_try(format('delete from api_private.analysis_release_policies where sha256 = %L', h));
  perform pg_temp.check_eq(r, '23514:', 'B5: owner cannot delete a policy');
  r := pg_temp.q_try('delete from api_private.analysis_release_policies');
  perform pg_temp.check_eq(r, '23514:', 'B5: owner cannot truncate policies by delete');
  select count(*) into n_dec from api_private.analysis_release_decisions;
  r := pg_temp.q_try('update api_private.analysis_release_decisions set actor = ''tampered''');
  perform pg_temp.check_eq(r, '23514:', 'B5: decisions cannot be edited');
  r := pg_temp.q_try('delete from api_private.analysis_release_decisions');
  perform pg_temp.check_eq(r, '23514:', 'B5: decisions cannot be deleted');
  perform pg_temp.check_eq((select count(*) from api_private.analysis_release_decisions)::text, n_dec::text, 'B5: decision count intact');
  r := pg_temp.q_try('insert into api_private.analysis_release_control (singleton) values (false)');
  perform pg_temp.check(r like '23514%', 'B5: a second control row is impossible (got ' || r || ')');
  r := pg_temp.q_try('insert into api_private.analysis_release_control (singleton) values (true)');
  perform pg_temp.check(r like '23505%', 'B5: the singleton cannot be duplicated (got ' || r || ')');
  r := pg_temp.q_try(format('update api_private.analysis_release_control set active_policy_sha256 = %L', repeat('0', 64)));
  perform pg_temp.check(r like '23503%', 'B5: the control row cannot point at an uninstalled digest (got ' || r || ')');
  r := pg_temp.q_try(format($q$insert into api_private.analysis_release_decisions (policy_sha256, action, actor)
                                values (%L, 'approve_mechanics', 'x')$q$, repeat('0', 64)));
  perform pg_temp.check(r like '23503%', 'B5: a decision cannot cite an uninstalled digest (got ' || r || ')');
  r := pg_temp.q_try(format($q$insert into api_private.analysis_release_decisions (policy_sha256, action, actor)
                                values (%L, 'bless', 'x')$q$, h));
  perform pg_temp.check(r like '23514%', 'B5: unknown decision verbs are refused (got ' || r || ')');
end $$;

select format('ATTACK 04 release policy boundaries: %s assertions passed', pg_temp.assertions());
rollback;
