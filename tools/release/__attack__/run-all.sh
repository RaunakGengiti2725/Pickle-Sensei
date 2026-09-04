#!/usr/bin/env bash
# Adversarial pass 3 — release-config-docs. Runs every probe and writes a
# HELD/BROKEN table + raw logs to artifacts/attack-release-config-docs-3/<stamp>/.
#
#   tools/release/__attack__/run-all.sh
#
# Exit code = number of BROKEN probe groups (0 when everything held). Failing
# node:test cases are reproduced findings; see the header of each probe file.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${ATTACK_OUT:-$ROOT/artifacts/attack-release-config-docs-3/$STAMP}"
mkdir -p "$OUT"
cd "$ROOT"
HERE=tools/release/__attack__

echo "release-config-docs attack @ $(git rev-parse HEAD) (dirty=$(git diff --quiet && echo false || echo true)) node=$(node --version)"
echo "artifacts: $OUT"

pnpm -s release:check >"$OUT/baseline_release_check.log" 2>&1
echo "baseline pnpm release:check -> exit=$? ok=$(grep -c '^ok' "$OUT/baseline_release_check.log") FAIL=$(grep -c '^FAIL' "$OUT/baseline_release_check.log")"

ATTACK_REPORT="$OUT/checker-scenarios.json" node --test --test-reporter=spec \
  "$HERE/release-config-docs-3.attack.test.mjs" >"$OUT/node-test.log" 2>&1
node_exit=$?
echo "node --test checker/docs probes -> exit=$node_exit ($(grep -E '^ℹ (pass|fail) ' "$OUT/node-test.log" | tr '\n' ' '); log: $OUT/node-test.log)"

node "$HERE/probe-s4-generator-version.mjs" "$OUT/s4_generator_vs_manifest.json" >"$OUT/s4.log" 2>&1
s4_exit=$?
echo "S4 manifest:generate vs release-manifest -> exit=$s4_exit"

bash "$HERE/probe-s5-ci-release-stage.sh" "$OUT" >"$OUT/s5.log" 2>&1
s5_exit=$?
echo "S5 CI release stage -> exit=$s5_exit"

bash "$HERE/probe-s6-xcprivacy-tracking.sh" "$OUT" >"$OUT/s6.log" 2>&1
s6_exit=$?
echo "S6 xcprivacy NSPrivacyTracking=true -> exit=$s6_exit"

verdict() { [ "$1" -eq 0 ] && echo HELD || echo BROKEN; }
node - "$OUT" "$node_exit" "$s4_exit" "$s5_exit" "$s6_exit" <<'EOF'
const fs = require("node:fs");
const [out, nodeExit, s4, s5, s6] = process.argv.slice(2);
const checker = JSON.parse(fs.readFileSync(`${out}/checker-scenarios.json`, "utf8"));
const rows = checker.results.map((r) => ({ id: r.id, title: r.title, verdict: r.verdict, error: r.error ?? null }));
const v = (code) => (Number(code) === 0 ? "HELD" : "BROKEN");
rows.push({ id: "S4", title: "manifest:generate vs release-manifest version", verdict: v(s4) });
rows.push({ id: "S5", title: "release stage executed by CI", verdict: v(s5) });
rows.push({ id: "S6", title: "NSPrivacyTracking=true caught by a Linux check", verdict: v(s6) });
const summary = {
  tool: "attack-release-config-docs-3",
  seed: checker.seed,
  generatedAtIso: new Date().toISOString(),
  nodeTestExit: Number(nodeExit),
  broken: rows.filter((r) => r.verdict === "BROKEN").map((r) => r.id),
  held: rows.filter((r) => r.verdict === "HELD").map((r) => r.id),
  rows,
};
fs.writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(`\n${"ID".padEnd(12)} ${"VERDICT".padEnd(8)} TITLE`);
for (const r of rows) console.log(`${r.id.padEnd(12)} ${r.verdict.padEnd(8)} ${r.title}`);
console.log(`\nBROKEN: ${summary.broken.length}  HELD: ${summary.held.length}  summary: ${out}/summary.json`);
EOF

broken=0
for e in "$node_exit" "$s4_exit" "$s5_exit" "$s6_exit"; do [ "$e" -ne 0 ] && broken=$((broken + 1)); done
exit $broken
