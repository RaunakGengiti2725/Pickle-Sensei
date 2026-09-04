#!/usr/bin/env bash
# scripts/verify-cloud.sh termination behaviour (no signal trap).
#
# `timeout`, a supervisor, or `kill <pid>` deliver SIGTERM to the orchestrator
# only — not to its foreground stage subshell. Without a trap the orchestrator
# dies, the stage's tool keeps running detached, and no summary.json is ever
# written for the run.
#
# Asserts (desired behaviour):
#   S1  after SIGTERM to the orchestrator the stage child is gone within 3 s
#   S2  a summary.json for the run exists (recording the interrupted stage)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SB=$(mktemp -d)
trap 'rm -rf "$SB"; [ -n "${CHILD_PID:-}" ] && kill "$CHILD_PID" 2>/dev/null' EXIT
new_verify_cloud_sandbox "$SB"

# a slow "pnpm format:check": records its PID, then sleeps
make_stub "$SB/bin" pnpm 'echo $$ >"$SANDBOX/child.pid"; sleep 120'

(cd "$SB" && HOME="$SB" PATH="$SANDBOX_BIN:/usr/bin:/bin" exec scripts/verify-cloud.sh --only format) \
  >"$AUDIT_OUT/signals_console.log" 2>&1 &
ORCH=$!
for _ in $(seq 1 50); do [ -s "$SB/child.pid" ] && break; sleep 0.1; done
CHILD_PID=$(cat "$SB/child.pid")
assert_true "precondition: stage child running" kill -0 "$CHILD_PID"

kill -TERM "$ORCH"
wait "$ORCH"
ORCH_RC=$?
log "orchestrator exit code after SIGTERM: $ORCH_RC"
sleep 3

if kill -0 "$CHILD_PID" 2>/dev/null; then
  log "FAIL S1 stage child (pid $CHILD_PID, 'pnpm format:check') still running 3s after the orchestrator died"
  ps -o pid,ppid,etime,cmd -p "$CHILD_PID" | tee "$AUDIT_OUT/signals_orphan.txt"
  _assert_failures=$((_assert_failures + 1))
else
  log "ok   S1 stage child terminated with the orchestrator"
fi

summary=$(ls "$SB"/artifacts/verify-cloud/*/summary.json 2>/dev/null | head -1)
assert_true "S2 summary.json written for the interrupted run" test -n "$summary"
ls -la "$SB"/artifacts/verify-cloud/*/ >"$AUDIT_OUT/signals_artifact_dir.txt" 2>&1
{ echo "orchestrator rc=$ORCH_RC"; cat "$AUDIT_OUT/signals_artifact_dir.txt"; } >>"$AUDIT_OUT/signals_console.log"

finish
