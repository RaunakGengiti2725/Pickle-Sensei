/**
 * STRESS `scr-progressscreen` / lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the real ProgressScreen mounted in a real
 * navigator. Helpers live in apps/mobile/__harness__/progressScreenStress/
 * (runner.tsx: invariants I1–I9; model.ts: the data oracle) — outside
 * __tests__ so jest's default testMatch does not treat them as suites.
 * Every sequence is replayable from its seed; the campaign writes a
 * seed → outcome JSON table.
 *
 *   default (suite):  STRESS_ITER=40 sequences, seeds 1..40
 *   full campaign:    STRESS_ITER=2000 npx jest --ci --silent progressScreen.randomized
 *   replay one seed:  STRESS_SEED=<seed> STRESS_ITER=1 npx jest progressScreen.randomized
 *
 * `STRESS_NOW` pins the clock (Date only — timers stay real) so windows are
 * identical across runs and machines; `STRESS_ARTIFACT` overrides the table
 * path (default apps/mobile/artifacts/stress/progressscreen-randomized-seeded.json,
 * gitignored).
 */

jest.mock('@op-engineering/op-sqlite', () =>
  (
    jest.requireActual(
      '../../__harness__/progressScreenStress/dbMock',
    ) as typeof import('../../__harness__/progressScreenStress/dbMock')
  ).createOpSqliteMock(),
);

jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const React = jest.requireActual<typeof import('react')>('react');
  const insets = { top: 47, bottom: 34, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 393, height: 852 };
  const SafeAreaInsetsContext = React.createContext(insets);
  const SafeAreaFrameContext = React.createContext(frame);
  return {
    SafeAreaView: RN.View,
    SafeAreaProvider: (props: { children?: React.ReactNode }) =>
      React.createElement(RN.View, null, props.children),
    SafeAreaInsetsContext,
    SafeAreaFrameContext,
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets, frame },
  };
});

jest.mock('react-native-linear-gradient', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: RN.View };
});

import {
  generateScenario,
  type Scenario,
} from '../../__harness__/progressScreenStress/generator';
import {
  KNOWN_DEFECTS,
  runScenario,
  type ScenarioOutcome,
} from '../../__harness__/progressScreenStress/runner';

// apps/mobile types only `jest` (no @types/node); declare the exact Node
// surface the artifact writer drives.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const fs = require('node:fs') as {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const path = require('node:path') as {
  resolve(...parts: string[]): string;
  dirname(path: string): string;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

const ITERATIONS = envInt('STRESS_ITER', 40);
const BASE_SEED = envInt('STRESS_SEED', 1);
const NOW_ISO = process.env['STRESS_NOW'] ?? '2026-09-04T15:30:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
if (!Number.isFinite(NOW_MS)) {
  throw new Error(`STRESS_NOW is not a parseable instant: "${NOW_ISO}"`);
}
const ARTIFACT_PATH =
  process.env['STRESS_ARTIFACT'] ??
  path.resolve(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'progressscreen-randomized-seeded.json',
  );
const CHUNK = 20;
const CHUNK_TIMEOUT_MS = 20 * 60_000;
const DETERMINISM_SEEDS = 5;
const FLAKE_RERUNS = 10;

const seeds: number[] = [];
for (let index = 0; index < ITERATIONS; index += 1)
  seeds.push(BASE_SEED + index);
const chunks: number[][] = [];
for (let index = 0; index < seeds.length; index += CHUNK) {
  chunks.push(seeds.slice(index, index + CHUNK));
}

const outcomes = new Map<number, ScenarioOutcome>();
interface MinimizedFailure {
  seed: number;
  invariant: string;
  message: string;
  failingStep: number;
  originalLength: number;
  minimizedLength: number;
  minimizedActions: string[];
  rerunFailures: number;
  rerunTotal: number;
}
const minimized: MinimizedFailure[] = [];
const determinism: Array<{ seed: number; identical: boolean; steps: number }> =
  [];

beforeAll(() => {
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'performance',
      'hrtime',
    ],
  });
  jest.setSystemTime(NOW_MS);
});

