#!/usr/bin/env bash
# Drives __tests__/stress/cameraUiBoundaryI18nA11y.stress.test.tsx across
# process-level locale and time-zone environments (jest sandboxes process.env,
# so ICU locale / TZ can only vary per jest process) and aggregates every
# per-run JSON table into one seed→outcome summary.
#
#   apps/mobile/scripts/stress-camera-ui.sh [out-dir] [campaign-iter]
#
# Env: STRESS_ITER_LANE (rows per locale/zone lane, default 40),
#      STRESS_CAMPAIGN_ITER (rows for the big run, default 1500).
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=${1:-artifacts/stress/cmp-camera-ui/$(date -u +%Y%m%dT%H%M%SZ)}
BIG=${2:-${STRESS_CAMPAIGN_ITER:-1500}}
LANE=${STRESS_ITER_LANE:-40}
TEST=__tests__/stress/cameraUiBoundaryI18nA11y.stress.test.tsx
mkdir -p "$OUT"

run() {
  local name=$1
  shift
  local log="$OUT/$name.log"
  echo "== $name: $*"
  set +e
  env "$@" STRESS_OUT="$PWD/$OUT/$name.json" npx jest --ci --silent "$TEST" >"$log" 2>&1
  local code=$?
  set -e
  echo "$name → exit $code" | tee -a "$OUT/exit-codes.txt"
  grep -E '^Tests:' "$log" || true
}

# 1. Default suite (what CI runs): grid + 120 campaign + dst lanes.
run default TZ=UTC LC_ALL=C.UTF-8 LANG=C.UTF-8

# 2. Big campaign.
run "campaign-$BIG" TZ=UTC LC_ALL=C.UTF-8 LANG=C.UTF-8 STRESS_ITER="$BIG"

# 3. Time zones (UTC±14, DST-observing zones, half/quarter-hour offsets).
for tz in UTC Etc/GMT-14 Etc/GMT+12 Pacific/Kiritimati Europe/Berlin \
  America/Los_Angeles Pacific/Auckland Asia/Kolkata Australia/Lord_Howe \
  Asia/Kathmandu America/St_Johns Pacific/Chatham; do
  run "tz-${tz//\//_}" TZ="$tz" LC_ALL=C.UTF-8 LANG=C.UTF-8 STRESS_ITER="$LANE"
done

# 4. Locales (process ICU default locale).
for loc in de_DE fr_FR ar_EG hi_IN ja_JP pt_BR tr_TR ru_RU th_TH zh_CN en_IN es_MX; do
  run "locale-$loc" TZ=UTC LC_ALL="$loc.UTF-8" LANG="$loc.UTF-8" STRESS_ITER="$LANE"
done

node - "$OUT" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2];
const files = fs.readdirSync(out).filter(f => f.endsWith('.json') && f !== 'summary.json');
const runs = [];
const seedOutcomes = new Map();
let rows = 0;
let minimized = 0;
const failed = [];
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  rows += r.rows.length;
  minimized += r.minimized.length;
  runs.push({
    file: f,
    icuLocale: r.run.icuLocale,
    timeZone: r.run.timeZone,
    tzOffsetMinutesNow: r.run.tzOffsetMinutesNow,
    env: r.run.env,
    summary: {
      rows: r.summary.rows,
      held: r.summary.held,
      hostileHeld: r.summary.hostileHeld,
      broken: r.summary.broken,
      hostileCrash: r.summary.hostileCrash,
      hostileLeak: r.summary.hostileLeak,
      minimizedRows: r.summary.minimizedRows,
    },
  });
  for (const row of [...r.rows, ...r.minimized]) {
    const key = `${row.id}@${r.run.timeZone}@${r.run.icuLocale}`;
    seedOutcomes.set(key, row.outcome);
    if (row.outcome !== 'HELD' && row.outcome !== 'HOSTILE_HELD') {
      failed.push({
        run: f,
        id: row.id,
        seed: row.seed,
        outcome: row.outcome,
        component: row.component,
        window: row.window,
        inputInContract: row.inputInContract,
        inputRejectReason: row.inputRejectReason,
        mutations: row.mutations,
        broken: row.checks.filter(c => c.status === 'BROKEN').map(c => `${c.name}: ${c.detail ?? ''}`),
        renderError: row.renderError,
        replay: row.replay,
      });
    }
  }
}
const exitCodes = fs.readFileSync(path.join(out, 'exit-codes.txt'), 'utf8').trim().split('\n');
const summary = {
  unit: 'cmp-camera-ui',
  lens: 'boundary-i18n-a11y',
  scenariosExecuted: rows + minimized,
  campaignRows: rows,
  minimizedRows: minimized,
  runs,
  exitCodes,
  brokenInContract: failed.filter(f => f.outcome === 'BROKEN').length,
  hostileCrash: failed.filter(f => f.outcome === 'HOSTILE_CRASH').length,
  hostileLeak: failed.filter(f => f.outcome === 'HOSTILE_LEAK').length,
  failed,
};
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
const seen = new Set();
const brokenSeeds = [];
for (const f of failed.filter(f => f.outcome === 'BROKEN')) {
  const key = `${f.seed} ${f.mutations.map(m => m.id).join(',')}`;
  if (!seen.has(key)) { seen.add(key); brokenSeeds.push(key); }
}
fs.writeFileSync(path.join(out, 'broken-seeds.txt'), brokenSeeds.join('\n') + (brokenSeeds.length ? '\n' : ''));
console.log(JSON.stringify({
  scenariosExecuted: summary.scenariosExecuted,
  brokenInContract: summary.brokenInContract,
  hostileCrash: summary.hostileCrash,
  hostileLeak: summary.hostileLeak,
  runs: runs.length,
  brokenSeeds: brokenSeeds.length,
}));
EOF

# 5. Flakiness: every distinct in-contract BROKEN (seed, mutation-set) replays
#    10× as its own jest process; the rate goes to flakiness.json.
mkdir -p "$OUT/rerun"
while read -r seed muts; do
  [ -z "$seed" ] && continue
  for i in $(seq 1 10); do
    set +e
    env TZ=UTC LC_ALL=C.UTF-8 LANG=C.UTF-8 STRESS_SEED="$seed" STRESS_MUTATIONS="$muts" \
      STRESS_OUT="$PWD/$OUT/rerun/$seed-${muts//,/+}-$i.json" \
      npx jest --ci --silent "$TEST" >"$OUT/rerun/$seed-${muts//,/+}-$i.log" 2>&1
    echo "rerun $seed [$muts] #$i → exit $?" >>"$OUT/exit-codes.txt"
    set -e
  done
done <"$OUT/broken-seeds.txt"

node - "$OUT" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2];
const dir = path.join(out, 'rerun');
const rate = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const row of r.rows) {
    const key = row.id;
    rate[key] ??= { seed: row.seed, replay: row.replay, runs: 0, broken: 0, outcomes: [] };
    rate[key].runs += 1;
    if (row.outcome === 'BROKEN') rate[key].broken += 1;
    rate[key].outcomes.push(row.outcome);
  }
}
for (const v of Object.values(rate)) v.rate = `${v.broken}/${v.runs}`;
fs.writeFileSync(path.join(out, 'flakiness.json'), JSON.stringify(rate, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, v.rate]))));
EOF
echo "summary: $OUT/summary.json  flakiness: $OUT/flakiness.json"
