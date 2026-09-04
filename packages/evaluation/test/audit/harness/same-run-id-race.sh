#!/usr/bin/env bash
# Audit harness (pkg-evaluation-bench): the overwrite guard in run.ts:245-246
# is a check-then-write. Two runs launched with the SAME --run-id both pass the
# existsSync() check and the later writer silently replaces the earlier
# summary; neither exits non-zero. Exit 0 = defect reproduced.
#
# Usage: packages/evaluation/test/audit/harness/same-run-id-race.sh [out-dir]
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
OUT="${1:-/tmp/audit-runid-race-$$}"
TSX="$REPO_ROOT/packages/swing-lab/node_modules/.bin/tsx"
CLI="$REPO_ROOT/packages/evaluation/src/regression/cli.ts"
mkdir -p "$OUT"
cd "$REPO_ROOT"

"$TSX" "$CLI" run --only coach_gates --out-dir "$OUT" --run-id same >"$OUT/same-1.log" 2>&1 &
P1=$!
"$TSX" "$CLI" run --only coach_gates --out-dir "$OUT" --run-id same >"$OUT/same-2.log" 2>&1 &
P2=$!
wait $P1; E1=$?
wait $P2; E2=$?

echo "run 1 exit $E1; run 2 exit $E2"
echo "files in $OUT:"; ls -1 "$OUT" | sed 's/^/  /'
REFUSED="$(grep -c "refusing to overwrite" "$OUT/same-1.log" "$OUT/same-2.log" | awk -F: '{s+=$2} END {print s}')"
echo "runs that refused to overwrite: $REFUSED"

if [ "$E1" -eq 0 ] && [ "$E2" -eq 0 ] && [ "$REFUSED" -eq 0 ]; then
  echo "RESULT: defect reproduced (both runs exit 0, one summary silently overwrote the other)"
  exit 0
fi
echo "RESULT: not reproduced (guard held or timing did not overlap)"
exit 1