afterAll(() => {
  jest.useRealTimers();
});

function sameFailure(
  outcome: ScenarioOutcome,
  reference: NonNullable<ScenarioOutcome['failure']>,
): boolean {
  return (
    outcome.failure !== null &&
    outcome.failure.invariant === reference.invariant
  );
}

/** ddmin over the action list: the smallest subsequence (by halving) that
 * still violates the same invariant from the same seed's fixtures. */
async function minimize(seed: number, outcome: ScenarioOutcome) {
  const full = generateScenario(seed, NOW_MS);
  const reference = outcome.failure!;
  let actions = full.actions.slice(
    0,
    reference.step === 0 ? 0 : reference.step,
  );
  let granularity = 2;
  while (actions.length >= 2) {
    const size = Math.ceil(actions.length / granularity);
    let reduced = false;
    for (let start = 0; start < actions.length; start += size) {
      const candidate = [
        ...actions.slice(0, start),
        ...actions.slice(start + size),
      ];
      const result = await runScenario(
        { ...full, actions: candidate },
        NOW_MS,
        { stopOnFailure: true },
      );
      if (sameFailure(result, reference)) {
        actions = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= actions.length) break;
      granularity = Math.min(granularity * 2, actions.length);
    }
  }
  let rerunFailures = 0;
  for (let attempt = 0; attempt < FLAKE_RERUNS; attempt += 1) {
    const result = await runScenario(full, NOW_MS, { stopOnFailure: true });
    if (sameFailure(result, reference)) rerunFailures += 1;
  }
  const minimizedRun = await runScenario({ ...full, actions }, NOW_MS, {
    stopOnFailure: true,
  });
  minimized.push({
    seed,
    invariant: reference.invariant,
    message: reference.message,
    failingStep: reference.step,
    originalLength: full.actions.length,
    minimizedLength: actions.length,
    minimizedActions: minimizedRun.steps.map(step => step.action),
    rerunFailures,
    rerunTotal: FLAKE_RERUNS,
  });
}

