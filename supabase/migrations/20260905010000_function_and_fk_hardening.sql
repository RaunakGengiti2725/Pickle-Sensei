begin;

set local lock_timeout = '10s';

alter function public.set_updated_at() set search_path = '';
alter function public.player_rank_tier(numeric) set search_path = '';
alter function public.complete_onboarding() set search_path = '';

do $$
begin
  if pg_catalog.to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

create index if not exists account_deletion_feedback_user_idx
  on public.account_deletion_feedback (user_id);
create index if not exists captures_session_id_idx
  on public.captures (session_id);
create index if not exists captures_shot_id_idx
  on public.captures (shot_id);

commit;
