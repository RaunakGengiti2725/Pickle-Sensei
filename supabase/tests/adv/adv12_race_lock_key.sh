#!/usr/bin/env bash
# ADV-12 — real two-connection races on the access_lock_key(uid) /
# offline_ticket_lock_key(ticket) boundaries. Run by run_adv_tests.sh as
#   adv12_race_lock_key.sh <container> <database>
# Three races, each with exactly one credit left:
#   R1 two online reservations under different idempotency keys;
#   R2 an online reservation vs an offline grant for a new installation;
#   R3 two consumes of the same offline ticket with different shot ids.
# Connection A holds its transaction open for 3s after the call so B has to
# queue on the lock (or, if the lock is missing, both would be accepted — the
# break this attack looks for). The setup is committed and torn down here
# (the ledger rows outlive the account by design and carry unique ids).
set -uo pipefail
CONTAINER="$1"; DB="$2"
psql_() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }

U=00000000-0000-4000-8000-0000000012a1
S=00000000-0000-4000-8000-0000000012a2
psql_ <<SQL
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values ('$U','race@example.com','{}','{"provider":"apple"}');
insert into auth.identities (provider, provider_id, user_id, identity_data) values ('apple','adv12-race','$U','{}');
insert into auth.sessions (id, user_id) values ('$S','$U');
-- one of the two lifetime free ratings is already spent on this identity
insert into public.free_rating_ledger (identity_hash, scored_count) values (public.free_rating_identity_hash('apple','adv12-race'), 1)
  on conflict (identity_hash) do update set scored_count = greatest(public.free_rating_ledger.scored_count, 1);
SQL

preamble() {
  cat <<SQL
begin;
do \$\$ begin perform set_config('request.headers', jsonb_build_object('x-pickle-api-key', public.get_api_request_key())::text, true); end \$\$;
set local role authenticated;
set local request.jwt.claim.sub = '$U';
set local request.jwt.claims = '{"session_id":"$S"}';
SQL
}
shot() {
  cat <<JSON
{"id":"$1","resultKind":"scored","shotType":"drive","capturedAt":"2026-09-08T10:00:00Z","startMs":0,"endMs":1000,"confidence":0.9,"overallScore":7.2,"versionVector":{"appVersion":"1.0.0","modelBundleVersion":"b","poseModelVersion":"p","paddleModelVersion":"p","strokeDetectorVersion":"s","phaseModelVersion":"p","scoringModelVersion":"s","shotConfigVersion":"c"}}
JSON
}

bad=()
# R1 — two online reservations
r1a=$( { preamble; printf "select result from public.reserve_analysis_permit('adv12-r1-a');\nselect pg_sleep(3);\ncommit;\n"; } | psql_ 2>&1 | grep -v '^$' | head -1 ) &
p=$!; sleep 1
r1b=$( { preamble; printf "select result from public.reserve_analysis_permit('adv12-r1-b');\ncommit;\n"; } | psql_ 2>&1 | grep -v '^$' | head -1 )
wait "$p"
n=$(psql_ -c "select count(*) from public.analysis_permits where user_id = '$U' and status = 'reserved';")
echo "ADV-12 R1 online×online: B=<$r1b> reserved_rows=$n"
[ "$n" = "1" ] || bad+=("R1_reserved_rows=$n")
[ "$r1b" = "access.paywall_required" ] || bad+=("R1_B=$r1b")

# release the reservation so exactly one credit is free again
psql_ -c "update public.analysis_permits set status = 'released', outcome = 'cancelled' where user_id = '$U' and status = 'reserved';" >/dev/null

# R2 — online reservation vs offline grant
psql_ <<SQL >/dev/null
$(preamble)
select public.register_offline_device('adv12-inst', 'production', true);
commit;
SQL
r2a=$( { preamble; printf "select result from public.reserve_analysis_permit('adv12-r2-a');\nselect pg_sleep(3);\ncommit;\n"; } | psql_ 2>&1 | grep -v '^$' | head -1 ) &
p=$!; sleep 1
r2b=$( { preamble; printf "select result || ':' || coalesce(cardinality(ticket_ids), 0) from public.issue_offline_grant('adv12-inst', 2);\ncommit;\n"; } | psql_ 2>&1 | grep -v '^$' | head -1 )
wait "$p"
n=$(psql_ -c "select (select count(*) from public.analysis_permits where user_id = '$U' and status = 'reserved') + (select count(*) from public.offline_allocation_ledger where user_id = '$U' and event = 'allocated');")
echo "ADV-12 R2 online×offline: B=<$r2b> live_credits=$n"
[ "$n" = "1" ] || bad+=("R2_live_credits=$n")
[ "$r2b" = "access.paywall_required:0" ] || bad+=("R2_B=$r2b")

# R3 — same offline ticket, two shots: release the online reservation, take the one ticket, race the consume
psql_ -c "update public.analysis_permits set status = 'released', outcome = 'cancelled' where user_id = '$U' and status = 'reserved';" >/dev/null
t=$( { preamble; printf "select ticket_ids[1] from public.issue_offline_grant('adv12-inst', 1);\ncommit;\n"; } | psql_ 2>&1 | grep -v '^$' | head -1 )
if [[ ! "$t" =~ ^[0-9a-f-]{36}$ ]]; then bad+=("R3_no_ticket=$t"); fi
r3a=$( { preamble; printf "select public.consume_offline_ticket('%s', '%s'::jsonb);\nselect pg_sleep(3);\ncommit;\n" "$t" "$(shot 00000000-0000-4000-8000-0000000012c1)"; } | psql_ 2>&1 | grep -v '^$' | head -1 ) &
p=$!; sleep 1
r3b=$( { preamble; printf "select public.consume_offline_ticket('%s', '%s'::jsonb);\ncommit;\n" "$t" "$(shot 00000000-0000-4000-8000-0000000012c2)"; } | psql_ 2>&1 | grep -v '^$' | head -1 )
wait "$p"
n=$(psql_ -c "select (select count(*) from public.shots where user_id = '$U') || '/' || (select count(*) from public.offline_allocation_ledger where ticket_id = '$t' and event = 'consumed');")
echo "ADV-12 R3 consume×consume: B=<$r3b> shots/consumed=$n"
[ "$n" = "1/1" ] || bad+=("R3_rows=$n")
[ "$r3b" = "offline.ticket_consumed" ] || bad+=("R3_B=$r3b")

# lock keys: distinct per user, and the ticket key space is not the user key space
k=$(psql_ -c "select (public.access_lock_key('$U') <> public.access_lock_key('$S')) and (api_private.offline_ticket_lock_key('$U') <> public.access_lock_key('$U'));")
[ "$k" = "t" ] || bad+=("lock_keys_collide=$k")

# teardown (ledger rows stay by design)
psql_ -c "delete from auth.users where id = '$U';" >/dev/null

if [ "${#bad[@]}" -gt 0 ]; then
  echo "ADV-12 BREAK: ${bad[*]}"
  exit 1
fi
echo "ADV-12: PASS"
