#!/usr/bin/env bash
# Regression tests for scripts/verify-cloud.sh's run verdict and summary.json.
#
# Runs on Linux with no services: the cases use cheap stages (the ml unittests,
# a fake python3 that fails, an e2e stage whose browsers are missing) and skip
# lists, then check the exit code, the final verdict line and summary.json
# against REVIEW.md's rule that a skipped stage is never a pass:
#
#   * zero executed stages (--only ml --skip ml, or --tier pr with every stage
#     skipped) is a non-zero exit and ok:false with a "no stages executed" reason
#   * any skipped/unavailable/failed stage is ok:false and a non-zero exit
#   * ok == every recorded stage status is "passed" for every run
#   * a run whose stages all pass still exits 0 with ok:true
#
# Usage: scripts/tests/test_verify_cloud.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/verify-cloud.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RC=0

pass() { echo "[test_verify_cloud] PASS: $*"; }
flunk() { echo "[test_verify_cloud] FAIL: $*" >&2; }

for tool in jq node python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 75; }
done

# A python3 that fails every unittest run; everything else is untouched.
mkdir -p "$WORK/failpy"
cat >"$WORK/failpy/python3" <<'SH'
#!/usr/bin/env bash
echo "fake python3: forced failure" >&2
exit 1
SH
chmod +x "$WORK/failpy/python3"

# run <label> <env assignments...> -- <verify-cloud args...>
# Leaves: $OUT (stdout+stderr), $CODE, $SUMMARY (summary.json path).
run() {
  local label="$1"; shift
  local -a envs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  local dir="$WORK/$label"
  mkdir -p "$dir"
  OUT="$dir/run.out"; SUMMARY="$dir/summary.json"
  (cd "$REPO_ROOT" && env "${envs[@]}" VERIFY_ARTIFACTS="$dir" "$SCRIPT" "$@") >"$OUT" 2>&1
  CODE=$?
}

# Invariants every run must satisfy, whatever its stages did.
check_invariants() {
  local label="$1" ok all_passed
  if ! jq -e . "$SUMMARY" >/dev/null 2>&1; then
    RC=1; flunk "$label: summary.json is not valid JSON"; return
  fi
  ok="$(jq -r '.ok' "$SUMMARY")"
  all_passed="$(jq -r '[.stages[].status] | all(. == "passed")' "$SUMMARY")"
  if [ "$ok" = "$all_passed" ]; then
    pass "$label: ok ($ok) == every recorded stage passed ($all_passed)"
  else
    RC=1; flunk "$label: ok=$ok but every-stage-passed=$all_passed — ok must be computed from the recorded statuses"
  fi
  if [ "$ok" = true ] && [ "$CODE" -ne 0 ]; then
    RC=1; flunk "$label: ok:true but exit $CODE"
  elif [ "$ok" = false ] && [ "$CODE" -eq 0 ]; then
    RC=1; flunk "$label: ok:false but exit 0"
  else
    pass "$label: exit code $CODE agrees with ok:$ok"
  fi
  # A skipped stage is recorded but not executed.
  if [ "$(jq -r '[.stages[] | select(.status != "skipped")] | length' "$SUMMARY")" -eq 0 ]; then
    if jq -e '.ok == false' "$SUMMARY" >/dev/null && jq -r '.reason' "$SUMMARY" | grep -qi 'no stages executed'; then
      pass "$label: zero stages executed → ok:false with a 'no stages executed' reason"
    else
      RC=1; flunk "$label: zero stages executed but ok=$ok reason=$(jq -r '.reason' "$SUMMARY")"
    fi
  fi
}

# ---------------------------------------------------------------- CI-03 ----

# 1. --only ml --skip ml: nothing runs.
run only-skip -- --only ml --skip ml
check_invariants "only ml --skip ml"
if [ "$CODE" -ne 0 ]; then
  pass "only ml --skip ml exits non-zero ($CODE)"
else
  RC=1; flunk "only ml --skip ml exited 0 with zero stages executed"
fi
if grep -qi 'no stages executed' "$OUT"; then
  pass "only ml --skip ml says 'no stages executed'"
else
  RC=1; flunk "only ml --skip ml output does not mention 'no stages executed'"; tail -n 3 "$OUT" >&2
fi
if grep -q 'verify-cloud: OK' "$OUT"; then
  RC=1; flunk "only ml --skip ml printed 'verify-cloud: OK'"
else
  pass "only ml --skip ml does not print 'verify-cloud: OK'"
