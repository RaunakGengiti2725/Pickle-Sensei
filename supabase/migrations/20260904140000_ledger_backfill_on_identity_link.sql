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
-- THE FIX. A definer AFTER INSERT trigger on auth.identities upserts the
-- ledger row of EVERY identity of the user (the new one included) to
--
--     greatest(its existing count, identity-max across all of the user's
--              identities, the new one included)
--
-- so linking carries the account's history onto the new identity, an identity
-- that arrives with a HIGHER history carries it onto the account's other
-- identities right away (AGENTS.md: every identity of the user carries the
-- identity-max — deletion + re-sign-in with ANY of them keeps the count), and
-- linking a zero-history identity to a zero-history account writes nothing.
-- Nothing is ever lowered and nothing is ever decremented. The
-- account-deletion cascade deletes auth.identities rows; this trigger does not
-- listen to DELETE, so the rows written here outlive the account like every
-- other ledger row.
--
-- SERIALIZATION. The trigger takes the SAME per-user advisory lock that
-- reserve_analysis_permit() / apply_synced_shot() / the shots permit gate
-- hold (pg_advisory_xact_lock(access_lock_key(user_id))) BEFORE reading the
-- ledger. Without it a link that lands while a scored sync's transaction is
-- open reads the ledger under READ COMMITTED before that sync's write, the
-- sync in turn wrote every identity that existed when it ran (which excludes
-- the one being linked), both commit, and the late-linked identity has no
-- ledger row — delete + re-sign-in with it alone then mints fresh free
-- ratings. Under the lock the two orders both converge: link-after-sync
-- waits for the sync to commit and inherits its count; sync-after-link waits
-- for the link to commit and record_scored_shot_in_ledger() then sees the
-- new identity in auth.identities and writes it too. GoTrue's first sign-in
-- (auth.users + auth.identities in one transaction) holds the lock only for
-- the remainder of that transaction; the only writers it ever contends with
-- are the user's own rating writes. Live: supabase/tests/run_identity_link_race_test.sh.
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
  v_max integer;
begin
  -- Serialize against this user's in-flight rating writes; see header.
  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(new.user_id));

  select coalesce(max(l.scored_count), 0) into v_max
  from auth.identities i
  join public.free_rating_ledger l
    on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
  where i.user_id = new.user_id;

  if v_max > 0 then
    insert into public.free_rating_ledger as led (identity_hash, scored_count)
    select public.free_rating_identity_hash(i.provider, i.provider_id), v_max
    from auth.identities i
    where i.user_id = new.user_id
    on conflict (identity_hash) do update
      set scored_count = greatest(led.scored_count, excluded.scored_count),
          updated_at = now();
  end if;

  return new;
end;
$$;

comment on function public.sync_free_rating_ledger_on_identity_link() is
  'AFTER INSERT on auth.identities, under pg_advisory_xact_lock(access_lock_key(user_id)) like every other rating write: every identity of the user gets free_rating_ledger.scored_count = greatest(its own count, the user''s identity-max). Keeps the ledger complete for identities linked after (or while) ratings were spent; never lowers a count.';

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
