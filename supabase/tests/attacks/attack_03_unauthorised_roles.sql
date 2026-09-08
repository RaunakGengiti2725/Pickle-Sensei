-- ATTACK 03 — unauthorised roles on the two NEW SQL surfaces
-- (20260908020000_analysis_release_authority, 20260908100000_permit_partial_
-- terminal_outcome): every role, allowed AND denied, by EXECUTING the call
-- (has_function_privilege alone can lie when a definer wrapper exists).
--
--   R1  anon / authenticated / service_role: none of the five release
--       mutators executes (42501); only service_role may read; the trigger
--       function is not executable by anyone but the owner.
--   R2  the three api_private tables and the decisions sequence are
--       unreadable and unwritable by all three roles (42501 on every verb),
--       even through the api_private USAGE the authenticated role holds.
--   R3  owner path (allowed): install → approve both → activate → read;
--       service_role read (allowed) returns exactly the owner's state.
--   R4  partial permit surfaces: the client role may settle ITS OWN reserved
--       permit as released/partial (allowed), may not touch another user's
--       permit (0 rows, RLS), anon may not touch permits at all (42501), and
--       the lifecycle trigger functions are not client-executable.
--   R5  a released/partial permit is invisible to another authenticated user
--       and to anon (no cross-account leak of the new terminal state).
begin;
\ir _helpers.sql

-- --------------------------------------------------------------------------
-- R1 / R2: denied paths per role.
-- --------------------------------------------------------------------------
create function pg_temp.role_probe(p_role text) returns void
language plpgsql as $$
declare r text; f text; t text; v text;
begin
  execute format('set local role %I', p_role);
  set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a301';

  foreach f in array array[
    $f$select public.install_analysis_release_policy('{}', repeat('0', 64))$f$,
    $f$select public.approve_analysis_release_output(repeat('0', 64), 'mechanics', 'x', repeat('0', 64))$f$,
    $f$select public.activate_analysis_release_policy(repeat('0', 64), 'x')$f$,
    $f$select public.withdraw_analysis_release_policy(repeat('0', 64), 'x')$f$,
    $f$select public.deny_new_analysis_authorizations('x')$f$,
    $f$select api_private.guard_analysis_release_history()$f$,
    $f$select api_private.enforce_permit_transition()$f$,
    $f$select public.guard_analysis_permit_lifecycle()$f$]
  loop
    r := pg_temp.q_try(f);
    -- guard_analysis_permit_lifecycle keeps its default EXECUTE for
    -- service_role (trigger functions need none); calling a trigger function
    -- directly is 0A000 for whoever may execute it — that is not a leak.
    if p_role = 'service_role' and f like '%guard_analysis_permit_lifecycle%' then
      perform pg_temp.check(r in ('42501:', '0A000:'), p_role || ' cannot use ' || f || ' (got ' || r || ')');
    else
      perform pg_temp.check_eq(r, '42501:', p_role || ' must be refused EXECUTE on ' || f);
    end if;
  end loop;

  r := pg_temp.q_scalar('select public.read_analysis_release_policy()::text');
  if p_role = 'service_role' then
    perform pg_temp.check(r like '{%', 'service_role may read the release policy (got ' || r || ')');
  else
    perform pg_temp.check_eq(r, '42501:', p_role || ' must not read the release policy');
  end if;

  foreach t in array array['analysis_release_policies', 'analysis_release_control', 'analysis_release_decisions'] loop
    foreach v in array array[
      format('select count(*) from api_private.%I', t),
      format('update api_private.%I set %s where true', t,
        case t when 'analysis_release_control' then 'deny_new_authorizations = false'
               when 'analysis_release_policies' then 'withdrawn_at = null'
               else 'actor = ''x''' end),
      format('delete from api_private.%I', t)]
    loop
      r := pg_temp.q_try(v);
      perform pg_temp.check_eq(r, '42501:', p_role || ' must be refused: ' || v);
    end loop;
  end loop;
  r := pg_temp.q_try($q$insert into api_private.analysis_release_decisions (policy_sha256, action, actor)
                        values (null, 'deny_new', 'forged')$q$);
  perform pg_temp.check_eq(r, '42501:', p_role || ' must not forge a release decision');
  r := pg_temp.q_try($q$insert into api_private.analysis_release_policies (sha256, version, canonical_document, document)
                        values (repeat('0', 64), 'forged', '{}', '{}')$q$);
  perform pg_temp.check_eq(r, '42501:', p_role || ' must not install a policy row directly');
  r := pg_temp.q_scalar($q$select nextval('api_private.analysis_release_decisions_id_seq')::text$q$);
  perform pg_temp.check_eq(r, '42501:', p_role || ' must not touch the decisions sequence');

  reset role;
  set local request.jwt.claim.sub = '';
