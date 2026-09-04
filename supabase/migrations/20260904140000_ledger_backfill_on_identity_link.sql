-- ============================================================================
-- Free-rating ledger: an identity linked AFTER the ratings were spent must
-- inherit the account's history at link time.
--
-- THE HOLE. record_scored_shot_in_ledger() (20260902150000) writes the ledger
-- for every identity the user has AT THE MOMENT a scored shot is inserted.
-- Nothing wrote the ledger when an identity arrived later: sign in with
-- Google, spend both free ratings, link Apple (GoTrue linkIdentity = an INSERT
-- into auth.identities), delete the account, sign in again with ONLY the
-- Apple ID → the Apple hash has no ledger row, lifetime_scored_count() = 0,
-- two fresh free ratings. AGENTS.md promises "every identity of the user"
-- carries the count; the late-linked one did not.
--
-- THE FIX. A definer AFTER INSERT trigger on auth.identities upserts the new
-- identity's ledger row to
--
--     greatest(its existing count, max count of the user's OTHER identities)
--
-- so linking carries the account's history onto the new identity, an identity
-- that arrives with a HIGHER history keeps it (the scored-shot trigger then
-- pulls the others up on the next rating, exactly as before), and linking a
-- zero-history identity to a zero-history account writes nothing. Nothing is
-- ever lowered and nothing is ever decremented. The account-deletion cascade
-- deletes auth.identities rows; this trigger does not listen to DELETE, so
-- the rows written here outlive the account like every other ledger row.
--
-- WHY A TRIGGER ON auth.identities. It is the one path every link takes —
-- GoTrue's linkIdentity, its first sign-in (auth.users then auth.identities
-- in the same transaction; on_auth_user_created already hangs off auth.users
-- the same way), and any admin-side identity repair — so the ledger stays
-- complete without an Edge-side hook that a client could skip. auth.users
-- triggers are the supported extension point on hosted Supabase; the
-- identities table sits beside it in the same schema with the same grants.
-- SECURITY DEFINER because the inserting role (supabase_auth_admin) has no
-- grant on public.free_rating_ledger. Not client-executable.
--
-- Applied migrations are untouched. Pinned live by security_regression.sql
-- J10/J11 and statically by __wf__/db_migrations_rls_indexes.test.ts.
-- ============================================================================

create or replace function public.sync_free_rating_ledger_on_identity_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := public.free_rating_identity_hash(new.provider, new.provider_id);
  v_inherited integer;
begin
  select coalesce(max(l.scored_count), 0) into v_inherited
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = new.user_id
    and i.id <> new.id;

  if v_inherited > 0 then
    insert into public.free_rating_ledger as led (identity_hash, scored_count)
    values (v_hash, v_inherited)
    on conflict (identity_hash) do update
      set scored_count = greatest(led.scored_count, excluded.scored_count),
          updated_at = now();
  end if;

  return new;
end;
$$;

comment on function public.sync_free_rating_ledger_on_identity_link() is
  'AFTER INSERT on auth.identities: the linked identity''s free_rating_ledger row becomes greatest(its own count, the identity-max of the user''s other identities). Keeps the ledger complete for identities linked after ratings were spent; never lowers a count.';

revoke execute on function public.sync_free_rating_ledger_on_identity_link()
  from public, anon, authenticated;

drop trigger if exists identities_sync_free_rating_ledger on auth.identities;
create trigger identities_sync_free_rating_ledger
  after insert on auth.identities
  for each row execute function public.sync_free_rating_ledger_on_identity_link();

-- ---------------------------------------------------------------------------
-- Backfill: every identity linked today inherits its user's identity-max, so
-- an account that already spent ratings under one provider and later linked
-- another is covered from this migration on. Idempotent (greatest); rows
-- with nothing to inherit are not created.
-- ---------------------------------------------------------------------------
insert into public.free_rating_ledger as led (identity_hash, scored_count)
select public.free_rating_identity_hash(i.provider, i.provider_id), m.identity_max
from auth.identities i
join (
  select i2.user_id, max(l.scored_count) as identity_max
  from auth.identities i2
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i2.provider, i2.provider_id)
  group by i2.user_id
) m on m.user_id = i.user_id
where m.identity_max > 0
on conflict (identity_hash) do update
  set scored_count = greatest(led.scored_count, excluded.scored_count),
      updated_at = now();
