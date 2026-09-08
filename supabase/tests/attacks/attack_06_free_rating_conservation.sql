-- ATTACK 06 — free-rating conservation with the NEW partial outcome, replays,
-- clock games and a deleted-and-recreated identity.
--
--   F1  partials never charge: three partial syncs on three permits →
--       lifetime_scored_count 0, access_state.scored_count 0, no ledger row,
--       the reserve RPC still issues.
--   F2  two ratings spend the allowance; a permit reserved BEFORE the limit
--       still settles a partial (accepted, no charge) but refuses a rating
--       (paywall, permit released/free_limit_exceeded); the reserve RPC
--       refuses; the count is exactly 2 everywhere (account + identity).
--   F3  replay: every shot re-sent byte-identical → accepted, one row each,
--       count 2; a partial shot id re-sent as 'scored' under a fresh permit
--       → accepted (idempotent on the id), the stored row stays partial, the
--       fresh permit is NOT consumed and NOT charged; a scored shot id
--       re-sent as 'partial' keeps its rating and its permit.
--   F4  clock games: a partial sync on a permit swept to released/expired
--       (late offline settlement) → accepted, released/partial, no charge; a
--       far-future / epoch-zero / pre-epoch capturedAt never changes the
--       count; a partial dated before the account existed is still not a
--       rating.
--   F5  the same identity comes back after account deletion: the ledger says
--       2, so a rating is refused while a partial is still accepted and the
--       inherited count stays exactly 2 (never 3, never 0).
--   F6  premium whose entitlement expired 1s ago: partial accepted, rating
--       refused; premium valid until +1s: rating accepted with no ledger
--       inflation beyond the scored rows.
begin;
\ir _helpers.sql

create function pg_temp.sync(p_shot uuid, p_permit uuid, p_kind text, p_extra jsonb default '{}') returns text
language plpgsql as $$
declare v text; s text; h text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(p_shot, p_permit, p_kind) || p_extra);
  return v;
exception when others then
  get stacked diagnostics s = returned_sqlstate, h = pg_exception_hint;
  return s || ':' || coalesce(h, '');
end $$;

create function pg_temp.reserve(p_key text) returns text
language plpgsql as $$
declare r record; s text; h text;
begin
  select * into r from public.reserve_analysis_permit(p_key);
  return r.result || '/' || coalesce(r.permit_id::text, 'NULL');
exception when others then
  get stacked diagnostics s = returned_sqlstate, h = pg_exception_hint;
  return s || ':' || coalesce(h, '');
end $$;

create function pg_temp.counts() returns text
language sql as $$
  select format('lifetime=%s identity=%s access=%s reserved=%s',
    public.lifetime_scored_count(), public.identity_scored_count(),
    (select scored_count from public.access_state()), (select reserved_count from public.access_state()))
$$;

