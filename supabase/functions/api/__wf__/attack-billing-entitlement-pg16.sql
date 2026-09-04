-- ADVERSARIAL PASS — billing_entitlements predicate on the REAL migrations
-- (run by attack-billing-entitlement-pg16.sh after shim_auth.sql + every
-- migration, on a throwaway postgres:16).
--
-- Each block raises on a violated invariant; ON_ERROR_STOP makes psql exit 3.
-- Blocks that must observe wall-clock progress run OUTSIDE a transaction
-- (autocommit) because now() is frozen inside one.
\set ON_ERROR_STOP on
\set QUIET on

\set uid '00000000-0000-4000-8000-0000000000e1'
\set uid2 '00000000-0000-4000-8000-0000000000e2'

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values
  (:'uid', 'attack-premium@example.com', '{}', '{"provider":"apple"}'),
  (:'uid2', 'attack-other@example.com', '{}', '{"provider":"google"}');

create or replace function pg_temp.atk_shot(p_id uuid, p_permit uuid, p_kind text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'id', p_id,
    'analysisPermitId', p_permit,
    'sessionId', null,
    'shotType', 'dink',
    'cameraView', 'side',
    'capturedAt', now(),
    'startMs', 0, 'contactMs', 500, 'endMs', 1000,
    'overallScore', case when p_kind = 'scored' then 6.5 else null end,
    'confidence', 0.9,
    'resultKind', p_kind,
    'versionVector', jsonb_build_object(
      'appVersion', '1', 'modelBundleVersion', '1', 'poseModelVersion', '1',
      'paddleModelVersion', '1', 'strokeDetectorVersion', '1',
      'phaseModelVersion', '1', 'scoringModelVersion', '1', 'shotConfigVersion', '1'),
    'phases', '[]'::jsonb, 'checkpoints', '[]'::jsonb)
$$;

-- ── Setup: a PREMIUM user who has 2 scored shots.
insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
values (:'uid', true, 'pickle_sensei_pro_monthly', now() + interval '1 day');

set role authenticated;
set request.jwt.claim.sub = :'uid';
do $$
declare r record; res text;
begin
  select * into r from public.reserve_analysis_permit('atk-1');
  if r.result <> 'accepted' then raise exception 'premium reserve 1: %', r.result; end if;
  res := public.apply_synced_shot(pg_temp.atk_shot('50000000-0000-4000-8000-000000000001', r.permit_id, 'scored'));
  if res <> 'accepted' then raise exception 'premium scored 1: %', res; end if;
  select * into r from public.reserve_analysis_permit('atk-2');
  if r.result <> 'accepted' then raise exception 'premium reserve 2: %', r.result; end if;
  res := public.apply_synced_shot(pg_temp.atk_shot('50000000-0000-4000-8000-000000000002', r.permit_id, 'scored'));
  if res <> 'accepted' then raise exception 'premium scored 2: %', res; end if;
  if (select scored_count from public.access_state()) <> 2 then raise exception 'precondition: 2 scored shots'; end if;
  if not (select premium from public.access_state()) then raise exception 'precondition: premium'; end if;
end $$;
reset role;

-- ── S5: expires_at = now() - 1s → reserve_analysis_permit must paywall.
update public.billing_entitlements set expires_at = now() - interval '1 second' where user_id = :'uid';
set role authenticated;
set request.jwt.claim.sub = :'uid';
do $$
declare r record; s record;
begin
  select * into s from public.access_state();
  if s.premium then raise exception 'S5: expired entitlement reported premium: %', s; end if;
  select * into r from public.reserve_analysis_permit('atk-3-expired');
  if r.result <> 'access.paywall_required' then raise exception 'S5: expired premium with 2 scored shots reserved: %', r.result; end if;
  if (select count(*) from public.analysis_permits where idempotency_key = 'atk-3-expired') <> 0 then
    raise exception 'S5: a permit row was minted for the refused reserve';
  end if;
  raise notice 'S5 HELD: expires_at=now()-1s, 2 scored shots -> %', r.result;
end $$;
reset role;

