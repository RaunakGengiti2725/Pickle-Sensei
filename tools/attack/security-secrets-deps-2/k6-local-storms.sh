#!/usr/bin/env bash
# Adversarial tester #2 (security-secrets-deps, pass 3) — S1 + extras.
#
# Boots the REAL edge function (supabase/functions/api/index.ts) on :8000
# against the stub Supabase (supabase/functions/api/__wf__/supabase_stub.ts)
# on :54399 — never a real project — and runs:
#
#   S1  the documented-but-never-executed expired-token loop
#       (tools/loadtest/wf-expired-token-loop.js) exactly as documented;
#   S1x the forged-token storm (k6-forged-token-storm.js): well-formed,
#       unexpired, unverifiable bearers from N IPs — the storm that actually
#       reaches Supabase Auth — asserting the per-IP auth-failure budget caps
#       upstream exchanges and nothing ever 5xxs.
#
# Then it audits S1's own contract from its summary JSON: the script's
# `checks` threshold (rate>0.99) tolerates a failing teardown check, so a
# run can exit 0 while the assertion the script exists for fails.
#
# Usage:  tools/attack/security-secrets-deps-2/k6-local-storms.sh [out_dir]
# Exit:   0 every gate held, 1 at least one gate BROKEN, 2 setup failure.
# Requires: deno, k6, python3, curl. Uses only 127.0.0.1.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${1:-${HOME}/attack-artifacts/k6}"
mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/results.jsonl"
: >"$RESULTS"
K6="${K6:-$(command -v k6 || echo "$HOME/bin/k6")}"
DENO="${DENO:-$(command -v deno || echo "$HOME/.deno/bin/deno")}"
BASE_URL="http://127.0.0.1:8000"
STUB_URL="http://127.0.0.1:54399"
BROKEN=0

record() { # probe verdict detail
  printf '{"probe":"%s","verdict":"%s","detail":"%s"}\n' "$1" "$2" "$3" >>"$RESULTS"
  printf '[probe] %-44s → %s %s\n' "$1" "$2" "$3"
  [ "$2" = "HELD" ] || BROKEN=1
}

for bin in "$K6" "$DENO" python3 curl; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "missing: $bin" >&2
    exit 2
  }
done

cd "$REPO_ROOT"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup EXIT

if ! curl -fsS -o /dev/null "$STUB_URL/__stub/stats" 2>/dev/null; then
  "$DENO" run --node-modules-dir=none --allow-net --allow-env \
    supabase/functions/api/__wf__/supabase_stub.ts >"$OUT_DIR/stub.log" 2>&1 &
  PIDS+=("$!")
fi
if ! curl -fsS -o /dev/null "$BASE_URL/healthz" 2>/dev/null; then
  SUPABASE_URL="$STUB_URL" SUPABASE_ANON_KEY=x \
    "$DENO" run --node-modules-dir=none --allow-net --allow-env --allow-read \
    supabase/functions/api/index.ts >"$OUT_DIR/edge.log" 2>&1 &
  PIDS+=("$!")
fi
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$BASE_URL/healthz" 2>/dev/null &&
    curl -fsS -o /dev/null "$STUB_URL/__stub/stats" 2>/dev/null; then break; fi
  sleep 0.5
done
curl -fsS -o /dev/null "$BASE_URL/healthz" || {
  echo "edge function did not come up on :8000" >&2
  exit 2
}

# ── S1: the documented command, verbatim, plus a machine-readable summary.
set +e
"$K6" run -e BASE_URL="$BASE_URL" -e STUB_URL="$STUB_URL" \
  --summary-export "$OUT_DIR/s1-expired-token-loop.summary.json" \
  tools/loadtest/wf-expired-token-loop.js >"$OUT_DIR/s1-expired-token-loop.stdout" 2>&1
S1_RC=$?
set -e
echo "S1 k6 exit=$S1_RC (log: $OUT_DIR/s1-expired-token-loop.stdout)"
S1_EXCHANGES="$(curl -fsS "$STUB_URL/__stub/stats" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("auth:/auth/v1/token", 0))')"

python3 - "$OUT_DIR/s1-expired-token-loop.summary.json" "$S1_RC" "$S1_EXCHANGES" >"$OUT_DIR/s1-audit.txt" <<'EOF'
import json, sys
summary = json.load(open(sys.argv[1]))
rc = int(sys.argv[2]); exchanges = int(sys.argv[3])
m = summary["metrics"]
def cnt(name): return int(m.get(name, {}).get("count", 0))
iters = cnt("iterations")
ok_401 = cnt("expired_token_401")
server_err = m.get("server_errors", {}).get("value", 1.0)
def walk(group):  # checks live in nested groups (setup/teardown are groups)
    yield from group.get("checks", {}).items()
    for sub in group.get("groups", {}).values():
        yield from walk(sub)