grant execute on function pg_temp.sync(uuid, uuid, text, jsonb), pg_temp.reserve(text), pg_temp.counts() to authenticated;

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a601', 'a06-free@example.test', '{"full_name":"Free"}', '{"provider":"google"}'),
  ('00000000-0000-4000-8000-00000000a602', 'a06-pro@example.test', '{"full_name":"Pro"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'google-sub-a06-free', '00000000-0000-4000-8000-00000000a601', '{"sub":"google-sub-a06-free"}'),
  ('apple', 'apple-sub-a06-pro', '00000000-0000-4000-8000-00000000a602', '{"sub":"apple-sub-a06-pro"}');

create function pg_temp.ledger(p_provider text, p_sub text) returns text
language sql security definer as $$
  select coalesce((select scored_count::text from public.free_rating_ledger
                   where identity_hash = public.free_rating_identity_hash(p_provider, p_sub)), 'NONE')
$$;

-- --------------------------------------------------------------------------
-- F1: partials never charge.
-- --------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
do $$
declare p uuid[]; i integer; r text;
begin
  -- the reserve RPC caps live holds at the remaining allowance (2): the
  -- third hold waits until a partial settles one of them
  for i in 1..2 loop
    r := pg_temp.reserve('a06-key-' || i);
    perform pg_temp.check(r like 'accepted/%', 'F1: reserve ' || i || ' (got ' || r || ')');
    p[i] := split_part(r, '/', 2)::uuid;
  end loop;
  perform pg_temp.check_eq(pg_temp.reserve('a06-key-3'), 'access.paywall_required/NULL', 'F1: two live holds exhaust the allowance while nothing is scored');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=0 identity=0 access=0 reserved=2', 'F1: two holds, nothing scored');
  r := pg_temp.sync('00000000-0000-4000-8000-00000000a601', p[1], 'partial');
  perform pg_temp.check_eq(r, 'accepted', 'F1: partial 1 accepted');
  perform pg_temp.check_eq(pg_temp.r_permit(p[1]), 'released/partial', 'F1: permit 1 released/partial');
  r := pg_temp.reserve('a06-key-3');
  perform pg_temp.check(r like 'accepted/%', 'F1: a settled partial frees its hold (got ' || r || ')');
  p[3] := split_part(r, '/', 2)::uuid;
  for i in 2..3 loop
    r := pg_temp.sync(('00000000-0000-4000-8000-00000000a6' || lpad(i::text, 2, '0'))::uuid, p[i], 'partial');
    perform pg_temp.check_eq(r, 'accepted', 'F1: partial ' || i || ' accepted');
    perform pg_temp.check_eq(pg_temp.r_permit(p[i]), 'released/partial', 'F1: permit ' || i || ' released/partial');
  end loop;
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=0 identity=0 access=0 reserved=0', 'F1: three partials cost nothing');
  for i in 4..5 loop
    r := pg_temp.reserve('a06-key-' || i);
    perform pg_temp.check(r like 'accepted/%', 'F1: the reserve RPC still issues after three partials (got ' || r || ')');
  end loop;
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=0 identity=0 access=0 reserved=2', 'F1: two fresh holds');
end $$;
reset role;
do $$ begin perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a06-free'), 'NONE', 'F1: no identity ledger row from partials'); end $$;

-- --------------------------------------------------------------------------
-- F2: two ratings spend the allowance; a pre-reserved permit still takes a
--     partial but not a rating.
-- --------------------------------------------------------------------------
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a620', '00000000-0000-4000-8000-00000000a601', 'a06-overissued');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
do $$
declare p4 uuid; p5 uuid; p6 uuid := '00000000-0000-4000-8000-00000000a620'; r text;
begin
  select id into p4 from public.analysis_permits where idempotency_key = 'a06-key-4';
  select id into p5 from public.analysis_permits where idempotency_key = 'a06-key-5';
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a611', p4, 'scored'), 'accepted', 'F2: rating 1');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a612', p5, 'scored'), 'accepted', 'F2: rating 2');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=1', 'F2: exactly two ratings spent');
  r := pg_temp.reserve('a06-key-6');
  perform pg_temp.check_eq(r, 'access.paywall_required/NULL', 'F2: the reserve RPC refuses at the limit');
  -- the pre-reserved permit: a rating is refused and the permit is closed as free_limit_exceeded
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a613', p6, 'scored'), 'access.paywall_required', 'F2: over-issued permit cannot become a third rating');
  perform pg_temp.check_eq(pg_temp.r_permit(p6), 'released/free_limit_exceeded', 'F2: permit closed as free_limit_exceeded');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a613'), 'MISSING', 'F2: no third rating row');
  -- a partial on the now-closed permit is refused too (it is not backing any more)
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a614', p6, 'partial'), 'access.permit_not_reserved', 'F2: free_limit_exceeded is not backing for a partial either');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'F2: count pinned at 2');
end $$;
reset role;
-- a permit reserved before the limit, still open: partial accepted at the limit
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a621', '00000000-0000-4000-8000-00000000a601', 'a06-preissued');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
do $$
begin
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a615', '00000000-0000-4000-8000-00000000a621', 'partial'), 'accepted', 'F2: a partial at the limit is accepted (mechanics-only is not a rating)');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a621'), 'released/partial', 'F2: released/partial');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'F2: still 2');
end $$;

-- --------------------------------------------------------------------------
-- F3: replays.
-- --------------------------------------------------------------------------
do $$
declare p4 uuid; p1 uuid; r text; n integer;
begin
  select id into p4 from public.analysis_permits where idempotency_key = 'a06-key-4';
  select id into p1 from public.analysis_permits where idempotency_key = 'a06-key-1';
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a611', p4, 'scored'), 'accepted', 'F3: byte-identical rating replay accepted');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a601', p1, 'partial'), 'accepted', 'F3: byte-identical partial replay accepted');
  select count(*) into n from public.shots;
  perform pg_temp.check_eq(n::text, '6', 'F3: still 6 rows (3 partial + 2 scored + 1 partial)');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'F3: replays do not charge');
  -- a scored shot id re-sent as partial keeps its rating (no silent downgrade, no refund)
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a611', p4, 'partial'), 'accepted', 'F3: scored id re-sent as partial is idempotent');
  perform pg_temp.check(pg_temp.s_shot('00000000-0000-4000-8000-00000000a611') like 'scored/7.1%', 'F3: the rating row is untouched');
  perform pg_temp.check_eq(pg_temp.r_permit(p4), 'finalized/scored', 'F3: its permit stays consumed');
