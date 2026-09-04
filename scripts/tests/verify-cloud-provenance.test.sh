#!/usr/bin/env bash
# Regression tests for scripts/verify-cloud.sh provenance + security evidence.
#
#   scripts/tests/verify-cloud-provenance.test.sh
#
# Builds a throwaway git repo holding copies of scripts/verify-cloud.sh,
# scripts/security-scan.sh and .gitleaks.toml, then asserts:
#   1. >5000 untracked non-artifacts files       -> dirty=true  (summary.json "dirty": true)
#   2. clean tree / only untracked artifacts/    -> dirty=false
#   3. one modified tracked file                 -> dirty=true
#   4. planted secret fixture, --only security   -> exit 1 + redacted JSON report under
#      $VERIFY_ARTIFACTS naming the fixture path and rule id
#   5. security.log names RuleID/File/Line/Fingerprint for the finding
#   6. no fixture, --only security               -> exit 0 + empty-findings JSON report
#
# Needs git, bash, python3 and the pinned gitleaks (scripts/security-scan.sh
# downloads it once into its cache). Exit 0 = all cases passed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 75; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SCRATCH="$WORK/repo"

FAILURES=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
assert_eq() {
  # assert_eq <label> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1: expected '$2', got '$3'"; fi
}

fresh_scratch() {
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH/scripts"
  cp "$REPO_ROOT/scripts/verify-cloud.sh" "$REPO_ROOT/scripts/security-scan.sh" "$SCRATCH/scripts/"
  cp "$REPO_ROOT/.gitleaks.toml" "$SCRATCH/"
  echo "tracked" >"$SCRATCH/tracked.txt"
  git -C "$SCRATCH" init -q
  git -C "$SCRATCH" add -A
  git -C "$SCRATCH" -c user.email=test@example.invalid -c user.name=test commit -q -m "scratch"
}

# dirty_flag <artifacts dir> -> prints "<header dirty>/<summary dirty>" ; exit code of verify-cloud in $?
dirty_flag() {
  local va="$1" out header summary rc
  out="$(cd "$SCRATCH" && VERIFY_ARTIFACTS="$va" scripts/verify-cloud.sh --only ml --skip ml 2>&1)"
  rc=$?
  header="$(printf '%s\n' "$out" | sed -n 's/.*(dirty=\([a-z]*\)).*/\1/p' | head -n 1)"
  summary="$(python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["dirty"]).lower())' "$va/summary.json" 2>/dev/null || echo missing)"
  printf '%s/%s' "$header" "$summary"
  return "$rc"
}

# ---- 1. >5000 untracked non-artifacts files -------------------------------
fresh_scratch
mkdir -p "$SCRATCH/artifacts"
: >"$SCRATCH/artifacts/x"
for i in $(seq 1 6000); do : >"$SCRATCH/untracked-$i"; done
lines="$(git -C "$SCRATCH" status --porcelain | wc -l | tr -d ' ')"
[ "$lines" -gt 5000 ] || fail "precondition: expected >5000 porcelain lines, got $lines"
result="$(dirty_flag "$WORK/va-many")"
assert_eq "verify-cloud exit with many untracked files" 0 "$?"
assert_eq "dirty flag with >5000 untracked non-artifacts files" "true/true" "$result"

# ---- 2. clean tree, then only untracked artifacts/ -------------------------
fresh_scratch
result="$(dirty_flag "$WORK/va-clean")"
assert_eq "verify-cloud exit on clean tree" 0 "$?"
assert_eq "dirty flag on clean tree" "false/false" "$result"

mkdir -p "$SCRATCH/artifacts"
: >"$SCRATCH/artifacts/x"
result="$(dirty_flag "$WORK/va-artifacts")"
assert_eq "verify-cloud exit with only artifacts/ untracked" 0 "$?"
assert_eq "dirty flag with only untracked artifacts/ paths" "false/false" "$result"

