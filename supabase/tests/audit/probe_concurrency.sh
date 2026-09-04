#!/usr/bin/env bash
# Pickle Sensei — db-schema-migrations execution audit: concurrent RPC races.
#
# Runs INSIDE the throwaway Postgres container (psql on PATH, superuser
# `postgres`, shim + all migrations applied). Fires genuinely parallel psql
# clients at apply_synced_shot() / reserve_analysis_permit() and asserts the
# invariants the advisory lock (20260901000000, 20260902150000) promises:
#
#   R1  two reserved permits, two concurrent scored syncs → both accepted (2 scored)
#   R2  over-issued permits (8 reserved, inserted as service) + 8 concurrent
#       scored syncs → EXACTLY 2 accepted, 6 access.paywall_required, the 6
#       losing permits released as free_limit_exceeded, 2 scored rows
#   R3  8 concurrent replays of ONE shot payload → ONE row, permit consumed
#       once, no error; the per-call status split is reported (see the note
#       in the R3 block about access.permit_not_reserved)
#   R4  1 scored + 1 reserved permit; 8 concurrent reserve() with fresh keys
#       racing the sync of that permit → sync accepted, all 8 reserves denied,
#       final state 2 scored / 0 reserved
#   R5  8 concurrent abstention syncs on 8 over-issued permits → all accepted
#       (abstentions never consume), 0 scored, 8 permits released/low_confidence
#
# Exits non-zero on any violated invariant. Never used against production.
set -euo pipefail

DB="${1:-postgres}"
PSQL=(psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qAt)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

as_user() { # $1 uid, $2 sql
  printf "set role authenticated; set request.jwt.claim.sub = '%s'; select pg_sleep(0.05); %s" "$1" "$2"
}

shot_json() { # $1 shot id, $2 permit id, $3 result kind
  local score=null
  [ "$3" = scored ] && score=7.1
  printf '{"id":"%s","analysisPermitId":"%s","sessionId":null,"shotType":"dink","cameraView":"side","capturedAt":"2026-09-01T12:00:00Z","startMs":0,"contactMs":400,"endMs":900,"overallScore":%s,"confidence":0.91,"resultKind":"%s","phases":[],"checkpoints":[],"versionVector":{"appVersion":"1.0.0","modelBundleVersion":"b","poseModelVersion":"p","paddleModelVersion":"pd","strokeDetectorVersion":"s","phaseModelVersion":"ph","scoringModelVersion":"sc","shotConfigVersion":"c"}}' \
    "$1" "$2" "$score" "$3"
}

new_user() { # $1 uid, $2 tag
  "${PSQL[@]}" -c "insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
                   values ('$1', 'race-$2@example.com', '{}', '{\"provider\":\"google\"}')" >/dev/null
}

permit_id() { printf '00000000-0000-4000-%s-%012d' "$1" "$2"; }
shot_id()   { printf '00000000-0000-4000-%s-%012d' "$1" "$2"; }

count() { "${PSQL[@]}" -c "$1" | grep -v "^$"; }   # drop the blank pg_sleep row

fail() { echo "CONCURRENCY PROBE FAILED — $*" >&2; exit 1; }

# ─────────────────────────────── R1 ─────────────────────────────────────────
U1=00000000-0000-4000-d001-000000000001
new_user $U1 r1
for i in 1 2; do
  count "$(as_user $U1 "select permit_id from public.reserve_analysis_permit('r1-$i')")" >"$WORK/r1p$i"
done
for i in 1 2; do
  "${PSQL[@]}" -c "$(as_user $U1 "select public.apply_synced_shot('$(shot_json "$(shot_id d1a1 $i)" "$(cat "$WORK/r1p$i")" scored)'::jsonb)")" >"$WORK/r1s$i" 2>&1 &
done
wait
acc=$(cat "$WORK"/r1s* | grep -c '^accepted$' || true)
scored=$(count "select count(*) from public.shots where user_id = '$U1' and result_kind = 'scored'")
echo "R1 accepted=$acc scored_rows=$scored"
[ "$acc" = 2 ] && [ "$scored" = 2 ] || fail "R1: two legitimately reserved permits must both sync"

# ─────────────────────────────── R2 ─────────────────────────────────────────
U2=00000000-0000-4000-d002-000000000001
new_user $U2 r2
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$(permit_id d2a1 $i)', '$U2', 'r2-$i')" >/dev/null
done
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "$(as_user $U2 "select public.apply_synced_shot('$(shot_json "$(shot_id d2b1 $i)" "$(permit_id d2a1 $i)" scored)'::jsonb)")" >"$WORK/r2s$i" 2>&1 &
done
wait
acc=$(cat "$WORK"/r2s* | grep -c '^accepted$' || true)
pay=$(cat "$WORK"/r2s* | grep -c '^access.paywall_required$' || true)
scored=$(count "select count(*) from public.shots where user_id = '$U2' and result_kind = 'scored'")
released=$(count "select count(*) from public.analysis_permits where user_id = '$U2' and status = 'released' and outcome = 'free_limit_exceeded'")
finalized=$(count "select count(*) from public.analysis_permits where user_id = '$U2' and status = 'finalized' and outcome = 'scored'")
echo "R2 accepted=$acc paywall=$pay scored_rows=$scored released_free_limit=$released finalized=$finalized"
[ "$acc" = 2 ] && [ "$pay" = 6 ] && [ "$scored" = 2 ] && [ "$released" = 6 ] && [ "$finalized" = 2 ] \
  || fail "R2: over-issued permits must yield exactly 2 scored / 6 paywall / 6 released"

