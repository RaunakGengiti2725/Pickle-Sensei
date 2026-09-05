#!/usr/bin/env bash
# R6 — tools/loadtest/smoke.js exits 0 against an unreachable BASE_URL: its
# only thresholds are server_errors (5xx rate) and health_latency, so 100 %
# transport failures and 0 % passing checks still "pass thresholds" — the
# release-checklist reading of the script (docs/PRELAUNCH_CHECKLIST.md §6).
# Targets 127.0.0.1:9 (discard, nothing listens); never a real host.
# HELD = k6 exits non-zero; BROKEN = exit 0 with http_req_failed = 100 %.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
K6="${K6:-$(command -v k6 || true)}"
[ -n "$K6" ] || die "k6 not installed (K6=/path/to/k6)"
cd "$REPO_ROOT"
rc=0; "$K6" run -e BASE_URL=http://127.0.0.1:9 --summary-export "$OUT/r6-smoke-summary.json" tools/loadtest/smoke.js >"$OUT/r6-smoke.log" 2>&1 || rc=$?
failed="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.metrics.http_req_failed.value)' "$OUT/r6-smoke-summary.json")"
if [ "$rc" = 0 ]; then
  verdict BROKEN r6:smoke-dead-target "k6 smoke.js exit 0 against 127.0.0.1:9 (http_req_failed=$failed)"
else
  verdict HELD r6:smoke-dead-target "k6 smoke.js exit $rc against 127.0.0.1:9 (http_req_failed=$failed)"
fi
finish
