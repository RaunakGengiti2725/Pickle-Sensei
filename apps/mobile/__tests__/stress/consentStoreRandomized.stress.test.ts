/**
 * Seeded randomized long-run campaign over `src/state/consentStore.ts`.
 * Model, generator and invariants: test-support/stress/consentStoreStressHarness.ts.
 *
 * Scale:   STRESS_ITER=<n>        sequences (default 250; the campaign runs ≥ 2000)
 *          STRESS_SEED_BASE=<n>   first seed (default 1)
 *          STRESS_MIN_LEN / STRESS_MAX_LEN   sequence length bounds (default 5 / 60)
 * Replay:  STRESS_ONLY=<seed>
 * Output:  STRESS_OUT=<dir>       JSON seed table + failures (default artifacts/stress)
 *
 * Every sequence runs TWICE: the second run must produce an identical trace
 * (determinism). Every failing seed is ddmin-minimised and written with its
 * reduced action list and the exact replay command.
 */
import { useConsentStore } from '../../src/state/consentStore';
import {
  fingerprint,
  generateScenario,
  minimizeScenario,
  resetConsentStore,
  runScenario,
  type RunResult,
  type Scenario,
} from '../../test-support/stress/consentStoreStressHarness';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see __tests__/matrix/networkAuthMatrix.test.ts), so the shims
// stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
};
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ITER = Number(process.env.STRESS_ITER ?? 250);
const SEED_BASE = Number(process.env.STRESS_SEED_BASE ?? 1);
const MIN_LEN = Number(process.env.STRESS_MIN_LEN ?? 5);
const MAX_LEN = Number(process.env.STRESS_MAX_LEN ?? 60);
const ONLY = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');

interface SeedRow {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN' | 'NONDETERMINISTIC';
  violations: string[];
  orderingObservations: string[];
  stats: RunResult['stats'];
}

interface FailureRow {
  seed: number;
  invariants: string[];
  violations: RunResult['violations'];
  replay: string;
  originalLength: number;
  minimized: Scenario;
  minimizedTraceTail: RunResult['trace'];
}

const rows: SeedRow[] = [];
const failures: FailureRow[] = [];
const orderingSeeds: Array<{
  seed: number;
  observations: RunResult['orderingObservations'];
}> = [];
const heap: Array<{ index: number; heapUsedMb: number; rssMb: number }> = [];
const orderingWitnesses: Array<{
  kind: string;
  seed: number;
  originalLength: number;
  minimized: Scenario;
  observation: RunResult['orderingObservations'][number];
  finalState: RunResult['trace'][number]['state'];
}> = [];
const wallStart = Date.now();

const seeds = ONLY
  ? [ONLY]
  : Array.from({ length: ITER }, (_, i) => SEED_BASE + i);

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
});

