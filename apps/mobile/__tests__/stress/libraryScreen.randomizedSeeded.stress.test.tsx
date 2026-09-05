/**
 * STRESS — LibraryScreen, lens `randomized-seeded`.
 *
 * Renders the real LibraryScreen inside the real bottom-tab + native-stack
 * navigators with the real training/auth stores, a real SQLite database behind
 * the op-sqlite mock and a fake training server behind fetch. A seeded PRNG
 * drives 5–60 legal/near-legal actions per sequence (tab presses, row taps,
 * navigation, gated DB/fetch settlement in arbitrary order and outcome, local
 * inserts, server mutations, auth/configuration flips); the model invariants
 * documented in `xc-harness/stress-libraryscreen-randomized/runner.tsx` are checked after
 * every action.
 *
 *   STRESS_ITER=2000 STRESS_OUT=/tmp/lib-stress npx jest --ci __tests__/stress/libraryScreen.randomizedSeeded
 *
 * Default (no env) runs a short campaign so the suite stays fast. Every run
 * writes the seed → outcome table to `$STRESS_OUT` (default
 * `artifacts/stress/libraryScreen-randomized-seeded/`, gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
jest.mock('@op-engineering/op-sqlite', () => {
  const {
    dbGate,
  } = require('../../xc-harness/stress-libraryscreen-randomized/gates');
  return { open: () => dbGate.open() };
});

import {
  minimize,
  runSequence,
  type SequenceResult,
} from '../../xc-harness/stress-libraryscreen-randomized/runner';

const ITER = Number.parseInt(process.env.STRESS_ITER ?? '24', 10);
const SEED_BASE = Number.parseInt(process.env.STRESS_SEED_BASE ?? '1000', 10);
const BATCH = Number.parseInt(process.env.STRESS_BATCH ?? '25', 10);
const DETERMINISM_SAMPLE = Number.parseInt(
  process.env.STRESS_DETERMINISM ?? '8',
  10,
);
const FLAKY_RERUNS = Number.parseInt(
  process.env.STRESS_FLAKY_RERUNS ?? '10',
  10,
);
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'libraryScreen-randomized-seeded',
  );
const TEST_TIMEOUT_MS = Math.max(30_000, BATCH * 4_000);
// minimize (≤ length re-runs) + FLAKY_RERUNS per failing seed
const AFTER_ALL_TIMEOUT_MS = 20 * 60_000;

interface SeedRow {
  seed: number;
  outcome: SequenceResult['outcome'];
  length: number;
  traceHash: string;
  durationMs: number;
  loadsIssued: number;
  fetchesIssued: number;
  world: SequenceResult['world'];
  observations: SequenceResult['observations'];
  invariants: string[];
  error: string | null;
}

const rows: SeedRow[] = [];
const failures: SequenceResult[] = [];

function rowOf(result: SequenceResult): SeedRow {
  return {
    seed: result.seed,
    outcome: result.outcome,
    length: result.length,
    traceHash: result.traceHash,
    durationMs: result.durationMs,
    loadsIssued: result.loadsIssued,
    fetchesIssued: result.fetchesIssued,
    world: result.world,
    observations: result.observations,
    invariants: [...new Set(result.violations.map(v => v.invariant))],
    error: result.error,
  };
}

function writeJson(name: string, value: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

const batches: [number, number][] = [];
for (let start = 0; start < ITER; start += BATCH) {
  batches.push([
    SEED_BASE + start,
    SEED_BASE + Math.min(ITER, start + BATCH) - 1,
  ]);
}

describe(`LibraryScreen randomized-seeded campaign (${ITER} sequences, seeds ${SEED_BASE}…${SEED_BASE + ITER - 1})`, () => {
  test.each(batches)(
    'seeds %i–%i hold every invariant',
    async (first, last) => {
      const batchFailures: string[] = [];
      for (let seed = first; seed <= last; seed += 1) {
        const result = await runSequence(seed, { keepSteps: false });
        rows.push(rowOf(result));
        if (result.outcome !== 'HELD') {
          failures.push(result);
          batchFailures.push(
            `seed ${seed}: ${result.outcome} ${result.error ?? ''} ${result.violations
              .slice(0, 3)
              .map(v => `@${v.step} ${v.invariant}: ${v.detail}`)
              .join(' | ')}`,
          );
        }
      }
      expect(batchFailures).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'same seed twice → identical trace (determinism)',
    async () => {
      const mismatches: string[] = [];
      const step = Math.max(1, Math.floor(ITER / DETERMINISM_SAMPLE));
      const seeds: number[] = [];
      for (
        let i = 0;
        i < ITER && seeds.length < DETERMINISM_SAMPLE;
        i += step
      ) {
        seeds.push(SEED_BASE + i);
      }
      const replays: { seed: number; first: string; second: string }[] = [];
      for (const seed of seeds) {
        const a = await runSequence(seed);
        const b = await runSequence(seed);
        replays.push({ seed, first: a.traceHash, second: b.traceHash });
        if (a.traceHash !== b.traceHash) {
          const firstDiff = a.steps.findIndex(
            (s, i) =>
              b.steps[i] === undefined ||
              s.action !== b.steps[i]!.action ||
              s.view !== b.steps[i]!.view,
          );
          mismatches.push(
            `seed ${seed}: ${a.traceHash} ≠ ${b.traceHash}; first divergence at step ${firstDiff}: ${JSON.stringify(a.steps[firstDiff])} vs ${JSON.stringify(b.steps[firstDiff])}`,
          );
        }
      }
      writeJson('determinism.json', { seeds: replays, mismatches });
      expect(mismatches).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  afterAll(async () => {
    const minimized: {
      seed: number;
      invariant: string;
      fullLength: number;
      prefix: number;
      firstViolation: SequenceResult['violations'][number] | null;
      trace: string[];
    }[] = [];
    for (const failure of failures) {
      const invariants = [...new Set(failure.violations.map(v => v.invariant))];
      for (const invariant of invariants.length > 0 ? invariants : ['ERROR']) {
        const { prefix, result } = await minimize(failure.seed, invariant);
        minimized.push({
          seed: failure.seed,
          invariant,
          fullLength: failure.length,
          prefix,
          firstViolation:
            result.violations.find(v => v.invariant === invariant) ?? null,
          trace: result.steps.map(
            s =>
              `${s.step}. ${s.action} => ${s.view}${s.violations.length ? `  !! ${s.violations.join(' ; ')}` : ''}`,
          ),
        });
      }
    }
    // Flake check: every failing seed is replayed FLAKY_RERUNS more times and
    // the observed failure rate is recorded (a deterministic harness should
    // yield 100% or reveal nondeterminism).
    const flaky: {
      seed: number;
      reruns: number;
      failed: number;
      rate: number;
      traceHashes: string[];
    }[] = [];
    for (const failure of failures) {
      const hashes: string[] = [];
      let failed = 0;
      for (let i = 0; i < FLAKY_RERUNS; i += 1) {
        const again = await runSequence(failure.seed, { keepSteps: false });
        hashes.push(again.traceHash);
        if (again.outcome !== 'HELD') failed += 1;
      }
      flaky.push({
        seed: failure.seed,
        reruns: FLAKY_RERUNS,
        failed,
        rate: FLAKY_RERUNS > 0 ? failed / FLAKY_RERUNS : 0,
        traceHashes: [...new Set(hashes)],
      });
    }
    const summary = {
      generatedAt: new Date().toISOString(),
      iterations: ITER,
      executed: rows.length,
      seedBase: SEED_BASE,
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      error: rows.filter(r => r.outcome === 'ERROR').length,
      lengths: {
        min: Math.min(...rows.map(r => r.length)),
        max: Math.max(...rows.map(r => r.length)),
        total: rows.reduce((n, r) => n + r.length, 0),
      },
      loadsIssued: rows.reduce((n, r) => n + r.loadsIssued, 0),
      fetchesIssued: rows.reduce((n, r) => n + r.fetchesIssued, 0),
      worlds: {
        guest: rows.filter(r => r.world.owner === 'guest').length,
        signedIn: rows.filter(r => r.world.owner === 'signed-in').length,
        configured: rows.filter(r => r.world.configured).length,
        initialHome: rows.filter(r => r.world.initialTab === 'Home').length,
      },
      wallMs: rows.reduce((n, r) => n + r.durationMs, 0),
      failingSeeds: rows.filter(r => r.outcome !== 'HELD').map(r => r.seed),
      observations: {
        segmentsHiddenWhileLoadingSteps: rows.reduce(
          (n, r) => n + r.observations.segmentsHiddenWhileLoading,
          0,
        ),
        sequencesWithSegmentsHiddenWhileLoading: rows.filter(
          r => r.observations.segmentsHiddenWhileLoading > 0,
        ).length,
      },
    };
    writeJson('seeds.json', rows);
    writeJson('summary.json', summary);
    writeJson('minimized.json', minimized);
    writeJson('flaky.json', flaky);
  }, AFTER_ALL_TIMEOUT_MS);
});
