#!/usr/bin/env bash
# Runs the StreakCalendarScreen boundary/i18n/a11y stress campaign once per
# device time zone. Jest sandboxes `process.env`, so TZ cannot change inside a
# single run — every zone is a separate jest process with its own seed base
# and artifact directory. Writes <out>/matrix-summary.json (zone → exit code,
# rows, failed seeds) and never masks a failing zone.
#
#   STRESS_ITER=<n>   iterations per zone (default 8 → 64 rendered variants)
#   STRESS_BASE=<n>   campaign base seed (default 20260905; zone i uses base+i)
#   STRESS_OUT=<dir>  artifact root (default ../../artifacts/stress-streak-calendar/matrix)
set -euo pipefail

cd "$(dirname "$0")/.."

ITER="${STRESS_ITER:-8}"
BASE="${STRESS_BASE:-20260905}"
OUT="${STRESS_OUT:-$(pwd)/../../artifacts/stress-streak-calendar/matrix}"
SUITE="__tests__/stress/streakCalendarScreen.boundaryI18nA11y.stress.test.tsx"
ZONES=(
  Pacific/Kiritimati
  Etc/GMT+12
  Pacific/Chatham
  America/Los_Angeles
  Europe/Berlin
  America/Santiago
  Asia/Kathmandu
  UTC
)

mkdir -p "$OUT"
overall=0
index=0
: > "$OUT/exit-codes.txt"
for zone in "${ZONES[@]}"; do
  dir="$OUT/${zone//\//_}"
  mkdir -p "$dir"
  echo "== zone=$zone iter=$ITER base=$((BASE + index)) → $dir"
  set +e
  TZ="$zone" STRESS_ITER="$ITER" STRESS_BASE="$((BASE + index))" \
    STRESS_ARTIFACT_DIR="$dir" \
    npx jest --ci --silent "$SUITE" -t campaign >"$dir/jest.log" 2>&1
  code=$?
  set -e
  echo "$zone $code" >> "$OUT/exit-codes.txt"
  if [ "$code" -ne 0 ]; then overall=1; fi
  index=$((index + 1))
done

node - "$OUT" "$ITER" "$BASE" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const [out, iter, base] = process.argv.slice(2);
const zones = {};
let rows = 0;
let failed = 0;
for (const line of fs.readFileSync(path.join(out, 'exit-codes.txt'), 'utf8').trim().split('\n')) {
  const [zone, code] = line.split(' ');
  const dir = path.join(out, zone.replace(/\//g, '_'));
  const summaryFile = fs.readdirSync(dir).find(f => f.startsWith('summary-'));
  const summary = summaryFile ? JSON.parse(fs.readFileSync(path.join(dir, summaryFile), 'utf8')) : null;
  zones[zone] = {
    exitCode: Number(code),
    deviceZoneSeen: summary ? Object.keys(summary.coverage.timeZones) : [],
    clockEdges: summary ? summary.coverage.clockEdges : null,
    iterations: summary ? summary.iterations : 0,
    passed: summary ? summary.passed : 0,
    failedSeeds: summary ? summary.failedSeeds : null,
    summaryFile: summaryFile ? path.join(dir, summaryFile) : null,
  };
  rows += summary ? summary.iterations : 0;
  failed += summary ? summary.failed : 0;
}
const result = { iterPerZone: Number(iter), base: Number(base), zones, rowsTotal: rows, failedTotal: failed };
fs.writeFileSync(path.join(out, 'matrix-summary.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ rowsTotal: rows, failedTotal: failed, exitCodes: Object.fromEntries(Object.entries(zones).map(([z, v]) => [z, v.exitCode])) }, null, 2));
EOF

exit "$overall"
