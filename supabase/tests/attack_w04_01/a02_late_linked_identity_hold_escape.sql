-- ATTACK A02 — replay / duplicate identity: the hold does not follow an
-- identity linked AFTER allocation.
--
-- identity_hashes is a snapshot taken at allocation. GoTrue links a second
-- provider identity (same verified e-mail) to the existing account without
-- any app code; the online ledger handles exactly this
-- (20260905000100_late_linked_identity_ledger.sql, J10/J11). The offline
-- ledger does not: after the account is deleted and re-created by signing in
-- with the late-linked identity only, offline_hold_count() is 0 while the
-- two tickets on the original installation are still outstanding — the same
-- human is issued two more (4 tickets against a 2-rating budget).
begin;
\ir _setup.sql

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
declare r record; g record;
begin
  select * into r from public.register_offline_device('e1-key', 'production', true);
  select * into g from public.issue_offline_grant('e1-key', 2);
  if g.result <> 'accepted' or array_length(g.ticket_ids, 1) <> 2 then
    raise exception 'A02 precondition: two tickets (got %, %)', g.result, g.ticket_ids;
  end if;
end $$;

-- The provider link lands after the allocation (GoTrue automatic linking).
select pg_temp.as_owner();
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'apple-sub-e1-linked', '00000000-0000-4000-8000-0000000000e1',
   '{"sub":"apple-sub-e1-linked","email":"e1@example.com"}');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-00000000e101');
do $$
begin
  if public.offline_hold_count() <> 2 then
    raise exception 'A02 precondition: the account still holds 2 (got %)', public.offline_hold_count();
  end if;
end $$;

-- Account deletion, then re-creation by signing in with the Apple identity.
select pg_temp.as_owner();
delete from auth.users where id = '00000000-0000-4000-8000-0000000000e1';
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-4000-8000-0000000000e9', 'e1@example.com', '{"full_name":"E1"}', '{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values
  ('apple', 'apple-sub-e1-linked', '00000000-0000-4000-8000-0000000000e9',
   '{"sub":"apple-sub-e1-linked","email":"e1@example.com"}');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-4000-8000-00000000e901', '00000000-0000-4000-8000-0000000000e9');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000e9', '00000000-0000-4000-8000-00000000e901');
do $$
declare r record; g record; held int; outstanding int;
begin
  held := public.offline_hold_count();
  select * into r from public.register_offline_device('e1-key-2', 'production', true);
  select * into g from public.issue_offline_grant('e1-key-2', 2);
  outstanding := pg_temp.tickets_ever('e1-key') + pg_temp.tickets_ever('e1-key-2');
  if outstanding > 2 then
    raise exception 'A02 BREAK: re-created account (late-linked identity only) sees hold = %, issue → % with % ticket(s); % tickets outstanding for one identity holder (2 on e1-key never consumed or released)',
      held, g.result, coalesce(array_length(g.ticket_ids, 1), 0), outstanding;
  end if;
  if held <> 2 or g.result <> 'access.paywall_required' then
    raise exception 'A02: the hold must follow every identity of the account (hold %, issue %)', held, g.result;
  end if;
end $$;
rollback;