end $$;

select pg_temp.role_probe('anon');
select pg_temp.role_probe('authenticated');
select pg_temp.role_probe('service_role');

-- --------------------------------------------------------------------------
-- R3: the owner path is allowed and the service read mirrors it exactly.
-- --------------------------------------------------------------------------
do $$
declare lineage jsonb; document jsonb; serialized text; policy_hash text; owner_state jsonb; svc text;
begin
  select jsonb_object_agg(k, jsonb_build_object('version', 'fixture-1', 'sha256', repeat('a', 64)))
    into lineage
  from unnest(array['pipeline','definition','model','preprocessing','calibration','dataset','validationReport','supportedDomain']) k;
  document := jsonb_build_object(
    'schemaVersion', 'analysis-release-policy-v1', 'version', 'a03-policy',
    'validFrom', floor(extract(epoch from now()))::bigint - 60,
    'validUntil', floor(extract(epoch from now()))::bigint + 3600,
    'mechanics', jsonb_build_object('lineage', lineage),
    'benchmark', jsonb_build_object('lineage', lineage));
  serialized := document::text;
  policy_hash := encode(sha256(convert_to(serialized, 'UTF8')), 'hex');
  perform public.install_analysis_release_policy(serialized, policy_hash);
  perform public.approve_analysis_release_output(policy_hash, 'mechanics', 'a03-mech', repeat('a', 64));
  perform public.approve_analysis_release_output(policy_hash, 'benchmark', 'a03-bench', repeat('a', 64));
  perform public.activate_analysis_release_policy(policy_hash, 'a03-operator');
  owner_state := public.read_analysis_release_policy();
  perform pg_temp.check(not (owner_state ->> 'denyNewAuthorizations')::boolean
    and owner_state #>> '{approval,policy,sha256}' = policy_hash,
    'R3: owner activation is readable by the owner');

  set local role service_role;
  svc := pg_temp.q_scalar('select public.read_analysis_release_policy()::text');
  reset role;
  perform pg_temp.check_eq(svc, owner_state::text, 'R3: service_role reads exactly the owner state');
end $$;

-- --------------------------------------------------------------------------
-- R4 / R5: the partial outcome across roles.
-- --------------------------------------------------------------------------
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a301', 'a03-owner@example.test', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a302', 'a03-other@example.test', '{"provider":"apple"}');
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a311', '00000000-0000-4000-8000-00000000a301', 'a03-own'),
  ('00000000-0000-4000-8000-00000000a312', '00000000-0000-4000-8000-00000000a301', 'a03-own-2'),
  ('00000000-0000-4000-8000-00000000a321', '00000000-0000-4000-8000-00000000a302', 'a03-other');

-- anon: no permit access at all.
set local role anon;
set local request.jwt.claim.sub = '';
do $$
declare r text;
begin
  r := pg_temp.p_move('00000000-0000-4000-8000-00000000a311', 'released', 'partial');
  perform pg_temp.check_eq(r, '42501:', 'R4: anon may not settle a permit');
  r := pg_temp.q_scalar('select count(*)::text from public.analysis_permits');
  perform pg_temp.check_eq(r, '42501:', 'R4: anon may not read permits');
  r := pg_temp.q_scalar(format('select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a331', '00000000-0000-4000-8000-00000000a311', 'partial')));
  perform pg_temp.check_eq(r, '42501:', 'R4: anon may not call the sync RPC');
