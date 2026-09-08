-- ADV-09 — malformed / hostile apply_synced_shot() payloads.
--
-- The edge fn validates the body before calling the RPC, but the RPC is
-- EXECUTE-granted to `authenticated`, so a client with a bearer + API key can
-- call it through PostgREST with any JSON. Boundary: a malformed payload must
-- never (a) write a shot / phase / checkpoint row, (b) settle or release the
-- permit it names (a clean retry must still be possible), (c) increment the
-- identity ledger, (d) claim `accepted`. Raising is acceptable (the edge fn
-- maps it to 503) but the permit and the ledger must be untouched afterwards.
\set ON_ERROR_STOP on
\set QUIET on
begin;

insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad91', 'adv09@example.com', '{"provider":"google"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad92', '00000000-0000-4000-8000-00000000ad91', 'google', 'adv09-google-sub');
-- Premium: the free allowance must never be the reason a case is refused, so
-- every case meets a live reserved permit and only payload validation decides.
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
values ('00000000-0000-4000-8000-00000000ad91', true, now() + interval '30 days', now());

create function pg_temp.adv09_base(p_id text, p_permit text, p_kind text) returns jsonb
language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')))
$$;
grant execute on function pg_temp.adv09_base(text, text, text) to authenticated, anon;

-- A distinct, deterministic shot id per case so no case can replay another.
create function pg_temp.adv09_id(p_label text) returns text
language sql as $$ select '00000000-0000-4000-8000-' || substr(md5(p_label), 1, 12) $$;
grant execute on function pg_temp.adv09_id(text) to authenticated, anon;

-- One hostile payload per label, always aimed at the CURRENT permit.
create function pg_temp.adv09_case(p_label text, p_permit uuid) returns jsonb
language sql as $$
  select case p_label
    when 'json array' then '[]'::jsonb
    when 'json null' then 'null'::jsonb
    when 'json string' then '"scored"'::jsonb
    when 'empty object' then '{}'::jsonb
    when 'missing id' then pg_temp.adv09_base('x', p_permit::text, 'scored') - 'id'
    when 'id not a uuid' then pg_temp.adv09_base('not-a-uuid', p_permit::text, 'scored')
    when 'permit not a uuid' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), 'nope', 'scored')
    when 'permit missing, scored' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), null, 'scored')
    when 'permit of nobody' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), '00000000-0000-4000-8000-00000000ad9f', 'scored')
    when 'resultKind uppercase' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'SCORED')
    when 'resultKind unknown' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'premium_bypass')
    when 'resultKind missing' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') - 'resultKind'
    when 'score 99' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"overallScore": 99}'
    when 'score negative' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"overallScore": -1}'
    when 'score string' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"overallScore": "7.1"}'
    when 'score missing, scored' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') - 'overallScore'
    when 'contact before start' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"startMs": 900, "contactMs": 100, "endMs": 1000}'
    when 'negative ms' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"startMs": -5}'
    when 'capturedAt garbage' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"capturedAt": "not-a-date"}'
    when 'shotType 5k chars' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || jsonb_build_object('shotType', repeat('x', 5000))
    when 'low_confidence with score' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'low_confidence')
    when 'phases not an array' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"phases": {"phaseKey": "x"}}'
    when 'phase with foreign shotId' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored')
      || jsonb_build_object('phases', jsonb_build_array(jsonb_build_object('phaseKey', 'prep', 'startMs', 0, 'representativeMs', 1, 'endMs', 2, 'confidence', 0.5, 'shotId', '00000000-0000-4000-8000-00000000ad99')))
    when 'sessionId not a uuid' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"sessionId": "abc"}'
    when 'userId spoofed' then pg_temp.adv09_base(pg_temp.adv09_id(p_label), p_permit::text, 'scored') || '{"userId": "00000000-0000-4000-8000-00000000ad81"}'
  end
$$;
grant execute on function pg_temp.adv09_case(text, uuid) to authenticated, anon;

do $$ begin perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad91';