-- ── S5b: boundary — expires_at exactly at the transaction's now() is NOT premium (strict >).
begin;
update public.billing_entitlements set expires_at = now() where user_id = :'uid';
set local role authenticated;
set local request.jwt.claim.sub = :'uid';
do $$
declare r record;
begin
  if (select premium from public.access_state()) then raise exception 'S5b: expires_at = now() reported premium'; end if;
  select * into r from public.reserve_analysis_permit('atk-boundary');
  if r.result <> 'access.paywall_required' then raise exception 'S5b: boundary reserve: %', r.result; end if;
  raise notice 'S5b HELD: expires_at = now() -> %', r.result;
end $$;
rollback;

-- ── S5c: premium=false with a FUTURE expires_at (lapsed verdict that kept the old date) is not premium.
update public.billing_entitlements set premium = false, expires_at = now() + interval '30 days' where user_id = :'uid';
set role authenticated;
set request.jwt.claim.sub = :'uid';
do $$
declare r record;
begin
  if (select premium from public.access_state()) then raise exception 'S5c: premium=false row reported premium'; end if;
  select * into r from public.reserve_analysis_permit('atk-lapsed-future');
  if r.result <> 'access.paywall_required' then raise exception 'S5c: lapsed reserve: %', r.result; end if;
  raise notice 'S5c HELD: premium=false/expires_at future -> %', r.result;
end $$;
reset role;

-- ── S5d: FK / cascade truth behind the webhook's "persist failed" branch:
--        deleting the profiles row cascades the entitlement away and a
--        service-role upsert for the missing profile fails with 23503.
begin;
do $$
declare v_code text;
begin
  delete from public.profiles where id = '00000000-0000-4000-8000-0000000000e1';
  if exists (select 1 from public.billing_entitlements where user_id = '00000000-0000-4000-8000-0000000000e1') then
    raise exception 'S5d: entitlement survived profile deletion';
  end if;
  begin
    insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
    values ('00000000-0000-4000-8000-0000000000e1', false, null, null, now())
    on conflict (user_id) do update set premium = excluded.premium;
    raise exception 'S5d: upsert for a deleted profile succeeded';
  exception when foreign_key_violation then
    get stacked diagnostics v_code = returned_sqlstate;
    raise notice 'S5d HELD: upsert for deleted profile -> sqlstate %', v_code;
  end;
end $$;
rollback;

-- ── S7 (DB half): expires_at 500 ms ahead → premium now; after 600 ms → not premium,
--    and the RPC refuses a third free rating for the user with 2 scored shots.
update public.billing_entitlements set premium = true, expires_at = clock_timestamp() + interval '500 milliseconds' where user_id = :'uid';
set role authenticated;
set request.jwt.claim.sub = :'uid';
do $$
begin
  if not (select premium from public.access_state()) then raise exception 'S7: +500ms not premium'; end if;
end $$;
select pg_sleep(0.6);
do $$
declare r record; s record;
begin
  select * into s from public.access_state();
  if s.premium then raise exception 'S7: still premium 600ms after a +500ms expiry (now() frozen?)'; end if;
  select * into r from public.reserve_analysis_permit('atk-after-500ms');
  if r.result <> 'access.paywall_required' then raise exception 'S7: reserve after expiry: %', r.result; end if;
  raise notice 'S7 HELD: access_state.premium=% after 600ms; reserve -> %', s.premium, r.result;
end $$;
reset role;

-- ── X13: entitlement expires BETWEEN reserve and apply_synced_shot for a user
--        with 2 scored shots → the sync backstop refuses the scored shot
--        (permit released with free_limit_exceeded).
update public.billing_entitlements set premium = true, expires_at = clock_timestamp() + interval '400 milliseconds' where user_id = :'uid';
set role authenticated;
set request.jwt.claim.sub = :'uid';
do $$
declare r record;
begin
  select * into r from public.reserve_analysis_permit('atk-mid-flight');
  if r.result <> 'accepted' then raise exception 'X13: premium reserve refused: %', r.result; end if;
  perform set_config('atk.permit', r.permit_id::text, false);
