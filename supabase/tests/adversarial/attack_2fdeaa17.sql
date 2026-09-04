-- Adversarial matrix for 2fdeaa17 (DB-01 identity-link ledger backfill,
-- DB-02 direct scored-insert permit gate, DB-03 permit terminal lock).
--
-- Every case below is a VARIANT of the three original repros (ordering,
-- multiple identities, unicode subjects, boundary timestamps, premium
-- states, foreign/finalized/expired permits, role boundaries, terminal
-- transitions). Each raises if the fix does NOT hold. Run through
-- run_attack_2fdeaa17.sh (throwaway postgres:16 + shim_auth.sql + every
-- migration); the whole file executes inside one rolled-back transaction.
\set ON_ERROR_STOP on
\set VERBOSITY terse
begin;

create or replace function pg_temp.payload(p_shot uuid, p_permit uuid, p_kind text default 'scored', p_score numeric default 7.1)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', p_shot, 'analysisPermitId', p_permit, 'resultKind', p_kind,
    'shotType', 'drive', 'cameraView', 'side',
    'capturedAt', '2026-08-31T10:00:00Z',
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then p_score end, 'confidence', 0.9,
    'versionVector', jsonb_build_object(
      'appVersion', '1.0.0', 'modelBundleVersion', 'bundle-1',
      'poseModelVersion', 'pose-1', 'paddleModelVersion', 'paddle-1',
      'strokeDetectorVersion', 'stroke-1', 'phaseModelVersion', 'phase-1',
      'scoringModelVersion', 'scoring-1', 'shotConfigVersion', 'config-1'))
$$;

-- Direct INSERT into public.shots with the columns the RPC writes.
create or replace function pg_temp.direct_shot(p_shot uuid, p_user uuid, p_kind text default 'scored', p_score numeric default 9.5)
returns void language plpgsql as $$
begin
  insert into public.shots (
    id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
    overall_score, analysis_confidence, result_kind, app_version, model_bundle_version,
    pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
    scoring_model_version, shot_config_version, source)
  values (p_shot, p_user, 'drive', 'side', now(), 0, 500, 1000, p_score, 0.9, p_kind,
          '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1', 'real');
end $$;

create or replace function pg_temp.ledger(p_provider text, p_id text) returns integer language sql as $$
  select coalesce((select scored_count from public.free_rating_ledger
                   where identity_hash = public.free_rating_identity_hash(p_provider, p_id)), 0)
$$;