afterAll(() => {
  jest.useRealTimers();
  resetConsentStore();

  const byInvariant: Record<string, number> = {};
  for (const r of rows)
    for (const v of r.violations) byInvariant[v] = (byInvariant[v] ?? 0) + 1;
  const byOrdering: Record<string, number> = {};
  for (const o of orderingSeeds)
    for (const v of o.observations)
      byOrdering[v.invariant] = (byOrdering[v.invariant] ?? 0) + 1;
  const sum = (pick: (s: RunResult['stats']) => number) =>
    rows.reduce((n, r) => n + pick(r.stats), 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    unit: 'apps/mobile/src/state/consentStore.ts',
    lens: 'randomized-seeded',
    config: {
      iterations: ITER,
      seedBase: SEED_BASE,
      minLen: MIN_LEN,
      maxLen: MAX_LEN,
      only: ONLY,
    },
    executed: rows.length,
    held: rows.filter(r => r.outcome === 'HELD').length,
    broken: rows.filter(r => r.outcome === 'BROKEN').length,
    nondeterministic: rows.filter(r => r.outcome === 'NONDETERMINISTIC').length,
    totalSteps: rows.reduce((n, r) => n + r.length, 0),
    wallMs: Date.now() - wallStart,
    byInvariant,
    orderingObservations: {
      seedsAffected: orderingSeeds.length,
      byKind: byOrdering,
      witnesses: orderingWitnesses,
    },
    aggregate: {
      requests: sum(s => s.requests),
      landedApplied: sum(s => s.landedApplied),
      landedStale: sum(s => s.landedStale),
      aborted: sum(s => s.aborted),
      fetchRejected: sum(s => s.fetchRejected),
      busyGuardHits: sum(s => s.busyGuardHits),
      signedOutCalls: sum(s => s.signedOutCalls),
    },
    heap: {
      samples: heap.length,
      maxHeapUsedMb: Math.max(0, ...heap.map(h => h.heapUsedMb)),
      maxRssMb: Math.max(0, ...heap.map(h => h.rssMb)),
      first: heap[0] ?? null,
      last: heap[heap.length - 1] ?? null,
    },
    failingSeeds: failures.map(f => f.seed),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = ONLY ? `-seed${ONLY}` : '';
  writeFileSync(
    join(OUT_DIR, `consentStore-randomized-summary${suffix}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `consentStore-randomized-seeds${suffix}.json`),
    JSON.stringify(rows, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `consentStore-randomized-failures${suffix}.json`),
    JSON.stringify(failures, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `consentStore-randomized-ordering${suffix}.json`),
    JSON.stringify(orderingSeeds, null, 2),
  );
});

describe('consentStore seeded randomized long-run', () => {
  it.each(seeds.map(s => [s] as const))('seed=%i', async seed => {
    const scenario = generateScenario(seed, MIN_LEN, MAX_LEN);
    const first = await runScenario(scenario);
    const second = await runScenario(scenario);
    const deterministic = fingerprint(first) === fingerprint(second);

    const row: SeedRow = {
      seed,
      length: scenario.actions.length,
      outcome: !deterministic
        ? 'NONDETERMINISTIC'
        : first.ok
          ? 'HELD'
          : 'BROKEN',
      violations: [...new Set(first.violations.map(v => v.invariant))],
      orderingObservations: [
        ...new Set(first.orderingObservations.map(v => v.invariant)),
      ],
      stats: first.stats,
    };
    rows.push(row);
    if (first.orderingObservations.length > 0)
      orderingSeeds.push({ seed, observations: first.orderingObservations });
    const mem = process.memoryUsage();
    heap.push({
      index: rows.length,
      heapUsedMb: Math.round((mem.heapUsed / 1_048_576) * 10) / 10,
      rssMb: Math.round((mem.rss / 1_048_576) * 10) / 10,
    });

    if (!deterministic) {
      throw new Error(
        `NONDETERMINISTIC seed=${seed}: two runs of the same action list produced different traces`,
      );
    }
    if (!first.ok) {
      const primary = first.violations[0]!.invariant;
      const minimized = await minimizeScenario(scenario, primary);
      const replayed = await runScenario(minimized);
      failures.push({
        seed,
        invariants: row.violations,
        violations: first.violations,
        replay: `STRESS_ONLY=${seed} npx jest __tests__/stress/consentStoreRandomized.stress.test.ts`,
        originalLength: scenario.actions.length,
        minimized,
        minimizedTraceTail: replayed.trace.slice(-6),
      });
      throw new Error(
        [
          `STRESS FAILURE seed=${seed} (length ${scenario.actions.length}, minimized to ${minimized.actions.length})`,
          `replay: STRESS_ONLY=${seed} npx jest __tests__/stress/consentStoreRandomized.stress.test.ts`,
          ...first.violations.map(
            v => `  step ${v.step} [${v.invariant}] ${v.detail}`,
          ),
          `minimized: ${JSON.stringify(minimized.actions)}`,
        ].join('\n'),
      );
    }
  });

  it('minimises one witness per report-only ordering observation', async () => {
    const kinds = [
      ...new Set(
        orderingSeeds.flatMap(o => o.observations.map(v => v.invariant)),
      ),
    ];
    for (const kind of kinds) {
      const hit = orderingSeeds.find(o =>
        o.observations.some(v => v.invariant === kind),
      )!;
      const scenario = generateScenario(hit.seed, MIN_LEN, MAX_LEN);
      const minimized = await minimizeScenario(scenario, kind);
      const replayed = await runScenario(minimized);
      const observation = replayed.orderingObservations.find(
        v => v.invariant === kind,
      );
      expect(observation).toBeDefined();
      expect(replayed.ok).toBe(true);
      orderingWitnesses.push({
        kind,
        seed: hit.seed,
        originalLength: scenario.actions.length,
        minimized,
        observation: observation!,
        finalState: replayed.trace[replayed.trace.length - 1]!.state,
      });
    }
  });

  it('oracle sensitivity: an injected optimistic toggle is caught', async () => {
    // Wrap the real action with a pre-request optimistic write. The store's
    // contract forbids exactly this; the model/no_optimistic_state checks
    // must trip on a sequence that toggles while signed in.
    const original = useConsentStore.getState().setModelTrainingConsent;
    useConsentStore.setState({
      setModelTrainingConsent: async (granted, fetchFn) => {
        useConsentStore.setState({ modelTrainingActive: granted });
        await original(granted, fetchFn);
      },
    });
    try {
      const witness: Scenario = {
        seed: 0,
        actions: [
          { kind: 'signIn', account: 'A' },
          { kind: 'toggle', granted: true, body: 'http_error_valid_body' },
          { kind: 'flush' },
          { kind: 'land', index: 0 },
          { kind: 'flush' },
        ],
      };
      const faulty = await runScenario(witness);
      expect(faulty.ok).toBe(false);
      const tripped = new Set(faulty.violations.map(v => v.invariant));
      expect(tripped).toContain('model_state');
      expect(tripped).toContain('no_optimistic_state');
      expect(tripped).toContain('default_off');
      const minimized = await minimizeScenario(witness, 'no_optimistic_state');
      expect(minimized.actions.length).toBeLessThanOrEqual(3);
    } finally {
      useConsentStore.setState({ setModelTrainingConsent: original });
    }
    const clean = await runScenario(
      generateScenario(SEED_BASE, MIN_LEN, MAX_LEN),
    );
    expect(clean.ok).toBe(true);
  });

  it('executed the required scale', () => {
    expect(rows.length).toBe(ONLY ? 1 : ITER);
    if (!ONLY) {
      expect(rows.length).toBeGreaterThanOrEqual(Math.min(ITER, 250));
      for (const r of rows) {
        expect(r.length).toBeGreaterThanOrEqual(MIN_LEN);
        expect(r.length).toBeLessThanOrEqual(MAX_LEN);
      }
    }
  });
});
