#!/usr/bin/env bash
# Circular-dependency scan (madge) over every pnpm-workspace package under
# packages/*, services/* and tools/{mac-bench,iphone-trials,latency-slo}.
#
# Two passes per package:
#   1. src/  — production graph (cycles here ship)
#   2. test/ — test graph (cycles here only affect the test tree)
# plus ONE combined pass over every src/ root so cross-package cycles that
# only close when two packages are loaded together are also found.
#
# madge resolves `workspace:*` deps through node_modules symlinks to their
# real path, so cross-package edges appear as ../../<pkg>/src/... paths.
#
# Usage: tools/static-health/circular-deps.sh <out-dir>
# Exit: 0 when the scan ran to completion (findings are in the JSON, this is a
#       census, not a gate). Non-zero only when madge itself could not run.
set -euo pipefail

OUT="${1:?usage: circular-deps.sh <out-dir>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MADGE="${MADGE:-$(command -v madge || true)}"
if [ -z "$MADGE" ]; then
  echo "madge not found; install with: npm i -g madge@8   (or set MADGE=/path/to/madge)" >&2
  exit 2
fi
mkdir -p "$OUT"
cd "$ROOT"

pkgs=()
for d in packages/* services/* tools/mac-bench tools/iphone-trials tools/latency-slo; do
  [ -f "$d/package.json" ] && [ -d "$d/src" ] && pkgs+=("$d")
done

summary="$OUT/circular-summary.tsv"
printf 'package\tscope\tfiles\tcycles\n' >"$summary"
src_roots=()
for d in "${pkgs[@]}"; do
  name="$(node -p "require('./$d/package.json').name")"
  safe="${name//\//_}"
  tsconfig="$d/tsconfig.json"
  for scope in src test; do
    [ -d "$d/$scope" ] || continue
    json="$OUT/${safe}.${scope}.circular.json"
    graph="$OUT/${safe}.${scope}.graph.json"
    log="$OUT/${safe}.${scope}.circular.log"
    set +e
    "$MADGE" --extensions ts,tsx --ts-config "$tsconfig" --json "$d/$scope" >"$graph" 2>"$log"
    grc=$?
    "$MADGE" --circular --extensions ts,tsx --ts-config "$tsconfig" --json "$d/$scope" >"$json" 2>>"$log"
    rc=$?
    set -e
    # madge --circular exits 1 when cycles exist; anything else is a tool failure
    if [ $grc -ne 0 ] || { [ $rc -ne 0 ] && [ $rc -ne 1 ]; }; then
      echo "madge failed on $d/$scope (graph exit $grc, circular exit $rc), see $log" >&2
      exit 3
    fi
    files="$(node -p "Object.keys(JSON.parse(require('fs').readFileSync('$graph','utf8'))).length")"
    cycles="$(node -p "JSON.parse(require('fs').readFileSync('$json','utf8')).length")"
    printf '%s\t%s\t%s\t%s\n' "$name" "$scope" "$files" "$cycles" >>"$summary"
  done
  src_roots+=("$d/src")
done

# combined pass: every src root at once, base tsconfig
set +e
"$MADGE" --extensions ts,tsx --ts-config tsconfig.base.json --json "${src_roots[@]}" \
  >"$OUT/ALL.src.graph.json" 2>"$OUT/ALL.src.circular.log"
grc=$?
"$MADGE" --circular --extensions ts,tsx --ts-config tsconfig.base.json --json "${src_roots[@]}" \
  >"$OUT/ALL.src.circular.json" 2>>"$OUT/ALL.src.circular.log"
rc=$?
set -e
if [ $grc -ne 0 ] || { [ $rc -ne 0 ] && [ $rc -ne 1 ]; }; then
  echo "madge combined pass failed (graph exit $grc, circular exit $rc)" >&2
  exit 3
fi
files="$(node -p "Object.keys(JSON.parse(require('fs').readFileSync('$OUT/ALL.src.graph.json','utf8'))).length")"
cycles="$(node -p "JSON.parse(require('fs').readFileSync('$OUT/ALL.src.circular.json','utf8')).length")"
printf '%s\t%s\t%s\t%s\n' "ALL" "src" "$files" "$cycles" >>"$summary"

# workspace-level (package.json workspace:* edges) cycle check — the same
# condition pnpm reports as "WARN There are cyclic workspace dependencies"
# during install, computed read-only.
node "$ROOT/tools/static-health/workspace-cycles.mjs" --out "$OUT/workspace-cycles.json" >/dev/null

cat "$summary"
echo
echo "combined src cycles: $cycles  ($OUT/ALL.src.circular.json)"
node -p "const w=require('$OUT/workspace-cycles.json'); 'workspace cycles (incl. dev): '+w.cyclesIncludingDev.map(c=>c.packages.join(' <-> ')).join('; ')+' | runtime-only: '+(w.cyclesRuntimeOnly.length||'none')"