end $$;
reset role;

-- the owner of the permits, but WITHOUT the server request header: the API
-- gate hides everything, including the new partial settlement.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a301';
do $$
declare r text; saved text := current_setting('request.headers', true);
begin
  perform set_config('request.headers', '', true);
  r := pg_temp.p_move('00000000-0000-4000-8000-00000000a311', 'released', 'partial');
  perform pg_temp.check_eq(r, 'allowed 0', 'R4: a bearer without the server header cannot settle its own permit');
  r := pg_temp.q_scalar(format('select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a331', '00000000-0000-4000-8000-00000000a311', 'partial')));
  perform pg_temp.check(r in ('42501:', 'access.permit_not_found'), 'R4: the sync RPC refuses a bearer without the server header (got ' || r || ')');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a331'), 'MISSING', 'R4: no header, nothing written');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a311'), 'MISSING', 'R4: no header, no rows');
  perform set_config('request.headers', saved, true);
end $$;

-- the owner of the permits: allowed to settle own reservation as partial.
do $$
declare r text;
begin
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a311'), 'reserved/NULL', 'R4: with the header the owner sees the reservation');
  r := pg_temp.p_move('00000000-0000-4000-8000-00000000a311', 'released', 'partial');
  perform pg_temp.check_eq(r, 'allowed 1', 'R4: the owner settles own reservation as partial');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a311'), 'released/partial', 'R4: state released/partial');
  r := pg_temp.p_move('00000000-0000-4000-8000-00000000a321', 'released', 'partial');
  perform pg_temp.check_eq(r, 'allowed 0', 'R4: another user''s permit is out of reach (RLS)');
  r := pg_temp.q_scalar('select public.guard_analysis_permit_lifecycle()::text');
  perform pg_temp.check_eq(r, '42501:', 'R4: the lifecycle guard is not client-executable');
  r := pg_temp.q_scalar('select api_private.enforce_permit_transition()::text');
  perform pg_temp.check_eq(r, '42501:', 'R4: the state machine guard is not client-executable');
  r := pg_temp.q_scalar(format('select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a331', '00000000-0000-4000-8000-00000000a321', 'partial')));
  perform pg_temp.check_eq(r, 'access.permit_not_found', 'R4: a partial sync on another user''s permit is not found (never spent)');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a331'), 'MISSING', 'R4: nothing written');
end $$;

-- the other user: the released/partial permit and the partial vocabulary leak nothing.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a302';
do $$
declare r text;
begin
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a311'), 'MISSING', 'R5: another user cannot see the released/partial permit');
  r := pg_temp.p_move('00000000-0000-4000-8000-00000000a311', 'reserved', null);
  perform pg_temp.check_eq(r, 'allowed 0', 'R5: another user cannot reopen it (RLS hides the row)');
  r := pg_temp.q_scalar(format('select public.apply_synced_shot(%L::jsonb)',
    pg_temp.n_shot('00000000-0000-4000-8000-00000000a332', '00000000-0000-4000-8000-00000000a312', 'scored')));
  perform pg_temp.check_eq(r, 'access.permit_not_found', 'R5: another user cannot spend the owner''s live permit');
  perform pg_temp.check_eq(pg_temp.q_scalar('select public.permit_tombstoned(''00000000-0000-4000-8000-00000000a311'')::text'), 'false',
    'R5: permit_tombstoned never answers for another user''s id');
end $$;
reset role;
set local request.jwt.claim.sub = '';
do $$
begin
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a312'), 'reserved/NULL', 'R5: the live permit is untouched');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a321'), 'reserved/NULL', 'R5: the other user''s permit is untouched');
end $$;

select format('ATTACK 03 unauthorised roles: %s assertions passed', pg_temp.assertions());
rollback;