describe('ProgressScreen seeded randomized long-run', () => {
  for (const chunk of chunks) {
    test(
      `seeds ${chunk[0]}..${chunk[chunk.length - 1]} hold every invariant after every action`,
      async () => {
        for (const seed of chunk) {
          const scenario = generateScenario(seed, NOW_MS);
          expect(scenario.actions.length).toBeGreaterThanOrEqual(5);
          expect(scenario.actions.length).toBeLessThanOrEqual(60);
          const outcome = await runScenario(scenario, NOW_MS, {
            stopOnFailure: true,
          });
          outcomes.set(seed, outcome);
          if (outcome.status === 'broken') await minimize(seed, outcome);
        }
      },
      CHUNK_TIMEOUT_MS,
    );
  }

  test(
    'same seed twice yields an identical observation trace',
    async () => {
      const sample = seeds.slice(0, Math.min(DETERMINISM_SEEDS, seeds.length));
      for (const seed of sample) {
        const first = await runScenario(
          generateScenario(seed, NOW_MS),
          NOW_MS,
          {
            stopOnFailure: false,
          },
        );
        const second = await runScenario(
          generateScenario(seed, NOW_MS),
          NOW_MS,
          {
            stopOnFailure: false,
          },
        );
        const identical =
          JSON.stringify(first.steps) === JSON.stringify(second.steps);
        determinism.push({ seed, identical, steps: first.steps.length });
        expect(second.steps).toEqual(first.steps);
      }
    },
    CHUNK_TIMEOUT_MS,
  );

  // F1 (known defect, see runner.tsx KNOWN_DEFECTS): a verified capture 70
  // days old plus one today, viewed over 4 weeks, must not be described as the
  // first measured period on this device. `test.failing` turns green the day
  // the copy is fixed — then delete this block and the KNOWN_DEFECTS entry.
  test.failing(
    'F1 repro: older verified captures forbid "First measured period on this device."',
    async () => {
      const dayMs = 86_400_000;
      const scenario: Scenario = {
        seed: -1,
        initialApi: 'signed_out',
        initialFacts: [],
        initialCaptures: [
          {
            id: 'capture-f1-old',
            kind: 'guided',
            shotType: 'dink',
            capturedAtIso: new Date(NOW_MS - 70 * dayMs).toISOString(),
          },
          {
            id: 'capture-f1-today',
            kind: 'guided',
            shotType: 'dink',
            capturedAtIso: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
          },
        ],
        actions: [{ kind: 'section', section: 'practice' }, { kind: 'flush' }],
      };
      const outcome = await runScenario(scenario, NOW_MS, {
        stopOnFailure: true,
      });
      expect(outcome.failure).toBeNull();
      expect(outcome.knownDefectHits).toEqual([]);
    },
    CHUNK_TIMEOUT_MS,
  );

  test('campaign table is written and no seed is broken', () => {
    const rows = [...outcomes.values()].sort((a, b) => a.seed - b.seed);
    // How often each kind of effect actually happened (ids stripped), so the
    // table shows which paths the campaign really drove.
    const effectHistogram: Record<string, number> = {};
    for (const row of rows) {
      for (const step of row.steps) {
        const key = step.effect
          .replace(/Result:\S+/, 'Result:<id>')
          .replace(/(fact|capture) \S+/, '$1 <id>');
        effectHistogram[key] = (effectHistogram[key] ?? 0) + 1;
      }
    }
    const totals = rows.reduce(
      (sum, row) => ({
        actions: sum.actions + row.length,
        loads: sum.loads + row.counters.loads,
        navigations: sum.navigations + row.counters.navigations,
        errorStates: sum.errorStates + row.counters.errorStates,
        contentChecks: sum.contentChecks + row.counters.contentChecks,
        dbQueries: sum.dbQueries + row.counters.dbQueries,
        fetches: sum.fetches + row.counters.fetches,
      }),
      {
        actions: 0,
        loads: 0,
        navigations: 0,
        errorStates: 0,
        contentChecks: 0,
        dbQueries: 0,
        fetches: 0,
      },
    );
    const table = {
      unit: 'scr-progressscreen',
      lens: 'randomized-seeded',
      generatedAt: new Date(NOW_MS).toISOString(),
      clockPinnedTo: NOW_ISO,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      baseSeed: BASE_SEED,
      sequences: rows.length,
      sequencesHeld: rows.filter(row => row.status === 'held').length,
      sequencesKnownDefect: rows.filter(row => row.status === 'known_defect')
        .length,
      sequencesBroken: rows.filter(row => row.status === 'broken').length,
      knownDefects: [...KNOWN_DEFECTS].map(invariant => ({
        invariant,
        seeds: rows
          .filter(row =>
            row.knownDefectHits.some(hit => hit.invariant === invariant),
          )
          .map(row => row.seed),
      })),
      minLength: rows.length ? Math.min(...rows.map(row => row.length)) : null,
      maxLength: rows.length ? Math.max(...rows.map(row => row.length)) : null,
      totals,
      effectHistogram,
      determinism,
      failures: minimized,
      results: rows.map(row => ({
        seed: row.seed,
        length: row.length,
        status: row.status,
        counters: row.counters,
        failure: row.failure,
        knownDefectHits: row.knownDefectHits,
        // Per-step trace only for broken seeds keeps the table readable;
        // any seed replays exactly via STRESS_SEED.
        trace: row.status === 'held' ? undefined : row.steps,
        fixtures:
          row.status === 'held'
            ? undefined
            : (({ initialApi, initialFacts, initialCaptures }) => ({
                initialApi,
                initialFacts,
                initialCaptures,
              }))(generateScenario(row.seed, NOW_MS)),
        finalObservation: row.steps[row.steps.length - 1]?.observed ?? null,
      })),
    };
    fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
    fs.writeFileSync(ARTIFACT_PATH, `${JSON.stringify(table, null, 2)}\n`);

    expect(rows).toHaveLength(ITERATIONS);
    expect(
      rows
        .filter(row => row.status === 'broken')
        .map(row => ({ seed: row.seed, failure: row.failure })),
    ).toEqual([]);
  });
});
