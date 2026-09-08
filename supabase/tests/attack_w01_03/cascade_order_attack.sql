-- W01-03 attack: account deletion must still cascade the settled shot AND its
-- receipt regardless of the order in which Postgres fires the two
-- profiles→(shots | settlement_receipts) cascades. Expects the temp table
-- attack_fixture written by fixture_settled_shot.sql in the same session.
-- Fails (non-zero psql exit) when the deletion raises or leaves any row behind.
\set ON_ERROR_STOP on

do $attack$
declare
  v_user uuid := (select attack_user from attack_fixture);
  v_shot uuid := (select attack_shot from attack_fixture);
  v_state text;
  v_msg text;
begin
  begin
    delete from auth.users where id = v_user;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    raise exception 'ATTACK CONFIRMED: account deletion of a user with one settled shot raised % (%)',
      v_state, v_msg;
  end;
  if exists (select 1 from public.shots where id = v_shot)
     or exists (select 1 from public.settlement_receipts where shot_id = v_shot)
     or exists (select 1 from public.profiles where id = v_user) then
    raise exception 'ATTACK CONFIRMED: account deletion left the shot, receipt or profile behind';
  end if;
  raise notice 'account deletion cascaded shot % and its receipt', v_shot;
end
$attack$;
