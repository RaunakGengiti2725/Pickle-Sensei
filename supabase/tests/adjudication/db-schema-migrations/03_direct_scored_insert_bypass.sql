-- Candidate: authenticated holds INSERT on public.shots (and detail tables), so a
-- direct PostgREST insert records a scored shot with NO permit and past the
-- lifetime free limit — the permit gate lives only inside apply_synced_shot().
\echo '== 03: INSERT grants on shots / detail tables for authenticated =='
select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'authenticated'
  and table_name in ('shots', 'shot_phases', 'shot_checkpoints', 'shot_measurements', 'sessions')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'SELECT')
group by table_name order by table_name;
select policyname, cmd, with_check from pg_policies where schemaname = 'public' and tablename = 'shots' order by policyname;

\echo '== 03: alice exhausts both free ratings through the RPC path =='
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', now());
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select result, permit_id from public.reserve_analysis_permit('k1') \gset p1_
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e1', :'p1_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-08-31T10:00:00Z')) as first_shot;
select result, permit_id from public.reserve_analysis_permit('k2') \gset p2_
select public.apply_synced_shot(pg_temp.shot_payload('00000000-0000-4000-8000-0000000000e2', :'p2_permit_id',
  '00000000-0000-4000-8000-0000000000d1', 'scored', '2026-08-31T10:01:00Z')) as second_shot;
select result as third_reserve from public.reserve_analysis_permit('k3');
select (select premium from public.access_state()) as premium, public.lifetime_scored_count() as lifetime;

\echo '== 03: now a DIRECT insert of a third scored shot, no permit at all =='
select pg_temp.raw_shot('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-0000000000d1', 'scored', 9.9, now());
insert into public.shot_checkpoints (shot_id, user_id, checkpoint_key, score, confidence, band, direction, severity, applicable)
values ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-00000000000a', 'contact_position', 99, 0.9, 'green', 'ok', 0.1, true);
select count(*) filter (where result_kind = 'scored') as alice_scored_rows,
       (select count(*) from public.analysis_permits where user_id = '00000000-0000-4000-8000-00000000000a' and status = 'finalized') as finalized_permits
from public.shots where user_id = '00000000-0000-4000-8000-00000000000a';
select tier, rating from public.player_rank_state where user_id = '00000000-0000-4000-8000-00000000000a';
select case when (select count(*) from public.shots where user_id = '00000000-0000-4000-8000-00000000000a' and result_kind = 'scored') = 3
  then 'DEFECT_REPRODUCED 03: authenticated wrote a 3rd scored shot directly, no permit, past the free limit; rank recomputed'
  else 'HELD 03' end as verdict;
rollback;

\echo '== 03b: low_confidence shot with a non-null score (Edge rejects; DB accepts?) =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select pg_temp.raw_shot('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-0000000000d1', 'low_confidence', 9.9, now());
select case when exists (select 1 from public.shots where id = '00000000-0000-4000-8000-0000000000e4' and overall_score is not null)
  then 'DEFECT_REPRODUCED 03b: low_confidence row stored with overall_score=9.9 (no CHECK)'
  else 'HELD 03b' end as verdict;
rollback;
