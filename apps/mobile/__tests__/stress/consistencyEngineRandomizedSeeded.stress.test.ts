/**
 * STRESS — consistency engine, lens `randomized-seeded`.
 *
 * Seeded randomized long-run over `buildConsistencySnapshot`: legal and
 * near-legal action sequences (activities incl. malformed/future/local-
 * midnight instants, multi-week runs, clock advances, clock regressions,
 * DST/leap/year anchors, zone changes incl. +14, :30/:45 offsets and
 * invalid zones), invariants model-checked after every step against an
 * independent reference model (test-support/stress/consistencyEngineModel.ts).
 *
 * Scale is env-driven so the suite stays fast by default:
 *   STRESS_ITER=<n>        sequences (default 150; campaign runs ≥ 2000)
 *   STRESS_SEED=<n>        campaign seed (default 20260904)
 *   STRESS_ONLY=<seed>     replay one iteration seed with its full trace
 *   STRESS_OUT=<dir>       artifact directory (default apps/mobile/artifacts/stress)
 *   STRESS_STRICT_ORDER=1  treat INV-02b (scoreAvg 1dp rounding flipping with
 *                          input order — floating-point summation order) and
 *                          INV-02c (detail-row order for activities tied on
 *                          atIso+label follows input order) as failures instead
 *                          of counted observations
 *   STRESS_STRICT=1        treat INV-14b (adding PAST evidence on a formerly
 *                          shield-bridged day shifts the 7-day shield phase and
 *                          can LOWER longestStreak / shieldsEarnedTotal — a
 *                          reproduced design consequence, see findings) as a
 *                          failure instead of a counted observation
 * Every failing seed is ddmin-shrunk and recorded in the JSON table.
 */
import {
  describeAction,
  generateEngineSequence,
  runEngineActions,
  type EngineAction,
  type Violation,
} from '../../test-support/stress/consistencyEngineModel';
import {
  envInt,
  envString,
  fnv1a,
  iterationSeed,
  joinPath,
  minimizeSequence,
  writeArtifact,
} from '../../test-support/stress/seededRng';

declare const __dirname: string;

const ITER = envInt('STRESS_ITER', 150);
const CAMPAIGN_SEED = envInt('STRESS_SEED', 20260904);
const ONLY = envString('STRESS_ONLY');
const OUT_DIR =
  envString('STRESS_OUT') ??
  joinPath(__dirname, '..', '..', 'artifacts', 'stress');
const STRICT_ORDER = envInt('STRESS_STRICT_ORDER', 0) === 1;
const STRICT = envInt('STRESS_STRICT', 0) === 1;

/** Invariants recorded and counted but only fatal under the strict flags. */
const SOFT_INVARIANTS = new Set([
  ...(STRICT_ORDER
    ? []
    : ['INV-02b-scoreAvg-fp-order', 'INV-02c-activity-tie-order']),
  ...(STRICT ? [] : ['INV-14b-add-shield-phase']),
]);

interface SeedRow {
  seed: number;
  index: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  steps: number;
  maxStreak: number;
  maxActivities: number;
  zones: string[];
  traceHash: string;
  deterministic: boolean;
  violations: Violation[];
  observations: Violation[];
  minimized?: {
    length: number;
    actions: string[];
    probes: number;
    violation: Violation;
  };
}

function firstViolationKey(violations: readonly Violation[]): string | null {
  const first = violations[0];
  return first ? first.invariant : null;
}

function runIteration(seed: number, index: number): SeedRow {
  const sequence = generateEngineSequence(seed);
  const full = runEngineActions(seed, sequence.start, sequence.actions);
  // Determinism: regenerate + replay from the same seed → identical trace.
  const again = generateEngineSequence(seed);
  const replay = runEngineActions(seed, again.start, again.actions, {
    checkInvariants: false,
  });
  const deterministic =
    replay.traceHash === full.traceHash &&
    JSON.stringify(again.actions) === JSON.stringify(sequence.actions);
  const result = {
    ...full,
    violations: full.violations.filter(v => !SOFT_INVARIANTS.has(v.invariant)),
  };
  const row: SeedRow = {
    seed,
    index,
    length: sequence.actions.length,
    outcome:
      result.violations.length === 0 && deterministic ? 'HELD' : 'BROKEN',
    steps: result.trace.length,
    maxStreak: result.maxStreak,
    maxActivities: result.maxActivities,
    zones: result.zones,
    traceHash: fnv1a(result.traceHash),
    deterministic,
    violations: result.violations.slice(0, 20),
    observations: full.violations
      .filter(v => SOFT_INVARIANTS.has(v.invariant))
      .slice(0, 5),
  };
  if (!deterministic) {
    row.violations.unshift({
      step: -1,
      invariant: 'INV-00-determinism',
      detail: 'same seed produced a different action list or trace',
    });
  }
  if (result.violations.length > 0) {
    const targetKey = firstViolationKey(result.violations);
    const isTarget = (v: Violation) => v.invariant === targetKey;
    const stillFails = (candidate: readonly EngineAction[]) => {
      const probe = runEngineActions(seed, sequence.start, candidate, {
        stopWhen: isTarget,
      });
      return probe.violations.some(isTarget);
    };
    const { minimized, probes } = minimizeSequence(
      sequence.actions,
      stillFails,
    );
    const probe = runEngineActions(seed, sequence.start, minimized, {
      stopWhen: isTarget,
    });
    row.minimized = {
      length: minimized.length,
      actions: [
        `init asOf=${new Date(sequence.start.asOfMs).toISOString()} tz=${JSON.stringify(sequence.start.timeZone)}`,
        ...minimized.map(describeAction),
      ],
      probes,
      violation:
        probe.violations.find(v => v.invariant === targetKey) ??
        result.violations[0]!,
    };
  }
  return row;
}

