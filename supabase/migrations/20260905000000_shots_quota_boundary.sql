begin;

set local lock_timeout = '10s';

create or replace function public.record_scored_shot_in_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next integer;
begin
  if new.result_kind <> 'scored'
     or (tg_op = 'UPDATE' and old.result_kind = 'scored') then
    return new;
  end if;

  if tg_when = 'BEFORE' then
    perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(new.user_id));
    return new;
  end if;

  select coalesce(max(l.scored_count), 0) + 1 into v_next
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = new.user_id;

  if not coalesce((
    select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b
    where b.user_id = new.user_id
  ), false) and (
    v_next > 2 or (
      select count(*) from public.shots s
      where s.user_id = new.user_id and s.result_kind = 'scored'
    ) > 2
  ) then
    raise exception using
      errcode = '23514',
      message = 'access.paywall_required',
      constraint = 'shots_free_rating_quota';
  end if;

  insert into public.free_rating_ledger as led (identity_hash, scored_count)
  select public.free_rating_identity_hash(i.provider, i.provider_id), v_next
  from auth.identities i
  where i.user_id = new.user_id
  on conflict (identity_hash) do update
    set scored_count = greatest(led.scored_count + 1, excluded.scored_count),
        updated_at = now();

  return new;
end;
$$;

revoke execute on function public.record_scored_shot_in_ledger()
  from public, anon, authenticated;

create trigger shots_serialize_free_rating_quota
  before insert or update of result_kind on public.shots
  for each row execute function public.record_scored_shot_in_ledger();

commit;
