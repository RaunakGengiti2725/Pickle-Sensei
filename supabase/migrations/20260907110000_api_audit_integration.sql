create or replace function api_private.enforce_permit_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at
     or not (
       (new.status = old.status and new.outcome is not distinct from old.outcome)
       or (old.status = 'reserved' and new.status in ('finalized', 'released'))
       or (old.status = 'released' and old.outcome = 'expired'
           and (new.status, new.outcome) in (
             ('finalized', 'scored'),
             ('released', 'low_confidence'),
             ('released', 'free_limit_exceeded')))
     ) then
    raise exception using errcode = 'check_violation',
      message = 'Invalid analysis permit transition',
      hint = 'access.permit_transition_rejected';
  end if;
  return new;
end;
$$;
revoke all on function api_private.enforce_permit_transition()
  from public, anon, authenticated, service_role;

create or replace function public.permit_tombstoned(p_permit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select api_private.is_api_request()) and exists (
    select 1 from public.analysis_permit_tombstones t
    where t.permit_id = p_permit_id and t.user_id = (select auth.uid())
  )
$$;
revoke all on function public.permit_tombstoned(uuid) from public, anon;
grant execute on function public.permit_tombstoned(uuid) to authenticated;

create function api_private.enforce_webhook_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'service_role' then
    if old.processed_at is not null then
      raise exception 'Completed webhook audit history is immutable'
        using errcode = 'insufficient_privilege';
    end if;
    if tg_op = 'UPDATE' then
      if (to_jsonb(new) - 'claimed_at' - 'processed_at')
           is distinct from (to_jsonb(old) - 'claimed_at' - 'processed_at')
         or (new.claimed_at is distinct from old.claimed_at and (
           old.claimed_at > now() - interval '5 minutes'
           or new.claimed_at <= old.claimed_at or new.processed_at is not null
         )) then
        raise exception 'Invalid webhook lifecycle transition'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function api_private.enforce_webhook_lifecycle()
  from public, anon, authenticated, service_role;
create trigger webhook_events_guard_lifecycle
  before update or delete on public.webhook_events
  for each row execute function api_private.enforce_webhook_lifecycle();

grant update (claimed_at, processed_at), delete on public.webhook_events to service_role;

notify pgrst, 'reload schema';
