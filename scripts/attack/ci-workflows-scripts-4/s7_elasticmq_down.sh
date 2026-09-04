#!/usr/bin/env bash
# S7 — the `test` stage with ElasticMQ stopped.
#   1. default (SQS_ENDPOINT_TEST unset): stage passes, log says the 3 SQS
#      suites are skipped — documented behaviour, recorded as-is.
#   2. CI shape: ci.yml sets SQS_ENDPOINT_TEST=http://localhost:9324 EXPLICITLY
#      (the elasticmq service has no health check). If the broker is down the
#      stage must not silently downgrade an explicit requirement into a skip.
#   3. control: broker back up → the SQS suites actually run.
# Only `docker compose stop/start elasticmq` is touched; Postgres stays up.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

OUT="$ATTACK_EVIDENCE/s7"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$REPO_ROOT" || exit 2
DB="${ATTACK_DB_URL:-postgres://pickle:pickle_test_password@localhost:5433/pickle_test}"
trap 'docker compose start elasticmq >/dev/null 2>&1 || true' EXIT

run_test() { # $1 label, $2.. extra `env` arguments (VAR=val or -u VAR)
  local label="$1" rc=0; shift
  env -u SQS_ENDPOINT_TEST "$@" DATABASE_URL_TEST="$DB" VERIFY_ARTIFACTS="$OUT/$label" \
    scripts/verify-cloud.sh --only test >"$OUT/$label.stdout" 2>&1 || rc=$?
  echo "$rc"
}
sqs_suite_lines() { grep -E "sqs.integration" "$1" | head -3; }

log "stopping elasticmq"
docker compose stop elasticmq >"$OUT/compose-stop.log" 2>&1
sleep 1
curl -sS -m 3 -o /dev/null http://localhost:9324/ 2>/dev/null && { log "elasticmq still answering; abort"; exit 2; }

rc="$(run_test default-down)"
assert_eq "broker down, SQS_ENDPOINT_TEST unset: stage exit 0 (documented skip)" 0 "$rc"
assert_eq "broker down, unset: test stage status passed" passed "$(stage_status "$OUT/default-down/summary.json" test)"
assert_grep "broker down, unset: log says the 3 SQS tests are skipped" "unreachable — @pickle/queue skips its 3 SQS tests" "$OUT/default-down/test.log"
assert_grep "broker down, unset: vitest reports the SQS suite skipped" "skipped" "$OUT/default-down/test.log"
log "SQS suite lines: $(sqs_suite_lines "$OUT/default-down/test.log" | tr '\n' '|')"

# CI shape: explicit endpoint, broker down.
rc="$(run_test explicit-down SQS_ENDPOINT_TEST=http://localhost:9324)"
if [ "$rc" = 0 ] && [ "$(stage_status "$OUT/explicit-down/summary.json" test)" = passed ]; then
  verdict BROKEN "explicit SQS_ENDPOINT_TEST with broker down fails/unavailable (not a silent skip)" \
    "exit 0, test=passed; log: $(grep -m1 'SQS_ENDPOINT_TEST=' "$OUT/explicit-down/test.log") — ci.yml sets this var explicitly and its elasticmq service has no health check"
else
  verdict HELD "explicit SQS_ENDPOINT_TEST with broker down fails/unavailable (not a silent skip)" "exit $rc"
fi

# Control: broker up → suites run.
log "starting elasticmq"
docker compose start elasticmq >"$OUT/compose-start.log" 2>&1
for _ in $(seq 1 30); do curl -sS -m 2 -o /dev/null http://localhost:9324/ 2>/dev/null && break; sleep 1; done
rc="$(run_test explicit-up SQS_ENDPOINT_TEST=http://localhost:9324)"
assert_eq "broker up: stage exit 0" 0 "$rc"
assert_grep "broker up: log says SQS tests WILL run" "reachable — @pickle/queue SQS integration tests WILL run" "$OUT/explicit-up/test.log"
assert_not_grep "broker up: SQS suite not skipped" "sqs.integration.test.ts.*skipped" "$OUT/explicit-up/test.log"
log "SQS suite lines: $(sqs_suite_lines "$OUT/explicit-up/test.log" | tr '\n' '|')"

# Skipped-vs-run test counts must differ by the 3 SQS tests.
count_tests() { sed -E 's/\x1b\[[0-9;]*m//g' "$1" | grep -E "^\s*Tests\s" | grep -oE "[0-9]+ passed" | awk '{s+=$1} END {print s+0}'; }
down_n="$(count_tests "$OUT/default-down/test.log")"; up_n="$(count_tests "$OUT/explicit-up/test.log")"
log "tests passed: broker down=$down_n up=$up_n"
assert_eq "broker up runs exactly 3 more tests than broker down" 3 "$((up_n - down_n))"

finish
