#!/usr/bin/env bash
# Structural audit harness for the `ci-workflows-scripts` subsystem (Linux plane).
#
# Runs every test_*.sh / test_*.py in this directory against the checked-out
# scripts/workflows, writes each test's stdout to $AUDIT_OUT/<test>.log and a
# machine-readable $AUDIT_OUT/run_all.json, and exits non-zero if any test has
# a failing assertion. Each test documents the DESIRED behaviour it asserts, so
# a failing assertion is a reproduced defect at this commit and a passing one
# is a pinned invariant.
#
#   AUDIT_OUT=/tmp/audit tools/audit/ci-workflows-scripts-structural2/run_all.sh
#
# Hermetic: throwaway git repos and stubbed toolchains; no network beyond the
# gitleaks download that scripts/security-scan.sh itself performs when the
# pinned binary is not cached; never touches Supabase, GitHub, or the Mac runner.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AUDIT_OUT="${AUDIT_OUT:-$(cd "$HERE/../../.." && pwd)/artifacts/audit-structural2}"
mkdir -p "$AUDIT_OUT"

results=()
overall=0
for t in "$HERE"/test_*.sh "$HERE"/test_*.py; do
  name=$(basename "$t")
  case "$t" in *.py) runner=(python3 "$t") ;; *) runner=(bash "$t") ;; esac
  "${runner[@]}" >"$AUDIT_OUT/$name.log" 2>&1
  rc=$?
  fails=$(grep -c '^\[[^]]*\] FAIL ' "$AUDIT_OUT/$name.log")
  oks=$(grep -c '^\[[^]]*\] ok ' "$AUDIT_OUT/$name.log")
  [ "$rc" -eq 0 ] || overall=1
  printf '%-45s exit=%s ok=%s fail=%s\n' "$name" "$rc" "$oks" "$fails"
  results+=("{\"test\":\"$name\",\"exit\":$rc,\"ok\":$oks,\"fail\":$fails}")
done

{
  echo "{\"git_sha\":\"$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo unknown)\","
  echo " \"host\":\"$(uname -s)\",\"overall_exit\":$overall,\"tests\":["
  (IFS=,; echo "${results[*]}")
  echo "]}"
} >"$AUDIT_OUT/run_all.json"
echo "summary: $AUDIT_OUT/run_all.json"
exit $overall
