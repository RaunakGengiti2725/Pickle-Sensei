/**
 * CONCURRENCY STRESS — LiveCourtEngine (src/flow/liveCourt.ts).
 *
 * Drives `onStroke()` with Promise.all bursts whose provider promises settle
 * in a seeded, replayable order (SeededScheduler): duplicate clips, clips
 * that fail analysis (too short), providers that throw, a second burst
 * started while the first is in flight (call-during-call), `summary()` read
 * mid-flight, and a shared provider set used by two engines at once.
 *
 * Invariants (each has its own `it`, so the verdict is per invariant):
 *   E1 bounded wall time      — every burst settles before the deadline
 *   E2 no lost / duplicate row — allReps() is exactly the fulfilled non-null
 *                                results, each object once
 *   E3 summary ≡ allReps       — summary() is derivable from allReps()
 *   E4 repIndex is a unique 1..N stroke ordinal (the value repCounter was
 *                                bumped to when THIS stroke arrived)
 *   E5 personal-best flags are consistent with settlement order
 *   E6 failures are honest     — failing clips yield null, throwing
 *                                providers reject, nothing else changes
 *   E7 replay determinism      — the same seed reproduces the same trace
 *   E8 isolation               — two engines sharing a provider set never
 *                                see each other's reps
 *
 * Campaign size: STRESS_ITER (default 60; the full run uses 500).
 */
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import type { VisionProviderSet } from '@pickle/vision-contracts';
import { LiveCourtEngine, type LiveRep } from '../../src/flow/liveCourt';
import {
  ResultsTable,
  SeededScheduler,
  Violations,
  campaignSeeds,
  canonicalJson,
  describeViolations,
  mulberry32,
  withDeadline,
  type SeedResult,
} from './liveCourtStress.support.test';

const CAMPAIGN = 'liveCourtEngine.concurrency';
const DEFAULT_ITERATIONS = 60;
const BURST_DEADLINE_MS = 10_000;

interface StrokeClip {
  uri: string;
  durationMs: number;
  fps: number;
  width: number;
  height: number;
}

type ClipKind = 'ok' | 'duplicate' | 'too_short' | 'provider_throws';

interface PlannedClip {
  kind: ClipKind;
  clip: StrokeClip;
}

const DURATIONS_MS = [600, 900, 1200, 1500, 1800, 2000, 2400, 3000];

/** Wraps the deterministic fixture providers so the two async hops the
 * pipeline takes (stroke detection, feature extraction) go through the
 * seeded scheduler. `#throw` clips make the stroke detector throw — a
 * provider bug, not a Result failure. */
function scheduledProviders(
  scheduler: SeededScheduler,
  base: VisionProviderSet,
): VisionProviderSet {
  return {
    ...base,
    stroke: {
      modelVersion: base.stroke.modelVersion,
      source: base.stroke.source,
      detectStrokes: clip =>
        scheduler.gate(`stroke:${clip.uri}`, () => {
          if (clip.uri.includes('#throw')) {
            throw new Error(`stroke detector crashed on ${clip.uri}`);
          }
          return base.stroke.detectStrokes(clip);
        }),
    },
    features: {
      version: base.features.version,
      extractMeasurements: input =>
        scheduler.gate(`features:${input.poseFrames.length}`, () =>
          base.features.extractMeasurements(input),
        ),
    },
  };
}

