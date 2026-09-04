#!/usr/bin/env bash
# S2 — produce a full regression candidate under a specific Node binary and
# quantify how many of the baseline's metrics move.
#
#   test/attack/scripts/node-major-compare.sh <node-binary> <out-dir> [run-id]
#
# Exit 0 iff the candidate ran clean, the comparator exited 0 and ZERO metrics
# moved. Any moved metric is printed as `metric baseline -> candidate` and the
# script exits 1 (that is the finding, not a tolerance breach). Exit 2 on
# setup problems. Requires a CLEAN checkout (untracked datasets/ inputs make
# gitDirty=true and add a CONFOUND warning; that is reported, not hidden).
set -euo pipefail

NODE_BIN="${1:?node binary}"
OUT_DIR="${2:?out dir}"
RUN_ID="${3:-cand-$(basename "$(dirname "$(dirname "$NODE_BIN")")")}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../../.." && pwd)"
ROOT="$(cd "$PKG/../.." && pwd)"
BASELINE="$ROOT/datasets/reports/regression/baseline.json"
CLI="$PKG/src/regression/cli.ts"
TSX="$ROOT/packages/swing-lab/node_modules/.bin/tsx"

[[ -x "$NODE_BIN" ]] || { echo "not executable: $NODE_BIN" >&2; exit 2; }
[[ -x "$TSX" ]] || { echo "tsx missing at $TSX (run pnpm install)" >&2; exit 2; }
mkdir -p "$OUT_DIR"

# The tsx shim resolves `node` from PATH, so putting the requested binary's
# directory first pins the runtime for the runner AND (TSX_BIN in run.ts
# inherits the environment) every bench subprocess.
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "node: $(node --version) ($(command -v node))  commit: $(git -C "$ROOT" rev-parse --short HEAD)"
[[ "$(command -v node)" == "$NODE_BIN" ]] || { echo "PATH did not resolve to $NODE_BIN" >&2; exit 2; }

"$TSX" "$CLI" run --out-dir "$OUT_DIR" --run-id "$RUN_ID" | tee "$OUT_DIR/run.log"
CAND="$OUT_DIR/$RUN_ID.json"

set +e
"$TSX" "$CLI" compare "$BASELINE" "$CAND" --json > "$OUT_DIR/compare.json"
COMPARE_EXIT=$?
"$TSX" "$CLI" compare "$BASELINE" "$CAND" > "$OUT_DIR/compare.txt"
set -e
echo "compare exit: $COMPARE_EXIT (text report: $OUT_DIR/compare.txt)"

node - "$BASELINE" "$CAND" "$OUT_DIR/compare.json" <<'EOF'
const fs = require("node:fs");
const [baselinePath, candPath, comparePath] = process.argv.slice(2);
const b = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const c = JSON.parse(fs.readFileSync(candPath, "utf8"));
const report = JSON.parse(fs.readFileSync(comparePath, "utf8"));
const keys = Object.keys(b.metrics);
const moved = keys.filter((k) => !Object.is(b.metrics[k], c.metrics[k]));
const missing = keys.filter((k) => !(k in c.metrics));
const extra = Object.keys(c.metrics).filter((k) => !(k in b.metrics));
console.log(`runner: baseline ${b.runner.node} -> candidate ${c.runner.node}`);
console.log(`gitDirty: baseline ${b.provenance.gitDirty} -> candidate ${c.provenance.gitDirty}`);
console.log(`warnings: ${JSON.stringify(report.warnings)}`);
console.log(`metrics: ${keys.length} baseline, ${moved.length} moved, ${missing.length} missing, ${extra.length} extra`);
for (const k of moved) console.log(`  ${k} ${b.metrics[k]} -> ${c.metrics[k]}`);
process.exit(moved.length + missing.length + extra.length === 0 ? 0 : 1);
EOF
[[ "$COMPARE_EXIT" == 0 ]]
