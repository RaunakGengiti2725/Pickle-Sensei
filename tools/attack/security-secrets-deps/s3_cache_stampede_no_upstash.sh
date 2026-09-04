#!/usr/bin/env bash
# S3 — tools/loadtest/wf-cache-stampede.js at CONCURRENCY=200 against the
# local edge fn + __wf__ stub with NO Upstash env (L1 per-isolate cache only).
# Expected: the cold-cache stampede degrades without any 5xx (server_errors
# rate < 1%, every read 2xx/429), k6 thresholds pass (rc=0), and the edge log
# has no unhandled error. Documents the un-coalesced miss fan-out as well.
#
#   tools/attack/security-secrets-deps/s3_cache_stampede_no_upstash.sh [ARTIFACT_DIR]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$HOME/attack-artifacts/s3}"
mkdir -p "$OUT"
CONCURRENCY="${CONCURRENCY:-200}"
STUB_PORT=54399
EDGE_PORT=8000
K6="${K6:-$HOME/.cache/pickle-sensei/k6/k6}"
DENO="${DENO:-$HOME/.deno/bin/deno}"

if [ ! -x "$K6" ]; then
  mkdir -p "$(dirname "$K6")"
  curl -fsSL -o "$(dirname "$K6")/k6.tgz" \
    https://github.com/grafana/k6/releases/download/v1.4.2/k6-v1.4.2-linux-amd64.tar.gz
  tar xzf "$(dirname "$K6")/k6.tgz" -C "$(dirname "$K6")" --strip-components=1
  rm -f "$(dirname "$K6")/k6.tgz"
fi
"$K6" version | tee "$OUT/k6-version.txt"

pids=()
cleanup() { for p in "${pids[@]:-}"; do if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then kill "$p"; fi; done; }
trap cleanup EXIT

wait_for() { # url, tries
  local i
  for i in $(seq 1 "$2"); do
    if curl -sf -o /dev/null "$1"; then return 0; fi
    sleep 0.25
  done
  echo "timeout waiting for $1" >&2
  return 1
}

cd "$REPO_ROOT/supabase/functions/api"

# Stub (auth + PostgREST stand-in with counters).
STUB_PORT=$STUB_PORT "$DENO" run -A --quiet __wf__/supabase_stub.ts >"$OUT/stub.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:$STUB_PORT/__stub/stats" 80

# Edge fn with a MINIMAL env — Upstash vars are guaranteed absent (env -i).
env -i PATH="$PATH" HOME="$HOME" \
  SUPABASE_URL="http://127.0.0.1:$STUB_PORT" SUPABASE_ANON_KEY=x \
  "$DENO" run -A --node-modules-dir=none --quiet index.ts >"$OUT/edge.log" 2>&1 &
pids+=($!)
wait_for "http://127.0.0.1:$EDGE_PORT/healthz" 120

# Prove the fn sees no Upstash config (its own env, not the harness's).
edge_pid=${pids[1]}
if tr '\0' '\n' </proc/"$edge_pid"/environ | grep -q '^UPSTASH_'; then
  echo "harness bug: UPSTASH_* present in edge env" >&2
  exit 2
fi
echo "edge env UPSTASH_* vars: none (pid $edge_pid)" | tee "$OUT/edge-env-check.txt"

rc_k6=0
"$K6" run -e BASE_URL="http://127.0.0.1:$EDGE_PORT" -e STUB_URL="http://127.0.0.1:$STUB_PORT" \
  -e CONCURRENCY="$CONCURRENCY" \
  --summary-export "$OUT/k6-summary.json" \
  "$REPO_ROOT/tools/loadtest/wf-cache-stampede.js" >"$OUT/k6.stdout.log" 2>&1 || rc_k6=$?
echo "k6 rc=$rc_k6"
grep -E "wf-cache-stampede|server_errors|checks|read_latency|http_req_failed|✗|✓" "$OUT/k6.stdout.log" || echo "(k6 printed no summary lines — see $OUT/k6.stdout.log)"

curl -s "http://127.0.0.1:$STUB_PORT/__stub/stats" >"$OUT/stub-stats.json"
curl -s -o /dev/null -w "healthz-after %{http_code}\n" "http://127.0.0.1:$EDGE_PORT/healthz" | tee "$OUT/healthz-after.txt"

python3 - "$OUT" "$rc_k6" "$CONCURRENCY" <<'PY'
import json, sys, re
out, rc, conc = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
s = json.load(open(f"{out}/k6-summary.json"))
m = s["metrics"]
reqs = m["http_reqs"]["count"]
errs = m.get("server_errors", {}).get("passes", 0)  # Rate: passes == true values
def walk(group, acc):
    for k, v in group.get("checks", {}).items():
        if v["fails"]:
            acc[group.get("path", "") + "::" + k] = v["fails"]
    for g in group.get("groups", {}).values():
        walk(g, acc)
    return acc
failed_checks = walk(s["root_group"], {})
read_check = s["root_group"]["checks"]["read is 2xx or 429"]
edge = open(f"{out}/edge.log", errors="replace").read()
unhandled = [l for l in edge.splitlines() if re.search(r"error|uncaught|Error", l)]
stats = json.load(open(f"{out}/stub-stats.json"))
rank = int(stats.get("db:GET /player_technique_rating", 0)) + int(stats.get("db:GET /player_rank_state", 0))
prog = int(stats.get("db:GET /progress_daily", 0)) + int(stats.get("db:GET /practice_days", 0))
auth = int(stats.get("auth:/auth/v1/token", 0))
non2xx = m.get("http_req_failed", {}).get("passes", 0)
print(f"non-2xx responses (all 429 when read check holds): {non2xx}")
print(f"http_reqs={reqs} 5xx_responses={errs} read_2xx_or_429={read_check['passes']}/{read_check['passes']+read_check['fails']} read_latency_p95={m['read_latency']['p(95)']:.1f}ms max={m['read_latency']['max']:.1f}ms")
print(f"stub: rank_db_queries={rank} progress_db_queries={prog} (2 each = coalesced; {2*conc} each = un-coalesced) auth_exchanges={auth} for {reqs-3} authenticated reads")
print(f"edge.log error lines: {len(unhandled)}")
for l in unhandled[:5]: print("  ", l[:200])
print(f"failed k6 checks: {failed_checks}")

# Core scenario: L1-only degrades without 5xx and without an edge error.
core_ok = errs == 0 and read_check["fails"] == 0 and not unhandled
print(f"{'HELD' if core_ok else 'BROKEN'}: S3 core — CONCURRENCY={conc} without Upstash → 5xx={errs}, non-2xx/429 reads={read_check['fails']}, edge errors={len(unhandled)}")
# The script's own teardown assertions + its thresholds (rc≠0 ⇒ thresholds crossed).
script_ok = rc == 0 and not failed_checks
print(f"{'HELD' if script_ok else 'BROKEN'}: S3 script — wf-cache-stampede.js k6 rc={rc}; its teardown checks failing={len(failed_checks)} (asserts un-coalesced misses + 0 auth exchanges; observed rank={rank} progress={prog} auth={auth})")
sys.exit(0 if core_ok and script_ok else 1)
PY