end $$;
reset role;
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a622', '00000000-0000-4000-8000-00000000a601', 'a06-fresh-for-upgrade');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
do $$
begin
  -- a partial shot id re-sent as a rating under a fresh permit: must not become a rating
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a601', '00000000-0000-4000-8000-00000000a622', 'scored'), 'accepted', 'F3: partial id re-sent as scored is idempotent on the id');
  perform pg_temp.check(pg_temp.s_shot('00000000-0000-4000-8000-00000000a601') like 'partial/NULL/%', 'F3: the stored row stays partial and unscored');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a622'), 'reserved/NULL', 'F3: the fresh permit is neither consumed nor charged');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=1', 'F3: count still 2, one live hold');
end $$;
reset role;

-- --------------------------------------------------------------------------
-- F4: clock games.
-- --------------------------------------------------------------------------
-- the owner cannot back-date a live reservation (the state machine refuses any
-- rewrite of a reserved row that is not a settlement), so the offline permit is
-- seeded old the way a real 30-hour-old reservation would be found by the sweep
insert into public.analysis_permits (id, user_id, idempotency_key, created_at) values
  ('00000000-0000-4000-8000-00000000a626', '00000000-0000-4000-8000-00000000a601', 'a06-offline-30h', now() - interval '30 hours');
update public.analysis_permits set status = 'released', outcome = 'expired'
where status = 'reserved' and created_at < now() - interval '24 hours';
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a623', '00000000-0000-4000-8000-00000000a601', 'a06-far-future'),
  ('00000000-0000-4000-8000-00000000a624', '00000000-0000-4000-8000-00000000a601', 'a06-epoch-zero'),
  ('00000000-0000-4000-8000-00000000a625', '00000000-0000-4000-8000-00000000a601', 'a06-pre-epoch');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a601';
do $$
declare r text;
begin
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a626'), 'released/expired', 'F4: swept while offline');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a622'), 'reserved/NULL', 'F4: the fresh reservation is not swept');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a631', '00000000-0000-4000-8000-00000000a626', 'partial'), 'accepted', 'F4: late partial settlement on an expired permit accepted');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a626'), 'released/partial', 'F4: released/expired -> released/partial');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a632', '00000000-0000-4000-8000-00000000a626', 'scored'), 'access.permit_not_reserved', 'F4: the late-settled permit cannot then back a rating');
  r := pg_temp.sync('00000000-0000-4000-8000-00000000a633', '00000000-0000-4000-8000-00000000a623', 'partial', '{"capturedAt":"2999-12-31T23:59:59Z"}');
  perform pg_temp.check(r in ('accepted', 'shot.invalid_captured_at', 'shot.write_failed:23514', 'shot.write_failed:22008'), 'F4: far-future capturedAt is either stored as a partial or refused, never a rating (got ' || r || ')');
  r := pg_temp.sync('00000000-0000-4000-8000-00000000a634', '00000000-0000-4000-8000-00000000a624', 'partial', '{"capturedAt":"1970-01-01T00:00:00Z"}');
  perform pg_temp.check(r in ('accepted', 'shot.invalid_captured_at', 'shot.write_failed:23514', 'shot.write_failed:22008'), 'F4: epoch-zero capturedAt never charges (got ' || r || ')');
  r := pg_temp.sync('00000000-0000-4000-8000-00000000a635', '00000000-0000-4000-8000-00000000a625', 'partial', '{"capturedAt":"1969-12-31T23:59:59Z"}');
  perform pg_temp.check(r in ('accepted', 'shot.invalid_captured_at', 'shot.write_failed:23514', 'shot.write_failed:22008'), 'F4: pre-epoch capturedAt never charges (got ' || r || ')');
  perform pg_temp.check(pg_temp.counts() like 'lifetime=2 identity=2 access=2 reserved=%', 'F4: clock games never moved the count (' || pg_temp.counts() || ')');
  perform pg_temp.check_eq((select count(*)::text from public.shots where result_kind = 'scored'), '2', 'F4: two scored rows, no more');
