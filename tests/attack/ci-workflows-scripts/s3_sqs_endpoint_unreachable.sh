#!/usr/bin/env bash
# S3 — SQS_ENDPOINT_TEST exported while ElasticMQ is stopped.
#
# Attack: export SQS_ENDPOINT_TEST=http://localhost:9324, stop the elasticmq
# container, run `scripts/verify-cloud.sh --only test` and check that the
# `test` stage UNSETS the variable before `pnpm test` (so @pickle/queue's
# describe.skipIf(!endpoint) skips instead of hammering a dead broker).
#
# Default mode puts a `pnpm` shim on PATH that records the environment the
# stage hands to `pnpm test` and exits 0 — this isolates the stage's probe
# logic and runs in seconds. `--real` runs the actual `pnpm test` as well.
#
# Extra vectors exercised in the same run (each one a separate stage run):
#   blackhole  SQS_ENDPOINT_TEST -> RFC 5737 TEST-NET address (SYN never answered)
#   nonhttp    SQS_ENDPOINT_TEST -> the postgres_test port (TCP open, not HTTP)
#   empty      SQS_ENDPOINT_TEST='' (must fall back to the default and probe it)
#   up         ElasticMQ running again — the variable must be KEPT/exported
#
# Exit 0 = every case HELD, exit 1 = at least one BROKEN.
# Results: $OUT/results.jsonl (+ one verify-cloud artifact dir per case).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${S3_OUT:-/tmp/attack-s3-$(date -u +%Y%m%dT%H%M%SZ)}"
REAL=0
[ "${1:-}" = "--real" ] && REAL=1
mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2

: >"$OUT/results.jsonl"
BROKEN=0

SHIM="$OUT/shim"
mkdir -p "$SHIM"
REAL_PNPM="$(command -v pnpm)"
cat >"$SHIM/pnpm" <<EOF
#!/usr/bin/env bash
# records what the test stage exported, then optionally runs the real pnpm
{
  printf 'ARGS=%s\n' "\$*"
  if [ -n "\${SQS_ENDPOINT_TEST+x}" ]; then printf 'SQS_ENDPOINT_TEST=SET:%s\n' "\$SQS_ENDPOINT_TEST"; else echo 'SQS_ENDPOINT_TEST=UNSET'; fi
} >>"\$S3_SHIM_LOG"
if [ "\$S3_REAL" = 1 ]; then exec "$REAL_PNPM" "\$@"; fi
exit 0
EOF
chmod +x "$SHIM/pnpm"

# run_case <label> <expect: UNSET|SET> <env value or literal __unset__>
run_case() {
  local label="$1" expect="$2" value="$3" art="$OUT/$1-artifacts" rc start end verdict seen status
  export S3_SHIM_LOG="$OUT/$label.shim.log" S3_REAL="$REAL"
  : >"$S3_SHIM_LOG"
  start=$(date +%s)
  if [ "$value" = "__unset__" ]; then
    ( unset SQS_ENDPOINT_TEST; PATH="$SHIM:$PATH" VERIFY_ARTIFACTS="$art" timeout 600 scripts/verify-cloud.sh --only test ) >"$OUT/$label.out" 2>&1
  else
    ( export SQS_ENDPOINT_TEST="$value"; PATH="$SHIM:$PATH" VERIFY_ARTIFACTS="$art" timeout 600 scripts/verify-cloud.sh --only test ) >"$OUT/$label.out" 2>&1
  fi
  rc=$?
  end=$(date +%s)
  seen="$(grep -m1 '^SQS_ENDPOINT_TEST=' "$S3_SHIM_LOG" | cut -d= -f2- | cut -d: -f1)"
  status="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["stages"][0]["status"])' "$art/summary.json" 2>/dev/null || echo parse-error)"
  verdict=HELD
  [ "$seen" = "$expect" ] || verdict=BROKEN
  [ $REAL = 1 ] && [ "$status" != passed ] && verdict=BROKEN
  [ $REAL = 0 ] && [ "$rc" -ne 0 ] && verdict=BROKEN
  [ $verdict = BROKEN ] && BROKEN=1
  printf '{"case":"%s","env_value":"%s","expected_in_pnpm_env":"%s","seen_in_pnpm_env":"%s","stage_status":"%s","verify_exit":%d,"seconds":%d,"verdict":"%s","stage_log":"%s"}\n' \
    "$label" "$value" "$expect" "${seen:-none}" "$status" "$rc" "$((end - start))" "$verdict" "$art/test.log" | tee -a "$OUT/results.jsonl"
}

echo "== stopping elasticmq"
docker compose stop elasticmq >"$OUT/docker-stop.log" 2>&1 || { echo "docker compose stop failed"; cat "$OUT/docker-stop.log"; exit 2; }
trap 'docker compose start elasticmq >/dev/null 2>&1 || docker compose up -d elasticmq >/dev/null 2>&1' EXIT

run_case stopped   UNSET "http://localhost:9324"
run_case blackhole UNSET "http://192.0.2.1:9324"
run_case nonhttp   UNSET "http://localhost:5433"
run_case empty     UNSET ""
run_case unsetenv  UNSET "__unset__"

echo "== starting elasticmq"
docker compose start elasticmq >"$OUT/docker-start.log" 2>&1 || docker compose up -d elasticmq >>"$OUT/docker-start.log" 2>&1
for _ in $(seq 1 30); do curl -sS -m 2 -o /dev/null http://localhost:9324/ 2>/dev/null && break; sleep 1; done
run_case up SET "http://localhost:9324"

echo "== results: $OUT/results.jsonl"
cat "$OUT/results.jsonl"
exit $BROKEN
