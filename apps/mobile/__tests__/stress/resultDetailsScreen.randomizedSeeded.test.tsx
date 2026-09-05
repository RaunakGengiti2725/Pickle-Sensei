/**
 * STRESS · scr-resultdetailsscreen · lens randomized-seeded — CAMPAIGN
 *
 * Seeded randomized long-run over the public surface of ResultDetailsScreen
 * rendered inside a REAL React Navigation native stack over the REAL local
 * store, training store, api-session store and try-again handoff. Only
 * native modules and `fetch` are replaced (see the mocks below).
 *
 *   default:   STRESS_ITER unset  → 24 sequences (fast enough for the suite)
 *   campaign:  STRESS_ITER=2000   → 2000+ sequences, length 5–60 each
 *   replay:    STRESS_SEED=<n>    → run exactly that seed (twice, for the
 *                                   determinism check) and print its trace
 *
 * Every failing seed is minimized (prefix truncation + greedy deletion),
 * re-run 10× to measure flakiness, and written together with every seed's
 * outcome to STRESS_OUT (default: <os tmp>/stress-scr-resultdetailsscreen/).
 */
import type { PoseSequenceSidecarRef } from '../../src/camera/capture';

// apps/mobile types only `jest` (no @types/node); this file declares the exact
// Node surface it drives — the same convention as dbMigrationMalformedOutbox.
declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  hrtime: { bigint(): bigint };
  memoryUsage(): { heapUsed: number };
};
declare const globalThis: { gc?: () => void };

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync: MockDatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const fs = require('fs') as {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const os = require('os') as { tmpdir(): string };
const nodePath = require('path') as { join(...parts: string[]): string };

// ─── Native module mocks (the ONLY mocked app dependencies besides fetch) ───

// op-sqlite → a real SQLite engine (node:sqlite) so production migrations,
// repository writers and every read path run unmodified.
const mockSqliteState: { real: DatabaseSync | null } = { real: null };
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockSqliteState.real)
      mockSqliteState.real = new MockDatabaseSync(':memory:');
    const db = mockSqliteState.real;
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: () => {
        db.close();
        mockSqliteState.real = null;
      },
    };
  },
}));

// The native capture bridge: the pose sidecar read the review path performs.
const mockSidecarBehaviour: {
  uri: string;
  kind: 'none' | 'valid' | 'hash_mismatch' | 'unreadable';
} = {
  uri: '',
  kind: 'none',
};
const mockSidecarJson: { value: string } = { value: '' };
jest.mock('react-native', () => {
  // Mutate (don't spread) the actual module: spreading forces every lazy
  // TurboModule getter, which throws for modules absent from the Jest binary.
  const actual =
    jest.requireActual<typeof import('react-native')>('react-native');
  const modules = actual.NativeModules as Record<string, unknown>;
  modules['PickleVideoCapture'] = {
    ...(modules['PickleVideoCapture'] as Record<string, unknown> | undefined),
    readTextFile: async (uri: string): Promise<string> => {
      if (
        uri !== mockSidecarBehaviour.uri ||
        mockSidecarBehaviour.kind === 'unreadable'
      ) {
        throw new Error(`ENOENT: ${uri}`);
      }
      return mockSidecarJson.value;
    },
  };
  return actual;
});

