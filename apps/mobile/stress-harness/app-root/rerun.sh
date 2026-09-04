#!/usr/bin/env bash
# Replays minimized failing rows N times and reports the failure rate per row.
# Usage: stress-harness/app-root/rerun.sh <out-dir> [repeat=10] <case-or-seed>...
# A token that parses as an integer is replayed with STRESS_SEED, anything
# else with STRESS_CASE (a fixed-matrix scenario name).
set -euo pipefail
out="$1"; shift
repeat="${1:-10}"; shift
mkdir -p "$out"
cd "$(dirname "$0")/../.."
for token in "$@"; do
  for i in $(seq 1 "$repeat"); do
    dir="$out/$token/run-$i"
    mkdir -p "$dir"
    if [[ "$token" =~ ^[0-9]+$ ]]; then
      STRESS_ITER=0 STRESS_SEED="$token" STRESS_ARTIFACT_DIR="$dir" \
        npx jest --ci --silent __tests__/stress/appRootFailureInjection.stress.test.tsx \
        >"$dir/jest.log" 2>&1 && echo 0 >"$dir/exit" || echo $? >"$dir/exit"
    else
      STRESS_ITER=0 STRESS_CASE="$token" STRESS_ARTIFACT_DIR="$dir" \
        npx jest --ci --silent __tests__/stress/appRootFailureInjection.stress.test.tsx \
        >"$dir/jest.log" 2>&1 && echo 0 >"$dir/exit" || echo $? >"$dir/exit"
    fi
  done
done
node - "$out" "$repeat" "$@" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const [out, repeat, ...tokens] = process.argv.slice(2);
const table = [];
for (const token of tokens) {
  const runs = [];
  for (let i = 1; i <= Number(repeat); i++) {
    const dir = path.join(out, token, `run-${i}`);
    const rows = JSON.parse(fs.readFileSync(path.join(dir, 'appRootFailureInjection.rows.json'), 'utf8'));
    const row = rows.find(r => (/^\d+$/.test(token) ? r.seed === Number(token) : r.scenario === token));
    runs.push({
      exit: Number(fs.readFileSync(path.join(dir, 'exit'), 'utf8').trim()),
      verdict: row?.verdict ?? 'MISSING',
      failed: row?.failed ?? [],
      deviations: row?.deviations ?? [],
      screenAt60s: row?.observed.screenAt60s ?? null,
    });
  }
  const signatures = new Set(runs.map(r => JSON.stringify([r.verdict, r.failed, r.deviations, r.screenAt60s])));
  table.push({
    token,
    runs: runs.length,
    brokenRuns: runs.filter(r => r.verdict === 'BROKEN').length,
    jestExitNonZero: runs.filter(r => r.exit !== 0).length,
    deterministic: signatures.size === 1,
    verdict: runs[0].verdict,
    failed: runs[0].failed,
    deviations: runs[0].deviations,
    screenAt60s: runs[0].screenAt60s,
  });
}
fs.writeFileSync(path.join(out, 'rerun-table.json'), JSON.stringify(table, null, 2));
for (const entry of table) {
  console.log(`${entry.token}: ${entry.brokenRuns}/${entry.runs} BROKEN, deterministic=${entry.deterministic}, jestExit!=0: ${entry.jestExitNonZero}, ${entry.deviations.map(d => d.split(' ')[0]).join('+') || '-'}`);
}
EOF
