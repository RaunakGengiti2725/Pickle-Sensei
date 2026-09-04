-- ============================================================================
-- A scored shot is gated at the TABLE, not only inside apply_synced_shot().
--
-- THE HOLE. The permit + free-limit rules lived only inside the RPC.
-- `authenticated` also holds INSERT on public.shots (the SECURITY INVOKER RPC
-- writes through the caller's grant) with a policy of `user_id = auth.uid()`
-- and nothing else — so a client session that spoke to PostgREST directly
-- (project publishable key + its own JWT) could `insert into public.shots
-- (... result_kind = 'scored' ...)` with no permit at all and past the two
-- lifetime free ratings; the row counted, player_ranks refreshed. A
-- `low_confidence` row could also carry an overall_score (no CHECK), which
-- the Edge validator refuses but the table did not.
--
-- THE FIX (root cause: the gate was in the wrong layer).
--
--   1. BEFORE INSERT trigger `shots_insert_requires_permit` on public.shots.
--      For a row with result_kind = 'scored' written by a role RLS applies to
--      (row_security_active('public.shots') — anon/authenticated, i.e. every
--      PostgREST and RPC request; the table owner, service role and
--      migrations bypass RLS and are not gated, exactly like the policies),
--      it requires
--
--          new.user_id = auth.uid()
--          and a RESERVED, unexpired permit of that user exists
--          and (premium or public.lifetime_scored_count() < 2)
--
--      under the same per-user advisory lock reserve_analysis_permit() and
--      apply_synced_shot() take, so the count cannot move under it. A refused
--      row raises 42501 with the same vocabulary the RPC returns
--      ('access.permit_not_found' / 'access.paywall_required'). The canonical
--      reserve → apply_synced_shot() path already satisfies every condition
--      (the permit it holds FOR UPDATE is still reserved when the row is
--      inserted), so the RPC, the Edge route and the sync payload are
--      unchanged. Non-scored rows (abstentions) are quota-neutral — they
--      never touch the ledger or the rank — and stay owner-writable, sized to
--      the write that costs nothing.
--
--   2. CHECK `unscored_shots_have_no_score`: overall_score must be NULL
--      unless result_kind = 'scored' (the mirror of scored_shots_have_scores).
--      NOT VALID like the other post-launch caps: enforced for every new and
--      updated row without failing the deploy on a historical row.
--
-- The INSERT grant itself stays: apply_synced_shot() is SECURITY INVOKER on
-- purpose (RLS applies to every statement in it), and the grant is what it
-- writes through. What the grant can express is now exactly what the RPC
-- would accept.
--
-- Pinned live by security_regression.sql K1–K6 and statically by
-- __wf__/db_migrations_rls_indexes.test.ts.
-- ============================================================================

create or replace function public.enforce_scored_shot_permit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_premium boolean;
begin
  if new.result_kind <> 'scored'
     or v_uid is null
     or not pg_catalog.row_security_active('public.shots') then
    return new;
  end if;

  if new.user_id <> v_uid then
    raise exception 'access.permit_not_found'
      using errcode = 'insufficient_privilege',
            detail = 'A scored shot can only be recorded for the calling user.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(public.access_lock_key(v_uid));

  if not exists (
    select 1 from public.analysis_permits p
    where p.user_id = v_uid
      and p.status = 'reserved'
      and p.created_at > now() - interval '24 hours'
  ) then
    raise exception 'access.permit_not_found'
      using errcode = 'insufficient_privilege',
            detail = 'A scored shot requires a reserved, unexpired analysis permit; reserve one first and sync through apply_synced_shot().';
  end if;

  select coalesce((
    select b.premium and (b.expires_at is null or b.expires_at > now())
    from public.billing_entitlements b
    where b.user_id = v_uid
  ), false) into v_premium;

  if not v_premium and public.lifetime_scored_count() >= 2 then
    raise exception 'access.paywall_required'
      using errcode = 'insufficient_privilege',
            detail = 'The two lifetime free ratings are used; a membership is required to record another scored shot.';
  end if;

  return new;
end;
$$;

comment on function public.enforce_scored_shot_permit() is
  'BEFORE INSERT on public.shots: for every role RLS applies to, a scored row needs an owned, reserved, unexpired permit and lifetime_scored_count() < 2 (or membership), under the shared per-user access lock. Refusals are 42501 with the RPC''s access.* vocabulary. Non-scored rows pass.';

revoke execute on function public.enforce_scored_shot_permit()
  from public, anon, authenticated;

drop trigger if exists shots_insert_requires_permit on public.shots;
create trigger shots_insert_requires_permit
  before insert on public.shots
  for each row execute function public.enforce_scored_shot_permit();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'unscored_shots_have_no_score') then
    alter table public.shots add constraint unscored_shots_have_no_score
      check (result_kind = 'scored' or overall_score is null) not valid;
  end if;
end $$;

comment on constraint unscored_shots_have_no_score on public.shots is
  'A low_confidence (abstained) shot carries no score, whichever path writes it.';
