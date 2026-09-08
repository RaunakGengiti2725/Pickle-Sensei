-- ATTACK 07 — replay and duplicate identities, interleaved account switch.
--
-- The free allowance follows the SIGN-IN IDENTITY (free_rating_ledger keyed
-- by sha256(provider:provider_id), no FK). Attacks:
--
--   I1  identity linked mid-flight: a fresh account holds two live permits
--       (count 0) and then links a Google identity that already spent both
--       ratings on an earlier account — every scored sync under the live
--       permits must now be refused, the permits close as
--       free_limit_exceeded, partials are still accepted, and the ledger
--       never exceeds 2 for any of the account's identities.
--   I2  additive identities: an account with 1 rating of its own links a
--       second identity carrying 1 — the count is max (1), not the sum (2);
--       one more rating is still allowed and both identities end at 2.
--   I3  identity re-use across accounts: the same (provider, provider_id)
--       cannot exist twice; deleting the account and linking the identity to
--       a new account carries the count; relinking a NEVER-rated identity
--       carries nothing.
--   I4  key discipline: the ledger key is exact-bytes — provider case,
--       subject case and a trailing space are DIFFERENT identities (no
--       silent merge), and the same bytes always map to the same row.
--   I5  cross-user shot id replay: user B syncs a shot id that user A owns —
--       nothing is written for B, A's row is untouched, B's permit is still
--       backing, B is not charged, and the reply tells B nothing about A.
--   I6  the ledger surfaces: anon/authenticated cannot read or write
--       free_rating_ledger, cannot call free_rating_identity_hash() or the
--       trigger functions; identity_scored_count() is caller-scoped
--       (authenticated: own count, anon: refused).
begin;
\ir _helpers.sql

create function pg_temp.sync(p_shot uuid, p_permit uuid, p_kind text) returns text
language plpgsql as $$
declare v text; s text; h text;
begin
  v := public.apply_synced_shot(pg_temp.n_shot(p_shot, p_permit, p_kind));
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

create function pg_temp.ledger(p_provider text, p_sub text) returns text
language sql security definer as $$
  select coalesce((select scored_count::text from public.free_rating_ledger
                   where identity_hash = public.free_rating_identity_hash(p_provider, p_sub)), 'NONE')
$$;

create function pg_temp.ledger_rows() returns text
language sql security definer as $$
  select count(*)::text from public.free_rating_ledger
$$;

create function pg_temp.mk_user(p_id uuid, p_provider text, p_sub text) returns void
language plpgsql security definer as $$
begin
  insert into auth.users (id, email, raw_app_meta_data)
  values (p_id, p_id::text || '@a07.example.test', jsonb_build_object('provider', p_provider));
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_sub, p_id, jsonb_build_object('sub', p_sub));
end $$;

create function pg_temp.link(p_id uuid, p_provider text, p_sub text) returns text
language plpgsql security definer as $$
declare s text; h text;
begin
  insert into auth.identities (provider, provider_id, user_id, identity_data)
  values (p_provider, p_sub, p_id, jsonb_build_object('sub', p_sub));
  return 'linked';
exception when others then
  get stacked diagnostics s = returned_sqlstate, h = pg_exception_hint;
  return s || ':' || coalesce(h, '');
end $$;

create function pg_temp.permit(p_id uuid, p_user uuid, p_key text) returns void
language sql security definer as $$
  insert into public.analysis_permits (id, user_id, idempotency_key) values (p_id, p_user, p_key)
$$;

grant execute on function pg_temp.sync(uuid, uuid, text), pg_temp.reserve(text), pg_temp.counts()
  to anon, authenticated;

-- --------------------------------------------------------------------------
-- Actor A spends both ratings on google-sub-a07-spent.
-- --------------------------------------------------------------------------
select pg_temp.mk_user('00000000-0000-4000-8000-00000000a701', 'google', 'google-sub-a07-spent');
select pg_temp.permit('00000000-0000-4000-8000-00000000a711', '00000000-0000-4000-8000-00000000a701', 'a07-a-1');
select pg_temp.permit('00000000-0000-4000-8000-00000000a712', '00000000-0000-4000-8000-00000000a701', 'a07-a-2');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a701';
do $$
begin
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7a1', '00000000-0000-4000-8000-00000000a711', 'scored'), 'accepted', 'setup: A rating 1');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7a2', '00000000-0000-4000-8000-00000000a712', 'scored'), 'accepted', 'setup: A rating 2');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'setup: A at 2');
end $$;
reset role;
do $$ begin perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-spent'), '2', 'setup: ledger 2'); end $$;

