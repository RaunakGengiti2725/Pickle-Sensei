-- ADV-03 — a partial result is terminal: nothing may relabel a stored
-- partial / low_confidence shot into a scored rating after the fact.
--
-- Boundary: 20260908100000 makes `partial` a released terminal outcome on the
-- permit (state machine refuses released/partial -> finalized/scored) and
-- keeps partials out of the free-rating count. The SHOT row is the other
-- half of that promise: `shots_record_free_rating_ledger` fires on UPDATE OF
-- result_kind, so a row flipped to 'scored' would INCREMENT the identity
-- ledger for output the user never received as a rating. Clients hold no
-- UPDATE on shots (expected refused). The owner/service path has no trigger
-- guard at all — the same defense-in-depth standard §D2 applies to ledgers.
\set ON_ERROR_STOP on
\set QUIET on
begin;

insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad31', 'adv03@example.com', '{"provider":"apple"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad32', '00000000-0000-4000-8000-00000000ad31', 'apple', 'adv03-apple-sub');

do $$ begin perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad31';

create function pg_temp.adv03_shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', null, 'confidence', 0.2,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;

do $$
declare p1 uuid; r text;
begin
  select permit_id into p1 from public.reserve_analysis_permit('adv03-k1');
  r := public.apply_synced_shot(pg_temp.adv03_shot('00000000-0000-4000-8000-00000000ad33', p1, 'partial'));
  if r <> 'accepted' then raise exception 'ADV-03 precondition: partial sync %', r; end if;
  if public.lifetime_scored_count() <> 0 then
    raise exception 'ADV-03 precondition: a partial must not count, got %', public.lifetime_scored_count();
  end if;
end $$;

-- Attack 1 (client, API header present): relabel own partial row as scored.
do $$
declare kind text;
begin
  begin
    update public.shots set result_kind = 'scored', overall_score = 8.0
    where id = '00000000-0000-4000-8000-00000000ad33';
  exception when others then
    null; -- refused: expected
  end;
  select result_kind into kind from public.shots where id = '00000000-0000-4000-8000-00000000ad33';
  if kind <> 'partial' then
    raise exception 'ADV-03 BREAK: authenticated client relabelled a partial shot to %', kind;
  end if;
end $$;
reset role;

-- Attack 2 (owner role — compromised backend / accidental grant): the same
-- relabel. Expected: refused by a table guard, ledger unchanged.
do $$
declare kind text; ledger int;
begin
  begin
    update public.shots set result_kind = 'scored', overall_score = 8.0
    where id = '00000000-0000-4000-8000-00000000ad33';
  exception when others then
    null; -- refused: expected
  end;
  select result_kind into kind from public.shots where id = '00000000-0000-4000-8000-00000000ad33';
  select coalesce(max(scored_count), 0) into ledger from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('apple', 'adv03-apple-sub');
  if kind <> 'partial' or ledger <> 0 then
    raise exception 'ADV-03 BREAK: owner role relabelled a partial shot to % and the identity ledger now reads % (a withheld result became a charged rating)',
      kind, ledger;
  end if;
end $$;

rollback;
\echo 'ADV-03 partial shot relabel: PASS'