end $$;
select pg_sleep(0.5);
do $$
declare res text; v_outcome text; v_status text;
begin
  res := public.apply_synced_shot(pg_temp.atk_shot('50000000-0000-4000-8000-000000000003', current_setting('atk.permit')::uuid, 'scored'));
  select status, outcome into v_status, v_outcome from public.analysis_permits where id = current_setting('atk.permit')::uuid;
  raise notice 'X13 OBSERVED: entitlement expired between reserve and sync -> apply_synced_shot=% permit status=% outcome=%', res, v_status, v_outcome;
  if res = 'accepted' then
    raise exception 'X13: a scored shot was accepted for a now-lapsed user with 2 free ratings used';
  end if;
  if (select count(*) from public.shots where id = '50000000-0000-4000-8000-000000000003') <> 0 then
    raise exception 'X13: refused shot row persisted';
  end if;
end $$;
reset role;

-- ── X14: the authenticated role cannot forge, extend, or delete the verdict
--        (INSERT / UPDATE / DELETE on billing_entitlements), including via
--        an ON CONFLICT upsert, and cannot read another user's row.
set role authenticated;
set request.jwt.claim.sub = :'uid2';
do $$
declare v_ok int := 0;
begin
  begin
    insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
    values ('00000000-0000-4000-8000-0000000000e2', true, 'pickle_sensei_pro_lifetime', null);
    raise exception 'X14: authenticated INSERT into billing_entitlements succeeded';
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;
  begin
    insert into public.billing_entitlements (user_id, premium) values ('00000000-0000-4000-8000-0000000000e2', true)
    on conflict (user_id) do update set premium = true, expires_at = null;
    raise exception 'X14: authenticated UPSERT into billing_entitlements succeeded';
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;
  begin
    update public.billing_entitlements set premium = true, expires_at = null;
    raise exception 'X14: authenticated UPDATE of billing_entitlements succeeded';
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;
  begin
    delete from public.billing_entitlements;
    raise exception 'X14: authenticated DELETE of billing_entitlements succeeded';
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;
  if (select count(*) from public.billing_entitlements) <> 0 then
    raise exception 'X14: uid2 can read another user''s billing_entitlements row';
  end if;
  if (select premium from public.access_state()) then raise exception 'X14: uid2 premium without a row'; end if;
  raise notice 'X14 HELD: % client write paths refused with 42501; cross-user read returns 0 rows', v_ok;
end $$;
reset role;

-- ── X15: webhook_events is invisible and unwritable to clients (audit integrity).
insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
values ('atk-evt-1', 'revenuecat', 'RENEWAL', :'uid', '{}');
set role authenticated;
set request.jwt.claim.sub = :'uid';
do $$
declare v_ok int := 0;
begin
  begin
    if (select count(*) from public.webhook_events) <> 0 then raise exception 'X15: client can read webhook_events'; end if;
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;
  begin
    insert into public.webhook_events (id, payload) values ('atk-forged', '{}');
    raise exception 'X15: client inserted a webhook_events row';
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;
  begin
    delete from public.webhook_events where id = 'atk-evt-1';
    raise exception 'X15: client deleted a webhook_events row';
  exception when insufficient_privilege then v_ok := v_ok + 1;
  end;
  raise notice 'X15 HELD: webhook_events refused % client paths', v_ok;
end $$;
reset role;
do $$
begin
  if (select count(*) from public.webhook_events where id = 'atk-evt-1') <> 1 then raise exception 'X15: audit row missing'; end if;
end $$;

-- ── X16: webhook_events primary key is the only replay guard — a concurrent
--        second insert of the same id with ON CONFLICT DO NOTHING is a no-op
--        (what the edge fn's ignoreDuplicates upsert compiles to) and the
--        FIRST payload wins.
insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
values ('atk-evt-1', 'revenuecat', 'CANCELLATION', :'uid', '{"second":true}')
on conflict (id) do nothing;
do $$
begin
  if (select event_type from public.webhook_events where id = 'atk-evt-1') <> 'RENEWAL' then
    raise exception 'X16: second insert overwrote the audit row';
  end if;
  raise notice 'X16 HELD: ON CONFLICT DO NOTHING keeps the first audit payload';
end $$;

\echo ATTACK PG16 ENTITLEMENT INVARIANTS: ALL PASSED
