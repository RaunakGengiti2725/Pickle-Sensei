#!/usr/bin/env bash
# Execution audit harness for the ci-workflows-scripts subsystem
# (scripts/verify-cloud.sh, scripts/security-scan.sh, tools/macos-ci/*).
#
# Every check asserts the behaviour the scripts SHOULD have. A check that fails
# today documents a reproduced finding; a check that passes is a regression
# guard. Runs on Linux with no Docker requirement (no stage that needs a
# database is executed). Needs: bash, python3, git, network or a cached
# gitleaks (scripts/security-scan.sh downloads the pinned binary once).
#
#   tools/audit/ci-scripts-execution-audit.sh          # run all checks
#   tools/audit/ci-scripts-execution-audit.sh --list   # list check names
#
# Exit 0 = every expectation held, 1 = at least one expectation failed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-scripts-audit.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
PASSED=0
pass() { PASSED=$((PASSED + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n        expected: %s\n        observed: %s\n' "$1" "$2" "$3"; }
expect_eq() { # name expected observed
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi
}

# --- select-simulator.sh -----------------------------------------------------
check_select_simulator_uses_available_device() {
  local bin="$WORK/fakebin"; mkdir -p "$bin"
  cat >"$bin/xcrun" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"list devices available -j"*) echo '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{"isAvailable":true,"name":"iPhone 17 Pro","state":"Booted","udid":"AAAA-1111"}]}}';;
  *"list runtimes -j"*) echo '{"runtimes":[{"isAvailable":true,"platform":"iOS","version":"26.4","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-4"}]}';;
  *"list devicetypes -j"*) echo '{"devicetypes":[{"name":"iPhone 11 Pro","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"}]}';;
  *"create"*) echo "NEW-CREATED-UDID";;
  *) echo "fake xcrun: unexpected $*" >&2; exit 1;;
esac
EOF
  chmod +x "$bin/xcrun"
  local out err rc
  out="$(PATH="$bin:$PATH" tools/macos-ci/select-simulator.sh 2>"$WORK/sel.err")"; rc=$?
  err="$(cat "$WORK/sel.err")"
  expect_eq "select-simulator: exit 0 with a valid device list" 0 "$rc"
  expect_eq "select-simulator: returns the existing available iPhone" "AAAA-1111" "$out"
  case "$err" in
    *SyntaxError*) fail "select-simulator: python selector parses" "no SyntaxError" "$(grep -m1 SyntaxError <<<"$err")" ;;
    *) pass "select-simulator: python selector parses" ;;
  esac
  case "$err" in
    *"creating simulator"*) fail "select-simulator: does not create a new simulator when one exists" "no 'creating simulator'" "created a new device" ;;
    *) pass "select-simulator: does not create a new simulator when one exists" ;;
  esac
}

# --- scripts/verify-cloud.sh --------------------------------------------------
check_verify_cloud_arg_validation() {
  local rc out
  VERIFY_ARTIFACTS="$WORK/vc-bogus" scripts/verify-cloud.sh --only bogus >/dev/null 2>&1; rc=$?
  expect_eq "verify-cloud: --only bogus exits 2" 2 "$rc"
  VERIFY_ARTIFACTS="$WORK/vc-tier" scripts/verify-cloud.sh --tier bogus >/dev/null 2>&1; rc=$?
  expect_eq "verify-cloud: --tier bogus exits 2" 2 "$rc"
  scripts/verify-cloud.sh --nope >/dev/null 2>&1; rc=$?
  expect_eq "verify-cloud: unknown option exits 2" 2 "$rc"

  out="$(VERIFY_ARTIFACTS="$WORK/vc-noval" scripts/verify-cloud.sh --tier 2>&1)"; rc=$?
  expect_eq "verify-cloud: --tier without a value exits 2 (usage), not an unbound-variable crash" 2 "$rc"
  out="$(VERIFY_ARTIFACTS="$WORK/vc-noval2" scripts/verify-cloud.sh --only 2>&1)"; rc=$?
  expect_eq "verify-cloud: --only without a value exits 2 (usage), not an unbound-variable crash" 2 "$rc"

  # Stage names must be validated BEFORE any stage runs: with an unknown name
  # in the list nothing should execute.
  VERIFY_ARTIFACTS="$WORK/vc-lazy" scripts/verify-cloud.sh --only ml,bogus >/dev/null 2>&1; rc=$?
  expect_eq "verify-cloud: --only ml,bogus exits 2" 2 "$rc"
  if [ -f "$WORK/vc-lazy/ml.log" ]; then
    fail "verify-cloud: no stage runs when the stage list is invalid" "ml.log absent" "ml stage executed before 'bogus' was rejected"
  else
    pass "verify-cloud: no stage runs when the stage list is invalid"
  fi

  VERIFY_ARTIFACTS="$WORK/vc-skipbogus" scripts/verify-cloud.sh --only ml --skip bogus >/dev/null 2>&1; rc=$?
  expect_eq "verify-cloud: --skip with an unknown stage name is rejected (exit 2)" 2 "$rc"
}

