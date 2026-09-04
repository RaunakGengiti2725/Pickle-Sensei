-- Candidate: an identity linked AFTER the free ratings were spent gets no
-- ledger row, so delete-account + sign-in with only that identity resets the
-- lifetime free-rating count to zero.
\echo '== 02: alice (google) spends both free ratings via the RPCs =='
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now());
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select result, permit_id from public.reserve_analysis_permit('k1') \gset p1_
select public.apply_synced_shot(pg_temp.shot_payload(
  '00000000-0000-4000-8000-0000000000e1', :'p1_permit_id', '00000000-0000-4000-8000-0000000000d1',
  'scored', '2026-08-31T10:00:00Z')) as first_shot;
select result, permit_id from public.reserve_analysis_permit('k2') \gset p2_
select public.apply_synced_shot(pg_temp.shot_payload(
  '00000000-0000-4000-8000-0000000000e2', :'p2_permit_id', '00000000-0000-4000-8000-0000000000d1',
  'scored', '2026-08-31T10:01:00Z')) as second_shot;
select result as third_reserve_should_be_paywall from public.reserve_analysis_permit('k3');
select public.lifetime_scored_count() as alice_lifetime;
commit;

\echo '== 02: ledger rows after two scored shots (only the google identity) =='
select identity_hash, scored_count from public.free_rating_ledger;

\echo '== 02: alice links an Apple identity AFTER spending the ratings (GoTrue linkIdentity) =='
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-alice', '00000000-0000-4000-8000-00000000000a',
        '{"sub":"apple-sub-alice","email":"alice@privaterelay.appleid.com"}');
select exists (select 1 from public.free_rating_ledger
  where identity_hash = public.free_rating_identity_hash('apple', 'apple-sub-alice')) as apple_identity_has_ledger_row;

\echo '== 02: alice deletes her account (auth.users cascade), signs in again with ONLY the Apple identity =='
delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000c', 'alice@privaterelay.appleid.com',
        '{"full_name":"Alice"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('apple', 'apple-sub-alice', '00000000-0000-4000-8000-00000000000c',
        '{"sub":"apple-sub-alice"}');
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000c';
select public.lifetime_scored_count() as new_account_lifetime_count;
select result as reserve_after_delete from public.reserve_analysis_permit('k4');
select case when (select result from public.reserve_analysis_permit('k4')) = 'accepted'
  then 'DEFECT_REPRODUCED 02: late-linked Apple identity carries no ledger row; free ratings reset after deletion'
  else 'HELD 02' end as verdict;
commit;

\echo '== 02-control: same flow with the identity that WAS present when the shots were scored =='
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-4000-8000-00000000000d', 'alice@example.com',
        '{"full_name":"Alice"}', '{"provider":"google"}');
insert into auth.identities (provider, provider_id, user_id, identity_data)
values ('google', 'google-sub-alice', '00000000-0000-4000-8000-00000000000d', '{"sub":"google-sub-alice"}');
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000d';
select public.lifetime_scored_count() as google_reacreated_lifetime_count;
select result as reserve_google_recreated from public.reserve_analysis_permit('k5');
commit;
