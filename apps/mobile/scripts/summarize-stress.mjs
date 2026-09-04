#!/usr/bin/env node
/**
 * Folds a stress campaign's NDJSON evidence into one JSON table.
 *
 *   node scripts/summarize-stress.mjs artifacts/stress/<run-id>
 *
 * Reads <run-id>/events.ndjson (one line per executed iteration, written by
 * testing/stress/stressEvidence.ts) and writes <run-id>/campaign.json:
 *
 *   { runId, generatedAt, totals: { executed, held, broken, error },
 *     suites: { [suite]: { [scenario]: { executed, held, broken, error,
 *                                        violations: { [name]: count } } } },
 *     seeds: [ { suite, scenario, seed, outcome, violations, replay } ] }
 *
 * `replay` is the exact command that re-runs that one seed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: summarize-stress.mjs <artifacts/stress/run-id>');
  process.exit(2);
}

const lines = readFileSync(join(dir, 'events.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));

const totals = { executed: 0, held: 0, broken: 0, error: 0 };
const suites = {};
const seeds = [];

for (const event of lines) {
  const { suite, scenario, seed, outcome } = event;
  const violations =
    outcome === 'ERROR'
      ? [`ERROR:${String(event.error).slice(0, 200)}`]
      : (event.result && event.result.violations) || [];
  const bucket = outcome.toLowerCase();
  totals.executed += 1;
  totals[bucket] += 1;
  suites[suite] ??= {};
  suites[suite][scenario] ??= {
    executed: 0,
    held: 0,
    broken: 0,
    error: 0,
    violations: {},
  };
  const s = suites[suite][scenario];
  s.executed += 1;
  s[bucket] += 1;
  for (const v of violations) s.violations[v] = (s.violations[v] ?? 0) + 1;
  seeds.push({
    suite,
    scenario,
    seed,
    outcome,
    violations,
    replay: `cd apps/mobile && STRESS_SEED=${seed} npx jest --ci ${suite}`,
  });
}

seeds.sort(
  (a, b) =>
    a.suite.localeCompare(b.suite) ||
    a.scenario.localeCompare(b.scenario) ||
    a.seed - b.seed,
);

const out = {
  runId: basename(dir),
  generatedAt: new Date().toISOString(),
  totals,
  suites,
  seeds,
};
writeFileSync(join(dir, 'campaign.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ runId: out.runId, totals, suites }, null, 2));