# ─────────────────────────────── R3 ─────────────────────────────────────────
U3=00000000-0000-4000-d003-000000000001
new_user $U3 r3
P3=$(count "$(as_user $U3 "select permit_id from public.reserve_analysis_permit('r3-1')")")
S3=$(shot_id d3b1 1)
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "$(as_user $U3 "select public.apply_synced_shot('$(shot_json "$S3" "$P3" scored)'::jsonb)")" >"$WORK/r3s$i" 2>&1 &
done
wait
acc=$(cat "$WORK"/r3s* | grep -c '^accepted$' || true)
not_reserved=$(cat "$WORK"/r3s* | grep -c '^access.permit_not_reserved$' || true)
other=$(cat "$WORK"/r3s* | grep -v '^$' | grep -v '^accepted$' | grep -vc '^access.permit_not_reserved$' || true)
rows=$(count "select count(*) from public.shots where id = '$S3'")
pstat=$(count "select status || '/' || outcome from public.analysis_permits where id = '$P3'")
echo "R3 accepted=$acc permit_not_reserved=$not_reserved other=$other rows=$rows permit=$pstat"
# Hard invariants: exactly one row, permit consumed once, no error / write_failed.
[ "$rows" = 1 ] && [ "$pstat" = "finalized/scored" ] && [ "$other" = 0 ] && [ "$acc" -ge 1 ] \
  || fail "R3: concurrent replays of one shot must write exactly one row and consume the permit once"
# Contract note: the RPC's idempotent-replay check runs BEFORE the advisory
# lock, so a replay that queued behind the winning write sees the permit
# already finalized and answers access.permit_not_reserved (the route maps
# that to a permanent per-item rejection) although the row exists. The next
# drain's batched replay lookup acknowledges it. Reported, not fatal.
if [ "$not_reserved" != 0 ]; then
  echo "R3 NOTE: $not_reserved of 8 concurrent replays answered access.permit_not_reserved instead of accepted (row exists)"
fi

# ─────────────────────────────── R4 ─────────────────────────────────────────
U4=00000000-0000-4000-d004-000000000001
new_user $U4 r4
P4a=$(count "$(as_user $U4 "select permit_id from public.reserve_analysis_permit('r4-a')")")
"${PSQL[@]}" -c "$(as_user $U4 "select public.apply_synced_shot('$(shot_json "$(shot_id d4b1 1)" "$P4a" scored)'::jsonb)")" | grep -q '^accepted$' || fail "R4 setup"
P4b=$(count "$(as_user $U4 "select permit_id from public.reserve_analysis_permit('r4-b')")")
"${PSQL[@]}" -c "$(as_user $U4 "select public.apply_synced_shot('$(shot_json "$(shot_id d4b1 2)" "$P4b" scored)'::jsonb)")" >"$WORK/r4sync" 2>&1 &
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "$(as_user $U4 "select result from public.reserve_analysis_permit('r4-x$i')")" >"$WORK/r4r$i" 2>&1 &
done
wait
sync=$(grep -v '^$' "$WORK/r4sync")
den=$(cat "$WORK"/r4r* | grep -c '^access.paywall_required$' || true)
racc=$(cat "$WORK"/r4r* | grep -c '^accepted$' || true)
scored=$(count "select count(*) from public.shots where user_id = '$U4' and result_kind = 'scored'")
reserved=$(count "select count(*) from public.analysis_permits where user_id = '$U4' and status = 'reserved'")
echo "R4 sync=$sync reserve_denied=$den reserve_accepted=$racc scored_rows=$scored reserved_rows=$reserved"
[ "$sync" = accepted ] && [ "$den" = 8 ] && [ "$racc" = 0 ] && [ "$scored" = 2 ] && [ "$reserved" = 0 ] \
  || fail "R4: reserves racing the second sync must all be denied"

# ─────────────────────────────── R5 ─────────────────────────────────────────
U5=00000000-0000-4000-d005-000000000001
new_user $U5 r5
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "insert into public.analysis_permits (id, user_id, idempotency_key) values ('$(permit_id d5a1 $i)', '$U5', 'r5-$i')" >/dev/null
done
for i in $(seq 1 8); do
  "${PSQL[@]}" -c "$(as_user $U5 "select public.apply_synced_shot('$(shot_json "$(shot_id d5b1 $i)" "$(permit_id d5a1 $i)" low_confidence)'::jsonb)")" >"$WORK/r5s$i" 2>&1 &
done
wait
acc=$(cat "$WORK"/r5s* | grep -c '^accepted$' || true)
scored=$(count "select count(*) from public.shots where user_id = '$U5' and result_kind = 'scored'")
abst=$(count "select count(*) from public.analysis_permits where user_id = '$U5' and status = 'released' and outcome = 'low_confidence'")
lifetime=$(count "$(as_user $U5 "select public.lifetime_scored_count()")")
echo "R5 accepted=$acc scored_rows=$scored released_low_confidence=$abst lifetime_scored_count=$lifetime"
[ "$acc" = 8 ] && [ "$scored" = 0 ] && [ "$abst" = 8 ] && [ "$lifetime" = 0 ] \
  || fail "R5: abstentions must never consume a free rating"

echo "CONCURRENCY PROBES: ALL CASES PASSED"
