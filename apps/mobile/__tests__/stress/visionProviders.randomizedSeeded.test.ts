/// <reference types="node" />
/**
 * Seeded randomized long-run over `src/vision/providers.ts`
 * (selectVisionProviders, createFusionProviders, scoringStackStatus, the
 * returned providers and the module registry). Harness + invariants live in
 * `__harness__/stress/visionProviders/harness.ts`.
 *
 * Default run is small so the suite stays fast. Campaign controls:
 *   STRESS_ITER=<n>      number of sequences (default 40)
 *   STRESS_SEED=<n>      first seed (default 1); seeds are consecutive
 *   STRESS_OUT=<path>    write the seed → outcome JSON table there
 *   STRESS_REPLAY=<seed> replay one seed 10× and report its failure rate
 *
 * Replay any row: STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci
 *   __tests__/stress/visionProviders.randomizedSeeded.test.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { Platform } from 'react-native';

import { DEFAULT_MODEL_MANIFEST } from '@pickle/model-registry';
import { SHOT_TYPES } from '@pickle/shared-types';

import {
  MAX_SEQUENCE_LENGTH,
  MIN_SEQUENCE_LENGTH,
  expectedFusion,
  generateSequence,
  runCampaign,
  runSeed,
  type HarnessEnv,
  type PlatformOs,
  type SequenceOutcome,
} from '../../__harness__/stress/visionProviders/harness';

const ITERATIONS = Number.parseInt(process.env.STRESS_ITER ?? '40', 10);
const START_SEED = Number.parseInt(process.env.STRESS_SEED ?? '1', 10);
const OUT_PATH = process.env.STRESS_OUT ?? null;
const REPLAY_SEED = process.env.STRESS_REPLAY
  ? Number.parseInt(process.env.STRESS_REPLAY, 10)
  : null;

let currentOs: PlatformOs = Platform.OS;
const env: HarnessEnv = {
  setPlatformOs(os) {
    currentOs = os;
    jest.replaceProperty(Platform, 'OS', os);
  },
  currentPlatformOs() {
    return currentOs;
  },
};

afterEach(() => {
  jest.restoreAllMocks();
  currentOs = Platform.OS;
});

function describeViolations(rows: readonly SequenceOutcome[]): string {
  return rows
    .filter(row => row.outcome === 'BROKEN')
    .map(
      row =>
        `seed ${row.seed} (len ${row.length}, minimized to steps [${
          row.minimized?.keptIndices.join(',') ?? ''
        }]):\n${row.violations
          .map(v => `  step ${v.step} ${v.op} ${v.invariant}: ${v.detail}`)
          .join('\n')}`,
    )
    .join('\n');
}

describe('vision/providers — seeded randomized long-run', () => {
  test('preconditions: the manifest actually exercises the real fusion path', () => {
    // Without these the campaign would only ever observe 'unavailable'.
    for (const os of ['ios', 'android'] as const) {
      expect(expectedFusion(os, null).kind).toBe('real');
      for (const slug of SHOT_TYPES) {
        expect(expectedFusion(os, slug).kind).toBe('real');
      }
    }
    expect(
      DEFAULT_MODEL_MANIFEST.entries.some(
        entry =>
          entry.id === 'stroke.heuristic-hierarchical' &&
          entry.deploymentStatus === 'production',
      ),
    ).toBe(true);
  });

  test('generator: pure in the seed and within the 5–60 length bound', () => {
    for (let seed = START_SEED; seed < START_SEED + 200; seed += 1) {
      const a = generateSequence(seed);
      const b = generateSequence(seed);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.length).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
      expect(a.length).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
    }
  });

  test(
    `campaign: ${ITERATIONS} sequences from seed ${START_SEED} hold every invariant and replay deterministically`,
    async () => {
      const summary = await runCampaign(START_SEED, ITERATIONS, env);
      if (OUT_PATH) {
        fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
        fs.writeFileSync(
          OUT_PATH,
          JSON.stringify(
            {
              module: 'apps/mobile/src/vision/providers.ts',
              lens: 'randomized-seeded',
              generatedAtIso: new Date().toISOString(),
              ...summary,
            },
            null,
            2,
          ),
        );
      }
      expect(summary.sequences).toBe(ITERATIONS);
      expect(summary.minLength).toBeGreaterThanOrEqual(MIN_SEQUENCE_LENGTH);
      expect(summary.maxLength).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
      // Every public entry point must have been exercised at least once
      // (a single-seed replay is too short to guarantee that).
      if (ITERATIONS >= 10) {
        for (const op of [
          'select',
          'fusion',
          'classify',
          'registry',
          'status',
          'platform',
          'withEntry',
        ]) {
          expect(summary.opCounts[op] ?? 0).toBeGreaterThan(0);
        }
      }
      expect(summary.nonDeterministic).toBe(0);
      if (summary.broken > 0) {
        throw new Error(
          `${summary.broken}/${summary.sequences} sequences violated invariants:\n${describeViolations(
            summary.rows,
          )}`,
        );
      }
    },
    // ~1–2 ms per step; a 2000-sequence campaign is a few minutes.
    Math.max(60_000, ITERATIONS * 600),
  );

  (REPLAY_SEED === null ? test.skip : test)(
    `replay: seed ${REPLAY_SEED} run 10× reports its failure rate`,
    async () => {
      const seed = REPLAY_SEED ?? 0;
      let failures = 0;
      const hashes = new Set<string>();
      for (let i = 0; i < 10; i += 1) {
        const row = await runSeed(seed, env);
        hashes.add(row.traceHash);
        if (row.outcome === 'BROKEN') failures += 1;
      }
      const report = { seed, runs: 10, failures, distinctTraces: hashes.size };
      if (OUT_PATH) {
        fs.writeFileSync(
          OUT_PATH.replace(/\.json$/, '') + `.replay-${seed}.json`,
          JSON.stringify(report, null, 2),
        );
      }
      expect(hashes.size).toBe(1);
      expect(failures).toBe(0);
    },
    120_000,
  );
});