# ---- 3. single modified tracked file --------------------------------------
fresh_scratch
echo "changed" >>"$SCRATCH/tracked.txt"
result="$(dirty_flag "$WORK/va-modified")"
assert_eq "verify-cloud exit with a modified tracked file" 0 "$?"
assert_eq "dirty flag with one modified tracked file" "true/true" "$result"

# ---- 4 + 5. planted secret fixture -> exit 1, redacted report, detailed log
fresh_scratch
VA="$WORK/va-secret"
FIXTURE="fixtures/planted.env"
mkdir -p "$SCRATCH/fixtures"
# Synthetic value shaped like the custom `supabase-secret-api-key` rule (sb_secret_ + 20+ chars).
printf 'SUPABASE_SERVICE_KEY=%s%s\n' "sb_secret_" "$(printf 'A%.0s' $(seq 1 32))" >"$SCRATCH/$FIXTURE"
(cd "$SCRATCH" && VERIFY_ARTIFACTS="$VA" scripts/verify-cloud.sh --only security >"$WORK/secret-run.out" 2>&1)
assert_eq "verify-cloud --only security exit with planted fixture" 1 "$?"

report_check="$(python3 - "$VA" "$FIXTURE" <<'PY'
import glob, json, os, sys
va, fixture = sys.argv[1], sys.argv[2]
reports = sorted(glob.glob(os.path.join(va, "**", "*.json"), recursive=True))
reports = [r for r in reports if os.path.basename(r) != "summary.json"]
if not reports:
    print("no-report"); sys.exit(0)
findings = []
for r in reports:
    with open(r) as fh:
        data = json.load(fh)
    if isinstance(data, list):
        findings.extend(data)
if not findings:
    print("empty-report"); sys.exit(0)
leaked = [f for f in findings if f.get("Secret") != "REDACTED" or f.get("Match") != "REDACTED"]
if leaked:
    print("unredacted"); sys.exit(0)
hit = [f for f in findings if f.get("File") == fixture and f.get("RuleID") == "supabase-secret-api-key"]
print("ok" if hit else "fixture-not-named")
PY
)"
assert_eq "redacted JSON report under VERIFY_ARTIFACTS names fixture path + rule id" ok "$report_check"

LOG="$VA/security.log"
if [ -f "$LOG" ]; then
  for field in "RuleID:" "File:" "Line:" "Fingerprint:"; do
    if grep -q "^$field" "$LOG"; then pass "security.log has $field line"; else fail "security.log lacks $field line"; fi
  done
  if grep -q "supabase-secret-api-key" "$LOG" && grep -q "$FIXTURE" "$LOG"; then
    pass "security.log names rule id and fixture path"
  else
    fail "security.log does not name rule id and fixture path"
  fi
  if grep -q "sb_secret_A" "$LOG"; then fail "security.log leaks the fixture value"; else pass "security.log is redacted"; fi
else
  fail "security.log missing at $LOG"
fi

# ---- 6. no fixture -> exit 0 and an empty-findings report is still written -
fresh_scratch
VA="$WORK/va-clean-security"
(cd "$SCRATCH" && VERIFY_ARTIFACTS="$VA" scripts/verify-cloud.sh --only security >"$WORK/clean-run.out" 2>&1)
assert_eq "verify-cloud --only security exit without fixture" 0 "$?"
clean_report="$(python3 - "$VA" <<'PY'
import glob, json, os, sys
va = sys.argv[1]
reports = [r for r in sorted(glob.glob(os.path.join(va, "**", "*.json"), recursive=True)) if os.path.basename(r) != "summary.json"]
if not reports:
    print("no-report"); sys.exit(0)
for r in reports:
    with open(r) as fh:
        if json.load(fh) != []:
            print("non-empty"); sys.exit(0)
print("ok")
PY
)"
assert_eq "empty-findings JSON report written on a clean security stage" ok "$clean_report"

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "verify-cloud-provenance: $FAILURES assertion(s) FAILED"
  exit 1
fi
echo "verify-cloud-provenance: OK"
