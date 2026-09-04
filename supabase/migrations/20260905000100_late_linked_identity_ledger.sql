-- ============================================================================
-- Pickle Sensei — late-linked identities inherit the free-rating ledger (DB-01).
--
-- THE HOLE. 20260902150000 writes public.free_rating_ledger from the scored-
-- shot trigger, for every auth.identities row the user has AT THAT MOMENT.
-- An identity linked afterwards — GoTrue auto-links a Google sign-in to an
-- existing Apple account with the same verified email, and linkIdentity()
-- does it explicitly — got no ledger row. Delete the account, sign in again
-- with ONLY that later identity, and lifetime_scored_count() was back to
-- zero: two fresh free ratings through the very flow the ledger exists to
-- close. Reproduced: alice (google) spends both ratings; an apple identity
-- is linked; the account is deleted; a new account holding only the apple
-- identity reserves a permit successfully.
--
-- THE FIX. An AFTER INSERT trigger on auth.identities brings EVERY identity
-- of the user up to the user's lifetime count the moment one is linked:
--   count = greatest(user's scored shots, max ledger over the user's
--                    identities — including the new one, which may itself
--                    arrive carrying history from an earlier account)
-- and writes it for all of the user's identities (only when > 0, so a new
-- user's first identity leaves no row — J6 still holds). Nothing ever
-- decrements. The same "linked identities stay in step" rule the scored-shot
-- trigger applies, now also at link time. The backfill below applies the
-- rule to every account that exists today.
--
-- Definer, like handle_new_user() on auth.users: GoTrue (supabase_auth_admin)
-- performs the INSERT and holds no grant on the ledger or on public.shots.
-- Static pin: __wf__/db_migrations_rls_indexes.test.ts. Live: security
-- regression matrix J10–J11.
-- New file only — applied migrations are never edited.
-- ============================================================================

create or replace function public.inherit_free_rating_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  select greatest(
    (
      select count(*)::int from public.shots s
      where s.user_id = new.user_id and s.result_kind = 'scored'
    ),
    coalesce((
      select max(l.scored_count)
      from auth.identities i
      join public.free_rating_ledger l
        on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = new.user_id
    ), 0)
  ) into v_count;

  if v_count > 0 then
    insert into public.free_rating_ledger as led (identity_hash, scored_count)
    select public.free_rating_identity_hash(i.provider, i.provider_id), v_count
    from auth.identities i
    where i.user_id = new.user_id
    on conflict (identity_hash) do update
      set scored_count = greatest(led.scored_count, excluded.scored_count),
          updated_at = now();
  end if;

  return new;
end;
$$;

comment on function public.inherit_free_rating_ledger() is
  'AFTER INSERT on auth.identities: every identity of the user is raised to the user''s lifetime scored count (own scored shots or the highest ledger among its identities), so an identity linked after the free ratings were spent cannot start over after account deletion. Never decrements.';

revoke execute on function public.inherit_free_rating_ledger()
  from public, anon, authenticated;

drop trigger if exists on_auth_identity_linked on auth.identities;
create trigger on_auth_identity_linked
  after insert on auth.identities
  for each row execute function public.inherit_free_rating_ledger();

-- ---------------------------------------------------------------------------
-- Backfill: accounts whose identities were linked at different times may hold
-- ledger rows at different counts (or none). Bring each account's identities
-- up to its lifetime count. Idempotent (greatest); rows never move down.
-- ---------------------------------------------------------------------------
with per_user as (
  select
    i.user_id,
    greatest(
      coalesce((
        select count(*)::int from public.shots s
        where s.user_id = i.user_id and s.result_kind = 'scored'
      ), 0),
      coalesce(max(l.scored_count), 0)
    ) as lifetime
  from auth.identities i
  left join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  group by i.user_id
)
insert into public.free_rating_ledger as led (identity_hash, scored_count)
select public.free_rating_identity_hash(i.provider, i.provider_id), u.lifetime
from per_user u
join auth.identities i on i.user_id = u.user_id
where u.lifetime > 0
on conflict (identity_hash) do update
  set scored_count = greatest(led.scored_count, excluded.scored_count),
      updated_at = now();
