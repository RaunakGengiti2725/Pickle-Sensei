#!/usr/bin/env node
/**
 * Merge the per-shard JSON emitted by
 * streakCalendarScreen.randomizedSeeded.stress.test.tsx (one shard per
 * STRESS_SEED/STRESS_TAG pair) into a single campaign summary + results table.
 *
 *   node __tests__/stress/mergeStreakCalendarShards.mjs <outTag> <shardTag>...
 *
 * Reads/writes under STRESS_OUT (default apps/mobile/artifacts/stress).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir =
  process.env.STRESS_OUT ?? join(process.cwd(), 'artifacts/stress');
const [outTag, ...shardTags] = process.argv.slice(2);
if (!outTag || shardTags.length === 0) {
  console.error('usage: mergeStreakCalendarShards.mjs <outTag> <shardTag>...');
  process.exit(2);
}

const summaries = [];
const results = [];
for (const tag of shardTags) {
  summaries.push(
    JSON.parse(
      readFileSync(
        join(outDir, `streakcalendar-randomized-summary-${tag}.json`),
        'utf8',
      ),
    ),
  );
  results.push(
    ...JSON.parse(
      readFileSync(
        join(outDir, `streakcalendar-randomized-results-${tag}.json`),
        'utf8',
      ),
    ),
  );
}
results.sort((a, b) => a.seed - b.seed);

const seen = new Set();
for (const r of results) {
  if (seen.has(r.seed)) throw new Error(`duplicate seed ${r.seed}`);
  seen.add(r.seed);
}

const failed = results.filter(r => r.outcome !== 'pass');
const sum = key => summaries.reduce((t, s) => t + s[key], 0);
const knownIssueIds = [
  ...new Set(summaries.flatMap(s => s.knownIssues.map(k => k.id))),
];

const merged = {
  unit: summaries[0].unit,
  lens: summaries[0].lens,
  runTag: outTag,
  shards: summaries.map(s => ({
    runTag: s.runTag,
    baseSeed: s.baseSeed,
    requestedSequences: s.requestedSequences,
    executedSequences: s.executedSequences,
    passed: s.passed,
    failed: s.failed,
    heapUsedMbMax: s.heapUsedMbMax,
    wallMs: s.wallMs,
  })),
  timeZone: summaries[0].timeZone,
  node: summaries[0].node,
  seedRange: [results[0]?.seed ?? null, results.at(-1)?.seed ?? null],
  requestedSequences: sum('requestedSequences'),
  executedSequences: results.length,
  executedSteps: sum('executedSteps'),
  lengthRange: [
    Math.min(...results.map(r => r.length)),
    Math.max(...results.map(r => r.length)),
  ],
  lengthHistogram: results.reduce((acc, r) => {
    acc[r.length] = (acc[r.length] ?? 0) + 1;
    return acc;
  }, {}),
  passed: results.length - failed.length,
  failed: failed.length,
  failedKnownOnly: failed.filter(r => r.knownOnly).length,
  failedNew: failed.filter(r => !r.knownOnly).length,
  tolerateKnown: summaries.every(s => s.tolerateKnown),
  knownIssues: knownIssueIds.map(id => {
    const seeds = failed.filter(r => r.knownIssues.includes(id));
    const withRerun = seeds.filter(r => r.rerun10);
    return {
      id,
      seeds: seeds.length,
      firstSeed: seeds[0]?.seed ?? null,
      rerun10Seeds: withRerun.length,
      rerun10FailureRates: withRerun.map(r => r.rerun10.rate),
      minimizedLengths: seeds.map(r => r.minimizedActions?.length ?? null),
      shortestMinimized: seeds
        .filter(r => r.minimizedActions)
        .sort((a, b) => a.minimizedActions.length - b.minimizedActions.length)
        .slice(0, 3)
        .map(r => ({ seed: r.seed, actions: r.minimizedActions })),
    };
  }),
  determinismChecked: sum('determinismChecked'),
  determinismMismatches: sum('determinismMismatches'),
  nonDeterministicSeeds: results
    .filter(r => r.deterministic === false)
    .map(r => r.seed),
  invariantsTripped: failed
    .flatMap(r => r.failures)
    .reduce((acc, f) => {
      acc[f.invariant] = (acc[f.invariant] ?? 0) + 1;
      return acc;
    }, {}),
  flagsCoverage: results.reduce((acc, r) => {
    for (const [flag, on] of Object.entries(r.flags)) {
      if (on) acc[flag] = (acc[flag] ?? 0) + 1;
    }
    return acc;
  }, {}),
  heapUsedMbMax: Math.max(...summaries.map(s => s.heapUsedMbMax)),
  wallMsTotal: sum('wallMs'),
  failedSeeds: failed.map(r => ({
    seed: r.seed,
    outcome: r.outcome,
    firstFailure: r.failures[0] ?? null,
    failures: r.failures.length,
    knownIssues: r.knownIssues,
    knownOnly: r.knownOnly,
    deterministic: r.deterministic,
    minimizedLength: r.minimizedActions?.length ?? null,
    minimizedActions: r.minimizedActions,
    minimizePolicy: r.minimizePolicy,
    rerun10: r.rerun10,
    replay: r.replay,
  })),
};

writeFileSync(
  join(outDir, `streakcalendar-randomized-summary-${outTag}.json`),
  JSON.stringify(merged, null, 2),
);
writeFileSync(
  join(outDir, `streakcalendar-randomized-results-${outTag}.json`),
  JSON.stringify(results, null, 2),
);
console.log(
  JSON.stringify(
    {
      executedSequences: merged.executedSequences,
      executedSteps: merged.executedSteps,
      lengthRange: merged.lengthRange,
      passed: merged.passed,
      failed: merged.failed,
      failedKnownOnly: merged.failedKnownOnly,
      failedNew: merged.failedNew,
      determinism: [merged.determinismChecked, merged.determinismMismatches],
      heapUsedMbMax: merged.heapUsedMbMax,
    },
    null,
    2,
  ),
);
