/**
 * mod-run-capture-analysis — SEEDED RANDOMIZED LONG-RUN stress campaign.
 *
 * Every iteration is one seeded action sequence (length 5–60) over the public
 * API of `runCaptureAnalysis` + `practiceSet`, executed by
 * `testing/stress/mrcaHarness.ts`, which model-checks the documented
 * invariants after every step. Replay any seed with
 *
 *   STRESS_SEEDS=<seed[,seed…]> npx jest --ci __tests__/stress/mrcaRandomizedSeeded
 *
 * Campaign controls (defaults keep the suite fast enough for CI):
 *   STRESS_ITER=<n>        number of sequences (default 24)
 *   STRESS_SEED_BASE=<n>   first seed (default 1); seeds are consecutive
 *   STRESS_DETERMINISM=<k> re-run every k-th seed and compare traces (default 1)
 *   STRESS_OUT=<path>      write the seed → outcome JSON table there
 *   STRESS_SHARD=<i>/<n>   run only seeds where index % n == i
 *   STRESS_KNOWN=<id,...>  invariant ids of already-reported findings; seeds
 *                          whose ONLY violations carry these ids are recorded
 *                          as `known` (still in the table) instead of failing
 *                          the run, so the rest of the campaign stays visible
 *
 * Every failing seed is minimized (greedy action removal) and re-run 10× for a
 * flake rate; the minimized action list lands in the JSON table.
 */
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  const { seams } = jest.requireActual('../../testing/stress/mrcaSeams');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => seams.readArtifact(uri),
  };
});