check_verify_cloud_sigterm_writes_summary_and_reaps_children() {
  local dir="$WORK/vc-int" pid rc
  VERIFY_ARTIFACTS="$dir" scripts/verify-cloud.sh --only format,ml >"$WORK/vc-int.stdout" 2>&1 &
  pid=$!
  sleep 6
  kill -TERM "$pid" 2>/dev/null
  wait "$pid"; rc=$?
  sleep 2
  local orphans
  orphans="$(pgrep -af 'prettier --check' | grep -v pgrep || true)"
  if [ -n "$orphans" ]; then
    fail "verify-cloud: SIGTERM terminates the running stage's child processes" "no prettier process after the parent exited" "$orphans"
    pkill -f 'prettier --check' 2>/dev/null || true
  else
    pass "verify-cloud: SIGTERM terminates the running stage's child processes"
  fi
  if [ -f "$dir/summary.json" ]; then
    pass "verify-cloud: summary.json is written when the run is interrupted"
  else
    fail "verify-cloud: summary.json is written when the run is interrupted" "summary.json present (interrupted/failed)" "absent; exit $rc, only per-stage logs remain"
  fi
}

check_verify_cloud_security_stage_keeps_report() {
  # A failing security stage in CI is only actionable if the redacted finding
  # report is part of the uploaded artifacts.
  if grep -q -- '--report-dir' scripts/verify-cloud.sh; then
    pass "verify-cloud: security stage writes the redacted gitleaks report into the artifact dir"
  else
    fail "verify-cloud: security stage writes the redacted gitleaks report into the artifact dir" \
      "stage_security passes --report-dir \"\$ARTIFACTS/...\" (or --verbose)" \
      "security-scan.sh is invoked without --report-dir/--verbose; security.log only says 'leaks found: N'"
  fi
}

# --- scripts/security-scan.sh -------------------------------------------------
check_security_scan_exit_codes() {
  local rc
  GITLEAKS_BIN=/etc/hostname scripts/security-scan.sh --tree >/dev/null 2>&1; rc=$?
  expect_eq "security-scan: non-executable GITLEAKS_BIN exits 2" 2 "$rc"
  scripts/security-scan.sh --tree --history >/dev/null 2>&1; rc=$?
  expect_eq "security-scan: --tree --history are mutually exclusive (exit 2)" 2 "$rc"
  scripts/security-scan.sh --bogus >/dev/null 2>&1; rc=$?
  expect_eq "security-scan: unknown option exits 2" 2 "$rc"
  XDG_CACHE_HOME="$WORK/empty-cache" SECURITY_SCAN_OFFLINE=1 scripts/security-scan.sh --tree >/dev/null 2>&1; rc=$?
  expect_eq "security-scan: offline cache miss exits 2" 2 "$rc"

  scripts/security-scan.sh --tree --report-dir /proc/nope/reports >/dev/null 2>&1; rc=$?
  expect_eq "security-scan: unwritable --report-dir is a setup failure (exit 2)" 2 "$rc"

  local fake="$WORK/fake-gitleaks"; mkdir -p "$fake"
  printf '#!/bin/sh\nexit 0\n' >"$fake/gitleaks"; chmod +x "$fake/gitleaks"
  GITLEAKS_BIN="$fake/gitleaks" scripts/security-scan.sh --tree --report-dir "$WORK/fake-report" >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 0 ] && [ ! -s "$WORK/fake-report/gitleaks-tree.json" ]; then
    fail "security-scan: a scanner that exits 0 without producing the requested report is not a PASS" \
      "non-zero exit or gitleaks-tree.json present" "exit 0 and no report file"
  else
    pass "security-scan: a scanner that exits 0 without producing the requested report is not a PASS"
  fi
}

check_security_scan_detects_planted_secret() {
  local planted="$ROOT/tmp-audit-planted-secret.txt" rc
  printf 'SUPABASE_KEY=sb_secret_%s\n' "$(head -c 40 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" >"$planted"
  scripts/security-scan.sh --tree --report-dir "$WORK/planted-report" >/dev/null 2>&1; rc=$?
  rm -f "$planted"
  expect_eq "security-scan: planted sb_secret_ in the tree fails the scan (exit 1)" 1 "$rc"
  if [ -s "$WORK/planted-report/gitleaks-tree.json" ] && ! grep -q "sb_secret_" "$WORK/planted-report/gitleaks-tree.json"; then
    pass "security-scan: report is written and redacted"
  else
    fail "security-scan: report is written and redacted" "gitleaks-tree.json present without the raw secret" "missing or unredacted"
  fi
}