end $$;
reset role;

-- --------------------------------------------------------------------------
-- F5: the identity comes back after deletion.
-- --------------------------------------------------------------------------
delete from auth.users where id = '00000000-0000-4000-8000-00000000a601';
do $$
begin
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a06-free'), '2', 'F5: the ledger survives deletion at exactly 2');
  perform pg_temp.check_eq((select count(*)::text from public.shots where user_id = '00000000-0000-4000-8000-00000000a601'), '0', 'F5: shots cascaded');
end $$;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-00000000a603', 'a06-free@example.test', '{"full_name":"Free"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('google', 'google-sub-a06-free', '00000000-0000-4000-8000-00000000a603', '{"sub":"google-sub-a06-free"}');
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a641', '00000000-0000-4000-8000-00000000a603', 'a06-second-life-forged-1'),
  ('00000000-0000-4000-8000-00000000a642', '00000000-0000-4000-8000-00000000a603', 'a06-second-life-forged-2');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a603';
do $$
begin
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=2', 'F5: the new account inherits exactly 2');
  perform pg_temp.check_eq(pg_temp.reserve('a06-second-life'), 'access.paywall_required/NULL', 'F5: reserve refused');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a651', '00000000-0000-4000-8000-00000000a641', 'scored'), 'access.paywall_required', 'F5: a forged permit cannot become a third rating');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a641'), 'released/free_limit_exceeded', 'F5: closed as free_limit_exceeded');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a652', '00000000-0000-4000-8000-00000000a642', 'partial'), 'accepted', 'F5: a partial is still accepted');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'F5: inherited count stays 2 (never 3, never reset)');
end $$;
reset role;
do $$ begin perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a06-free'), '2', 'F5: ledger unchanged by the partial'); end $$;

-- --------------------------------------------------------------------------
-- F6: premium boundaries at ±1 second.
-- --------------------------------------------------------------------------
insert into public.billing_entitlements (user_id, premium, expires_at, verified_at)
values ('00000000-0000-4000-8000-00000000a602', true, now() - interval '1 second', now());
insert into public.analysis_permits (id, user_id, idempotency_key) values
  ('00000000-0000-4000-8000-00000000a661', '00000000-0000-4000-8000-00000000a602', 'a06-pro-1'),
  ('00000000-0000-4000-8000-00000000a662', '00000000-0000-4000-8000-00000000a602', 'a06-pro-2'),
  ('00000000-0000-4000-8000-00000000a663', '00000000-0000-4000-8000-00000000a602', 'a06-pro-3'),
  ('00000000-0000-4000-8000-00000000a664', '00000000-0000-4000-8000-00000000a602', 'a06-pro-4'),
  ('00000000-0000-4000-8000-00000000a665', '00000000-0000-4000-8000-00000000a602', 'a06-pro-5');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a602';
do $$
begin
  perform pg_temp.check_eq((select premium::text from public.access_state()), 'false', 'F6: expired 1s ago is not premium');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a671', '00000000-0000-4000-8000-00000000a661', 'scored'), 'accepted', 'F6: lapsed member still has free rating 1');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a672', '00000000-0000-4000-8000-00000000a662', 'scored'), 'accepted', 'F6: lapsed member still has free rating 2');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a673', '00000000-0000-4000-8000-00000000a663', 'scored'), 'access.paywall_required', 'F6: lapsed member is refused the third');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a674', '00000000-0000-4000-8000-00000000a664', 'partial'), 'accepted', 'F6: lapsed member still gets a partial');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=1', 'F6: lapsed member at 2');
end $$;
reset role;
update public.billing_entitlements set expires_at = now() + interval '1 second', verified_at = now() + interval '1 millisecond'
where user_id = '00000000-0000-4000-8000-00000000a602';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a602';
do $$
begin
  perform pg_temp.check_eq((select premium::text from public.access_state()), 'true', 'F6: valid for 1 more second is premium');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a675', '00000000-0000-4000-8000-00000000a665', 'scored'), 'accepted', 'F6: a member is rated beyond the free allowance');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=3 identity=3 access=3 reserved=0', 'F6: the member''s count is exactly the scored rows');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a676', '00000000-0000-4000-8000-00000000a663', 'scored'), 'access.permit_not_reserved', 'F6: membership does not revive the permit closed as free_limit_exceeded');
end $$;
reset role;

select format('ATTACK 06 free rating conservation: %s assertions passed', pg_temp.assertions());
rollback;
