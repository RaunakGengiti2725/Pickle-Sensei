#!/usr/bin/env bash
# Regression tests for scripts/verify-cloud.sh's verdict: `ok` / the exit code
# must be computed from the recorded stage statuses — a run in which nothing
# executed (or in which a selected stage was skipped) is never "OK".
#
#   scripts/tests/test_verify_cloud_cli.sh
#
# Runs the real script against this checkout with cheap stages only (ml =
# python3 unittests, e2e fails fast on a missing browser path), so it needs
# python3 and jq.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$REPO_ROOT"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $*"; }
check() {
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

# ok must equal "at least one stage was recorded and every recorded stage passed".
# (Plain `all` over an empty list is vacuously true, which is exactly the bug.)
OK_INVARIANT='.ok == ((.stages | length) > 0 and all(.stages[]; .status == "passed"))'
check_invariant() {
  check "$1: ok equals (every recorded stage passed) — $(jq -c '{ok, statuses: [.stages[].status]}' "$2")" \
    jq -e "$OK_INVARIANT" "$2" >/dev/null
}

run_vc() {
  # run_vc <case> <args...>; sets RC and SUMMARY
  local name="$1"
  shift
  SUMMARY="$TMP/$name/summary.json"
  VERIFY_ARTIFACTS="$TMP/$name" scripts/verify-cloud.sh "$@" >"$TMP/$name.log" 2>&1
  RC=$?
}

echo "# --only ml --skip ml (zero stages executed)"
run_vc only_skip --only ml --skip ml
check "exits non-zero (got $RC)" [ "$RC" -ne 0 ]
check "summary ok:false" jq -e '.ok == false' "$SUMMARY" >/dev/null
check "summary reason mentions 'no stages executed' — $(jq -r '.reason // "<missing>"' "$SUMMARY")" \
  jq -e '.reason | test("no stages executed")' "$SUMMARY" >/dev/null
check "stdout says so instead of 'verify-cloud: OK'" grep -q 'no stages executed' "$TMP/only_skip.log"
check "stdout never prints 'verify-cloud: OK'" bash -c "! grep -q 'verify-cloud: OK' '$TMP/only_skip.log'"
check_invariant "--only ml --skip ml" "$SUMMARY"

echo "# --tier pr --skip <every pr stage>"
run_vc pr_skip_all --tier pr --skip deps,format,lint,typecheck,test,db,mobile,ml,edge,rls,security
check "exits non-zero (got $RC)" [ "$RC" -ne 0 ]
check "summary ok:false with 11 skipped stages" \
  jq -e '.ok == false and ([.stages[] | select(.status == "skipped")] | length) == 11' "$SUMMARY" >/dev/null
check_invariant "--tier pr --skip all" "$SUMMARY"

echo "# --only ml,release --skip release (one executed pass, one skipped)"
run_vc mixed_skip --only ml,release --skip release
check "exits non-zero: a skipped stage is not a pass (got $RC)" [ "$RC" -ne 0 ]
check "summary ok:false, reason names the skipped stage — $(jq -r '.reason // "<missing>"' "$SUMMARY")" \
  jq -e '.ok == false and (.reason | test("release"))' "$SUMMARY" >/dev/null
check_invariant "--only ml,release --skip release" "$SUMMARY"

echo "# --only e2e with an unreachable browser path (unavailable stage)"
export PLAYWRIGHT_BROWSERS_PATH="$TMP/no-browsers-here"
run_vc unavailable --only e2e
unset PLAYWRIGHT_BROWSERS_PATH
check "exits non-zero (got $RC)" [ "$RC" -ne 0 ]
check "summary ok:false" jq -e '.ok == false' "$SUMMARY" >/dev/null
check_invariant "--only e2e (unavailable)" "$SUMMARY"

echo "# --only ml (normal run, everything passes)"
run_vc normal --only ml
check "exits 0 (got $RC)" [ "$RC" -eq 0 ]
check "summary ok:true" jq -e '.ok == true' "$SUMMARY" >/dev/null
check "stdout prints 'verify-cloud: OK'" grep -q 'verify-cloud: OK' "$TMP/normal.log"
check_invariant "--only ml" "$SUMMARY"

echo
echo "test_verify_cloud_cli: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
