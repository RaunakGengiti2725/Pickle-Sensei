#!/usr/bin/env bash
# Regression tests for the `test` stage of scripts/verify-cloud.sh — the SQS
# broker contract — plus the CI service wiring it relies on.
#
#   scripts/tests/verify-cloud-test-stage.test.sh   # exit 0 = every executed case passed
#
# Needs the test Postgres (docker compose up -d postgres_test) and the root
# pnpm deps; each stage run executes the full workspace `pnpm test` (~3 min).
# Cases:
#   A  SQS_ENDPOINT_TEST explicitly set but unreachable -> the stage is
#      unavailable/failed, the run exits non-zero and the summary note names
#      the endpoint (never a silent skip of the SQS suites).
#   B  SQS_ENDPOINT_TEST unset and no broker on the default port -> the stage
#      passes and its summary note states the SQS suites were skipped.
#   C  SQS_ENDPOINT_TEST set to a reachable ElasticMQ -> the stage passes and
#      test.log shows test/sqs.integration.test.ts with 3 tests, 0 skipped.
#   D  .github/workflows/ci.yml declares a health check on the elasticmq service.
# B and C are mutually exclusive on one machine (they depend on whether a
# broker answers on the default port); the one that cannot run here is printed
# as SKIPPED (environment) and does not count as a pass.
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"
VERIFY="$REPO_ROOT/scripts/verify-cloud.sh"
CI_YML="$REPO_ROOT/.github/workflows/ci.yml"
SQS_DEFAULT="http://localhost:9324"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() {
  PASS=$((PASS + 1))
  printf 'ok   - %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL - %s\n' "$1"
  shift
  [ $# -eq 0 ] || printf '       %s\n' "$@"
}
skip_env() { printf 'SKIP - %s (environment: %s)\n' "$1" "$2"; }

# stage_field <summary.json> <field>: the test stage's status or note.
stage_field() {
  python3 - "$1" "$2" <<'PY'
import json, sys
summary = json.load(open(sys.argv[1]))
stage = next(s for s in summary["stages"] if s["name"] == "test")
print(stage[sys.argv[2]])
PY
}

# run_test_stage <artifacts dir> [ENV=VALUE ...] -> RC
run_test_stage() {
  local out="$1"
  shift
  RC=0
  (
    cd "$REPO_ROOT"
    unset SQS_ENDPOINT_TEST
    env "$@" VERIFY_ARTIFACTS="$out" "$VERIFY" --only test
  ) >"$out.stdout" 2>&1 || RC=$?
}

# ------------------------------------------------------------- case A -----
run_test_stage "$WORK/a" SQS_ENDPOINT_TEST=http://127.0.0.1:9
A_STATUS="$(stage_field "$WORK/a/summary.json" status 2>/dev/null || echo missing)"
A_NOTE="$(stage_field "$WORK/a/summary.json" note 2>/dev/null || echo "")"
if [ "$RC" -ne 0 ] && { [ "$A_STATUS" = unavailable ] || [ "$A_STATUS" = failed ]; } && [[ "$A_NOTE" == *"127.0.0.1:9"* ]]; then
  pass "A: explicit unreachable SQS_ENDPOINT_TEST -> exit $RC, stage $A_STATUS, note names the endpoint"
else
  fail "A: explicit unreachable SQS_ENDPOINT_TEST fails the stage" "exit=$RC (want non-zero) status=$A_STATUS note=$A_NOTE"
  tail -n 15 "$WORK/a.stdout" | sed 's/^/       | /'
fi

# ------------------------------------------------------- cases B / C -----
if curl -sS -m 3 -o /dev/null "$SQS_DEFAULT/" 2>/dev/null; then
  skip_env "B: unset SQS_ENDPOINT_TEST without a broker -> pass with 'skipped' note" "a broker answers on $SQS_DEFAULT; stop it (docker compose stop elasticmq) to exercise the skip path"
  run_test_stage "$WORK/c" SQS_ENDPOINT_TEST="$SQS_DEFAULT"
  C_STATUS="$(stage_field "$WORK/c/summary.json" status 2>/dev/null || echo missing)"
  if [ "$RC" -eq 0 ] && [ "$C_STATUS" = passed ] && grep -Eq 'test/sqs\.integration\.test\.ts.*3 tests' "$WORK/c/test.log" && ! grep -Eq 'test/sqs\.integration\.test\.ts.*skipped' "$WORK/c/test.log"; then
    pass "C: reachable SQS_ENDPOINT_TEST=$SQS_DEFAULT -> stage passed, sqs.integration.test.ts 3 tests, 0 skipped"
  else
    fail "C: reachable SQS_ENDPOINT_TEST runs the SQS suites" "exit=$RC status=$C_STATUS" "$(grep -E 'sqs\.integration' "$WORK/c/test.log" 2>/dev/null | head -n 2)"
    tail -n 15 "$WORK/c.stdout" | sed 's/^/       | /'
  fi
else
  skip_env "C: reachable SQS_ENDPOINT_TEST -> SQS suites run (3 tests, 0 skipped)" "no broker on $SQS_DEFAULT; docker compose up -d elasticmq to exercise it"
  run_test_stage "$WORK/b"
  B_STATUS="$(stage_field "$WORK/b/summary.json" status 2>/dev/null || echo missing)"
  B_NOTE="$(stage_field "$WORK/b/summary.json" note 2>/dev/null || echo "")"
  if [ "$RC" -eq 0 ] && [ "$B_STATUS" = passed ] && [[ "${B_NOTE,,}" == *"sqs"*"skipped"* ]]; then
    pass "B: unset SQS_ENDPOINT_TEST without a broker -> stage passed, note: $B_NOTE"
  else
    fail "B: unset SQS_ENDPOINT_TEST without a broker passes with an 'SQS suites skipped' note" "exit=$RC status=$B_STATUS note='$B_NOTE'"
    tail -n 15 "$WORK/b.stdout" | sed 's/^/       | /'
  fi
fi

# ------------------------------------------------------------- case D -----
ELASTICMQ_BLOCK="$(awk '/^      elasticmq:/{on=1; next} on && /^      [a-z]/{on=0} on' "$CI_YML")"
if [ -n "$ELASTICMQ_BLOCK" ] && grep -q -- '--health-cmd' <<<"$ELASTICMQ_BLOCK"; then
  pass "D: ci.yml elasticmq service declares a health check"
else
  fail "D: ci.yml elasticmq service declares a health check" "no --health-cmd in the elasticmq service block of .github/workflows/ci.yml"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
