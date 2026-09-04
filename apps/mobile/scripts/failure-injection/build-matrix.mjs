#!/usr/bin/env node
/**
 * Consolidates the per-suite JSONL scenario records written by
 * `recorder.ts` into one matrix (JSON + Markdown).
 *
 *   node apps/mobile/scripts/failure-injection/build-matrix.mjs \
 *     [artifacts/failure-injection]
 *
 * Reads `<dir>/records/*.jsonl`, writes `<dir>/matrix.json` and
 * `<dir>/matrix.md`. Exit code 1 when any record is missing a replay
 * command or a seed (an unreplayable scenario is not evidence).
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const dir = resolve(
  process.argv[2] ?? resolve(root, 'artifacts', 'failure-injection'),
);
const recordsDir = resolve(dir, 'records');

if (!existsSync(recordsDir)) {
  console.error(`no records at ${recordsDir}`);
  process.exit(1);
}

const records = [];
for (const file of readdirSync(recordsDir)
  .filter(f => f.endsWith('.jsonl'))
  .sort()) {
  const text = readFileSync(resolve(recordsDir, file), 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
}

let unreplayable = 0;
const bySuite = {};
for (const r of records) {
  if (!r.replay || r.seed === undefined || r.seed === null) unreplayable += 1;
  const suite = (bySuite[r.suite] ??= {
    suite: r.suite,
    scenarios: 0,
    safe: 0,
    degraded: 0,
    defect: 0,
    invariantFailures: {
      noInfiniteSpinner: 0,
      noSilentFailure: 0,
      noStoreCrash: 0,
    },
    heapDeltaBytesMax: 0,
    durationMsTotal: 0,
  });
  suite.scenarios += 1;
  suite[r.verdict] = (suite[r.verdict] ?? 0) + 1;
  for (const [k, v] of Object.entries(r.invariants ?? {})) {
    if (v === 'fail')
      suite.invariantFailures[k] = (suite.invariantFailures[k] ?? 0) + 1;
  }
  suite.heapDeltaBytesMax = Math.max(
    suite.heapDeltaBytesMax,
    r.heapDeltaBytes ?? 0,
  );
  suite.durationMsTotal += r.durationMs ?? 0;
}

const matrix = {
  generatedAtIso: new Date().toISOString(),
  node: process.version,
  totals: {
    scenarios: records.length,
    safe: records.filter(r => r.verdict === 'safe').length,
    degraded: records.filter(r => r.verdict === 'degraded').length,
    defect: records.filter(r => r.verdict === 'defect').length,
    unreplayable,
  },
  suites: Object.values(bySuite),
  // Non-sweep rows in full; sweep rows (id contains '/') are summarised.
  scenarios: records
    .filter(r => !r.id.includes('/'))
    .map(r => ({
      id: r.id,
      suite: r.suite,
      title: r.title,
      seed: r.seed,
      verdict: r.verdict,
      invariants: r.invariants,
      files: r.files,
      observed: r.observed,
      expected: r.expected,
      replay: r.replay,
      durationMs: r.durationMs,
      heapDeltaBytes: r.heapDeltaBytes,
    })),
  sweeps: Object.entries(
    records
      .filter(r => r.id.includes('/'))
      .reduce((acc, r) => {
        const key = r.id.split('/')[0];
        (acc[key] ??= []).push(r);
        return acc;
      }, {}),
  ).map(([id, rows]) => ({
    id,
    suite: rows[0].suite,
    runs: rows.length,
    seeds: [
      Math.min(...rows.map(r => r.seed)),
      Math.max(...rows.map(r => r.seed)),
    ],
    verdicts: rows.reduce(
      (acc, r) => ((acc[r.verdict] = (acc[r.verdict] ?? 0) + 1), acc),
      {},
    ),
    sample: rows
      .slice(0, 3)
      .map(r => ({ seed: r.seed, verdict: r.verdict, observed: r.observed })),
  })),
};

writeFileSync(
  resolve(dir, 'matrix.json'),
  `${JSON.stringify(matrix, null, 2)}\n`,
);

const md = [];
md.push('# xc-failure-injection-mobile — scenario matrix');
md.push('');
md.push(
  `Generated ${matrix.generatedAtIso} on ${matrix.node}. Every row is VERIFIED (executed under Jest on Linux); Apple-runtime behaviour is out of scope.`,
);
md.push('');
md.push(
  '| suite | scenarios | safe | degraded | defect | spinner fails | silent fails | store-crash fails | max heap Δ (KiB) |',
);
md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const s of matrix.suites) {
  md.push(
    `| ${s.suite} | ${s.scenarios} | ${s.safe} | ${s.degraded} | ${s.defect} | ${s.invariantFailures.noInfiniteSpinner} | ${s.invariantFailures.noSilentFailure} | ${s.invariantFailures.noStoreCrash} | ${(s.heapDeltaBytesMax / 1024).toFixed(0)} |`,
  );
}
md.push('');
md.push(
  `Totals: ${matrix.totals.scenarios} scenarios — ${matrix.totals.safe} safe, ${matrix.totals.degraded} degraded, ${matrix.totals.defect} defect, ${matrix.totals.unreplayable} unreplayable.`,
);
md.push('');
md.push(
  'Verdicts: `safe` = every invariant held; `degraded` = a failure is swallowed or surfaced poorly but the flow settles; `defect` = a spinner never settles or a store/flow crashes out (`verdictFor` in recorder.ts). A scenario may override the derived verdict when the crashing seam has no shipping caller (e.g. the dormant voice coach in `tts`); the `observed` text says so.',
);
md.push('');
md.push('| id | verdict | spinner | silent | store | observed | replay |');
md.push('|---|---|---|---|---|---|---|');
for (const s of matrix.scenarios) {
  const inv = s.invariants ?? {};
  md.push(
    `| ${s.id} | ${s.verdict} | ${inv.noInfiniteSpinner} | ${inv.noSilentFailure} | ${inv.noStoreCrash} | ${String(s.observed).replace(/\|/g, '\\|').slice(0, 220)} | \`${s.replay}\` |`,
  );
}
md.push('');
md.push('## Seeded sweeps');
md.push('');
for (const sw of matrix.sweeps) {
  md.push(
    `- **${sw.id}** (${sw.suite}) — ${sw.runs} runs, seeds ${sw.seeds[0]}–${sw.seeds[1]}: ${JSON.stringify(sw.verdicts)}`,
  );
}
md.push('');
writeFileSync(resolve(dir, 'matrix.md'), `${md.join('\n')}\n`);

console.log(JSON.stringify(matrix.totals));
if (unreplayable > 0) {
  console.error(`${unreplayable} record(s) lack a replay command or seed`);
  process.exit(1);
}