-- --------------------------------------------------------------------------
-- I1: fresh account B (apple) reserves two permits, then links A's identity.
-- --------------------------------------------------------------------------
select pg_temp.mk_user('00000000-0000-4000-8000-00000000a702', 'apple', 'apple-sub-a07-b');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a702';
do $$
declare r text;
begin
  r := pg_temp.reserve('a07-b-1');
  perform pg_temp.check(r like 'accepted/%', 'I1: B reserves 1 (got ' || r || ')');
  r := pg_temp.reserve('a07-b-2');
  perform pg_temp.check(r like 'accepted/%', 'I1: B reserves 2 (got ' || r || ')');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=0 identity=0 access=0 reserved=2', 'I1: B is a fresh account with two live holds');
end $$;
reset role;
-- the account switch: A's spent Google identity is linked to B (Supabase
-- "link identity" — the identities row appears while B's permits are live)
do $$
begin
  perform pg_temp.check_eq(pg_temp.link('00000000-0000-4000-8000-00000000a702', 'google', 'google-sub-a07-spent'), '23505:',
    'I1: an identity still bound to A cannot be linked to B (unique provider_id, provider)');
  delete from auth.users where id = '00000000-0000-4000-8000-00000000a701';
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-spent'), '2', 'I1: deleting A keeps the ledger at 2');
  perform pg_temp.check_eq(pg_temp.link('00000000-0000-4000-8000-00000000a702', 'google', 'google-sub-a07-spent'), 'linked', 'I1: after deletion the identity links to B');
  perform pg_temp.check_eq(pg_temp.ledger('apple', 'apple-sub-a07-b'), '2', 'I1: B''s own apple identity is raised to 2 at link time');
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a702';
do $$
declare p1 uuid; p2 uuid;
begin
  select id into p1 from public.analysis_permits where idempotency_key = 'a07-b-1';
  select id into p2 from public.analysis_permits where idempotency_key = 'a07-b-2';
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=2', 'I1: B now counts 2 with two live holds');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7b1', p1, 'scored'), 'access.paywall_required', 'I1: a live hold does not rate past the inherited limit');
  perform pg_temp.check_eq(pg_temp.r_permit(p1), 'released/free_limit_exceeded', 'I1: the hold closes as free_limit_exceeded');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a7b1'), 'MISSING', 'I1: no rating row');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7b2', p2, 'partial'), 'accepted', 'I1: a partial under the other hold is still accepted');
  perform pg_temp.check_eq(pg_temp.r_permit(p2), 'released/partial', 'I1: released/partial');
  perform pg_temp.check_eq(pg_temp.reserve('a07-b-3'), 'access.paywall_required/NULL', 'I1: no new hold');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'I1: B pinned at 2');
end $$;
reset role;
do $$
begin
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-spent'), '2', 'I1: google ledger still 2');
  perform pg_temp.check_eq(pg_temp.ledger('apple', 'apple-sub-a07-b'), '2', 'I1: apple ledger still 2 (refusals and partials write nothing)');
end $$;

-- --------------------------------------------------------------------------
-- I2: additive identities — max, not sum.
-- --------------------------------------------------------------------------
select pg_temp.mk_user('00000000-0000-4000-8000-00000000a703', 'apple', 'apple-sub-a07-c');
select pg_temp.mk_user('00000000-0000-4000-8000-00000000a704', 'google', 'google-sub-a07-d');
select pg_temp.permit('00000000-0000-4000-8000-00000000a731', '00000000-0000-4000-8000-00000000a703', 'a07-c-1');
select pg_temp.permit('00000000-0000-4000-8000-00000000a732', '00000000-0000-4000-8000-00000000a703', 'a07-c-2');
select pg_temp.permit('00000000-0000-4000-8000-00000000a733', '00000000-0000-4000-8000-00000000a703', 'a07-c-3');
select pg_temp.permit('00000000-0000-4000-8000-00000000a741', '00000000-0000-4000-8000-00000000a704', 'a07-d-1');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a703';
do $$ begin
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7c1', '00000000-0000-4000-8000-00000000a731', 'scored'), 'accepted', 'I2: C rating 1');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=1 identity=1 access=1 reserved=2', 'I2: C at 1');
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a704';
do $$ begin
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7d1', '00000000-0000-4000-8000-00000000a741', 'scored'), 'accepted', 'I2: D rating 1');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=1 identity=1 access=1 reserved=0', 'I2: D at 1');
end $$;
reset role;
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-00000000a704';
  perform pg_temp.check_eq(pg_temp.link('00000000-0000-4000-8000-00000000a703', 'google', 'google-sub-a07-d'), 'linked', 'I2: D''s identity (1) joins C (1)');
  perform pg_temp.check_eq(pg_temp.ledger('apple', 'apple-sub-a07-c'), '1', 'I2: apple ledger stays 1 (max, not 2)');
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-d'), '1', 'I2: google ledger stays 1');
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a703';
do $$ begin
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=1 identity=1 access=1 reserved=2', 'I2: C still counts 1 (1+1 is not 2)');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7c2', '00000000-0000-4000-8000-00000000a732', 'scored'), 'accepted', 'I2: C rating 2 allowed');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7c3', '00000000-0000-4000-8000-00000000a733', 'scored'), 'access.paywall_required', 'I2: C rating 3 refused');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'I2: C at 2');
end $$;
reset role;
do $$
begin
  perform pg_temp.check_eq(pg_temp.ledger('apple', 'apple-sub-a07-c'), '2', 'I2: every identity of C is stamped 2');
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-d'), '2', 'I2: including the inherited one');
end $$;

