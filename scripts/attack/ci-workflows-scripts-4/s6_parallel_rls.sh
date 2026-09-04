#!/usr/bin/env bash
# S6 — two `supabase/tests/run_rls_tests.sh` on one host. The Docker path uses
# the fixed container name `pickle-rls-test` and runs `docker rm -f` both before
# starting and on EXIT, so a second invocation can delete the first one's
# container mid-migration (and every `docker exec pickle-rls-test` resolves by
# NAME, so a run may keep going inside a container it did not create).
#
# Expectation for HELD: both runs pass, or the collision is a loud failure that
# is attributable to the collision (never a pass produced in the other run's
# container). Anything else is a determinism finding.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s6"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2
docker info >/dev/null 2>&1 || { log "docker unavailable"; exit 2; }
STAGGER="${ATTACK_RLS_STAGGER:-3}"

# Record docker lifecycle events for the fixed name while the attack runs.
docker events --filter container=pickle-rls-test --filter type=container \
  --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}} {{.ID}}' >"$OUT/docker-events.txt" 2>&1 &
EV=$!
trap 'kill "$EV" 2>/dev/null; docker rm -f pickle-rls-test >/dev/null 2>&1 || true' EXIT
sleep 1

run() { # $1 label
  local rc=0
  ./supabase/tests/run_rls_tests.sh >"$OUT/$1.log" 2>&1 || rc=$?
  echo "$rc" >"$OUT/$1.exit"
}

log "starting run A; run B starts as soon as A's log shows 'applying' (A inside its migration loop), or after ${STAGGER}s"
run A & PA=$!
for _ in $(seq 1 $((STAGGER * 20))); do
  grep -q '^applying ' "$OUT/A.log" 2>/dev/null && break
  sleep 0.05
done
# Snapshot which container A is currently using.
docker inspect -f '{{.Id}} {{.Created}}' pickle-rls-test >"$OUT/container-before-B.txt" 2>&1 || true
run B & PB=$!
wait "$PA" "$PB"
sleep 1
kill "$EV" 2>/dev/null; wait "$EV" 2>/dev/null || true

ea="$(cat "$OUT/A.exit")"; eb="$(cat "$OUT/B.exit")"
log "exit A=$ea B=$eb"
grep -E "PASSED|FAILED|No such container|is not running|already exists|ERROR|error" "$OUT/A.log" | tail -5 | sed 's/^/  A: /' >&2
grep -E "PASSED|FAILED|No such container|is not running|already exists|ERROR|error" "$OUT/B.log" | tail -5 | sed 's/^/  B: /' >&2
containers_created="$(grep -c ' create ' "$OUT/docker-events.txt" || true)"
containers_destroyed="$(grep -c ' destroy ' "$OUT/docker-events.txt" || true)"
log "docker events: $containers_created created, $containers_destroyed destroyed for name pickle-rls-test"

if [ "$ea" = 0 ] && [ "$eb" = 0 ]; then
  # Both passed. Was that legitimate (two distinct containers, each surviving
  # its own run) or did one pass inside the other's container?
  if [ "$containers_destroyed" -ge 2 ] && [ "$containers_created" -eq 2 ]; then
    verdict HELD "two concurrent RLS runs both pass" "exit A=0 B=0"
  else
    verdict BROKEN "two concurrent RLS runs both pass in their own containers" "A=0 B=0 but events show create=$containers_created destroy=$containers_destroyed — see $OUT/docker-events.txt"
  fi
else
  a_pass="$(grep -c 'ALL CASES PASSED' "$OUT/A.log" || true)"
  b_pass="$(grep -c 'ALL CASES PASSED' "$OUT/B.log" || true)"
  verdict BROKEN "concurrent RLS runs do not interfere (fixed container name pickle-rls-test)" \
    "exit A=$ea B=$eb; A passed-matrix=$a_pass B passed-matrix=$b_pass; second run's pre-start 'docker rm -f' killed the first run's container mid-migration — logs $OUT/A.log $OUT/B.log, events $OUT/docker-events.txt"
fi

# A killed run must not be mistaken for an RLS regression: does the failing
# log say WHY (container removed) rather than only a psql/migration error?
for r in A B; do
  if [ "$(cat "$OUT/$r.exit")" != 0 ]; then
    if grep -qE "No such container|is not running|container .* removed|not found" "$OUT/$r.log"; then
      verdict HELD "run $r failure log names the container loss" "$(grep -m1 -E 'No such container|is not running|not found' "$OUT/$r.log")"
    else
      verdict BROKEN "run $r failure log names the container loss" "log shows only: $(tail -n 1 "$OUT/$r.log")"
    fi
  fi
done

finish