// The library's own Jest mock: real contexts/hooks, provider without the
// native RNCSafeAreaProvider view.
jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);
jest.mock('react-native-svg', () => {
  const React = require('react') as typeof import('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = require('react') as typeof import('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import {
  describeAction,
  generateActions,
  minimizeFailure,
  runSequence,
  type Action,
  type HarnessEnvironment,
  type SequenceResult,
} from './resultDetailsScreen.randomizedSeeded.harness';
import { Rng } from './resultDetailsScreen.randomizedSeeded.fixtures';

// ─── Campaign configuration ─────────────────────────────────────────────────

const ITERATIONS = Number(process.env['STRESS_ITER'] ?? '24');
const BASE_SEED = Number(process.env['STRESS_BASE_SEED'] ?? '1000');
const REPLAY_SEED = process.env['STRESS_SEED'];
const OUT_DIR =
  process.env['STRESS_OUT'] ??
  nodePath.join(os.tmpdir(), 'stress-scr-resultdetailsscreen');
const FLAKY_RERUNS = 10;

function buildEnvironment(): HarnessEnvironment {
  const { sequence } = generateSwingSequence();
  const json = serializePoseSequence(sequence);
  mockSidecarJson.value = json;
  const ref: PoseSequenceSidecarRef = {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///captures/placeholder.pose.json',
    frameCount: sequence.frames.length,
    sha256: sha256Hex(json),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: sequence.producedBy.modelVersion,
  };
  return {
    sidecar: { ref, mismatchRef: { ...ref, sha256: 'ab'.repeat(32) } },
    setSidecarBehaviour: behaviour => {
      mockSidecarBehaviour.uri = behaviour.uri;
      mockSidecarBehaviour.kind = behaviour.kind;
    },
  };
}

interface SeedRow {
  seed: number;
  length: number;
  outcome: 'held' | 'failed';
  deterministic: boolean;
  world: SequenceResult['world'];
  failure: SequenceResult['failure'];
  minimized: { actions: string[]; runs: number } | null;
  flaky: { reruns: number; failures: number; rate: number } | null;
  ms: number;
  /** Process heap after this seed (after a forced GC when node --expose-gc). */
  heapMb: number;
}

function traceKey(result: SequenceResult): string {
  return result.trace.map(step => `${step.action}=>${step.digest}`).join('\n');
}

describe('STRESS scr-resultdetailsscreen · randomized-seeded', () => {
  const env = buildEnvironment();

  it(
    `runs ${REPLAY_SEED ? `seed ${REPLAY_SEED}` : `${ITERATIONS} seeded sequences`} against the real navigator/stores`,
    async () => {
      const rows: SeedRow[] = [];
      const seeds = REPLAY_SEED
        ? [Number(REPLAY_SEED)]
        : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);
      const nonDeterministic: number[] = [];
      let executed = 0;
      const startedAt = process.hrtime.bigint();

      for (const seed of seeds) {
        const t0 = process.hrtime.bigint();
        const first = await runSequence(seed, env);
        executed += 1;
        const second = await runSequence(seed, env);
        executed += 1;
        const deterministic =
          traceKey(first) === traceKey(second) &&
          first.outcome === second.outcome;
        if (!deterministic) nonDeterministic.push(seed);
        const row: SeedRow = {
          seed,
          length: first.length,
          outcome: first.outcome,
          deterministic,
          world: first.world,
          failure: first.failure,
          minimized: null,
          flaky: null,
          ms: 0,
          heapMb: 0,
        };
        if (first.outcome === 'failed' || second.outcome === 'failed') {
          const failed = first.outcome === 'failed' ? first : second;
          row.outcome = 'failed';
          row.failure = failed.failure;
          const actions: Action[] = generateActions(seed, first.length);
          const minimized = await minimizeFailure(
            seed,
            actions,
            env,
            result => result.outcome === 'failed',
          );
          executed += minimized.runs;
          row.minimized = {
            actions: minimized.actions.map(describeAction),
            runs: minimized.runs,
          };
          let failures = 0;
          for (let i = 0; i < FLAKY_RERUNS; i += 1) {
            const rerun = await runSequence(seed, env, {
              actions: minimized.actions,
            });
            executed += 1;
            if (rerun.outcome === 'failed') failures += 1;
          }
          row.flaky = {
            reruns: FLAKY_RERUNS,
            failures,
            rate: failures / FLAKY_RERUNS,
          };
        }
        row.ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
        globalThis.gc?.();
        row.heapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576);
        rows.push(row);
        if (REPLAY_SEED) {
          console.log(
            JSON.stringify(
              {
                seed,
                trace: first.trace,
                failure: first.failure,
                requests: first.requests,
                consoleErrors: first.consoleErrors,
              },
              null,
              2,
            ),
          );
        }
      }

      const failed = rows.filter(row => row.outcome === 'failed');
      const summary = {
        unit: 'scr-resultdetailsscreen',
        lens: 'randomized-seeded',
        baseSeed: BASE_SEED,
        sequences: rows.length,
        scenariosExecuted: executed,
        actionsExecuted: rows.reduce((sum, row) => sum + row.length, 0),
        lengths: {
          min: Math.min(...rows.map(r => r.length)),
          max: Math.max(...rows.map(r => r.length)),
        },
        held: rows.length - failed.length,
        failed: failed.length,
        nonDeterministicSeeds: nonDeterministic,
        failingSeeds: failed.map(row => ({
          seed: row.seed,
          failure: row.failure,
          minimized: row.minimized,
          flaky: row.flaky,
        })),
        worldCoverage: coverage(rows),
        heapMb: {
          first: rows[0]?.heapMb ?? 0,
          last: rows[rows.length - 1]?.heapMb ?? 0,
          max: Math.max(...rows.map(r => r.heapMb)),
        },
        wallMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      };
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(
        nodePath.join(OUT_DIR, 'seeds.json'),
        JSON.stringify({ summary, seeds: rows }, null, 2),
      );
      console.log(
        `[stress] ${JSON.stringify(summary)} → ${OUT_DIR}/seeds.json`,
      );

      // Sanity: the generator honours the documented envelope.
      expect(summary.lengths.min).toBeGreaterThanOrEqual(5);
      expect(summary.lengths.max).toBeLessThanOrEqual(60);
      expect(nonDeterministic).toEqual([]);
      expect(
        failed.map(row => ({
          seed: row.seed,
          failure: row.failure,
          minimized: row.minimized,
          flaky: row.flaky,
        })),
      ).toEqual([]);
    },
    // A 2000-sequence campaign runs for a long time; the default is small.
    Math.max(120_000, ITERATIONS * 6_000),
  );
});

function coverage(rows: SeedRow[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const bump = (dimension: string, value: string) => {
    const bucket = (out[dimension] ??= {});
    bucket[value] = (bucket[value] ?? 0) + 1;
  };
  for (const row of rows) {
    bump('owner', row.world.owner);
    bump('present', String(row.world.present));
    bump('kind', row.world.kind);
    bump('record', row.world.record);
    bump('capture', row.world.capture);
    bump('sidecar', row.world.sidecar);
    bump('siblings', String(row.world.siblings));
    bump('sync', row.world.sync);
    bump('training', row.world.training);
    bump('feedback', row.world.feedback);
    bump('apiSession', String(row.world.apiSession));
  }
  return out;
}

// Keep the RNG import honest: the fixtures module is the single source of
// randomness, and a smoke check that two generators from one seed agree.
describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect(Array.from({ length: 8 }, () => a.int(0, 1000))).toEqual(
      Array.from({ length: 8 }, () => b.int(0, 1000)),
    );
  });
});
