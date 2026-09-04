#!/usr/bin/env bash
# Regression tests for tools/macos-ci/xcresult-summary.py (CI-11): the summary
# must exit non-zero when a named bundle is missing or unreadable, or when zero
# bundles were summarised — a stage that produced no .xcresult cannot report a
# clean summary. Uses a fake `xcrun` on PATH; runs on Linux.
#
# Usage: scripts/tests/test_xcresult_summary.sh        (exit 0 = all pass)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUMMARY="$REPO_ROOT/tools/macos-ci/xcresult-summary.py"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fake xcrun: FAKE_XCRUN_RC != 0 -> fail; otherwise print $FAKE_XCRUN_JSON.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/xcrun" <<'EOF'
#!/usr/bin/env bash
if [ "${FAKE_XCRUN_RC:-0}" -ne 0 ]; then
  echo "xcresulttool: unable to read bundle" >&2; exit "${FAKE_XCRUN_RC}"
fi
printf '%s\n' "${FAKE_XCRUN_JSON}"
EOF
chmod +x "$WORK/bin/xcrun"
export PATH="$WORK/bin:$PATH"

GREEN='{"result":"Passed","totalTestCount":12,"passedTests":12,"failedTests":0,"skippedTests":0,"testFailures":[]}'
RED='{"result":"Failed","totalTestCount":12,"passedTests":11,"failedTests":1,"skippedTests":0,"testFailures":[{"testName":"T.a","failureText":"boom"}]}'

mkdir -p "$WORK/Good.xcresult" "$WORK/Broken.xcresult"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }

run() { OUTPUT="$(env "$@" python3 "$SUMMARY" "${ARGS[@]}" 2>&1)"; RC=$?; }

echo "## 1. missing bundle path"
ARGS=("$WORK/Missing.xcresult"); run FAKE_XCRUN_JSON="$GREEN"
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'
check "prints (missing)" '[[ "$OUTPUT" == *"(missing)"* ]]'

echo "## 2. xcrun fails for every bundle"
ARGS=("$WORK/Broken.xcresult"); run FAKE_XCRUN_RC=1 FAKE_XCRUN_JSON=""
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'
check "reports the unreadable bundle" '[[ "$OUTPUT" == *"Broken.xcresult"* ]]'

echo "## 3. xcrun fails + missing (the swift-native failure mode)"
ARGS=("$WORK/Broken.xcresult" "$WORK/Missing.xcresult"); run FAKE_XCRUN_RC=1 FAKE_XCRUN_JSON=""
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'

echo "## 4. unmatched glob passed literally"
ARGS=("$WORK/nothing-here/*.xcresult"); run FAKE_XCRUN_JSON="$GREEN"
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'

echo "## 5. no arguments"
ARGS=(); run FAKE_XCRUN_JSON="$GREEN"
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'

echo "## 6. one readable bundle, 0 failed tests"
ARGS=("$WORK/Good.xcresult"); run FAKE_XCRUN_JSON="$GREEN"
check "exits 0 (rc=$RC)" '[ "$RC" -eq 0 ]'
check "prints the pass line" '[[ "$OUTPUT" == *"Good.xcresult"*"failed 0"* ]]'

echo "## 7. one readable bundle, failedTests > 0"
ARGS=("$WORK/Good.xcresult"); run FAKE_XCRUN_JSON="$RED"
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'
check "lists the failed test" '[[ "$OUTPUT" == *"FAILED T.a"* ]]'

echo "## 8. one good bundle plus one missing bundle"
ARGS=("$WORK/Good.xcresult" "$WORK/Missing.xcresult"); run FAKE_XCRUN_JSON="$GREEN"
check "exits non-zero (rc=$RC)" '[ "$RC" -ne 0 ]'

echo
echo "test_xcresult_summary: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