describe('consistency engine — seeded randomized long-run', () => {
  const rows: SeedRow[] = [];
  const startedAt = Date.now();

  afterAll(() => {
    const broken = rows.filter(row => row.outcome === 'BROKEN');
    const totalSteps = rows.reduce((sum, row) => sum + row.steps, 0);
    const byInvariant: Record<string, number> = {};
    for (const row of broken) {
      for (const violation of row.violations) {
        byInvariant[violation.invariant] =
          (byInvariant[violation.invariant] ?? 0) + 1;
      }
    }
    const observed = rows.filter(row => row.observations.length > 0);
    const observationsByInvariant: Record<string, number> = {};
    for (const row of observed) {
      for (const observation of row.observations) {
        observationsByInvariant[observation.invariant] =
          (observationsByInvariant[observation.invariant] ?? 0) + 1;
      }
    }
    writeArtifact(OUT_DIR, 'consistency-engine-randomized-seeded.json', {
      unit: 'mod-consistency-engine',
      lens: 'randomized-seeded',
      campaignSeed: CAMPAIGN_SEED,
      iterations: rows.length,
      only: ONLY ?? null,
      sequencesHeld: rows.length - broken.length,
      sequencesBroken: broken.length,
      stepsExecuted: totalSteps,
      snapshotsBuilt: totalSteps * 4, // primary + shuffled + determinism replay ×2
      determinismReplays: rows.length,
      nonDeterministicSeeds: rows
        .filter(row => !row.deterministic)
        .map(row => row.seed),
      violationsByInvariant: byInvariant,
      strictOrder: STRICT_ORDER,
      strict: STRICT,
      softInvariants: [...SOFT_INVARIANTS],
      observationsByInvariant,
      seedsWithObservations: observed.map(row => ({
        seed: row.seed,
        first: row.observations[0],
      })),
      failingSeeds: broken.map(row => ({
        seed: row.seed,
        firstViolation: row.violations[0],
        minimized: row.minimized,
      })),
      durationMs: Date.now() - startedAt,
      rows,
    });
  });

  if (ONLY !== undefined) {
    it(`replays seed ${ONLY} with a full trace`, () => {
      const seed = Number(ONLY);
      const sequence = generateEngineSequence(seed);
      const result = runEngineActions(seed, sequence.start, sequence.actions);
      const row = runIteration(seed, -1);
      rows.push(row);
      writeArtifact(OUT_DIR, `consistency-engine-seed-${seed}.json`, {
        seed,
        start: {
          asOfIso: new Date(sequence.start.asOfMs).toISOString(),
          timeZone: sequence.start.timeZone,
        },
        actions: sequence.actions,
        trace: result.trace,
        violations: result.violations,
        minimized: row.minimized ?? null,
      });
      expect(row.violations).toEqual([]);
    });
    return;
  }

  it(`holds every engine invariant across ${ITER} seeded sequences (5–60 actions each)`, () => {
    for (let index = 0; index < ITER; index += 1) {
      rows.push(runIteration(iterationSeed(CAMPAIGN_SEED, index), index));
    }
    const broken = rows.filter(row => row.outcome === 'BROKEN');
    const summary = broken.map(row => ({
      seed: row.seed,
      first: row.violations[0],
      minimized: row.minimized?.actions,
    }));
    expect(summary).toEqual([]);
  });

  it('exercises the deep economy (long runs, shields, volume) within the campaign', () => {
    // The generator must actually reach the interesting regions, otherwise a
    // green campaign proves little. These are coverage floors, not product
    // assertions.
    if (ITER < 50) return;
    expect(Math.max(...rows.map(row => row.maxStreak))).toBeGreaterThanOrEqual(
      100,
    );
    expect(
      Math.max(...rows.map(row => row.maxActivities)),
    ).toBeGreaterThanOrEqual(100);
    const zones = new Set(rows.flatMap(row => row.zones));
    expect(
      zones.has('Pacific/Kiritimati') || zones.has('Pacific/Chatham'),
    ).toBe(true);
  });
});