-- ---------------------------------------------------------------------------
-- DB-01 variants
-- ---------------------------------------------------------------------------
\echo '-- DB-01a: link BEFORE spending, then spend -> both identities counted'
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000a01', 'a01@example.com', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'a01-g', '00000000-0000-4000-8000-000000000a01', '{}'),
  ('apple',  'a01-a', '00000000-0000-4000-8000-000000000a01', '{}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000a01';
do $$
declare p uuid; r text;
begin
  select permit_id into p from public.reserve_analysis_permit('a01-1');
  r := public.apply_synced_shot(pg_temp.payload('00000000-0000-4000-8000-00000000a011', p));
  if r <> 'accepted' then raise exception 'DB-01a sync: %', r; end if;
end $$;
reset role;
do $$
begin
  if pg_temp.ledger('google', 'a01-g') <> 1 or pg_temp.ledger('apple', 'a01-a') <> 1 then
    raise exception 'DB-01a: ledger google=% apple=%', pg_temp.ledger('google','a01-g'), pg_temp.ledger('apple','a01-a');
  end if;
end $$;

\echo '-- DB-01b: spend 2, then link THREE identities (one with unicode subject) -> all inherit 2'
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000a02', 'a02@example.com', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'a02-g', '00000000-0000-4000-8000-000000000a02', '{}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000a02';
do $$
declare p uuid; r text;
begin
  select permit_id into p from public.reserve_analysis_permit('a02-1');
  r := public.apply_synced_shot(pg_temp.payload('00000000-0000-4000-8000-00000000a021', p));
  select permit_id into p from public.reserve_analysis_permit('a02-2');
  r := public.apply_synced_shot(pg_temp.payload('00000000-0000-4000-8000-00000000a022', p));
  if r <> 'accepted' then raise exception 'DB-01b sync: %', r; end if;
end $$;
reset role;
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'a02-a', '00000000-0000-4000-8000-000000000a02', '{}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'a02-ü-🎾-ñ', '00000000-0000-4000-8000-000000000a02', '{}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', repeat('x', 2000), '00000000-0000-4000-8000-000000000a02', '{}');
do $$
begin
  if pg_temp.ledger('apple', 'a02-a') <> 2 then raise exception 'DB-01b apple=%', pg_temp.ledger('apple','a02-a'); end if;
  if pg_temp.ledger('google', 'a02-ü-🎾-ñ') <> 2 then raise exception 'DB-01b unicode=%', pg_temp.ledger('google','a02-ü-🎾-ñ'); end if;
  if pg_temp.ledger('apple', repeat('x', 2000)) <> 2 then raise exception 'DB-01b long=%', pg_temp.ledger('apple', repeat('x', 2000)); end if;
end $$;

\echo '-- DB-01c: delete account, recreate with ONLY the unicode late-linked identity -> paywalled'
delete from auth.users where id = '00000000-0000-4000-8000-000000000a02';
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000a03', 'a03@example.com', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'a02-ü-🎾-ñ', '00000000-0000-4000-8000-000000000a03', '{}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000a03';
do $$
declare r record;
begin
  if public.lifetime_scored_count() <> 2 then raise exception 'DB-01c lifetime=%', public.lifetime_scored_count(); end if;
  select * into r from public.reserve_analysis_permit('a03-1');
  if r.result <> 'access.paywall_required' then raise exception 'DB-01c reserve=%', r.result; end if;
end $$;
reset role;

\echo '-- DB-01d: recreated account links a FRESH identity -> fresh identity inherits 2 too'
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'a03-fresh', '00000000-0000-4000-8000-000000000a03', '{}');
do $$
begin
  if pg_temp.ledger('apple', 'a03-fresh') <> 2 then raise exception 'DB-01d fresh=%', pg_temp.ledger('apple','a03-fresh'); end if;
end $$;

\echo '-- DB-01e: unlink + relink the same identity is monotone (never lowers a count)'
delete from auth.identities where provider = 'apple' and provider_id = 'a03-fresh';
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'a03-fresh', '00000000-0000-4000-8000-000000000a03', '{}');
do $$
begin
  if pg_temp.ledger('apple', 'a03-fresh') <> 2 then raise exception 'DB-01e relink=%', pg_temp.ledger('apple','a03-fresh'); end if;
end $$;

\echo '-- DB-01f: linking to a user with NO spend writes nothing (no phantom rows)'
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000a04', 'a04@example.com', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'a04-g', '00000000-0000-4000-8000-000000000a04', '{}'),
  ('apple',  'a04-a', '00000000-0000-4000-8000-000000000a04', '{}');
do $$
begin
  if exists (select 1 from public.free_rating_ledger
             where identity_hash in (public.free_rating_identity_hash('google','a04-g'),
                                     public.free_rating_identity_hash('apple','a04-a'))) then
    raise exception 'DB-01f: phantom ledger row for an unspent user';
  end if;
end $$;

\echo '-- DB-01g: trigger function is not client-executable'
do $$
begin
  if has_function_privilege('authenticated', 'public.sync_free_rating_ledger_on_identity_link()', 'EXECUTE')
     or has_function_privilege('anon', 'public.sync_free_rating_ledger_on_identity_link()', 'EXECUTE') then
    raise exception 'DB-01g: client role may execute the identity-link trigger function';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- DB-02 variants
