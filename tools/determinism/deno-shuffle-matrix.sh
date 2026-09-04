#!/usr/bin/env bash
# Run the edge-function Deno tests once per seed with --shuffle=<seed> and record
# every test's outcome per seed, then report tests whose outcome changes.
#
#   tools/determinism/deno-shuffle-matrix.sh [--seeds "1 2 3"] [--out DIR] [-- <extra deno test args>]
#
# Per seed, in supabase/functions/api/__wf__ (same flags as `deno task test` plus shuffle + junit):
#   deno test -A --no-check --config deno.json --shuffle=<s> --junit-path=$OUT/deno-seed-<s>.xml .
#   console -> $OUT/deno-seed-<s>.log, exit code -> $OUT/deno-seed-<s>.exit
# Finally: node tools/determinism/matrix-report.mjs junit $OUT/deno-seed-*.xml > $OUT/matrix.json
# Exit 0 when no test changes outcome across seeds, 1 otherwise.
set -uo pipefail

REPO_ROOT="${PICKLE_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"
[ -d "$HOME/.deno/bin" ] && export PATH="$HOME/.deno/bin:$PATH"

SEEDS="11 22 33 44 55"
OUT="${PICKLE_DETERMINISM_OUT:-$REPO_ROOT/artifacts/determinism}/deno-$(date -u +%Y%m%dT%H%M%SZ)"
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --seeds) SEEDS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v deno >/dev/null 2>&1 || { echo "missing required tool: deno" >&2; exit 75; }
mkdir -p "$OUT"
echo "deno-shuffle-matrix: seeds=[$SEEDS] out=$OUT sha=$(git rev-parse HEAD) $(deno --version | head -1)"

for s in $SEEDS; do
  echo "=== deno test --shuffle=$s start $(date -u +%H:%M:%S)"
  (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json --shuffle="$s" --junit-path="$OUT/deno-seed-$s.xml" "${EXTRA[@]}" .) \
    >"$OUT/deno-seed-$s.log" 2>&1
  rc=$?
  echo "$rc" >"$OUT/deno-seed-$s.exit"
  echo "    exit $rc — $(grep -E '^(ok|FAILED) \|' "$OUT/deno-seed-$s.log" | tail -1)"
done

node "$HARNESS_DIR/matrix-report.mjs" junit "$OUT"/deno-seed-*.xml >"$OUT/matrix.json"
rc=$?
node "$HARNESS_DIR/matrix-report.mjs" --table junit "$OUT"/deno-seed-*.xml
echo "matrix: $OUT/matrix.json"
exit $rc
