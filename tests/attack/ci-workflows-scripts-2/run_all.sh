#!/usr/bin/env bash
# Adversarial pass 3 — subsystem ci-workflows-scripts (Linux plane only).
#
# Runs every harness in this directory against the checked-out revision and
# leaves one results.jsonl + per-scenario logs under $ATTACK_OUT (default
# ~/attack-artifacts/ci-workflows-scripts-2/<UTC stamp>). Exit 0 only when
# every harness reports HELD for all of its checks; the JSONL is the record.
#
# Nothing here touches the Mac runner, pushes a branch, or triggers a workflow:
# s1/s2/s3 replace xcodebuild/xcrun/simctl/PlistBuddy with recorded shims so the
# ORCHESTRATION logic can be attacked on Linux; Apple runtime behaviour stays
# UNKNOWN from here and must come from a real M4 artifact.
#
# Needs: bash, python3, node (repo's node_modules for js-yaml), git, curl (or a
# cached gitleaks 8.30.1), unshare with user namespaces (s3), docker not needed.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export ATTACK_OUT="${ATTACK_OUT:-$HOME/attack-artifacts/ci-workflows-scripts-2/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$ATTACK_OUT"
overall=0
run() {
  local name="$1"; shift
  echo "=== $name"
  if "$@" >"$ATTACK_OUT/$name-driver.log" 2>&1; then echo "    $name: exit 0"; else echo "    $name: exit $? (see $ATTACK_OUT/$name-driver.log)"; overall=1; fi
  grep -E '^\[attack\]' "$ATTACK_OUT/$name-driver.log" | cut -c1-220
}
run s4 "$here/s4_planted_secret_untracked.sh"
run s6 "$here/s6_gitleaks_bin_override.sh"
run s7 "$here/s7_offline_security_stage.sh"
run s8 "$here/s8_history_scan_ref_dependence.sh"
run s1s2 "$here/s1_s2_mac_orchestrator_shim.sh"
run s3 "$here/s3_launch_check_shim.sh"
run s5 node "$here/s5_workflow_static.mjs" "$ATTACK_OUT"
echo
echo "results: $ATTACK_OUT/results.jsonl"
python3 - "$ATTACK_OUT/results.jsonl" <<'PY'
import collections, json, sys
c = collections.Counter()
for line in open(sys.argv[1]):
    line = line.strip()
    if line:
        c[json.loads(line)["verdict"]] += 1
print("verdicts:", dict(c))
PY
exit $overall