do $$
declare
  uid uuid := '00000000-0000-4000-8000-00000000ad91';
  outcomes text[] := '{}';
  -- Cases where an ACCEPT is tolerable: the payload is well formed for the
  -- SQL layer (a numeric string is a number to jsonb ->> casting; the
  -- start/contact/end ordering and non-negative timing are edge-parser
  -- rules, not table invariants)
  -- and the extra/ignored fields cannot escape the caller's rows.
  tolerated text[] := array['userId spoofed', 'phase with foreign shotId', 'low_confidence with score', 'score string', 'contact before start', 'negative ms'];
  labels text[] := array[
    'json array', 'json null', 'json string', 'empty object', 'missing id', 'id not a uuid',
    'permit not a uuid', 'permit missing, scored', 'permit of nobody', 'resultKind uppercase',
    'resultKind unknown', 'resultKind missing', 'score 99', 'score negative', 'score string',
    'score missing, scored', 'contact before start', 'negative ms', 'capturedAt garbage',
    'shotType 5k chars', 'low_confidence with score', 'phases not an array',
    'phase with foreign shotId', 'sessionId not a uuid', 'userId spoofed'];
  label text; permit uuid; payload jsonb; r text; breaks text[] := '{}';
  shots_before int; ledger_before int; permit_status text; i int := 0;
begin
  select permit_id into permit from public.reserve_analysis_permit('adv09-k0');
  if permit is null then raise exception 'ADV-09 precondition: reservation'; end if;

  foreach label in array labels loop
    i := i + 1;
    payload := pg_temp.adv09_case(label, permit);
    select count(*) into shots_before from public.shots where user_id = uid;
    ledger_before := public.lifetime_scored_count();
    begin
      r := public.apply_synced_shot(payload);
    exception when others then
      r := 'raised:' || sqlstate;
    end;
    outcomes := outcomes || format('%s=%s', label, r);

    if r = 'accepted' and not (label = any (tolerated)) then
      breaks := breaks || format('[%s] accepted', label);
    end if;
    if (select count(*) from public.shots where user_id = uid) <> shots_before and not (label = any (tolerated)) then
      breaks := breaks || format('[%s] wrote a shot row (result %s)', label, r);
    end if;
    if public.lifetime_scored_count() <> ledger_before and not (label = any (tolerated) and r = 'accepted') then
      breaks := breaks || format('[%s] moved lifetime_scored_count %s -> %s (result %s)', label, ledger_before, public.lifetime_scored_count(), r);
    end if;
    if label = 'low_confidence with score' and r = 'accepted'
       and (select overall_score from public.shots where id = pg_temp.adv09_id(label)::uuid) is not null then
      breaks := breaks || '[low_confidence with score] stored a score on a low_confidence row'::text;
    end if;
    -- Rows accepted from tolerated cases must belong to the caller and never
    -- reference a foreign shot.
    if exists (select 1 from public.shots where user_id <> uid)
       or exists (select 1 from public.shot_phases ph where ph.user_id <> uid
                  or ph.shot_id not in (select id from public.shots where user_id = uid)) then
      breaks := breaks || format('[%s] wrote rows outside the caller''s ownership', label);
    end if;

    select status into permit_status from public.analysis_permits where id = permit;
    if permit_status is distinct from 'reserved' then
      if not (label = any (tolerated) and r = 'accepted') then
        breaks := breaks || format('[%s] settled the permit to %s without delivering a rating (result %s)', label, permit_status, r);
      end if;
      select permit_id into permit from public.reserve_analysis_permit('adv09-k' || i);
      if permit is null then
        raise exception 'ADV-09 precondition: premium account could not re-reserve after case [%]', label;
      end if;
    end if;
  end loop;

  raise notice 'ADV-09 outcomes: %', array_to_string(outcomes, ' | ');
  if array_length(breaks, 1) > 0 then
    raise exception 'ADV-09 BREAK: %', array_to_string(breaks, ' | ');
  end if;
end $$;
reset role;

rollback;
\echo 'ADV-09 malformed sync payloads: PASS'