function planClips(
  rng: ReturnType<typeof mulberry32>,
  count: number,
): PlannedClip[] {
  const planned: PlannedClip[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rng.next();
    if (roll < 0.12 && planned.length > 0) {
      // Same clip submitted twice; a duplicate of a failing clip fails the same way.
      const source = rng.pick(planned);
      planned.push({
        kind:
          source.kind === 'ok' || source.kind === 'duplicate'
            ? 'duplicate'
            : source.kind,
        clip: { ...source.clip },
      });
      continue;
    }
    const durationMs = rng.pick(DURATIONS_MS);
    if (roll < 0.22) {
      planned.push({
        kind: 'too_short',
        clip: {
          uri: `file:///stroke-${i}#short`,
          durationMs: 300,
          fps: 30,
          width: 1080,
          height: 1920,
        },
      });
      continue;
    }
    if (roll < 0.3) {
      planned.push({
        kind: 'provider_throws',
        clip: {
          uri: `file:///stroke-${i}#throw`,
          durationMs,
          fps: 30,
          width: 1080,
          height: 1920,
        },
      });
      continue;
    }
    planned.push({
      kind: 'ok',
      clip: {
        uri: `file:///stroke-${i}`,
        durationMs,
        fps: 30,
        width: 1080,
        height: 1920,
      },
    });
  }
  return planned;
}

function makeEngine(
  providers: VisionProviderSet,
  sessionId: string,
): LiveCourtEngine {
  let ids = 0;
  return new LiveCourtEngine(providers, {
    sessionId,
    shotType: 'forehand_drive',
    focusCheckpoint: 'contact_position',
    handedness: 'right',
    appVersion: 'stress',
    modelBundleVersion: 'fixture-1',
    makeId: () => {
      ids += 1;
      return `${sessionId}-a${ids}`;
    },
  });
}

type Settled = PromiseSettledResult<LiveRep | null>;

/** Attaches the settlement handler immediately so a rejecting stroke is never
 * an unhandled rejection while the scheduler still holds other gates. */
function settle(promise: Promise<LiveRep | null>): Promise<Settled> {
  return promise.then(
    value => ({ status: 'fulfilled', value }) as const,
    (reason: unknown) => ({ status: 'rejected', reason }) as const,
  );
}

interface BurstTrace {
  repIndexes: number[];
  cues: string[];
  scores: Array<number | null>;
  personalBests: boolean[];
  summary: unknown;
  schedulerTrace: string[];
  rejected: number;
  nulls: number;
}

/** One seeded interleaving. Returns the trace (for determinism checks) and
 * records violations. */
