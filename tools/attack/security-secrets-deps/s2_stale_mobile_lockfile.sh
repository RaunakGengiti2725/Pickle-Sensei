#!/usr/bin/env bash
# Adversarial scenario S2 — `scripts/verify-cloud.sh --only deps` with
# apps/mobile/node_modules PRESENT and a deliberately STALE
# apps/mobile/package-lock.json (package.json edited, lockfile untouched).
#
# Expectation for a lockfile-integrity gate: the stage fails (npm ci refuses a
# lockfile that disagrees with package.json). Hypothesis under test: stage_deps
# skips `npm ci` whenever node_modules exists (verify-cloud.sh L179-183), so the
# stale lockfile is never examined and the stage passes.
#
#   tools/attack/security-secrets-deps/s2_stale_mobile_lockfile.sh [out-dir]
#
# Exit 0 = HELD (deps stage fails), exit 1 = BROKEN (deps stage passes).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-$REPO_ROOT/artifacts/attack/s2}"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone -q "$REPO_ROOT" "$WORK/repo"
cd "$WORK/repo"

# Make the mobile lockfile stale: pin prettier one patch back in package.json only.
python3 - <<'PY'
import json, re
p = "apps/mobile/package.json"
s = open(p).read()
s2 = re.sub(r'"prettier":\s*"3\.9\.6"', '"prettier": "3.9.5"', s, count=1)
assert s != s2, "expected prettier 3.9.6 pin in apps/mobile/package.json"
open(p, "w").write(s2)
PY
git diff --stat | tee "$OUT/staleness.diff.txt"

# node_modules "present" — the gate only tests -d, so an empty dir is enough to
# model a developer/CI cache whose contents no longer match the lockfile.
mkdir -p apps/mobile/node_modules

# Control 1: npm ci with this tree MUST refuse (proves the lockfile is stale).
rc_npm=0
(cd apps/mobile && npm ci --no-audit --no-fund --ignore-scripts --dry-run) >"$OUT/npm-ci-dry-run.log" 2>&1 || rc_npm=$?
echo "control npm ci --dry-run rc=$rc_npm" | tee "$OUT/results.txt"

# Attack: the canonical deps stage with node_modules present.
rc_gate=0
VERIFY_ARTIFACTS="$OUT/verify-deps" scripts/verify-cloud.sh --only deps >"$OUT/verify-deps.stdout.log" 2>&1 || rc_gate=$?
echo "verify-cloud --only deps rc=$rc_gate" | tee -a "$OUT/results.txt"
{ grep -h "npm ci\|node_modules present" "$OUT/verify-deps/deps.log" || echo "(deps.log has no npm ci / node_modules line)"; } | tee -a "$OUT/results.txt"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("summary ok=%s stages=%s" % (d["ok"], [(s["name"], s["status"]) for s in d["stages"]]))' \
  "$OUT/verify-deps/summary.json" | tee -a "$OUT/results.txt"

# Control 2: --fresh-deps forces npm ci and must fail on the same tree.
rc_fresh=0
VERIFY_ARTIFACTS="$OUT/verify-deps-fresh" scripts/verify-cloud.sh --only deps --fresh-deps >"$OUT/verify-deps-fresh.stdout.log" 2>&1 || rc_fresh=$?
echo "verify-cloud --only deps --fresh-deps rc=$rc_fresh" | tee -a "$OUT/results.txt"
{ grep -h "npm ERR\|lock file" "$OUT/verify-deps-fresh/deps.log" || echo "(deps.log has no npm error line)"; } | head -5 | tee -a "$OUT/results.txt"

if [ "$rc_npm" -ne 0 ] && [ "$rc_gate" -eq 0 ]; then
  echo "BROKEN: stale apps/mobile/package-lock.json passes the deps stage whenever node_modules exists (npm ci skipped)" | tee -a "$OUT/results.txt"
  exit 1
fi
echo "HELD" | tee -a "$OUT/results.txt"
