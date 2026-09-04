-- P05 — free_rating_ledger keeps every linked identity "in step".
--
-- Suspect: 20260902150000_free_rating_identity_ledger.sql:158-177 writes the
-- ledger only inside the scored-shot INSERT trigger, for identities linked at
-- that moment. An identity linked AFTER the user's scored shots gets no row
-- until the next scored insert (which the 2-rating cap may never allow), so
-- deleting the account and signing back in with only that identity restarts
-- at zero — the exact reset the migration exists to prevent. The migration's
-- own comment (:143-147) promises linked identities "stay in step".
\set ON_ERROR_STOP on
begin;
\i /probes/_seed.psql

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select permit_id as p1 from public.reserve_analysis_permit('key-1') \gset
select permit_id as p2 from public.reserve_analysis_permit('key-2') \gset
select pg_temp.check('alice: scored shot 1 accepted',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1', 'scored', 7.1)) = 'accepted');
select pg_temp.check('alice: scored shot 2 accepted',
  public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', :'p2', 'scored', 6.9)) = 'accepted');
select pg_temp.check('alice: lifetime_scored_count = 2', public.lifetime_scored_count() = 2);
select pg_temp.check('alice: third reservation refused (access.paywall_required)',
  (select result from public.reserve_analysis_permit('key-3')) = 'access.paywall_required');

-- Alice now links Apple to the same account (GoTrue linkIdentity / manual link).
reset role;
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'a-alice', '00000000-0000-4000-8000-00000000000a', '{}');

select pg_temp.check('ledger row exists for the late-linked apple identity',
  exists (select 1 from public.free_rating_ledger
          where identity_hash = public.free_rating_identity_hash('apple', 'a-alice')));
select pg_temp.check('late-linked apple identity is in step with google (scored_count = 2)',
  (select scored_count from public.free_rating_ledger
   where identity_hash = public.free_rating_identity_hash('apple', 'a-alice')) = 2);

-- Account deletion, then a fresh sign-in with ONLY the Apple identity.
delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000c', 'alice2@example.com', '{}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'a-alice', '00000000-0000-4000-8000-00000000000c', '{}');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
select pg_temp.check('re-signed-in apple identity still counts 2 lifetime scored ratings → got ' || public.lifetime_scored_count(),
  public.lifetime_scored_count() = 2);
select pg_temp.check('re-signed-in apple identity cannot reserve a free permit → ' || (select result from public.reserve_analysis_permit('key-4')),
  (select result from public.reserve_analysis_permit('key-4')) = 'access.paywall_required');

-- Control: the Google identity (linked at write time) DOES carry over.
reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000d', 'alice3@example.com', '{}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'g-alice', '00000000-0000-4000-8000-00000000000d', '{}');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000d';
select pg_temp.check('control: re-signed-in google identity counts 2', public.lifetime_scored_count() = 2);

select pg_temp.finish();
rollback;
