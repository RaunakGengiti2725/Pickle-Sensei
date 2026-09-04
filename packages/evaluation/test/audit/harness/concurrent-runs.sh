#!/usr/bin/env bash
# Audit harness (pkg-evaluation-bench): two concurrent `bench:regression` runs
# over the benches that write into tracked dataset dirs (runCapturingNewFile,
# benches.ts:264-278). Expected per docs/EVALUATION.md §1.1: each run consumes
# exactly its own output and leaves the tree as found. Observed on 4d812e1a:
# both runs fail event_recall/completion_bench and leave stray JSON files that
# flip provenance.gitDirty for the next run. Exit 0 = defect reproduced.
#
# Usage: packages/evaluation/test/audit/harness/concurrent-runs.sh [out-dir]
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
OUT="${1:-/tmp/audit-concurrent-$$}"
TSX="$REPO_ROOT/packages/swing-lab/node_modules/.bin/tsx"
CLI="$REPO_ROOT/packages/evaluation/src/regression/cli.ts"
DIRS=(datasets/experiments/wave-e datasets/completion-bench)
mkdir -p "$OUT"
cd "$REPO_ROOT"

untracked() { git ls-files --others --exclude-standard -- "${DIRS[@]}"; }

if [ -n "$(untracked)" ]; then
  echo "precondition failed: untracked files already present under ${DIRS[*]}" >&2
  untracked >&2
  exit 2
fi

"$TSX" "$CLI" run --only event_recall,completion_bench --out-dir "$OUT" --run-id par-a >"$OUT/par-a.log" 2>&1 &
PA=$!
"$TSX" "$CLI" run --only event_recall,completion_bench --out-dir "$OUT" --run-id par-b >"$OUT/par-b.log" 2>&1 &
PB=$!
wait $PA; EA=$?
wait $PB; EB=$?

STRAYS="$(untracked)"
echo "par-a exit $EA; par-b exit $EB"
echo "strays left under tracked dataset dirs:"
echo "${STRAYS:-<none>}"
grep -h "FAILED\|expected exactly one new file" "$OUT/par-a.log" "$OUT/par-b.log" | sed 's/^/  /' | sort -u

# Third run: a clean bench, but provenance now reports a dirty tree.
"$TSX" "$CLI" run --only coach_gates --out-dir "$OUT" --run-id after >"$OUT/after.log" 2>&1
EC=$?
DIRTY="$(node -e 'const s=require(process.argv[1]);console.log(s.provenance.gitDirty)' "$OUT/after.json")"
echo "follow-up run exit $EC, provenance.gitDirty=$DIRTY"

# Clean up ONLY the files this harness caused to appear.
if [ -n "$STRAYS" ]; then
  echo "$STRAYS" | while IFS= read -r f; do rm -f -- "$f"; done
fi
echo "strays after cleanup: $(untracked | wc -l)"

if [ "$EA" -ne 0 ] && [ "$EB" -ne 0 ] && [ -n "$STRAYS" ] && [ "$DIRTY" = "true" ]; then
  echo "RESULT: defect reproduced (both runs failed, strays left, later provenance dirty)"
  exit 0
fi
echo "RESULT: not reproduced"
exit 1
