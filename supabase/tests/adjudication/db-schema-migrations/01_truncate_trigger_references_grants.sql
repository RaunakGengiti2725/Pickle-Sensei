-- Candidate: authenticated/anon keep TRUNCATE / TRIGGER / REFERENCES on public
-- user-data tables; TRUNCATE ignores RLS so an authenticated caller can wipe
-- every user's rows.
\echo '== 01: TRUNCATE/TRIGGER/REFERENCES grants held by client roles =='
select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
group by grantee, table_name
order by grantee, table_name;

\echo '== 01: seed bob with a shot, then alice TRUNCATEs shots CASCADE as authenticated =='
insert into public.sessions (id, user_id, started_at)
values ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-00000000000b', now());
select pg_temp.raw_shot('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-0000000000d2', 'scored', 6.0, now());
select count(*) as bob_shots_before from public.shots where user_id = '00000000-0000-4000-8000-00000000000b';

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
select current_user, (select count(*) from public.shots) as visible_to_alice_via_rls;
truncate table public.shots cascade;
reset role;
select count(*) as bob_shots_after_alice_truncate from public.shots where user_id = '00000000-0000-4000-8000-00000000000b';
select case when (select count(*) from public.shots) = 0
  then 'DEFECT_REPRODUCED 01: authenticated TRUNCATE wiped another user''s shots (RLS bypassed)'
  else 'HELD 01' end as verdict;
rollback;

\echo '== 01b: authenticated can CREATE TRIGGER on public.shots (TRIGGER privilege) =='
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-00000000000a';
create or replace function pg_temp.noop_trg() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger adj_probe_trg before insert on public.shots for each row execute function pg_temp.noop_trg();
select case when exists (select 1 from pg_trigger where tgname = 'adj_probe_trg')
  then 'DEFECT_REPRODUCED 01b: authenticated created a trigger on public.shots'
  else 'HELD 01b' end as verdict;
rollback;
