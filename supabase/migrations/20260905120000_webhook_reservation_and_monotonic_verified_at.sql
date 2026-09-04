-- ============================================================================
-- Pickle Sensei — webhook idempotency reservation + monotonic billing verdicts
-- (edge-billing-webhook ADJ-1 / ADJ-2 / ADJ-3).
--
-- THE HOLES. (1) POST /webhooks/revenuecat wrote its webhook_events audit
-- row AFTER processing with a select-then-insert dedupe: a lookup or write
-- error was logged and ignored (fail open), and N concurrent deliveries of
-- one event id were each verified and persisted. (2) billing_entitlements
-- was an unconditional upsert on user_id, so a slower RevenueCat round trip
-- carrying an OLDER verdict overwrote a newer one (premium re-granted after
-- EXPIRATION).
--
-- THE FIX, DB side.
--   webhook_events gains a two-phase lifecycle: the edge function INSERTs
--   the row FIRST (ON CONFLICT DO NOTHING — the primary key is the atomic
--   reservation; only the delivery that inserted the row processes it),
--   `claimed_at` leases the in-flight reservation (a delivery whose isolate
--   died mid-flight is reclaimed once the lease lapses), and `processed_at`
--   is set only once every entitlement write landed. `processed_at IS NULL`
--   therefore means "in flight", never "done". Rows that exist today were
--   written after completion under the old contract → backfilled as
--   processed at received_at.
--
--   billing_entitlements gets a BEFORE UPDATE trigger that DROPS any update
--   whose verified_at is older than the stored one (RETURN NULL → 0 rows
--   affected → the PostgREST upsert reports no representation, which the
--   edge function logs as superseded). Equal timestamps are an idempotent
--   replay and newer ones win — last-writer-wins by verified_at, not by
--   arrival. The edge function takes verified_at BEFORE its RevenueCat
--   round trip so the timestamp orders the verdicts, not the responses.
--
-- Grants are unchanged: both tables stay service-role-only for writes and
-- webhook_events unreadable by clients (security_regression.sql E8/E9).
-- Live: __wf__/wf-billing-entitlement-sync-db.sql §9.
-- New file only — applied migrations are never edited.
-- ============================================================================

alter table public.webhook_events
  add column if not exists claimed_at timestamptz not null default now(),
  add column if not exists processed_at timestamptz;

comment on column public.webhook_events.claimed_at is
  'When the delivery currently processing this event id reserved it (insert-first, ON CONFLICT DO NOTHING). Renewed when a lapsed lease is reclaimed.';
comment on column public.webhook_events.processed_at is
  'Set once every entitlement write for the event landed. NULL = in flight; the row is deleted when the owning delivery fails retryably so RevenueCat''s redelivery is fully re-processed.';

update public.webhook_events
set processed_at = received_at
where processed_at is null;

create or replace function public.billing_entitlements_keep_newest_verdict()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.verified_at < old.verified_at then
    return null;
  end if;
  return new;
end;
$$;

comment on function public.billing_entitlements_keep_newest_verdict() is
  'BEFORE UPDATE guard: a verdict verified earlier than the stored one never overwrites it (a slow RevenueCat round trip cannot re-grant premium after a newer EXPIRATION). Equal or newer verified_at passes.';

revoke all on function public.billing_entitlements_keep_newest_verdict() from public, anon, authenticated;

drop trigger if exists billing_entitlements_keep_newest_verdict on public.billing_entitlements;
create trigger billing_entitlements_keep_newest_verdict
before update on public.billing_entitlements
for each row
execute function public.billing_entitlements_keep_newest_verdict();