-- --------------------------------------------------------------------------
-- I3: identity re-use across accounts.
-- --------------------------------------------------------------------------
do $$
declare before_rows text;
begin
  perform pg_temp.check_eq(pg_temp.link('00000000-0000-4000-8000-00000000a702', 'apple', 'apple-sub-a07-c'), '23505:', 'I3: a bound identity cannot be duplicated onto another account');
  delete from auth.users where id = '00000000-0000-4000-8000-00000000a703';
  perform pg_temp.check_eq(pg_temp.ledger('apple', 'apple-sub-a07-c'), '2', 'I3: ledger outlives C');
  -- E: brand-new account, links C's apple identity → 2; also links a never-rated identity → also 2
  perform pg_temp.mk_user('00000000-0000-4000-8000-00000000a705', 'apple', 'apple-sub-a07-c');
  perform pg_temp.check_eq(pg_temp.ledger('apple', 'apple-sub-a07-c'), '2', 'I3: relinking the spent identity keeps 2');
  before_rows := pg_temp.ledger_rows();
  perform pg_temp.check_eq(pg_temp.link('00000000-0000-4000-8000-00000000a705', 'google', 'google-sub-a07-never'), 'linked', 'I3: E links a never-rated identity');
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-never'), '2', 'I3: the never-rated identity inherits E''s 2 immediately (no fresh start via it later)');
  perform pg_temp.check_eq(pg_temp.ledger_rows(), (before_rows::int + 1)::text, 'I3: exactly one ledger row added');
  -- F: brand-new account with only a never-rated identity → nothing inherited
  perform pg_temp.mk_user('00000000-0000-4000-8000-00000000a706', 'google', 'google-sub-a07-fresh');
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-fresh'), 'NONE', 'I3: a fresh identity writes no ledger row');
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a705';
do $$ begin
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'I3: E inherits 2');
  perform pg_temp.check_eq(pg_temp.reserve('a07-e-1'), 'access.paywall_required/NULL', 'I3: E cannot reserve');
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a706';
do $$ begin
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=0 identity=0 access=0 reserved=0', 'I3: F starts at 0');
end $$;
reset role;
-- the never-rated identity is moved to a new account after E is deleted: it carries E's 2
do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-00000000a705';
  perform pg_temp.mk_user('00000000-0000-4000-8000-00000000a707', 'google', 'google-sub-a07-never');
end $$;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a707';
do $$ begin
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=2 identity=2 access=2 reserved=0', 'I3: the identity linked after the spend carries the spend');
end $$;
reset role;

-- --------------------------------------------------------------------------
-- I4: key discipline.
-- --------------------------------------------------------------------------
do $$
declare h1 text; h2 text;
begin
  h1 := public.free_rating_identity_hash('google', 'google-sub-a07-spent');
  h2 := public.free_rating_identity_hash('google', 'google-sub-a07-spent');
  perform pg_temp.check(h1 = h2 and h1 ~ '^[0-9a-f]{64}$', 'I4: deterministic 64-hex key');
  perform pg_temp.check(h1 <> public.free_rating_identity_hash('Google', 'google-sub-a07-spent'), 'I4: provider case is significant');
  perform pg_temp.check(h1 <> public.free_rating_identity_hash('google', 'Google-Sub-A07-Spent'), 'I4: subject case is significant');
  perform pg_temp.check(h1 <> public.free_rating_identity_hash('google', 'google-sub-a07-spent '), 'I4: a trailing space is a different key');
  perform pg_temp.check(h1 <> public.free_rating_identity_hash('googl', 'e:google-sub-a07-spent'), 'I4: shifting bytes across the separator is a different key');
  perform pg_temp.check_eq(pg_temp.ledger('Google', 'google-sub-a07-spent'), 'NONE', 'I4: a case-variant identity has no ledger row of its own');
  perform pg_temp.check_eq(pg_temp.ledger('google', 'google-sub-a07-spent '), 'NONE', 'I4: nor a padded one');
