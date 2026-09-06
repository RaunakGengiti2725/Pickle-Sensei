alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke all on functions from public, anon, authenticated;

revoke create on schema public from public, anon, authenticated;
revoke all on all tables in schema public from public, anon;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.access_lock_key(uuid), public.access_state(), public.apply_synced_shot(jsonb),
  public.complete_onboarding(), public.identity_scored_count(), public.lifetime_scored_count(),
  public.reserve_analysis_permit(text)
  to authenticated;

do $$
begin
  if current_setting('server_version_num')::integer >= 170000 then
    execute 'revoke maintain on all tables in schema public from authenticated';
  end if;
end $$;

alter function public.set_updated_at() set search_path = '';
alter function public.player_rank_tier(numeric) set search_path = '';
alter function public.complete_onboarding() set search_path = '';

revoke delete on public.sessions, public.analysis_permits, public.account_deletion_requests
  from authenticated;
revoke insert, update, delete on public.captures from authenticated;
revoke insert on public.shot_measurements from authenticated;
revoke update on public.user_saved_drills from authenticated;
grant usage on schema public to service_role;
grant select, insert, update on public.billing_entitlements, public.account_external_credentials
  to service_role;
grant select, insert on public.webhook_events to service_role;
revoke update, delete on public.webhook_events from service_role;
revoke delete on public.billing_entitlements, public.account_external_credentials from service_role;
revoke insert, update, delete on public.progress_daily, public.practice_days,
  public.player_technique_rating from authenticated;
alter view public.progress_daily set (security_invoker = true);
alter view public.practice_days set (security_invoker = true);
alter view public.player_technique_rating set (security_invoker = true);
drop policy if exists sessions_delete_own on public.sessions;
drop policy if exists analysis_permits_delete_own on public.analysis_permits;
drop policy if exists deletion_requests_delete_own on public.account_deletion_requests;
drop policy if exists captures_insert_own on public.captures;
drop policy if exists captures_update_own on public.captures;
drop policy if exists captures_delete_own on public.captures;
drop policy if exists shot_measurements_insert_own on public.shot_measurements;
drop policy if exists user_saved_drills_update_own on public.user_saved_drills;
drop policy if exists shots_update_own on public.shots;
drop policy if exists shot_phases_update_own on public.shot_phases;
drop policy if exists shot_phases_delete_own on public.shot_phases;
drop policy if exists shot_measurements_update_own on public.shot_measurements;
drop policy if exists shot_measurements_delete_own on public.shot_measurements;
drop policy if exists shot_checkpoints_update_own on public.shot_checkpoints;
drop policy if exists shot_checkpoints_delete_own on public.shot_checkpoints;

create schema if not exists api_private;
revoke all on schema api_private from public, anon, authenticated, service_role;
grant usage on schema api_private to authenticated;

create table api_private.request_key (
  singleton boolean primary key default true check (singleton),
  secret text not null
    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
    check (secret ~ '^[0-9a-f]{64}$')
);
alter table api_private.request_key enable row level security;
revoke all on api_private.request_key from public, anon, authenticated, service_role;
insert into api_private.request_key (singleton) values (true);

create function public.get_api_request_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select secret from api_private.request_key where singleton
$$;
revoke all on function public.get_api_request_key() from public, anon, authenticated;
grant execute on function public.get_api_request_key() to service_role;

create function api_private.is_api_request()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from api_private.request_key k
    where k.singleton
      and sha256(convert_to(k.secret, 'UTF8')) = sha256(convert_to(
        coalesce(nullif(current_setting('request.headers', true), '')::jsonb
          ->> 'x-pickle-api-key', ''), 'UTF8'
      ))
  )
$$;
revoke all on function api_private.is_api_request() from public, anon, service_role;
grant execute on function api_private.is_api_request() to authenticated;

create function api_private.is_active_session()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_session_id uuid;
begin
  if not api_private.is_api_request() then
    raise exception 'API request authorization required' using errcode = 'insufficient_privilege';
  end if;
  v_session_id := (nullif(current_setting('request.jwt.claims', true), '')::jsonb
    ->> 'session_id')::uuid;
  return exists (
    select 1
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = v_session_id and s.user_id = (select auth.uid())
      and (s.not_after is null or s.not_after > now())
      and (u.banned_until is null or u.banned_until <= now())
  );
exception when invalid_text_representation then
  return false;
end;
$$;
revoke all on function api_private.is_active_session() from public, anon, service_role;
grant execute on function api_private.is_active_session() to authenticated;

create function public.is_api_session_active()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select api_private.is_active_session()
$$;
revoke all on function public.is_api_session_active() from public, anon;
grant execute on function public.is_api_session_active() to authenticated;

do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (
        has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        or has_any_column_privilege('authenticated', c.oid, 'INSERT,UPDATE')
      )
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format(
      'create policy api_requests_only on public.%I as restrictive for all to authenticated
       using ((select api_private.is_api_request()))
       with check ((select api_private.is_api_request()))',
      t.relname
    );
  end loop;
end $$;

create policy shots_session_owned on public.shots as restrictive for insert to authenticated
  with check (session_id is null or exists (
    select 1 from public.sessions s
    where s.id = shots.session_id and s.user_id = (select auth.uid())
  ));
create policy shot_phases_parent_owned on public.shot_phases as restrictive for insert to authenticated
  with check (exists (
    select 1 from public.shots s
    where s.id = shot_phases.shot_id and s.user_id = (select auth.uid())
  ));
create policy shot_checkpoints_parent_owned on public.shot_checkpoints as restrictive for insert to authenticated
  with check (exists (
    select 1 from public.shots s
    where s.id = shot_checkpoints.shot_id and s.user_id = (select auth.uid())
  ));

create function api_private.enforce_permit_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status <> 'reserved' or new.status not in ('finalized', 'released')
     or new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'Invalid analysis permit transition' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
revoke all on function api_private.enforce_permit_transition()
  from public, anon, authenticated, service_role;
create trigger analysis_permits_state_machine
  before update on public.analysis_permits
  for each row execute function api_private.enforce_permit_transition();

create or replace function public.identity_scored_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(l.scored_count), 0)::int
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = (select auth.uid())
    and (select api_private.is_api_request())
$$;
revoke all on function public.identity_scored_count() from public, anon;
grant execute on function public.identity_scored_count() to authenticated;

create index if not exists account_deletion_feedback_user_idx
  on public.account_deletion_feedback (user_id);
create index if not exists captures_session_idx on public.captures (session_id);
create index if not exists captures_shot_idx on public.captures (shot_id);

notify pgrst, 'reload schema';
