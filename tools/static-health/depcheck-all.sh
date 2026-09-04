#!/usr/bin/env bash
# Runs depcheck against every workspace package/service/tool and records raw JSON.
#
# Usage: tools/static-health/depcheck-all.sh <out-dir>
#   DEPCHECK=/path/to/depcheck  (default: depcheck on PATH)
#
# depcheck reports three buckets per package:
#   dependencies      -> declared in "dependencies" but never imported (candidate unused)
#   devDependencies   -> declared in "devDependencies" but never imported
#   missing           -> imported but not declared in this package.json
#
# Known false-positive classes (NOT auto-filtered; the consolidator below labels them):
#   * typescript / vitest / tsx / @types/* used only via scripts or tsconfig
#   * "missing" entries that resolve through the pnpm workspace root or node builtins
#   * @pickle/* workspace packages consumed only via tsconfig paths
# This is a census, not a gate: depcheck exit code 255 == "issues found" and is expected.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/artifacts/static-health/depcheck}"
DEPCHECK="${DEPCHECK:-depcheck}"
mkdir -p "$OUT_DIR"

cd "$REPO_ROOT"
summary="$OUT_DIR/summary.tsv"
printf 'package\tdir\texit\tunused_deps\tunused_dev\tmissing\n' > "$summary"

for dir in packages/* services/* tools/mac-bench tools/iphone-trials tools/latency-slo apps/admin-web; do
  [ -f "$dir/package.json" ] || continue
  name="$(node -p "require('./$dir/package.json').name")"
  safe="${name//\//_}"
  out="$OUT_DIR/$safe.json"
  "$DEPCHECK" "$dir" --json \
    --ignore-patterns="dist,coverage,node_modules,*.d.ts" \
    > "$out" 2> "$OUT_DIR/$safe.stderr.log"
  code=$?
  read -r ud udv miss < <(node -e '
    const j = require(process.argv[1]);
    console.log(j.dependencies.length, j.devDependencies.length, Object.keys(j.missing).length);
  ' "$out")
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$dir" "$code" "$ud" "$udv" "$miss" >> "$summary"
done

echo "depcheck summary -> $summary"
cat "$summary"
node "$REPO_ROOT/tools/static-health/depcheck-consolidate.mjs" "$OUT_DIR" > "$OUT_DIR/consolidated.md"
echo
cat "$OUT_DIR/consolidated.md"