async function runBurst(
  seed: number,
  violations: Violations,
): Promise<BurstTrace & { events: number }> {
  const rng = mulberry32(seed);
  const scheduler = new SeededScheduler(rng);
  const providers = scheduledProviders(
    scheduler,
    createFixtureVisionProviderSet('forehand_drive'),
  );
  const engine = makeEngine(providers, `live-${seed}`);
  const bystander = makeEngine(providers, `bystander-${seed}`);

  const total = rng.int(2, 16);
  const firstWave = rng.int(1, total);
  const planned = planClips(rng, total);
  const secondWaveStep = rng.int(1, 4);
  const summaryProbeStep = rng.int(1, 6);
  const bystanderStrokes = rng.int(0, 3);

  const promises: Array<Promise<Settled>> = [];
  const bystanderPromises: Array<Promise<Settled>> = [];
  // Wave 1: a Promise.all burst.
  for (const entry of planned.slice(0, firstWave))
    promises.push(settle(engine.onStroke(entry.clip)));
  for (let i = 0; i < bystanderStrokes; i += 1) {
    bystanderPromises.push(
      settle(
        bystander.onStroke({
          uri: `file:///by-${i}`,
          durationMs: 1500,
          fps: 30,
          width: 1080,
          height: 1920,
        }),
      ),
    );
  }
  let secondWaveStarted = firstWave >= total;
  const midFlightSummaries: string[] = [];

  const settledAll = (async () => {
    const steps = await scheduler.drain({
      onStep: step => {
        // Call-during-call: wave 2 starts while wave 1 is still in flight.
        if (!secondWaveStarted && step >= secondWaveStep) {
          secondWaveStarted = true;
          for (const entry of planned.slice(firstWave))
            promises.push(settle(engine.onStroke(entry.clip)));
        }
        // Read-during-write: summary() while analyses are in flight.
        if (step === summaryProbeStep) {
          const summary = engine.summary();
          const reps = engine.allReps();
          midFlightSummaries.push(canonicalJson(summary));
          violations.check(
            'E3',
            summary.validReps + summary.lowConfidenceReps === reps.length,
            () =>
              `mid-flight summary counts ${summary.validReps}+${summary.lowConfidenceReps} ≠ allReps ${reps.length}`,
          );
        }
      },
    });
    if (!secondWaveStarted) {
      secondWaveStarted = true;
      for (const entry of planned.slice(firstWave))
        promises.push(settle(engine.onStroke(entry.clip)));
      await scheduler.drain();
    }
    // Wave 2 may have opened gates after the first drain returned.
    while (scheduler.pendingCount() > 0) await scheduler.drain();
    return steps;
  })();

  let deadlocked = false;
  try {
    await withDeadline(`seed ${seed} burst`, BURST_DEADLINE_MS, settledAll);
    await withDeadline(
      `seed ${seed} promises`,
      BURST_DEADLINE_MS,
      Promise.all([...promises, ...bystanderPromises]),
    );
  } catch (error) {
    deadlocked = true;
    violations.fail(
      'E1',
      error instanceof Error ? error.message : String(error),
    );
  }
  const results: Settled[] = deadlocked ? [] : await Promise.all(promises);
  const bystanderResults: Settled[] = deadlocked
    ? []
    : await Promise.all(bystanderPromises);

  const fulfilledReps: LiveRep[] = [];
  let rejected = 0;
  let nulls = 0;
  results.forEach((result, i) => {
    const plan = planned[i] as PlannedClip;
    if (result.status === 'rejected') {
      rejected += 1;
      violations.check(
        'E6',
        plan.kind === 'provider_throws',
        () =>
          `clip ${i} (${plan.kind}) rejected: ${String((result as PromiseRejectedResult).reason)}`,
      );
      return;
    }
    if (result.value === null) {
      nulls += 1;
      violations.check(
        'E6',
        plan.kind === 'too_short',
        () => `clip ${i} (${plan.kind}) resolved null`,
      );
      return;
    }
    violations.check(
      'E6',
      plan.kind === 'ok' || plan.kind === 'duplicate',
      () => `clip ${i} (${plan.kind}) produced a rep`,
    );
    fulfilledReps.push(result.value);
  });

  const reps = engine.allReps();
  const summary = engine.summary();

  // E2 — rows: exactly the fulfilled reps, each once, no foreign rows.
  violations.check(
    'E2',
    reps.length === fulfilledReps.length,
    () =>
      `allReps has ${reps.length} rows, ${fulfilledReps.length} strokes fulfilled`,
  );
  violations.check(
    'E2',
    new Set(reps).size === reps.length,
    () => `allReps holds the same rep object more than once`,
  );
  violations.check(
    'E2',
    fulfilledReps.every(rep => reps.includes(rep)),
    () => `a fulfilled rep is missing from allReps`,
  );
  violations.check(
    'E2',
    new Set(reps.map(rep => rep.analysis.id)).size === reps.length,
    () => `duplicate analysis ids in allReps`,
  );

  // E3 — summary derivable from the rows.
  const scored = reps.filter(rep => rep.analysis.resultKind === 'scored');
  const scores = scored
    .map(rep => rep.analysis.overallScore)
    .filter((s): s is number => s !== null);
  violations.check(
    'E3',
    summary.validReps === scored.length,
    () => `validReps ${summary.validReps} ≠ ${scored.length}`,
  );
  violations.check(
    'E3',
    summary.lowConfidenceReps === reps.length - scored.length,
    () =>
      `lowConfidenceReps ${summary.lowConfidenceReps} ≠ ${reps.length - scored.length}`,
  );
  violations.check(
    'E3',
    summary.bestScore === (scores.length ? Math.max(...scores) : null),
    () =>
      `bestScore ${summary.bestScore} ≠ max ${scores.length ? Math.max(...scores) : null}`,
  );
  violations.check(
    'E3',
    summary.startScore === (scores[0] ?? null) &&
      summary.endScore === (scores.at(-1) ?? null),
    () =>
      `start/end ${summary.startScore}/${summary.endScore} ≠ ${scores[0] ?? null}/${scores.at(-1) ?? null}`,
  );
  violations.check(
    'E3',
    summary.cuesSpoken ===
      reps.filter(rep => rep.cue.category !== 'SILENCE').length,
    () => `cuesSpoken ${summary.cuesSpoken} ≠ non-silent cues`,
  );
  for (const probe of midFlightSummaries) {
    violations.check('E3', probe.length > 0, () => 'empty mid-flight summary');
  }

  // E4 — repIndex: unique, within 1..strokes, one per stroke.
  const repIndexes = reps.map(rep => rep.repIndex);
  const strokesArrived = planned.length;
  violations.check(
    'E4',
    new Set(repIndexes).size === repIndexes.length,
    () =>
      `duplicate repIndex values: [${repIndexes.join(', ')}] over ${strokesArrived} strokes`,
  );
  violations.check(
    'E4',
    repIndexes.every(index => index >= 1 && index <= strokesArrived),
    () =>
      `repIndex out of range: [${repIndexes.join(', ')}] (strokes ${strokesArrived})`,
  );

  // E5 — personal-best flag consistent with the order reps were recorded.
  let best: number | null = null;
  reps.forEach((rep, i) => {
    const score = rep.analysis.overallScore;
    const expected = score !== null && best !== null && score > best;
    violations.check(
      'E5',
      rep.isPersonalBest === expected,
      () =>
        `rep #${i} isPersonalBest=${rep.isPersonalBest}, expected ${expected} (score ${score}, best ${best})`,
    );
    if (score !== null) best = best === null ? score : Math.max(best, score);
  });

  // E8 — isolation between engines sharing a provider set.
  const bystanderReps = bystander.allReps();
  violations.check(
    'E8',
    bystanderReps.length ===
      bystanderResults.filter(r => r.status === 'fulfilled' && r.value !== null)
        .length,
    () => `bystander rows ${bystanderReps.length} ≠ its fulfilled strokes`,
  );
  violations.check(
    'E8',
    bystanderReps.every(
      rep => rep.analysis.sessionId === `bystander-${seed}`,
    ) && reps.every(rep => rep.analysis.sessionId === `live-${seed}`),
    () => `a rep landed in the wrong engine`,
  );

  return {
    repIndexes,
    cues: reps.map(rep => rep.cue.category),
    scores: reps.map(rep => rep.analysis.overallScore),
    personalBests: reps.map(rep => rep.isPersonalBest),
    summary,
    schedulerTrace: scheduler.trace,
    rejected,
    nulls,
    events: planned.length + bystanderStrokes,
  };
}