end $$;

-- --------------------------------------------------------------------------
-- I5: cross-user shot id replay.
-- --------------------------------------------------------------------------
select pg_temp.permit('00000000-0000-4000-8000-00000000a761', '00000000-0000-4000-8000-00000000a706', 'a07-f-1');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a706';
do $$
declare r text;
begin
  -- 'a7c2' is C's scored row (C is deleted, its shots cascaded); 'a7b2' is B's live partial row
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a7b2'), 'MISSING', 'I5: F cannot see B''s row');
  r := pg_temp.sync('00000000-0000-4000-8000-00000000a7b2', '00000000-0000-4000-8000-00000000a761', 'scored');
  perform pg_temp.check(r <> 'accepted', 'I5: a foreign shot id is not accepted as F''s (got ' || r || ')');
  perform pg_temp.check(r not like '%a702%' and r not like '%apple-sub%' and r not like '%google-sub%', 'I5: the reply names no other user (got ' || r || ')');
  perform pg_temp.check_eq(pg_temp.s_shot('00000000-0000-4000-8000-00000000a7b2'), 'MISSING', 'I5: still nothing visible to F');
  perform pg_temp.check_eq(pg_temp.r_permit('00000000-0000-4000-8000-00000000a761'), 'reserved/NULL', 'I5: F''s permit still backs a clean retry');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=0 identity=0 access=0 reserved=1', 'I5: F not charged');
  perform pg_temp.check_eq(pg_temp.sync('00000000-0000-4000-8000-00000000a7f1', '00000000-0000-4000-8000-00000000a761', 'scored'), 'accepted', 'I5: the clean retry under a fresh id is accepted');
  perform pg_temp.check_eq(pg_temp.counts(), 'lifetime=1 identity=1 access=1 reserved=0', 'I5: F charged exactly once');
end $$;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a702';
do $$ begin
  perform pg_temp.check(pg_temp.s_shot('00000000-0000-4000-8000-00000000a7b2') like 'partial/NULL/%', 'I5: B''s row is untouched');
  perform pg_temp.check_eq((select user_id::text from public.shots where id = '00000000-0000-4000-8000-00000000a7b2'), '00000000-0000-4000-8000-00000000a702', 'I5: and still B''s');
end $$;
reset role;

-- --------------------------------------------------------------------------
-- I6: ledger surfaces per role.
-- --------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000a702';
do $$
declare r text;
begin
  perform pg_temp.check_eq(pg_temp.q_scalar('select count(*)::text from public.free_rating_ledger'), '42501:', 'I6: authenticated cannot read the ledger');
  perform pg_temp.check_eq(pg_temp.q_try('insert into public.free_rating_ledger (identity_hash, scored_count) values (repeat(''0'', 64), 0)'), '42501:', 'I6: authenticated cannot write the ledger');
  perform pg_temp.check_eq(pg_temp.q_try('update public.free_rating_ledger set scored_count = 0'), '42501:', 'I6: authenticated cannot reset the ledger');
  perform pg_temp.check_eq(pg_temp.q_try('delete from public.free_rating_ledger'), '42501:', 'I6: authenticated cannot delete the ledger');
  perform pg_temp.check_eq(pg_temp.q_scalar('select public.free_rating_identity_hash(''google'', ''x'')'), '42501:', 'I6: authenticated cannot compute ledger keys');
  perform pg_temp.check_eq(pg_temp.q_scalar('select public.identity_scored_count()::text'), '2', 'I6: authenticated reads its own identity count');
  r := pg_temp.q_scalar('select public.inherit_free_rating_ledger()::text');
  perform pg_temp.check(r like '42501%' or r like '0A000%' or r like '42883%', 'I6: the identity trigger function is not client-callable (got ' || r || ')');
end $$;
set local role anon;
set local request.jwt.claim.sub = '';
do $$
begin
  perform pg_temp.check_eq(pg_temp.q_scalar('select count(*)::text from public.free_rating_ledger'), '42501:', 'I6: anon cannot read the ledger');
  perform pg_temp.check_eq(pg_temp.q_scalar('select public.identity_scored_count()::text'), '42501:', 'I6: anon cannot call identity_scored_count');
  perform pg_temp.check_eq(pg_temp.q_scalar('select public.lifetime_scored_count()::text'), '42501:', 'I6: anon cannot call lifetime_scored_count');
  perform pg_temp.check_eq(pg_temp.q_scalar('select public.free_rating_identity_hash(''google'', ''x'')'), '42501:', 'I6: anon cannot compute ledger keys');
end $$;
reset role;

select format('ATTACK 07 identity replay: %s assertions passed', pg_temp.assertions());
rollback;
