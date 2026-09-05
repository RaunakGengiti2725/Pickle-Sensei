/**
 * STRESS — unit `mod-session-flow`, lens `randomized-seeded`.
 *
 * Seeded randomized long-run over the session flow public API:
 * `LiveSessionFlow` (push / end / settled / snapshot), the native bridge feed
 * (`connectNativeSessionMotionFeed` against a simulated emitter: valid,
 * malformed, foreign-captureId, non-motion and post-end payloads, multiple
 * and disconnected feeds), the clip-source / analysis-provider seams (scripted
 * deferreds settled in random order as ready / low-confidence / resultless /
 * abstained / pending / rejected / hanging, sync throws, availability flips,
 * throwing onUpdate subscribers) and `sessionScoreProgression` (bucket
 * partition, index order, order independence, monotonicity across steps).
 *
 * Invariants are model-checked after EVERY step; see the INV-xx catalogue in
 * test-support/stress/sessionFlowSeededModel.ts. Every failing seed is
 * ddmin-shrunk and recorded in the JSON table.
 *
 * Scale is env-driven so the suite stays fast by default:
 *   STRESS_ITER=<n>      sequences (default 120; the campaign runs ≥ 2000)
 *   STRESS_SEED=<n>      campaign seed (default 20260905)
 *   STRESS_ONLY=<seed>   replay one iteration seed and print its full trace
 *   STRESS_OUT=<dir>     artifact directory (default apps/mobile/artifacts/stress)
 *   STRESS_STRICT=1      treat the SOFT invariants as failures:
 *                        INV-04c (a non-finite tMs through pushSample poisons
 *                        snapshot.durationMs → formatSessionClock "NaN:NaN")
 *                        and INV-09b (getCompletedSession().onUpdateFailures
 *                        lags the live snapshot by one after a throwing
 *                        subscriber). Both are recorded per seed regardless.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  describeAction,
  generateSequence,
  iterationSeed,
  minimizeSequence,
  runProgressionSequence,
  runSequence,
  type GeneratedSequence,
  type Minimized,
  type RunResult,
  type Violation,
} from '../../test-support/stress/sessionFlowSeededModel';

// Only the names capture.ts imports — spreading the real RN index would pull
// TurboModule getters that jest cannot satisfy (same shape as
// __tests__/sessionNative.test.ts).
jest.mock('react-native', () => {
  const listeners: Array<(event: unknown) => void> = [];
  const bridge = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    startSessionCapture: jest.fn(),
    stopSessionCapture: jest.fn(),
    extractSessionEventClip: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener(_type: string, listener: (event: unknown) => void) {
        listeners.push(listener);
        return {
          remove: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedListeners: listeners,
  };
});

const { __simulatedListeners: listeners } = jest.requireMock(
  'react-native',
) as {
  __simulatedListeners: Array<(event: unknown) => void>;
};

declare const __dirname: string;

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ITER = envInt('STRESS_ITER', 120);
const CAMPAIGN_SEED = envInt('STRESS_SEED', 20260905);
const ONLY = process.env.STRESS_ONLY ? envInt('STRESS_ONLY', 0) : null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const STRICT = envInt('STRESS_STRICT', 0) === 1;

function emitNative(payload: unknown): void {
  for (const listener of [...listeners]) listener(payload);
}

interface SeedRow {
  seed: number;
  index: number;
  length: number;
  steps: number;
  pushes: number;
  events: number;
  scoredPoints: number;
  hangs: number;
  config: GeneratedSequence['config'];
  outcome: 'HELD' | 'BROKEN';
  deterministic: boolean;
  traceHash: string;
  violations: Violation[];
  observations: Violation[];
  minimized?: Minimized;
}

const run = (sequence: GeneratedSequence, checkInvariants = true) =>
  runSequence(sequence, { emitNative, strict: STRICT, checkInvariants });

async function runIteration(seed: number, index: number): Promise<SeedRow> {
  const sequence = generateSequence(seed);
  const first = await run(sequence);
  // Determinism: regenerate + replay from the same seed → identical trace.
  const again = generateSequence(seed);
  const replay = await run(again, false);
  const deterministic =
    replay.traceHash === first.traceHash &&
    JSON.stringify(again) === JSON.stringify(sequence);
  const row: SeedRow = {
    seed,
    index,
    length: sequence.actions.length,
    steps: first.steps,
    pushes: first.pushes,
    events: first.events,
    scoredPoints: first.scoredPoints,
    hangs: first.hangs,
    config: sequence.config,
    outcome: first.violations.length === 0 && deterministic ? 'HELD' : 'BROKEN',
    deterministic,
    traceHash: first.traceHash,
    violations: first.violations.slice(0, 20),
    observations: first.observations.slice(0, 5),
  };
  const firstViolation = first.violations[0];
  if (firstViolation) {
    const minimized = await minimizeSequence(
      sequence,
      firstViolation.invariant,
      candidate => run(candidate),
    );
    if (minimized) row.minimized = minimized;
  }
  return row;
}

function writeArtifact(name: string, payload: unknown): string {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

describe('session flow — seeded randomized long-run', () => {
  if (ONLY !== null) {
    it(`replays seed ${ONLY} with its full trace`, async () => {
      const sequence = generateSequence(ONLY);
      const result: RunResult = await run(sequence);
      const path = writeArtifact(`session-flow-seed-${ONLY}.json`, {
        seed: ONLY,
        config: sequence.config,
        actions: sequence.actions.map(describeAction),
        rawActions: sequence.actions,
        trace: result.trace,
        violations: result.violations,
        observations: result.observations,
      });
      console.log(
        [
          `seed ${ONLY} → ${path}`,
          ...result.trace,
          ...result.violations.map(
            v => `VIOLATION ${v.invariant} @${v.step} ${v.action}: ${v.detail}`,
          ),
          ...result.observations.map(
            v =>
              `OBSERVATION ${v.invariant} @${v.step} ${v.action}: ${v.detail}`,
          ),
        ].join('\n'),
      );
      expect(result.violations).toEqual([]);
    });
    return;
  }

  it(
    `holds every invariant over ${ITER} seeded sequences (campaign seed ${CAMPAIGN_SEED})`,
    async () => {
      const rows: SeedRow[] = [];
      const startedAt = Date.now();
      for (let index = 0; index < ITER; index += 1) {
        rows.push(
          await runIteration(iterationSeed(CAMPAIGN_SEED, index), index),
        );
      }
      const elapsedMs = Date.now() - startedAt;
      const broken = rows.filter(row => row.outcome === 'BROKEN');
      const byInvariant = new Map<string, number>();
      const observationsByInvariant = new Map<string, number>();
      for (const row of rows) {
        for (const violation of row.violations) {
          byInvariant.set(
            violation.invariant,
            (byInvariant.get(violation.invariant) ?? 0) + 1,
          );
        }
        for (const observation of row.observations) {
          observationsByInvariant.set(
            observation.invariant,
            (observationsByInvariant.get(observation.invariant) ?? 0) + 1,
          );
        }
      }
      const lengths = rows.map(row => row.length);
      const summary = {
        lens: 'randomized-seeded',
        unit: 'mod-session-flow',
        campaignSeed: CAMPAIGN_SEED,
        iterations: rows.length,
        strict: STRICT,
        elapsedMs,
        sequenceLength: {
          min: Math.min(...lengths),
          max: Math.max(...lengths),
          mean:
            lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length),
        },
        totalSteps: rows.reduce((sum, row) => sum + row.steps, 0),
        totalPushes: rows.reduce((sum, row) => sum + row.pushes, 0),
        totalEvents: rows.reduce((sum, row) => sum + row.events, 0),
        totalScoredPoints: rows.reduce((sum, row) => sum + row.scoredPoints, 0),
        sequencesWithEvents: rows.filter(row => row.events > 0).length,
        sequencesWithScoredPoints: rows.filter(row => row.scoredPoints > 0)
          .length,
        held: rows.length - broken.length,
        broken: broken.length,
        nonDeterministic: rows.filter(row => !row.deterministic).length,
        violationsByInvariant: Object.fromEntries(byInvariant),
        observationsByInvariant: Object.fromEntries(observationsByInvariant),
        seedsWithObservations: rows
          .filter(row => row.observations.length > 0)
          .slice(0, 50)
          .map(row => ({
            seed: row.seed,
            invariants: [...new Set(row.observations.map(o => o.invariant))],
          })),
        brokenSeeds: broken.map(row => ({
          seed: row.seed,
          invariant: row.violations[0]?.invariant ?? 'non-deterministic',
          detail:
            row.violations[0]?.detail ?? 'trace hash differed between two runs',
          minimizedLength: row.minimized?.length ?? null,
        })),
      };
      const summaryPath = writeArtifact(
        `session-flow-randomized-seeded-summary-${CAMPAIGN_SEED}-${ITER}.json`,
        summary,
      );
      const tablePath = writeArtifact(
        `session-flow-randomized-seeded-table-${CAMPAIGN_SEED}-${ITER}.json`,
        rows,
      );
      console.log(
        `session flow randomized-seeded: ${summary.held}/${summary.iterations} HELD, ` +
          `${summary.broken} BROKEN, ${summary.nonDeterministic} non-deterministic, ` +
          `${summary.totalSteps} steps, ${summary.totalEvents} events in ${elapsedMs}ms\n` +
          `summary → ${summaryPath}\ntable → ${tablePath}\n` +
          `violations: ${JSON.stringify(summary.violationsByInvariant)}\n` +
          `observations: ${JSON.stringify(summary.observationsByInvariant)}`,
      );
      expect(rows.length).toBe(ITER);
      // Every sequence honours the 5..60 length contract.
      expect(summary.sequenceLength.min).toBeGreaterThanOrEqual(5);
      expect(summary.sequenceLength.max).toBeLessThanOrEqual(60);
      expect(summary.nonDeterministic).toBe(0);
      expect(
        broken.map(row => ({
          seed: row.seed,
          violation: row.violations[0],
          minimized: row.minimized?.actions,
        })),
      ).toEqual([]);
    },
    Math.max(30_000, ITER * 400),
  );

  it(`sessionScoreProgression holds over ${ITER} synthesized event sets (pure campaign)`, () => {
    const rows = [];
    for (let index = 0; index < ITER; index += 1) {
      const seed = iterationSeed(CAMPAIGN_SEED ^ 0x50524f47, index);
      const first = runProgressionSequence(seed);
      const again = runProgressionSequence(seed);
      rows.push({
        seed,
        index,
        views: first.views,
        steps: first.steps,
        deterministic: first.traceHash === again.traceHash,
        traceHash: first.traceHash,
        outcome:
          first.violations.length === 0 && first.traceHash === again.traceHash
            ? ('HELD' as const)
            : ('BROKEN' as const),
        violations: first.violations.slice(0, 10),
      });
    }
    const broken = rows.filter(row => row.outcome === 'BROKEN');
    const tablePath = writeArtifact(
      `session-progression-randomized-seeded-table-${CAMPAIGN_SEED}-${ITER}.json`,
      {
        campaignSeed: CAMPAIGN_SEED,
        iterations: rows.length,
        held: rows.length - broken.length,
        broken: broken.length,
        totalSteps: rows.reduce((sum, row) => sum + row.steps, 0),
        totalViews: rows.reduce((sum, row) => sum + row.views, 0),
        rows,
      },
    );
    console.log(
      `session progression randomized-seeded: ${rows.length - broken.length}/${rows.length} HELD → ${tablePath}`,
    );
    expect(rows.filter(row => !row.deterministic)).toEqual([]);
    expect(
      broken.map(row => ({ seed: row.seed, violation: row.violations[0] })),
    ).toEqual([]);
  });
});
