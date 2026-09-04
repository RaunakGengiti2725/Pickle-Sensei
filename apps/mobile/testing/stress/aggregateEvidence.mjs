#!/usr/bin/env node
// Aggregates a stress campaign's NDJSON evidence into a seed → outcome table.
// Usage: node testing/stress/aggregateEvidence.mjs <events.ndjson> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error(
    'usage: aggregateEvidence.mjs <events.ndjson> <seed-outcomes.json>',
  );
  process.exit(2);
}

const records = readFileSync(input, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line));

const rows = records.map(record => ({
  suite: record.suite,
  scenario: record.scenario,
  seed: record.seed,
  plan: record.plan,
  verdict: record.verdict,
  brokenInvariant: record.observed?.brokenInvariant ?? null,
  assertionError:
    typeof record.observed?.error === 'string'
      ? record.observed.error.split('\n')[0]
      : null,
  durationMs: record.durationMs,
  heapUsedMb: record.heapUsedMb,
  rssMb: record.rssMb,
}));

const byVerdict = {};
const byScenario = {};
const faultValues = {};
for (const row of rows) {
  byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
  const key = `${row.suite}/${row.scenario}`;
  byScenario[key] ??= { total: 0, held: 0, broken: 0, error: 0 };
  byScenario[key].total += 1;
  byScenario[key][row.verdict] += 1;
  for (const [dependency, value] of Object.entries(row.plan ?? {})) {
    const label = typeof value === 'string' ? value : JSON.stringify(value);
    faultValues[dependency] ??= {};
    faultValues[dependency][label] = (faultValues[dependency][label] ?? 0) + 1;
  }
}

const heap = rows.map(row => row.heapUsedMb).filter(Number.isFinite);
const summary = {
  source: input,
  scenariosExecuted: rows.length,
  byVerdict,
  byScenario,
  faultValues,
  heapUsedMb: {
    min: Math.min(...heap),
    max: Math.max(...heap),
    last: heap[heap.length - 1] ?? null,
  },
  brokenSeeds: rows
    .filter(row => row.verdict !== 'held')
    .map(row => ({
      suite: row.suite,
      scenario: row.scenario,
      seed: row.seed,
      plan: row.plan,
      brokenInvariant: row.brokenInvariant,
      assertionError: row.assertionError,
    })),
  rows,
};

writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      scenariosExecuted: summary.scenariosExecuted,
      byVerdict,
      heapUsedMb: summary.heapUsedMb,
    },
    null,
    2,
  ),
);