failed_checks = {k: v for k, v in walk(summary["root_group"]) if v["fails"] > 0}
print(f"iterations={iters} expired_token_401={ok_401} server_errors_rate={server_err} "
      f"stub_auth_exchanges={exchanges} k6_exit={rc}")
print("failed_checks=" + json.dumps(sorted(failed_checks)))
# 1. Never 5xx, every attempt 401 — the security property.
print("S1-never-5xx-all-401", "HELD" if ok_401 == iters and server_err == 0 else "BROKEN")
# 2. Expired tokens cost zero Supabase Auth exchanges (bearerExpired short
#    circuit) — the 1800/h budget is not touched at all.
print("S1-zero-upstream-auth-exchanges", "HELD" if exchanges == 0 else "BROKEN")
# 3. The script's OWN teardown check asserts exchanges === attempts (the
#    pre-fix cost model). If it fails yet k6 exits 0, the run is not a gate.
stale = "every expired-token retry hit Supabase Auth (no negative cache)"
stale_failed = stale in failed_checks
print("S1x-script-teardown-check-fails-but-run-passes",
      "BROKEN" if (stale_failed and rc == 0) else "HELD")
EOF
cat "$OUT_DIR/s1-audit.txt"
while read -r name verdict; do
  case "$name" in S1-*|S1x-*) record "$name" "$verdict" "" ;; esac
done <"$OUT_DIR/s1-audit.txt"

# ── S1x: forged-token storm (thresholds fail the run on their own).
curl -fsS -o /dev/null -X POST "$STUB_URL/__stub/reset"
set +e
"$K6" run -e BASE_URL="$BASE_URL" -e STUB_URL="$STUB_URL" -e SEED=20260904 \
  -e DEVICES=20 -e ATTEMPTS=60 \
  --summary-export "$OUT_DIR/s1x-forged-token-storm.summary.json" \
  tools/attack/security-secrets-deps-2/k6-forged-token-storm.js \
  >"$OUT_DIR/s1x-forged-token-storm.stdout" 2>&1
STORM_RC=$?
set -e
if ! grep -E "forged-token-storm|✓|✗" "$OUT_DIR/s1x-forged-token-storm.stdout"; then
  echo "(k6 produced no check/threshold lines — see $OUT_DIR/s1x-forged-token-storm.stdout)"
fi
if [ "$STORM_RC" -eq 0 ]; then
  record "S1x-forged-token-storm-budget-and-no-5xx" HELD "k6 exit 0"
else
  record "S1x-forged-token-storm-budget-and-no-5xx" BROKEN "k6 exit $STORM_RC"
fi

# ── S1y: rapid single-IP repeat of the expired loop far past the auth-failure
# budget — expired bearers count as auth failures, so after 30 the IP is
# throttled (429) and the answer must still never be 5xx.
python3 - "$BASE_URL" "$STUB_URL" >"$OUT_DIR/s1y-single-ip-rapid.txt" <<'EOF'
import base64, json, sys, time, urllib.request, urllib.error
base, stub = sys.argv[1], sys.argv[2]
def b64(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()
tok = b64({"alg":"RS256","typ":"JWT"}) + "." + b64({"iss":"https://appleid.apple.com","sub":"user-7","aud":"wf","exp":int(time.time())-600}) + ".sig"
urllib.request.urlopen(urllib.request.Request(stub + "/__stub/reset", method="POST")).read()
statuses = []
for _ in range(45):
    req = urllib.request.Request(base + "/v1/me/access", headers={"Authorization": "Bearer " + tok, "X-Forwarded-For": "10.97.0.1"})
    try:
        r = urllib.request.urlopen(req); statuses.append(r.status)
    except urllib.error.HTTPError as e:
        statuses.append(e.code)
stats = json.load(urllib.request.urlopen(stub + "/__stub/stats"))
ex = stats.get("auth:/auth/v1/token", 0)
print("statuses=" + ",".join(map(str, statuses)))
print(f"upstream_auth_exchanges={ex}")
ok = all(s in (401, 429) for s in statuses) and 429 in statuses and statuses[:30] == [401]*30 and ex == 0
print("S1y-single-ip-45-expired-401x30-then-429-no-upstream", "HELD" if ok else "BROKEN")
EOF
cat "$OUT_DIR/s1y-single-ip-rapid.txt"
record "$(awk '/^S1y-/{print $1}' "$OUT_DIR/s1y-single-ip-rapid.txt")" \
  "$(awk '/^S1y-/{print $2}' "$OUT_DIR/s1y-single-ip-rapid.txt")" ""

echo
echo "results: $RESULTS"
if [ "$BROKEN" -ne 0 ]; then
  echo "AT LEAST ONE PROBE BROKEN"
  exit 1
fi
echo "ALL PROBES HELD"
