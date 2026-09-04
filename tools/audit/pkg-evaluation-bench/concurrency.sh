#!/usr/bin/env bash
# Reproduces the concurrent-run failure mode of bench:regression.
#
# `event_recall` and `completion_bench` are subprocess benches whose scripts
# write a timestamped file into a COMMITTED dataset directory; the runner
# detects "the one new file" by diffing the directory listing
# (packages/evaluation/src/regression/benches.ts, runCapturingNewFile).
# Two runners started at the same time both see two new files, both benches
# FAIL in both runs (exit 1 — fail-closed, good) and none of the four files is
# removed, leaving untracked JSON under datasets/ that flips `gitDirty` for
# every later run until someone deletes them by hand.
#
# The script removes exactly the files it caused and asserts a clean tree.
set -u
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
AUDIT_OUT=${AUDIT_OUT:-/tmp/pickle-audit-bench}
C=$AUDIT_OUT/conc
mkdir -p "$C"
cd "$REPO"

# same notion of "clean" as the runner's isTreeDirty (tracked changes or untracked dataset inputs)
if [ -n "$(git status --porcelain --untracked-files=no)" ] || [ -n "$(git ls-files --others --exclude-standard -- datasets)" ]; then
  echo "working tree must be clean before this probe" >&2
  exit 2
fi

pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$C" --run-id par-a --only event_recall,completion_bench > "$C/par-a.log" 2>&1 &
PA=$!
pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$C" --run-id par-b --only event_recall,completion_bench > "$C/par-b.log" 2>&1 &
PB=$!
wait $PA; echo "par-a exit=$?" | tee "$C/exits.txt"
wait $PB; echo "par-b exit=$?" | tee -a "$C/exits.txt"

git status --porcelain | tee "$C/strays.txt"
STRAYS=$(git ls-files --others --exclude-standard -- datasets)
echo "stray-untracked-dataset-files $(printf '%s\n' "$STRAYS" | grep -c .)" | tee -a "$C/exits.txt"

# A follow-up single run now records gitDirty=true purely because of the strays.
pnpm -s --filter @pickle/evaluation bench:regression --out-dir "$C" --run-id after-stray --only coach_gates > "$C/after-stray.log" 2>&1
echo "after-stray exit=$?" | tee -a "$C/exits.txt"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('after-stray gitDirty=' + str(d['provenance']['gitDirty']).lower())" "$C/after-stray.json" | tee -a "$C/exits.txt"

# cleanup: only the files this probe caused
for f in $STRAYS; do rm -f "$f"; done
echo "git-status-lines-after-cleanup $(git status --porcelain | wc -l)" | tee -a "$C/exits.txt"
