#!/usr/bin/env bash
# Deterministic repro — the RevenueCat webhook's replay check is read-then-write
# (harness scenario S1, observation `lanesThatPassedSeenCheck`).
#
# supabase/functions/api/index.ts (POST /webhooks/revenuecat):
#   seen = select id from webhook_events where id = :eventId     -- (1)
#   if seen → 200 "duplicate acknowledged, no RevenueCat round trip"
#   verdict = verifyWithRevenueCat(appUserId)                    -- external call
#   persistBillingVerdict(...)                                    -- billing_entitlements upsert
#   upsert webhook_events {id} ignoreDuplicates                   -- (2) audit row
#
# Two deliveries of the SAME event id whose (1) both run before either (2) both
# pass the replay check. The primary key keeps the audit table at one row (2) —
# no duplicate rows — but the RevenueCat verification and the entitlement write
# run once per delivery, so the "replays cost no round trip" property holds only
# for sequential replays. Forced here with two sessions doing (1) then (2).
#
# Usage: ../stress_pg_up.sh && ./repro_webhook_seen_check_race.sh ; exit 0 = reproduced.
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
source "$HERE/_lib.sh"

EVT="evt_race_$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
trap 'psql_owner "delete from public.webhook_events where id = '"'"'$EVT'"'"'" >/dev/null' EXIT

seen() { psql_as service_role "" "select coalesce((select 'seen' from public.webhook_events where id = '$EVT'), 'not_seen');" | tail -1; }
audit() { psql_as service_role "" "insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
  values ('$EVT', 'revenuecat', 'RENEWAL', 'user-1', '{\"event\":{\"id\":\"$EVT\"}}'::jsonb) on conflict (id) do nothing;
  select 'rows=' || count(*) from public.webhook_events where id = '$EVT';" | tail -1; }

S1=$(seen); S2=$(seen)            # both deliveries run their replay check first
A1=$(audit); A2=$(audit)          # ... then both audit-log
ROWS=$(psql_owner "select count(*) from public.webhook_events where id = '$EVT'")
echo "delivery 1: replay check=$S1 → would verify with RevenueCat + write entitlement; audit $A1"
echo "delivery 2: replay check=$S2 → would verify with RevenueCat + write entitlement; audit $A2"
echo "webhook_events rows for $EVT: $ROWS (primary key holds)"
if [ "$S1" = "not_seen" ] && [ "$S2" = "not_seen" ] && [ "$ROWS" = "1" ]; then
  echo "REPRODUCED: both concurrent deliveries pass the replay check; dedupe is only at the audit row"
  exit 0
fi
echo "not reproduced"
exit 1
