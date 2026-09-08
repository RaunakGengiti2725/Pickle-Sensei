-- ADV-02 — the identity free-rating ledger must be as tamper-proof as the
-- consent / evaluation / feedback ledgers.
--
-- Boundary: security_regression.sql §D2 proves that even a table-owner
-- session (compromised backend, accidental grant, migration mistake) cannot
-- UPDATE or DELETE consent_records / evaluation_trials / analysis_feedback
-- because triggers refuse it. public.free_rating_ledger is the anti-reset
-- ledger that makes the two lifetime free ratings follow the sign-in identity
-- across account deletion; its writers use greatest()-only semantics but the
-- TABLE has no guard. Expected (same standard as D2): a decrement, a reset or
-- a DELETE by the owner role is refused; service_role has no privilege at all.
\set ON_ERROR_STOP on
\set QUIET on
begin;

insert into auth.users (id, email, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000ad21', 'adv02@example.com', '{"provider":"apple"}');
insert into auth.identities (id, user_id, provider, provider_id)
values ('00000000-0000-4000-8000-00000000ad22', '00000000-0000-4000-8000-00000000ad21', 'apple', 'adv02-apple-sub');
insert into auth.sessions (id, user_id) values ('00000000-0000-4000-8000-00000000ad23', '00000000-0000-4000-8000-00000000ad21');

-- Spend both free ratings the supported way so the ledger holds 2.
do $$ begin perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000ad21';
do $$ begin perform set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000ad21","session_id":"00000000-0000-4000-8000-00000000ad23"}', true); end $$;

create function pg_temp.adv02_shot(p_id uuid, p_permit uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id, 'analysisPermitId', p_permit, 'resultKind', 'scored',
    'shotType', 'drive', 'cameraView', 'side', 'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000, 'overallScore', 7.1, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1', 'poseModelVersion', 'pose-1',
      'paddleModelVersion', 'paddle-1', 'strokeDetectorVersion', 'stroke-1',
      'phaseModelVersion', 'phase-1', 'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;

do $$
declare p1 uuid; p2 uuid; r text;
begin
  select permit_id into p1 from public.reserve_analysis_permit('adv02-k1');
  select permit_id into p2 from public.reserve_analysis_permit('adv02-k2');
  r := public.apply_synced_shot(pg_temp.adv02_shot('00000000-0000-4000-8000-00000000ad24', p1));
  if r <> 'accepted' then raise exception 'ADV-02 precondition: first scored sync %', r; end if;
  r := public.apply_synced_shot(pg_temp.adv02_shot('00000000-0000-4000-8000-00000000ad25', p2));
  if r <> 'accepted' then raise exception 'ADV-02 precondition: second scored sync %', r; end if;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'ADV-02 precondition: lifetime_scored_count must be 2, got %', public.lifetime_scored_count();
  end if;
end $$;
reset role;

-- Ledger row exists for this identity.
do $$
begin
  if (select count(*) from public.free_rating_ledger where scored_count >= 2) < 1 then
    raise exception 'ADV-02 precondition: identity ledger must record 2 scored ratings';
  end if;
end $$;

-- Attack 1: service_role cannot touch the ledger at all.
do $$
begin
  if has_table_privilege('service_role', 'public.free_rating_ledger', 'SELECT')
     or has_table_privilege('service_role', 'public.free_rating_ledger', 'UPDATE')
     or has_table_privilege('service_role', 'public.free_rating_ledger', 'DELETE')
     or has_table_privilege('authenticated', 'public.free_rating_ledger', 'SELECT')
     or has_table_privilege('anon', 'public.free_rating_ledger', 'SELECT') then
    raise exception 'ADV-02 BREAK: a client/service role holds a privilege on free_rating_ledger';
  end if;
end $$;

-- Attack 2: the owner role decrements the ledger (the §D2 standard says a
-- ledger refuses this even to its owner).
do $$
declare before_count int; after_count int;
begin
  select max(scored_count) into before_count from public.free_rating_ledger;
  begin
    update public.free_rating_ledger set scored_count = 0;
  exception when others then
    null; -- refused: expected
  end;
  select max(scored_count) into after_count from public.free_rating_ledger;
  if after_count < before_count then
    raise exception 'ADV-02 BREAK: owner role reset free_rating_ledger.scored_count from % to % (no trigger guards the ledger)',
      before_count, after_count;
  end if;
end $$;

-- Attack 3: the owner role deletes the ledger row (identity forgets the spend).
do $$
declare n int;
begin
  begin
    delete from public.free_rating_ledger;
  exception when others then
    null; -- refused: expected
  end;
  select count(*) into n from public.free_rating_ledger;
  if n = 0 then
    raise exception 'ADV-02 BREAK: owner role deleted every free_rating_ledger row; identity_scored_count() is now 0 for a spent identity';
  end if;
end $$;

rollback;
\echo 'ADV-02 free-rating ledger monotonic: PASS'
