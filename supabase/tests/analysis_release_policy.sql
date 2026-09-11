-- W01/W04: operator approval is independent of deployment and app credentials.
\set ON_ERROR_STOP on
begin;
do $$
begin
  if has_function_privilege('service_role', 'public.install_analysis_release_policy(text,text)', 'EXECUTE') then
    raise exception 'POLICY: the runtime service must not install its own release authority';
  end if;
  if has_function_privilege('authenticated', 'public.read_analysis_release_policy()', 'EXECUTE')
     or has_function_privilege('anon', 'public.read_analysis_release_policy()', 'EXECUTE') then
    raise exception 'POLICY: clients must use the live-session API route';
  end if;
end $$;

set local role service_role;
do $$
declare state jsonb;
begin
  state := public.read_analysis_release_policy();
  if state -> 'document' <> 'null'::jsonb or not (state ->> 'denyNewAuthorizations')::boolean then
    raise exception 'POLICY: a fresh install must be blocked, with no invented approval';
  end if;
  begin
    update api_private.analysis_release_control set deny_new_authorizations = false;
    raise exception 'POLICY: runtime must not change the approval gate';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare artifact jsonb := jsonb_build_object('version','fixture-1','sha256',repeat('a',64));
  lineage jsonb; document jsonb; serialized text; policy_hash text; state jsonb;
begin
  select jsonb_object_agg(k, artifact) into lineage from unnest(array[
    'pipeline','definition','model','preprocessing','calibration','dataset','validationReport','supportedDomain'
  ]) k;
  document := jsonb_build_object(
    'schemaVersion','analysis-release-policy-v1','version','fixture-policy-1',
    'validFrom',floor(extract(epoch from now()))::bigint - 60,
    'validUntil',floor(extract(epoch from now()))::bigint + 3600,
    'mechanics',jsonb_build_object('lineage',lineage),
    'benchmark',jsonb_build_object('lineage',lineage,
      'uncertainty',jsonb_build_object('kind','calibrated_prediction_interval','nominalCoverage',0.9,
        'coverageScope','supported_slice','calibrationUnit','player_session'),
      'maximumIntervalWidth',1.5,'boundaryStep',0.25,
      'supportedIntervals',jsonb_build_array(jsonb_build_object('lower',3,'upper',5))),
    'supportedInputs',jsonb_build_array(jsonb_build_object('shotType','forehand_drive','cameraView','side',
      'handedness','right','captureMode','imported_video')));
  -- The operator transports canonical bytes. This SQL fixture is not a signed
  -- release; Edge separately proves RFC8785 before using any installed bytes.
  serialized := document::text;
  policy_hash := encode(sha256(convert_to(serialized,'UTF8')),'hex');
  perform public.install_analysis_release_policy(serialized, policy_hash);
  begin
    perform public.activate_analysis_release_policy(policy_hash, 'fixture-operator');
    raise exception 'POLICY: installation alone must not authorize output';
  exception when check_violation then null;
  end;
  perform public.approve_analysis_release_output(policy_hash,'mechanics','fixture-mechanics-reviewer',repeat('a',64));
  begin
    perform public.activate_analysis_release_policy(policy_hash, 'fixture-operator');
    raise exception 'POLICY: mechanics approval cannot approve the benchmark';
  exception when check_violation then null;
  end;
  begin
    perform public.approve_analysis_release_output(policy_hash,'benchmark','fixture-benchmark-reviewer',repeat('b',64));
    raise exception 'POLICY: approval must identify the exact validation report';
  exception when check_violation then null;
  end;
  perform public.approve_analysis_release_output(policy_hash,'benchmark','fixture-benchmark-reviewer',repeat('a',64));
  perform public.activate_analysis_release_policy(policy_hash,'fixture-operator');
  state := public.read_analysis_release_policy();
  if (state ->> 'denyNewAuthorizations')::boolean or state -> 'document' <> document then
    raise exception 'POLICY: approved exact policy must be readable';
  end if;
  if state #>> '{approval,policy,sha256}' <> policy_hash then
    raise exception 'POLICY: authority must bind the installed bytes';
  end if;
  begin
    update api_private.analysis_release_policies p set document = p.document || '{"version":"tampered"}'::jsonb
      where sha256 = policy_hash;
    raise exception 'POLICY: installed policy bytes must be immutable';
  exception when check_violation then null;
  end;
  perform public.withdraw_analysis_release_policy(policy_hash,'fixture-operator');
  state := public.read_analysis_release_policy();
  if not (state ->> 'denyNewAuthorizations')::boolean or state #>> '{approval,withdrawnAt}' is null then
    raise exception 'POLICY: withdrawal must stop new authorization';
  end if;
  begin
    perform public.activate_analysis_release_policy(policy_hash,'fixture-operator');
    raise exception 'POLICY: a withdrawn policy cannot silently reactivate';
  exception when check_violation then null;
  end;
  if (select count(*) from api_private.analysis_release_decisions where policy_sha256 = policy_hash) <> 4 then
    raise exception 'POLICY: every approval, activation and withdrawal must be audited once';
  end if;
end $$;
rollback;
\echo 'Analysis release policy authority: PASS'
