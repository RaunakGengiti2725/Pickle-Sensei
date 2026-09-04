#!/usr/bin/env node
/**
 * xc-matrix-behavioral — folds an `events.ndjson` evidence file into a
 * scenario matrix (JSON + Markdown) with pass/fail counts, heap/RSS peaks,
 * durations and the seeds of every failure (replay: `XC_SEED=<seed>`).
 *
 *   node apps/mobile/testing/xcBehavioral/summarize.mjs \
 *     artifacts/xc-behavioral/scale25/events.ndjson
 *
 * Writes `matrix.json` and `matrix.md` beside the input file.
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const input = process.argv[2];
if (!input) {
  console.error('usage: summarize.mjs <events.ndjson>');
  process.exit(2);
}

const rows = readFileSync(input, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

const groups = new Map();
for (const row of rows) {
  const key = `${row.suite}/${row.scenario}`;
  if (!groups.has(key)) {
    groups.set(key, {
      suite: row.suite,
      scenario: row.scenario,
      runs: 0,
      pass: 0,
      fail: 0,
      failSeeds: [],
      heapUsedMbMax: 0,
      rssMbMax: 0,
      durationMsTotal: 0,
      durationMsMax: 0,
      observedKeys: new Set(),
    });
  }
  const g = groups.get(key);
  g.runs += 1;
  if (row.verdict === 'pass') g.pass += 1;
  else {
    g.fail += 1;
    g.failSeeds.push({
      seed: row.seed,
      inputs: row.inputs,
      error: row.observed.error ?? null,
    });
  }
  g.heapUsedMbMax = Math.max(g.heapUsedMbMax, row.heapUsedMb);
  g.rssMbMax = Math.max(g.rssMbMax, row.rssMb);
  g.durationMsTotal += row.durationMs;
  g.durationMsMax = Math.max(g.durationMsMax, row.durationMs);
  for (const k of Object.keys(row.observed)) g.observedKeys.add(k);
}

/** Per-scenario tallies of the observed flags that back a finding. */
function tally(scenario, key) {
  const counts = {};
  for (const row of rows) {
    if (row.scenario !== scenario) continue;
    const v = JSON.stringify(row.observed[key] ?? null);
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return counts;
}

const findingsEvidence = {
  'storesMatrix/accessStaleRefresh.staleOverwrotePremium': tally(
    'accessStaleRefresh',
    'staleOverwrotePremium',
  ),
  'permitLifecycleMatrix/permitPersistFault.permitReleasedAfterPersistFailure':
    tally('permitPersistFault', 'permitReleasedAfterPersistFailure'),
  'analyzeScreenMatrix/closeDuringCapture.extraGoBacks': tally(
    'closeDuringCapture',
    'extraGoBacks',
  ),
  'analyzeScreenMatrix/closeDuringCapture.pendingCaptureRows': tally(
    'closeDuringCapture',
    'pendingCaptureRows',
  ),
  'analyzeScreenMatrix/freeLimitDoubleTap.replaces': tally(
    'freeLimitDoubleTap',
    'replaces',
  ),
};

const matrix = [...groups.values()]
  .map(g => ({
    ...g,
    durationMsAvg: Math.round(g.durationMsTotal / g.runs),
    observedKeys: [...g.observedKeys].sort(),
  }))
  .sort((a, b) =>
    `${a.suite}/${a.scenario}`.localeCompare(`${b.suite}/${b.scenario}`),
  );

const summary = {
  input,
  generatedAtIso: new Date().toISOString(),
  totals: {
    runs: rows.length,
    pass: rows.filter(r => r.verdict === 'pass').length,
    fail: rows.filter(r => r.verdict === 'fail').length,
    heapUsedMbMax: Math.max(...rows.map(r => r.heapUsedMb)),
    rssMbMax: Math.max(...rows.map(r => r.rssMb)),
  },
  matrix,
  findingsEvidence,
};

const md = [
  `# xc-matrix-behavioral — ${input}`,
  '',
  `runs=${summary.totals.runs} pass=${summary.totals.pass} fail=${summary.totals.fail} heapUsedMbMax=${summary.totals.heapUsedMbMax} rssMbMax=${summary.totals.rssMbMax}`,
  '',
  '| suite | scenario | runs | pass | fail | heapUsedMb max | rssMb max | ms avg | ms max | fail seeds |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ...matrix.map(
    g =>
      `| ${g.suite} | ${g.scenario} | ${g.runs} | ${g.pass} | ${g.fail} | ${g.heapUsedMbMax} | ${g.rssMbMax} | ${g.durationMsAvg} | ${g.durationMsMax} | ${g.failSeeds.map(f => f.seed).join(' ') || '—'} |`,
  ),
  '',
  '## Observed flags backing findings',
  '',
  ...Object.entries(findingsEvidence).map(
    ([k, v]) => `- \`${k}\`: ${JSON.stringify(v)}`,
  ),
  '',
].join('\n');

const outDir = dirname(input);
writeFileSync(
  join(outDir, 'matrix.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
writeFileSync(join(outDir, 'matrix.md'), md);
console.log(md);
