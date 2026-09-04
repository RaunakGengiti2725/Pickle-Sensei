#!/usr/bin/env bash
# S5 — cancellation mid-flight. SIGTERM the verify-cloud parent 6 s into
# `--only format` (what a CI runner / `timeout` / Ctrl-C-from-a-wrapper does)
# and observe: parent exit code, whether summary.json exists, and whether the
# `prettier --check .` child keeps running as an orphan.
#
# The run is started in its own process group (setsid) so the harness can
# clean up any orphans afterwards without touching unrelated processes.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s5"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2
[ -d node_modules/.bin ] && [ -x node_modules/.bin/prettier ] || { log "root deps missing; run scripts/verify-cloud.sh --only deps first"; exit 2; }

WAIT_S="${ATTACK_SIGTERM_AFTER:-6}"
ART="$OUT/verify"

descendants() { # $1 pgid → "pid ppid etime cmd" for every process in that group
  ps -eo pid=,ppid=,pgid=,etimes=,args= | awk -v g="$1" '$3 == g { $3=""; print }'
}

setsid env VERIFY_ARTIFACTS="$ART" scripts/verify-cloud.sh --only format >"$OUT/verify.stdout" 2>&1 &
PID=$!
sleep 0.5
PGID="$(ps -o pgid= -p "$PID" | tr -d ' ')"
log "parent pid=$PID pgid=$PGID; waiting ${WAIT_S}s"
sleep "$WAIT_S"
descendants "$PGID" >"$OUT/tree-before-sigterm.txt"
grep -q "prettier" "$OUT/tree-before-sigterm.txt" || log "WARNING: prettier not yet running at T+${WAIT_S}s (tree: $(wc -l <"$OUT/tree-before-sigterm.txt") procs)"

kill -TERM "$PID"
rc=0; wait "$PID" || rc=$?
log "parent exited rc=$rc"
sleep 1
descendants "$PGID" >"$OUT/tree-after-sigterm.txt"

assert_eq "parent exits 143 on SIGTERM" 143 "$rc"
if [ -f "$ART/summary.json" ]; then
  verdict BROKEN "no summary.json after SIGTERM" "summary.json exists: $(cat "$ART/summary.json")"
else
  verdict HELD "no summary.json after SIGTERM" "no partial/green summary written"
fi

orphans="$(grep -cE 'prettier|node .*prettier' "$OUT/tree-after-sigterm.txt" || true)"
if [ "$orphans" -gt 0 ]; then
  verdict BROKEN "SIGTERM to verify-cloud terminates its stage children" "$orphans prettier process(es) still running (orphaned, ppid≠$PID): see $OUT/tree-after-sigterm.txt"
  # Does the orphan keep writing the stage log after the parent is gone?
  size1="$(stat -c %s "$ART/format.log" 2>/dev/null || echo 0)"
  sleep 4
  size2="$(stat -c %s "$ART/format.log" 2>/dev/null || echo 0)"
  log "format.log grew $size1 → $size2 bytes after parent death"
  # Wait (bounded) for the orphan to finish naturally to see what it leaves behind.
  for _ in $(seq 1 120); do
    [ -z "$(descendants "$PGID")" ] && break
    sleep 1
  done
  descendants "$PGID" >"$OUT/tree-after-wait.txt"
  log "orphan finished; format.log tail: $(tail -n 2 "$ART/format.log" | tr '\n' '|')"
else
  verdict HELD "SIGTERM to verify-cloud terminates its stage children" "no prettier left running"
fi

# Cleanup: anything still alive in the group belongs to this attack.
if [ -n "$(descendants "$PGID")" ]; then
  kill -TERM -- "-$PGID" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$PGID" 2>/dev/null || true
fi

# Compare with `timeout`-style delivery to the whole group (what GitHub's runner
# cancellation approximates): the group must not leave anything behind.
setsid env VERIFY_ARTIFACTS="$OUT/verify-group" scripts/verify-cloud.sh --only format >"$OUT/verify-group.stdout" 2>&1 &
PID2=$!; sleep 0.5; PGID2="$(ps -o pgid= -p "$PID2" | tr -d ' ')"
sleep "$WAIT_S"
kill -TERM -- "-$PGID2"
rc2=0; wait "$PID2" || rc2=$?
sleep 1
left="$(descendants "$PGID2" | wc -l)"
assert_eq "process-group SIGTERM leaves no orphans (control)" 0 "$left"
log "group-kill parent rc=$rc2"
[ "$left" -gt 0 ] && { kill -KILL -- "-$PGID2" 2>/dev/null || true; }

finish