-- ---------------------------------------------------------------------------
\echo '-- DB-02a: direct scored insert with no permit at 0 lifetime -> permit_not_found'
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000b01', 'b01@example.com', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-000000000b02', 'b02@example.com', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'b01-g', '00000000-0000-4000-8000-000000000b01', '{}'),
  ('google', 'b02-g', '00000000-0000-4000-8000-000000000b02', '{}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b01';
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b011', '00000000-0000-4000-8000-000000000b01');
    raise exception 'DB-02a: scored insert without a permit was accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'access.permit_not_found' then raise exception 'DB-02a msg=%', sqlerrm; end if;
  end;
end $$;

\echo '-- DB-02b: foreign reserved permit (b02) does not authorise b01'
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b02';
select permit_id as b02_permit from public.reserve_analysis_permit('b02-1') \gset
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b01';
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b012', '00000000-0000-4000-8000-000000000b01');
    raise exception 'DB-02b: foreign permit authorised a scored insert';
  exception when insufficient_privilege then null;
  end;
end $$;

\echo '-- DB-02c: user_id mismatch (insert as b02 row while jwt=b01) -> refused'
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b013', '00000000-0000-4000-8000-000000000b02');
    raise exception 'DB-02c: mismatched user_id accepted';
  exception when insufficient_privilege then null;
  end;
end $$;

\echo '-- DB-02d: finalized permit does not authorise a direct insert; permit stays finalized'
do $$
declare p uuid; r text;
begin
  select permit_id into p from public.reserve_analysis_permit('b01-1');
  r := public.apply_synced_shot(pg_temp.payload('00000000-0000-4000-8000-00000000b014', p));
  if r <> 'accepted' then raise exception 'DB-02d sync=%', r; end if;
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b015', '00000000-0000-4000-8000-000000000b01');
    raise exception 'DB-02d: finalized permit authorised a direct insert';
  exception when insufficient_privilege then
    if sqlerrm <> 'access.permit_not_found' then raise exception 'DB-02d msg=%', sqlerrm; end if;
  end;
  if (select status from public.analysis_permits where id = p) <> 'finalized' then
    raise exception 'DB-02d: permit status changed by the refused insert';
  end if;
end $$;

\echo '-- DB-02e: exactly-24h-old permit refused, 24h minus 1s accepted (boundary matches the RPC)'
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000b0e1', '00000000-0000-4000-8000-000000000b01', 'b01-exact', now() - interval '24 hours');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b01';
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b016', '00000000-0000-4000-8000-000000000b01');
    raise exception 'DB-02e: exactly-24h permit authorised a direct insert';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
update public.analysis_permits set created_at = now() - interval '24 hours' + interval '1 second'
 where id = '00000000-0000-4000-8000-00000000b0e1';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b01';
select pg_temp.direct_shot('00000000-0000-4000-8000-00000000b016', '00000000-0000-4000-8000-000000000b01');
do $$
begin
  if public.lifetime_scored_count() <> 2 then raise exception 'DB-02e lifetime=%', public.lifetime_scored_count(); end if;
end $$;

\echo '-- DB-02f: at 2 lifetime with a live reserved permit -> paywall_required'
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b017', '00000000-0000-4000-8000-000000000b01');
    raise exception 'DB-02f: third scored insert accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'access.paywall_required' then raise exception 'DB-02f msg=%', sqlerrm; end if;
  end;
end $$;

\echo '-- DB-02g: expired premium does not bypass; active premium does; lifetime premium does'
reset role;
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000b01', true, now() - interval '1 second');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b01';
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b018', '00000000-0000-4000-8000-000000000b01');
    raise exception 'DB-02g: expired premium bypassed the quota';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
update public.billing_entitlements set expires_at = now() + interval '1 hour' where user_id = '00000000-0000-4000-8000-000000000b01';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b01';
select pg_temp.direct_shot('00000000-0000-4000-8000-00000000b018', '00000000-0000-4000-8000-000000000b01');
reset role;
update public.billing_entitlements set expires_at = null where user_id = '00000000-0000-4000-8000-000000000b01';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b01';
select pg_temp.direct_shot('00000000-0000-4000-8000-00000000b019', '00000000-0000-4000-8000-000000000b01');
reset role;
delete from public.billing_entitlements where user_id = '00000000-0000-4000-8000-000000000b01';

\echo '-- DB-02h: premium WITHOUT any permit is still refused (permit is required, quota is not)'
insert into public.billing_entitlements (user_id, premium, expires_at)
values ('00000000-0000-4000-8000-000000000b02', true, null);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b02';
update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = :'b02_permit';
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b021', '00000000-0000-4000-8000-000000000b02');
    raise exception 'DB-02h: premium inserted a scored shot with no reserved permit';
  exception when insufficient_privilege then
    if sqlerrm <> 'access.permit_not_found' then raise exception 'DB-02h msg=%', sqlerrm; end if;
  end;
end $$;
reset role;

\echo '-- DB-02i: low_confidence/abstained rows must carry no score; non-scored insert needs no permit'
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b02';
do $$
begin
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b022', '00000000-0000-4000-8000-000000000b02', 'low_confidence', 9.9);
    raise exception 'DB-02i: low_confidence row stored with a score';
  exception when check_violation then null;
  end;
  begin
    perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b023', '00000000-0000-4000-8000-000000000b02', 'low_confidence', 0);
    raise exception 'DB-02i: low_confidence row stored with score 0';
  exception when check_violation then null;
  end;
  perform pg_temp.direct_shot('00000000-0000-4000-8000-00000000b024', '00000000-0000-4000-8000-000000000b02', 'low_confidence', null);
  if public.lifetime_scored_count() <> 0 then raise exception 'DB-02i: abstention counted'; end if;
end $$;
reset role;

\echo '-- DB-02j: scored row via RPC with a null score is still refused by the pre-existing CHECK'
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000b02';
do $$
declare p uuid; r text;
begin
  select permit_id into p from public.reserve_analysis_permit('b02-2');
  r := public.apply_synced_shot(pg_temp.payload('00000000-0000-4000-8000-00000000b025', p, 'scored', null));
  if r not like 'shot.write_failed:%' then raise exception 'DB-02j: scored row without a score accepted: %', r; end if;
  if (select status from public.analysis_permits where id = p) <> 'reserved' then
    raise exception 'DB-02j: failed write moved the permit';
  end if;
end $$;
reset role;

\echo '-- DB-02k: enforcing trigger is present, BEFORE INSERT, invoker, not client-executable'
do $$
begin
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'shots'
                   and t.tgname = 'shots_insert_requires_permit' and not t.tgisinternal
                   and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4) then
    raise exception 'DB-02k: shots_insert_requires_permit is not a BEFORE INSERT row trigger';
  end if;
  if (select prosecdef from pg_proc where proname = 'enforce_scored_shot_permit'
      and pronamespace = 'public'::regnamespace) then
    raise exception 'DB-02k: enforce_scored_shot_permit must be SECURITY INVOKER';
  end if;
  if has_function_privilege('authenticated', 'public.enforce_scored_shot_permit()', 'EXECUTE') then
    raise exception 'DB-02k: authenticated may execute enforce_scored_shot_permit';
  end if;
  if has_table_privilege('authenticated', 'public.shots', 'UPDATE') then
    raise exception 'DB-02k: authenticated holds UPDATE on public.shots (result_kind flip path)';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- DB-03 variants