const table = new ResultsTable(CAMPAIGN);
const seeds = campaignSeeds(DEFAULT_ITERATIONS);

beforeAll(async () => {
  for (const seed of seeds) {
    const started = Date.now();
    const violations = new Violations();
    let events = 0;
    let steps = 0;
    try {
      const first = await runBurst(seed, violations);
      events = first.events;
      steps = first.schedulerTrace.length;
      // E7 — replay: a fresh engine + scheduler from the same seed must
      // produce the identical trace.
      const second = await runBurst(seed, new Violations());
      const fingerprint = (t: BurstTrace): string =>
        canonicalJson({
          repIndexes: t.repIndexes,
          cues: t.cues,
          scores: t.scores,
          personalBests: t.personalBests,
          trace: t.schedulerTrace,
          rejected: t.rejected,
          nulls: t.nulls,
        });
      violations.check(
        'E7',
        fingerprint(first) === fingerprint(second),
        () =>
          `replay diverged: ${fingerprint(first)} vs ${fingerprint(second)}`,
      );
      events += second.events;
      table.record({
        seed,
        outcome: violations.ids().length === 0 ? 'HELD' : 'BROKEN',
        violated: violations.ids(),
        details: violations.messages(),
        counters: { events, interleavingSteps: steps, iterations: 2 },
        trace: first.schedulerTrace,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      violations.fail(
        'E0',
        `harness threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      const result: SeedResult = {
        seed,
        outcome: 'BROKEN',
        violated: violations.ids(),
        details: violations.messages(),
        counters: { events, interleavingSteps: steps, iterations: 1 },
        durationMs: Date.now() - started,
      };
      table.record(result);
    }
  }
}, 600_000);

afterAll(() => {
  const path = table.write();
  const summary = table.summary();
  console.info(
    `[${CAMPAIGN}] seeds=${summary.seeds} held=${summary.held} broken=${summary.broken} ` +
      `events=${summary.totals['events'] ?? 0} steps=${summary.totals['interleavingSteps'] ?? 0}` +
      (path ? ` table=${path}` : ''),
  );
});

describe(`LiveCourtEngine concurrency campaign (${seeds.length} seeds)`, () => {
  it('ran every planned seed (harness itself never threw)', () => {
    expect(table.summary().seeds).toBe(seeds.length);
    expect(describeViolations(table, 'E0')).toBe('E0: held on every seed');
  });

  it('E1 every burst settles inside the wall-time bound (no deadlock)', () => {
    expect(describeViolations(table, 'E1')).toBe('E1: held on every seed');
  });

  it('E2 allReps() holds exactly the fulfilled reps — no lost, no duplicate rows', () => {
    expect(describeViolations(table, 'E2')).toBe('E2: held on every seed');
  });

  it('E3 summary() is derivable from allReps() at every observation point', () => {
    expect(describeViolations(table, 'E3')).toBe('E3: held on every seed');
  });

  it('E4 repIndex is a unique stroke ordinal under concurrent onStroke() calls', () => {
    expect(describeViolations(table, 'E4')).toBe('E4: held on every seed');
  });

  it('E5 isPersonalBest flags follow the recorded order', () => {
    expect(describeViolations(table, 'E5')).toBe('E5: held on every seed');
  });

  it('E6 failing clips resolve null, throwing providers reject, nothing else leaks', () => {
    expect(describeViolations(table, 'E6')).toBe('E6: held on every seed');
  });

  it('E7 every seed replays to the identical trace', () => {
    expect(describeViolations(table, 'E7')).toBe('E7: held on every seed');
  });

  it('E8 engines sharing a provider set stay isolated', () => {
    expect(describeViolations(table, 'E8')).toBe('E8: held on every seed');
  });
});

describe('LiveCourtEngine sequential oracle', () => {
  it('assigns repIndex 1..N when strokes are awaited one at a time', async () => {
    const providers = createFixtureVisionProviderSet('forehand_drive');
    const engine = makeEngine(providers, 'sequential');
    const indexes: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const rep = await engine.onStroke({
        uri: `file:///seq-${i}`,
        durationMs: 1500,
        fps: 30,
        width: 1080,
        height: 1920,
      });
      if (rep) indexes.push(rep.repIndex);
    }
    expect(indexes).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('minimal concurrent repro: two simultaneous strokes share one repIndex', async () => {
    const providers = createFixtureVisionProviderSet('forehand_drive');
    const engine = makeEngine(providers, 'two-at-once');
    const clip = {
      uri: 'file:///pair',
      durationMs: 1500,
      fps: 30,
      width: 1080,
      height: 1920,
    };
    const [a, b] = await Promise.all([
      engine.onStroke(clip),
      engine.onStroke({ ...clip, uri: 'file:///pair-2' }),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Contract under test: two distinct strokes → two distinct ordinals.
    expect(new Set([a!.repIndex, b!.repIndex]).size).toBe(2);
  });
});
