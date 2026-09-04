-- Candidate: the owner may UPDATE analysis_permits.status/outcome (needed by
-- the Edge finalize route). Nothing pins the transition, so a finalized permit
-- can be flipped back to 'reserved' and fed to apply_synced_shot() again.
-- Also: does the second scored shot bypass the lifetime free limit?
\echo '== 05: column grants on analysis_permits for authenticated =='
select column_name, privilege_type from information_schema.role_column_grants
where table_schema = 'public' and table_name = 'analysis_permits' and grantee = 'authenticated' order by 1, 2;
select tgname from pg_trigger where tgrelid = 'public.analysis_permits'::regclass and not tgisinternal;

insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now());

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select result, permit_id from public.reserve_analysis_permit('k1') \gset p1_
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-08-31T10:00:00Z')) as first_shot;
select status, outcome from public.analysis_permits where id = :'p1_permit_id';

\echo '== 05: owner flips the finalized permit back to reserved =='
update public.analysis_permits set status = 'reserved', outcome = null where id = :'p1_permit_id';
select status, outcome from public.analysis_permits where id = :'p1_permit_id';

\echo '== 05: reuse the same permit for a SECOND scored shot =='
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-08-31T10:01:00Z')) as second_shot_same_permit;
select count(*) as scored_shots, (select count(*) from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000000a') as permits
from public.shots where user_id = '00000000-0000-4000-8000-00000000000a' and result_kind = 'scored';

\echo '== 05: flip again — does the lifetime backstop stop a THIRD scored shot? =='
update public.analysis_permits set status = 'reserved', outcome = null where id = :'p1_permit_id';
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e3', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-08-31T10:02:00Z')) as third_shot_same_permit;
select count(*) as scored_shots_after_third_try from public.shots where user_id = '00000000-0000-4000-8000-00000000000a' and result_kind = 'scored';
select case when (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-00000000000a' and result_kind = 'scored') = 2
  then 'DEFECT_REPRODUCED 05: one permit -> two scored shots after owner reopened it (lifetime backstop still capped at 2)'
  when (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-00000000000a' and result_kind = 'scored') > 2
  then 'DEFECT_REPRODUCED 05: permit reuse ALSO bypassed the lifetime free limit'
  else 'HELD 05' end as verdict;

\echo '== 05b: owner sets an invalid status/outcome vocabulary? =='
update public.analysis_permits set status = 'bogus' where id = :'p1_permit_id';
rollback;