fi
if jq -e '.ok == false' "$SUMMARY" >/dev/null 2>&1; then
  pass "only ml --skip ml summary ok:false"
else
  RC=1; flunk "only ml --skip ml summary ok is $(jq -r '.ok' "$SUMMARY" 2>&1)"
fi

# 2. --tier pr with every PR stage skipped.
PR_STAGES="$(sed -n 's/^PR_STAGES=(\(.*\))$/\1/p' "$SCRIPT" | tr ' ' ',')"
[ -n "$PR_STAGES" ] || { RC=1; flunk "could not read PR_STAGES from $SCRIPT"; }
run pr-all-skipped -- --tier pr --skip "$PR_STAGES"
check_invariants "tier pr --skip <all>"
if [ "$CODE" -ne 0 ]; then
  pass "tier pr --skip <all pr stages> exits non-zero ($CODE)"
else
  RC=1; flunk "tier pr --skip <all pr stages> exited 0"
fi
if [ "$(jq -r '[.stages[] | select(.status == "skipped")] | length' "$SUMMARY")" -eq "$(jq -r '.stages | length' "$SUMMARY")" ]; then
  pass "tier pr --skip <all>: every recorded stage is skipped"
else
  RC=1; flunk "tier pr --skip <all>: expected only skipped stages"
fi

# 3. One stage passes, one is skipped: skipped is not a pass.
run pass-plus-skip -- --only ml,edge --skip edge
check_invariants "only ml,edge --skip edge"
if [ "$(jq -r '.stages[] | select(.name == "ml") | .status' "$SUMMARY")" = passed ] \
  && [ "$(jq -r '.stages[] | select(.name == "edge") | .status' "$SUMMARY")" = skipped ]; then
  pass "only ml,edge --skip edge records ml=passed edge=skipped"
else
  RC=1; flunk "only ml,edge --skip edge: unexpected statuses $(jq -c '[.stages[] | {name, status}]' "$SUMMARY")"
fi
if [ "$CODE" -ne 0 ] && jq -e '.ok == false' "$SUMMARY" >/dev/null; then
  pass "a skipped stage makes the run ok:false / non-zero ($CODE)"
else
  RC=1; flunk "a skipped stage was reported as a pass (exit $CODE, ok=$(jq -r .ok "$SUMMARY"))"
fi
if grep -Eqi 'skipped' "$OUT" && ! grep -q 'verify-cloud: OK' "$OUT"; then
  pass "verdict line names the skipped stage instead of OK"
else
  RC=1; flunk "verdict for a skipped stage: $(tail -n 1 "$OUT")"
fi

# 4. All selected stages pass: unchanged behaviour.
run all-passed -- --only ml
check_invariants "only ml (all passed)"
if [ "$CODE" -eq 0 ] && jq -e '.ok == true' "$SUMMARY" >/dev/null && grep -q 'verify-cloud: OK' "$OUT"; then
  pass "only ml with everything passing: exit 0, ok:true, 'verify-cloud: OK'"
else
  RC=1; flunk "only ml (all passed) exit=$CODE ok=$(jq -r .ok "$SUMMARY")"; tail -n 3 "$OUT" >&2
fi

# 5. A failed stage.
run failed PATH="$WORK/failpy:$PATH" -- --only ml
check_invariants "only ml (failing python3)"
if [ "$CODE" -ne 0 ] && [ "$(jq -r '.stages[0].status' "$SUMMARY")" = failed ] && grep -q 'verify-cloud: FAILED' "$OUT"; then
  pass "a failed stage: exit $CODE, status failed, 'verify-cloud: FAILED'"
else
  RC=1; flunk "failed stage: exit=$CODE status=$(jq -r '.stages[0].status' "$SUMMARY")"; tail -n 3 "$OUT" >&2
fi

# 6. An unavailable stage (exit 75).
run unavailable PLAYWRIGHT_BROWSERS_PATH="$WORK/no-browsers" -- --only e2e
check_invariants "only e2e (browsers missing)"
if [ "$CODE" -ne 0 ] && [ "$(jq -r '.stages[0].status' "$SUMMARY")" = unavailable ]; then
  pass "an unavailable stage: exit $CODE, status unavailable"
else
  RC=1; flunk "unavailable stage: exit=$CODE status=$(jq -r '.stages[0].status' "$SUMMARY")"; tail -n 3 "$OUT" >&2
fi

if [ $RC -eq 0 ]; then
  pass "verify-cloud.sh verdict and summary.json behave as specified"
else
  flunk "verify-cloud.sh verdict/summary regressions above"
fi
exit $RC