-- ---------------------------------------------------------------------------
\echo '-- DB-03a: finalized -> reserved, outcome rewrite, terminal -> other terminal all refused'
insert into auth.users (id, email, raw_app_meta_data) values
  ('00000000-0000-4000-8000-000000000c01', 'c01@example.com', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'c01-g', '00000000-0000-4000-8000-000000000c01', '{}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-000000000c01';
do $$
declare p uuid; r text;
begin
  select permit_id into p from public.reserve_analysis_permit('c01-1');
  r := public.apply_synced_shot(pg_temp.payload('00000000-0000-4000-8000-00000000c011', p));
  if r <> 'accepted' then raise exception 'DB-03a sync=%', r; end if;
  begin
    update public.analysis_permits set status = 'reserved', outcome = null where id = p;
    raise exception 'DB-03a: finalized permit reopened';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set outcome = 'cancelled' where id = p;
    raise exception 'DB-03a: terminal outcome rewritten';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.analysis_permits set status = 'released' where id = p;
    raise exception 'DB-03a: finalized -> released allowed';
  exception when insufficient_privilege then null;
  end;
  -- same-value write is a no-op transition and is tolerated
  update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = p;
  if (select status || '/' || outcome from public.analysis_permits where id = p) <> 'finalized/scored' then
    raise exception 'DB-03a: permit drifted';
  end if;
  r := public.apply_synced_shot(pg_temp.payload('00000000-0000-4000-8000-00000000c012', p));
  if r <> 'access.permit_not_reserved' then raise exception 'DB-03a reuse=%', r; end if;
end $$;

\echo '-- DB-03b: released (cancelled) -> reserved refused; reserved -> released still works'
do $$
declare p uuid;
begin
  select permit_id into p from public.reserve_analysis_permit('c01-2');
  update public.analysis_permits set status = 'released', outcome = 'cancelled' where id = p;
  begin
    update public.analysis_permits set status = 'reserved', outcome = null where id = p;
    raise exception 'DB-03b: released permit reopened';
  exception when insufficient_privilege then null;
  end;
end $$;

\echo '-- DB-03c: DELETE, TRUNCATE-free re-mint, explicit status/outcome/created_at inserts refused'
do $$
declare p uuid;
begin
  select id into p from public.analysis_permits where idempotency_key = 'c01-1';
  begin
    delete from public.analysis_permits where id = p;
    raise exception 'DB-03c: owner deleted a permit';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key, status)
    values ('00000000-0000-4000-8000-00000000c0c1', '00000000-0000-4000-8000-000000000c01', 'c01-x', 'reserved');
    raise exception 'DB-03c: explicit status insert accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key, outcome)
    values ('00000000-0000-4000-8000-00000000c0c2', '00000000-0000-4000-8000-000000000c01', 'c01-y', null);
    raise exception 'DB-03c: explicit outcome insert accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key, created_at)
    values ('00000000-0000-4000-8000-00000000c0c3', '00000000-0000-4000-8000-000000000c01', 'c01-z', now() + interval '1 year');
    raise exception 'DB-03c: explicit created_at insert accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values (p, '00000000-0000-4000-8000-000000000c01', 'c01-dup');
    raise exception 'DB-03c: duplicate permit id re-minted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values ('00000000-0000-4000-8000-00000000c0c4', '00000000-0000-4000-8000-000000000c01', 'c01-1');
    raise exception 'DB-03c: duplicate idempotency key re-minted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.analysis_permits (id, user_id, idempotency_key)
    values ('00000000-0000-4000-8000-00000000c0c5', '00000000-0000-4000-8000-000000000b01', 'c01-foreign');
    raise exception 'DB-03c: permit minted for a foreign user';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

\echo '-- DB-03d: the cron sweep and the RPC paths (reserved -> released/expired|free_limit_exceeded) still transition'
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000c0d1', '00000000-0000-4000-8000-000000000c01', 'c01-stale', now() - interval '25 hours');
update public.analysis_permits set status = 'released', outcome = 'expired'
 where status = 'reserved' and created_at < now() - interval '24 hours';
do $$
begin
  if (select status || '/' || outcome from public.analysis_permits where id = '00000000-0000-4000-8000-00000000c0d1') <> 'released/expired' then
    raise exception 'DB-03d: sweep transition blocked';
  end if;
end $$;

\echo '-- DB-03e: table owner / service path may still not reopen (trigger is unconditional)'
do $$
begin
  begin
    update public.analysis_permits set status = 'reserved', outcome = null where id = '00000000-0000-4000-8000-00000000c0d1';
    raise exception 'DB-03e: superuser reopened a released permit through the trigger';
  exception when insufficient_privilege then null;
  end;
end $$;

rollback;
\echo ATTACK MATRIX 2fdeaa17: ALL VARIANTS HELD