jest.mock('../../src/util/uuid', () => {
  const actual = jest.requireActual('../../src/util/uuid');
  const { seams } = jest.requireActual('../../testing/stress/mrcaSeams');
  return {
    ...actual,
    makeUuid: () => seams.makeUuid(),
  };
});

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  const { seams } = jest.requireActual('../../testing/stress/mrcaSeams');
  return {
    __esModule: true,
    ...actual,
    analyzeCapture: (...args: unknown[]) =>
      seams.analyzeCapture
        ? seams.analyzeCapture(...args)
        : actual.analyzeCapture(...args),
  };
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  SEQUENCE_MAX_LENGTH,
  SEQUENCE_MIN_LENGTH,
  executeSequence,
  generateSequence,
  minimizeActions,
  type Action,
  type SequenceResult,
} from '../../testing/stress/mrcaHarness';

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '24'));
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? '1');
const DETERMINISM_EVERY = Math.max(
  1,
  Number(process.env.STRESS_DETERMINISM ?? '1'),
);
const OUT = process.env.STRESS_OUT ?? null;
const EXPLICIT_SEEDS = (process.env.STRESS_SEEDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(s => s.length > 0)
  .map(Number);
const [SHARD_INDEX, SHARD_COUNT] = (process.env.STRESS_SHARD ?? '0/1')
  .split('/')
  .map(Number) as [number, number];
const KNOWN = new Set(
  (process.env.STRESS_KNOWN ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0),
);
const CHUNK = 25;
const FLAKE_RERUNS = 10;
// Real fusion inference per run: budget generously per chunk.
const CHUNK_TIMEOUT_MS = 20 * 60_000;

function campaignSeeds(): number[] {
  if (EXPLICIT_SEEDS.length > 0) return EXPLICIT_SEEDS;
  const seeds: number[] = [];
  for (let i = 0; i < ITER; i += 1) {
    if (i % SHARD_COUNT === SHARD_INDEX) seeds.push(SEED_BASE + i);
  }
  return seeds;
}

const SEEDS = campaignSeeds();
const chunks: number[][] = [];
for (let i = 0; i < SEEDS.length; i += CHUNK) {
  chunks.push(SEEDS.slice(i, i + CHUNK));
}

interface SeedRow {
  seed: number;
  length: number;
  outcome: SequenceResult['outcome'] | 'known';
  deterministic: boolean | null;
  violations: SequenceResult['violations'];
  stats: SequenceResult['stats'];
  durationMs: number;
  error?: string;
  minimized?: {
    length: number;
    actions: Action[];
    violations: SequenceResult['violations'];
    error?: string;
  };
  flakeRate?: { failures: number; runs: number };
  trace?: SequenceResult['trace'];
}

const rows: SeedRow[] = [];

function stableTrace(result: SequenceResult): string {
  return JSON.stringify({
    trace: result.trace,
    violations: result.violations,
    stats: result.stats,
  });
}

function onlyKnown(result: SequenceResult): boolean {
  return (
    result.outcome === 'violation' &&
    result.violations.every(v => KNOWN.has(v.invariant))
  );
}

function failed(result: SequenceResult): boolean {
  return result.outcome !== 'ok' && !onlyKnown(result);
}

async function runOne(seed: number, index: number): Promise<SeedRow> {
  const actions = generateSequence(seed);
  expect(actions.length).toBeGreaterThanOrEqual(SEQUENCE_MIN_LENGTH);
  expect(actions.length).toBeLessThanOrEqual(SEQUENCE_MAX_LENGTH);
  const startedAt = Date.now();
  const first = await executeSequence(seed, actions);
  let deterministic: boolean | null = null;
  if (index % DETERMINISM_EVERY === 0 || failed(first)) {
    const second = await executeSequence(seed, generateSequence(seed));
    deterministic = stableTrace(first) === stableTrace(second);
  }
  const row: SeedRow = {
    seed,
    length: actions.length,
    outcome: onlyKnown(first) ? 'known' : first.outcome,
    deterministic,
    violations: first.violations,
    stats: first.stats,
    durationMs: Date.now() - startedAt,
    ...(first.error !== undefined ? { error: first.error } : {}),
    trace: first.trace,
  };
  if (failed(first) || deterministic === false) {
    let failures = 0;
    for (let k = 0; k < FLAKE_RERUNS; k += 1) {
      const again = await executeSequence(seed, generateSequence(seed));
      if (failed(again) || stableTrace(again) !== stableTrace(first)) {
        failures += 1;
      }
    }
    row.flakeRate = { failures, runs: FLAKE_RERUNS };
    if (failed(first)) {
      const minimal = await minimizeActions(seed, actions, failed);
      const replay = await executeSequence(seed, minimal, {
        stopOnViolation: true,
      });
      row.minimized = {
        length: minimal.length,
        actions: minimal,
        violations: replay.violations,
        ...(replay.error !== undefined ? { error: replay.error } : {}),
      };
    }
  }
  return row;
}

describe('mod-run-capture-analysis randomized seeded campaign', () => {
  afterAll(() => {
    if (!OUT) return;
    mkdirSync(dirname(OUT), { recursive: true });
    const sorted = rows.slice().sort((a, b) => a.seed - b.seed);
    const totals = sorted.reduce<SequenceResult['stats']>(
      (acc, r) => {
        for (const key of Object.keys(acc) as Array<
          keyof SequenceResult['stats']
        >) {
          acc[key] += r.stats[key];
        }
        return acc;
      },
      {
        runsStarted: 0,
        runsSettled: 0,
        scored: 0,
        lowConfidence: 0,
        qualityBlocked: 0,
        unavailable: 0,
        rejected: 0,
        reserves: 0,
        releases: 0,
        practiceSetCalls: 0,
        kvCorruptions: 0,
        dbFaultsArmed: 0,
        dbFaultsHit: 0,
        racesRun: 0,
        abandoned: 0,
      },
    );
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          unit: 'mod-run-capture-analysis',
          lens: 'randomized-seeded',
          sequenceLength: {
            min: SEQUENCE_MIN_LENGTH,
            max: SEQUENCE_MAX_LENGTH,
          },
          seedBase: SEED_BASE,
          seedsPlanned: SEEDS.length,
          executed: sorted.length,
          ok: sorted.filter(r => r.outcome === 'ok').length,
          violation: sorted.filter(r => r.outcome === 'violation').length,
          known: sorted.filter(r => r.outcome === 'known').length,
          knownInvariants: [...KNOWN],
          violationsByInvariant: sorted.reduce<Record<string, number[]>>(
            (acc, r) => {
              for (const id of new Set(r.violations.map(v => v.invariant))) {
                (acc[id] ??= []).push(r.seed);
              }
              return acc;
            },
            {},
          ),
          harnessError: sorted.filter(r => r.outcome === 'harness_error')
            .length,
          determinismChecked: sorted.filter(r => r.deterministic !== null)
            .length,
          nonDeterministic: sorted.filter(r => r.deterministic === false)
            .length,
          actionsExecuted: sorted.reduce((n, r) => n + r.length, 0),
          totals,
          rows: sorted.map(row => ({
            ...row,
            // Traces are large; keep them only where they are evidence.
            trace:
              row.outcome === 'ok' && row.deterministic !== false
                ? undefined
                : row.trace,
          })),
        },
        null,
        2,
      ),
    );
  });

  test.each(chunks.map((seeds, i) => [i, seeds] as const))(
    'chunk %i holds every invariant on every step',
    async (_chunk, seeds) => {
      const chunkRows: SeedRow[] = [];
      for (let i = 0; i < seeds.length; i += 1) {
        const row = await runOne(seeds[i]!, SEEDS.indexOf(seeds[i]!));
        rows.push(row);
        chunkRows.push(row);
      }
      const broken = chunkRows.filter(
        r =>
          (r.outcome !== 'ok' && r.outcome !== 'known') ||
          r.deterministic === false,
      );
      expect(
        broken.map(r => ({
          seed: r.seed,
          outcome: r.outcome,
          deterministic: r.deterministic,
          violations: (r.minimized?.violations ?? r.violations).slice(0, 5),
          error: r.minimized?.error ?? r.error,
          minimizedLength: r.minimized?.length,
          flakeRate: r.flakeRate,
        })),
      ).toEqual([]);
    },
    CHUNK_TIMEOUT_MS,
  );
});
