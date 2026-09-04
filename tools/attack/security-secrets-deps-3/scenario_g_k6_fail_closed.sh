#!/usr/bin/env bash
# Scenario G — every k6 script under tools/loadtest must throw BEFORE any HTTP
# call when BASE_URL is unset (fail-closed default against accidental hits on
# production). A local TCP listener counts connections during each run; any
# connection, or a k6 exit other than 107 (script exception at init), is a
# BROKEN result.
#
# Extra G2: with BASE_URL pointing at a DEAD port, `smoke.js` completes its full
# 60 s profile with 100 % http_req_failed and 0 % checks passing yet exits 0 —
# its thresholds cover only `server_errors` (status>=500, never true for a
# connection failure) and latency (0 s). The same gap holds for user-flow.js and
# auth-abuse.js (no `checks` threshold); the wf-*.js scripts do assert
# `checks: rate>0.99`. Set ATTACK_SKIP_G2=1 to skip the 60 s run.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$REPO_ROOT"

command -v k6 >/dev/null || inconclusive "k6 not installed (pinned v1.3.0 was used for the recorded run)"

port=$((18000 + RANDOM % 1000))
counter="$ATTACK_OUT/g-connections.txt"
python3 - "$port" "$counter" <<'EOF' &
import socket, sys, time
port, out = int(sys.argv[1]), sys.argv[2]
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(64); s.settimeout(0.5)
n, deadline = 0, time.time() + 90
while time.time() < deadline:
    try:
        c, _ = s.accept(); n += 1; c.close()
    except socket.timeout:
        pass
    with open(out, "w") as f: f.write(str(n))
EOF
listener=$!
trap 'kill $listener 2>/dev/null || true; cleanup' EXIT
sleep 0.5

fails=()
for script in tools/loadtest/*.js; do
  name="$(basename "$script" .js)"
  rc=0
  # BASE_URL deliberately absent; the listener would catch a fallback default.
  env -u BASE_URL k6 run --quiet --no-summary "$script" > "$ATTACK_OUT/g-$name.log" 2>&1 || rc=$?
  if [ "$rc" != 107 ] || ! grep -q 'Set -e BASE_URL' "$ATTACK_OUT/g-$name.log"; then
    fails+=("$name: exit $rc without the BASE_URL guard error")
  fi
done
# Empty string must behave like unset.
rc=0
BASE_URL="" k6 run --quiet --no-summary tools/loadtest/smoke.js > "$ATTACK_OUT/g-smoke-empty.log" 2>&1 || rc=$?
[ "$rc" = 107 ] || fails+=("smoke.js with BASE_URL='' exit $rc (expected 107)")

sleep 1
conns="$(cat "$counter" 2>/dev/null || echo 0)"
[ "$conns" = 0 ] || fails+=("$conns TCP connection(s) reached the local listener during no-BASE_URL runs")

g2_note=""
if [ "${ATTACK_SKIP_G2:-0}" != 1 ]; then
  rc=0
  k6 run --no-color --summary-export "$ATTACK_OUT/g2-dead-target-summary.json" \
    -e BASE_URL="http://127.0.0.1:1" tools/loadtest/smoke.js > "$ATTACK_OUT/g2-dead-target.log" 2>&1 || rc=$?
  failed_rate="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["metrics"]["http_req_failed"]["value"])' "$ATTACK_OUT/g2-dead-target-summary.json" 2>/dev/null || echo unknown)"
  log "smoke.js against dead port → exit $rc, http_req_failed=$failed_rate"
  if [ "$rc" = 0 ] && [ "$failed_rate" = 1 ]; then
    g2_note="G2: smoke.js exits 0 with 100% http_req_failed — thresholds never fail on an unreachable target"
  fi
fi

if [ "${#fails[@]}" = 0 ] && [ -z "$g2_note" ]; then
  held "all k6 scripts throw before HTTP without BASE_URL; unreachable target fails the run"
fi
printf '%s\n' "${fails[@]}" "${g2_note:+$g2_note}"
[ "${#fails[@]}" = 0 ] && echo "note: the no-BASE_URL guard HELD for every script; only G2 (false green) is broken"
broken "k6 harness gap(s) listed above"
