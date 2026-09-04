-- S4: a deleted user's Apple subject re-appears as the provider_id of a NEW
-- user under provider='google'. The ledger key is sha256('provider:subject'),
-- so the Apple ledger must NOT carry over (documented cross-provider limit),
-- and the new identity must start at zero — while the Apple ledger row itself
-- must survive untouched for a future Apple sign-in.
\set ON_ERROR_STOP on
\set QUIET on
begin;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000c', 'carol@example.com',
        '{"full_name":"Carol"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-carol', '00000000-0000-4000-8000-00000000000c',
        '{"sub":"apple-sub-carol","email":"carol@example.com"}');

-- Carol spends both free ratings.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
do $$
declare v text; p uuid; i int;
begin
  for i in 1..2 loop
    select permit_id into p from public.reserve_analysis_permit('carol-key-' || i);
    v := public.apply_synced_shot(jsonb_build_object(
      'id', ('00000000-0000-4000-8000-0000000000c' || i)::uuid,
      'analysisPermitId', p,
      'resultKind', 'scored',
      'shotType', 'drive', 'cameraView', 'side',
      'capturedAt', '2026-08-31T10:00:00Z',
      'startMs', 0, 'contactMs', 500, 'endMs', 1000,
      'overallScore', 7.1, 'confidence', 0.9,
      'versionVector', jsonb_build_object(
        'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
        'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
        'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
        'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1')
    ));
    if v <> 'accepted' then
      raise exception 'S4 setup: scored shot % must be accepted (got %)', i, v;
    end if;
  end loop;
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S4 setup: Carol must sit at 2';
  end if;
end $$;
reset role;

do $$
begin
  if (select scored_count from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-carol')) <> 2 then
    raise exception 'S4 setup: apple ledger row must be 2';
  end if;
end $$;

-- Account deletion.
delete from auth.users where id = '00000000-0000-4000-8000-00000000000c';

-- New user Dave: provider=google with Carol's Apple subject as provider_id.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000d', 'dave@example.com',
        '{"full_name":"Dave"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'apple-sub-carol', '00000000-0000-4000-8000-00000000000d',
        '{"sub":"apple-sub-carol","email":"dave@example.com"}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000d';
do $$
declare a record; r record;
begin
  select * into a from public.access_state();
  raise notice 'RESULT S4: dave access_state premium=% scored_count=% reserved_count=%',
    a.premium, a.scored_count, a.reserved_count;
  if a.scored_count <> 0 or public.identity_scored_count() <> 0
     or public.lifetime_scored_count() <> 0 then
    raise exception 'S4: BROKEN ledger carried across providers (scored_count=%, identity=%, lifetime=%)',
      a.scored_count, public.identity_scored_count(), public.lifetime_scored_count();
  end if;
  select * into r from public.reserve_analysis_permit('dave-key-1');
  if r.result <> 'accepted' then
    raise exception 'S4: BROKEN fresh google identity refused a reserve (%)', r.result;
  end if;
  raise notice 'RESULT S4: HELD google identity with reused apple subject starts at 0 and can reserve';
end $$;
reset role;

-- The Apple ledger row must be untouched, and the hashes must differ.
do $$
declare v_apple int; v_google int;
begin
  select scored_count into v_apple from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-carol');
  select scored_count into v_google from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('google', 'apple-sub-carol');
  raise notice 'RESULT S4: ledger apple=% google=%', v_apple, coalesce(v_google::text, 'absent');
  if v_apple <> 2 then
    raise exception 'S4: apple ledger row must survive at 2 (got %)', v_apple;
  end if;
  if v_google is not null then
    raise exception 'S4: google row must not exist before a scored shot';
  end if;
  if public.free_rating_identity_hash('apple', 'apple-sub-carol')
     = public.free_rating_identity_hash('google', 'apple-sub-carol') then
    raise exception 'S4: hashes collided across providers';
  end if;
end $$;

-- S4b: Carol signs back in with Apple (same subject) → her 2 are still there.
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000e', 'carol@example.com',
        '{"full_name":"Carol"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-carol', '00000000-0000-4000-8000-00000000000e',
        '{"sub":"apple-sub-carol","email":"carol@example.com"}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000e';
do $$
declare r record;
begin
  if public.lifetime_scored_count() <> 2 then
    raise exception 'S4b: BROKEN apple re-sign-in lost the ledger (%)', public.lifetime_scored_count();
  end if;
  select * into r from public.reserve_analysis_permit('carol-again');
  if r.result <> 'access.paywall_required' then
    raise exception 'S4b: BROKEN apple re-sign-in could reserve (%)', r.result;
  end if;
  raise notice 'RESULT S4b: HELD apple re-sign-in still at 2 and refused';
end $$;
reset role;

-- S4c: separator ambiguity probe — the key is provider||':'||provider_id, so
-- ('a','b:c') and ('a:b','c') hash identically. Providers are Supabase-owned
-- enum-like strings without ':' so this is informational only.
do $$
begin
  raise notice 'RESULT S4c: INFO hash(a,b:c)=hash(a:b,c) is %',
    public.free_rating_identity_hash('a', 'b:c') = public.free_rating_identity_hash('a:b', 'c');
end $$;

rollback;
\echo S4 DONE