check_security_scan_history_scope_is_head_lineage() {
  # The history scan must gate the commits under test (HEAD lineage), not
  # every ref the checkout happens to have fetched. A leak committed on an
  # unrelated orphan branch must not fail the scan of HEAD.
  local clone="$WORK/clone" rc
  git clone -q --no-hardlinks --no-local "$ROOT" "$clone" 2>/dev/null || { fail "security-scan: history scan scoped to HEAD lineage" "clone" "git clone failed"; return; }
  (
    cd "$clone" || exit 1
    git -c user.name=audit -c user.email=audit@example.invalid checkout -q --orphan audit/unrelated-leak
    git rm -rqf . >/dev/null 2>&1 || true
    printf 'SUPABASE_KEY=sb_secret_%s\n' "$(head -c 40 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" >leak.txt
    git add leak.txt
    git -c user.name=audit -c user.email=audit@example.invalid commit -qm "unrelated branch with a planted secret"
    git checkout -q -f "$(git -C "$ROOT" rev-parse HEAD)" 2>/dev/null || git checkout -q -f main
  ) || { fail "security-scan: history scan scoped to HEAD lineage" "fixture" "could not build fixture clone"; return; }
  (cd "$clone" && scripts/security-scan.sh --history >"$WORK/history-scope.log" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "security-scan: history scan scoped to HEAD lineage (leak on an unrelated ref does not fail HEAD)"
  else
    fail "security-scan: history scan scoped to HEAD lineage (leak on an unrelated ref does not fail HEAD)" \
      "exit 0 — HEAD lineage is clean" "exit $rc: $(grep -m1 'leaks found' "$WORK/history-scope.log" || tail -n1 "$WORK/history-scope.log")"
  fi
  (cd "$clone" && scripts/security-scan.sh --history --log-opts HEAD >/dev/null 2>&1); rc=$?
  expect_eq "security-scan: --history --log-opts HEAD is clean on the same clone" 0 "$rc"
}

# --- tools/macos-ci helpers ---------------------------------------------------
check_apple_paths_changed_rejects_invalid_base() {
  local out rc
  out="$(tools/macos-ci/apple-paths-changed.sh deadbeef HEAD 2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "apple-paths-changed: an invalid (non-zero) base SHA is an error, not 'first run'"
  else
    fail "apple-paths-changed: an invalid (non-zero) base SHA is an error, not 'first run'" "non-zero exit" "exit 0, printed '$out' (indistinguishable from the all-zero first-push case)"
  fi
  out="$(tools/macos-ci/apple-paths-changed.sh 0000000000000000000000000000000000000000 HEAD 2>/dev/null)"; rc=$?
  expect_eq "apple-paths-changed: all-zero base → true (first push)" "0 true" "$rc $out"
  tools/macos-ci/apple-paths-changed.sh HEAD >/dev/null 2>&1; rc=$?
  expect_eq "apple-paths-changed: one argument exits 2" 2 "$rc"
}

check_xcresult_summary_missing_bundle_is_visible() {
  local out rc
  out="$(python3 tools/macos-ci/xcresult-summary.py /nonexistent/foo.xcresult 2>&1)"; rc=$?
  case "$out" in
    *"(missing)"*) pass "xcresult-summary: missing bundle is reported as missing" ;;
    *) fail "xcresult-summary: missing bundle is reported as missing" "'(missing)' line" "$out" ;;
  esac
  expect_eq "xcresult-summary: no bundles → exit 0 (nothing failed)" 0 "$rc"
}

check_swing_lab_extract_rejects_impossible_counts() {
  local d="$WORK/extract" rc
  mkdir -p "$d"
  python3 - "$d" <<'EOF'
import json, os, sys
d = sys.argv[1]
json.dump({"framesSeen": 100, "framesWithPose": 500}, open(os.path.join(d, "extract-meta.json"), "w"))
json.dump({"format": "pickle.pose-sequence.v1", "frames": [{"t": 0}]}, open(os.path.join(d, "pose.json"), "w"))
EOF
  python3 tools/macos-ci/check-swing-lab-extract.py "$d" >/dev/null 2>&1; rc=$?
  if [ "$rc" -ne 0 ]; then
    pass "check-swing-lab-extract: framesWithPose > framesSeen is rejected"
  else
    fail "check-swing-lab-extract: framesWithPose > framesSeen is rejected" "non-zero exit" "exit 0 (accepted 500 posed frames out of 100 seen)"
  fi
}

CHECKS=(
  check_select_simulator_uses_available_device
  check_verify_cloud_arg_validation
  check_verify_cloud_sigterm_writes_summary_and_reaps_children
  check_verify_cloud_security_stage_keeps_report
  check_security_scan_exit_codes
  check_security_scan_detects_planted_secret
  check_security_scan_history_scope_is_head_lineage
  check_apple_paths_changed_rejects_invalid_base
  check_xcresult_summary_missing_bundle_is_visible
  check_swing_lab_extract_rejects_impossible_counts
)

if [ "${1:-}" = "--list" ]; then printf '%s\n' "${CHECKS[@]}"; exit 0; fi

for c in "${CHECKS[@]}"; do
  echo "== $c"
  "$c"
done
echo
echo "ci-scripts-execution-audit: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
