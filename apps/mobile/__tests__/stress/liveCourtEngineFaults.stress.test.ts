/**
 * STRESS · failure-injection · LiveCourtEngine (src/flow/liveCourt.ts)
 *
 * Dependencies of the unit and what is injected:
 *   vision.stroke / vision.pose / vision.paddle / vision.phase /
 *   vision.features (VisionProviderSet through analyzeClip)
 *       → throw | reject | timeout(90s) | malformed | partial | slow(5s) | never
 *   camera clip (the `clip` argument of onStroke)
 *       → malformed (NaN/negative/zero dimensions) | partial (too short)
 *   clock (`new Date().toISOString()`)
 *       → throw (toISOString throws) | malformed (system time at epoch 0 /
 *         year 275760 / invalid)
 *   id generator (`makeId`)
 *       → throw | malformed (empty / non-string / duplicate id)
 *
 * Invariants asserted per stroke (module contract; the Live Court screen no
 * longer exists, so "visible retry control" is asserted as: the failure is
 * OBSERVABLE to the caller — a null return, a rejection, or an honest
 * still-pending promise — never a rep that looks scored but is not):
 *   I1 no fake success: a rep is returned ONLY with a finite overallScore in
 *      [0,10] (or null with resultKind low_confidence), finite checkpoint
 *      scores, a non-empty cue text and no runtime artifacts in the text;
 *   I2 no unexpected hang: after 60s of fake time every stroke whose faults
 *      were not `never`/`timeout` has settled;
 *   I3 no corrupted engine state: summary counts add up, aggregates are
 *      finite-or-null, bestScore equals the max scored rep, allReps() has
 *      unique repIndex values;
 *   I4 replayable: the same seed produces the same canonical outcome.
 *
 * Scale: STRESS_ITER = seeds (default 6) × STROKES_PER_SEED (40) strokes.
 *        STRESS_ITER=250 → 10 000 strokes. STRESS_SEED=<n> replays one seed.
 * Output: artifacts/stress/live-court/liveCourtEngineFaults.json
 */
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine, type LiveRep } from '../../src/flow/liveCourt';
import {
  FaultyVisionProviderSet,
  INJECTED_FAULT_MODES,
  TIMEOUT_MS,
  VISION_DEPENDENCIES,
  WATCHDOG_MS,
  assertKnownBrokenStillReproduce,
  assertSeedOutcome,
  buildTable,
  campaignSeeds,
  canonicalJson,
  isFiniteOrNull,
  leaksRuntimeArtifact,
  mulberry32,
  strokeClipUri,
  writeArtifact,
  type FaultMode,
  type KnownBroken,
  type SeedOutcome,
  type VisionDependency,
} from '../../test-support/stress/liveCourtStressKit';

const STROKES_PER_SEED = 40;
const SUITE = 'liveCourtEngineFaults';

/** Reproduced production defects (see the MINIMIZED tests below). */
const KNOWN_BROKEN: readonly KnownBroken[] = [
  {
    finding: 'LC-1',
    violationClass: 'I3:duplicate_repIndex_in_allReps',
    observed:
      'LiveCourtEngine.onStroke increments repCounter before awaiting analyzeClip and reads it again ' +
      'after the await, so two in-flight strokes (one slow) both receive the later counter value.',
  },
  {
    finding: 'LC-2',
    violationClass: 'I5:unvalidated_window_forwarded',
    observed:
      'analyzeClip builds {startMs, endMs} from the first detector event without validating it and ' +
      'fans it out to pose/paddle; a detector event with string bounds reaches both providers ' +
      '(the repo fixture pose provider then loops forever: "a" + 33.3 < "b" is always true).',
  },
];

type ClipFault = 'none' | 'malformed' | 'partial';
type ClockFault = 'none' | 'throw' | 'malformed';
type IdFault = 'none' | 'throw' | 'malformed';

interface StrokePlan {
  vision: {
    dependency: VisionDependency;
    mode: FaultMode;
    variant: number;
  } | null;
  clip: { fault: ClipFault; variant: number };
  clock: { fault: ClockFault; variant: number };
  id: { fault: IdFault; variant: number };
}

interface StrokeRecord {
  stroke: number;
  faults: string[];
  settled: boolean;
  result: 'rep' | 'null' | 'rejected' | 'pending';
  error: string | null;
  overallScore: number | null | 'non-finite';
  resultKind: string | null;
  cueCategory: string | null;
  violations: string[];
}

const HEALTHY_CLIP = {
  uri: 'file:///stress/clip.mov',
  durationMs: 2000,
  fps: 30,
  width: 1080,
  height: 1920,
};

function planStroke(rng: ReturnType<typeof mulberry32>): StrokePlan {
  const plan: StrokePlan = {
    vision: null,
    clip: { fault: 'none', variant: 0 },
    clock: { fault: 'none', variant: 0 },
    id: { fault: 'none', variant: 0 },
  };
  // ~60% of strokes carry exactly one injected fault; the rest are healthy
  // so the campaign also checks that healthy strokes after a fault recover.
  if (!rng.chance(0.6)) return plan;
  const target = rng.int(0, 9);
  if (target <= 6) {
    plan.vision = {
      dependency: rng.pick(VISION_DEPENDENCIES),
      mode: rng.pick(INJECTED_FAULT_MODES),
      variant: rng.int(0, 7),
    };
  } else if (target === 7) {
    plan.clip = {
      fault: rng.pick(['malformed', 'partial']),
      variant: rng.int(0, 5),
    };
  } else if (target === 8) {
    plan.clock = {
      fault: rng.pick(['throw', 'malformed']),
      variant: rng.int(0, 3),
    };
  } else {
    plan.id = {
      fault: rng.pick(['throw', 'malformed']),
      variant: rng.int(0, 3),
    };
  }
  return plan;
}

function clipFor(plan: StrokePlan, strokeIndex: number): typeof HEALTHY_CLIP {
  const healthy = { ...HEALTHY_CLIP, uri: strokeClipUri(strokeIndex) };
  if (plan.clip.fault === 'none') return healthy;
  if (plan.clip.fault === 'partial') {
    const variants = [
      { ...healthy, durationMs: 0 },
      { ...healthy, durationMs: 499 },
      { ...healthy, durationMs: 1 },
      { ...healthy, uri: '' },
      { ...healthy, width: 0, height: 0 },
      { ...healthy, fps: 0 },
    ];
    return variants[plan.clip.variant % variants.length]!;
  }
  const variants = [
    { ...healthy, durationMs: NaN },
    { ...healthy, durationMs: -2000 },
    { ...healthy, durationMs: Infinity },
    { ...healthy, fps: NaN, width: NaN, height: NaN },
    { ...healthy, durationMs: 1e12 },
    { ...healthy, uri: 'not a uri', durationMs: -1 },
  ];
  return variants[plan.clip.variant % variants.length]!;
}

function faultLabels(plan: StrokePlan): string[] {
  const labels: string[] = [];
  if (plan.vision) labels.push(`${plan.vision.dependency}:${plan.vision.mode}`);
  if (plan.clip.fault !== 'none') labels.push(`camera.clip:${plan.clip.fault}`);
  if (plan.clock.fault !== 'none') labels.push(`clock:${plan.clock.fault}`);
  if (plan.id.fault !== 'none') labels.push(`id_generator:${plan.id.fault}`);
  return labels;
}

/** A vision fault that legitimately leaves the promise pending past 60s. */
function expectedToHang(plan: StrokePlan): boolean {
  return (
    plan.vision !== null &&
    (plan.vision.mode === 'never' || plan.vision.mode === 'timeout')
  );
}

function checkRep(rep: LiveRep, violations: string[]): void {
  const analysis = rep.analysis;
  if (!analysis || typeof analysis !== 'object') {
    violations.push('I1:rep_without_analysis');
    return;
  }
  const score = analysis.overallScore;
  if (analysis.resultKind === 'scored') {
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      violations.push(`I1:scored_with_nonfinite_overall(${String(score)})`);
    } else if (score < 0 || score > 10) {
      violations.push(`I1:scored_out_of_range(${score})`);
    }
  } else if (analysis.resultKind === 'low_confidence') {
    if (score !== null)
      violations.push(`I1:low_confidence_with_score(${String(score)})`);
  } else {
    violations.push(`I1:unknown_resultKind(${String(analysis.resultKind)})`);
  }
  if (!Array.isArray(analysis.checkpoints)) {
    violations.push('I1:checkpoints_not_array');
  } else {
    for (const checkpoint of analysis.checkpoints) {
      if (!isFiniteOrNull(checkpoint.score)) {
        violations.push(`I1:checkpoint_nonfinite(${checkpoint.key})`);
      }
    }
  }
  if (rep.cue.category !== 'SILENCE') {
    if (typeof rep.cue.text !== 'string' || rep.cue.text.length === 0) {
      violations.push('I1:cue_text_empty');
    } else {
      const leak = leaksRuntimeArtifact(rep.cue.text);
      if (leak) violations.push(`I1:cue_text_leaks(${leak})`);
    }
  }
}

/** Deterministic sweep: every (dependency × mode) exactly once, each
 * followed by a healthy stroke so recovery after every fault is checked. */
function sweepPlans(): StrokePlan[] {
  const healthy = (): StrokePlan => ({
    vision: null,
    clip: { fault: 'none', variant: 0 },
    clock: { fault: 'none', variant: 0 },
    id: { fault: 'none', variant: 0 },
  });
  const plans: StrokePlan[] = [];
  let variant = 0;
  for (const dependency of VISION_DEPENDENCIES) {
    for (const mode of INJECTED_FAULT_MODES) {
      plans.push({
        ...healthy(),
        vision: { dependency, mode, variant: variant++ },
      });
      plans.push(healthy());
    }
  }
  // Every malformed stroke-detector shape (the sweep above only reaches
  // variants 0..6 of the 8 garbage shapes) — variant 7 is the string window.
  for (let v = 0; v < 8; v += 1) {
    plans.push({
      ...healthy(),
      vision: { dependency: 'vision.stroke', mode: 'malformed', variant: v },
    });
  }
  for (const fault of ['malformed', 'partial'] as const) {
    for (let v = 0; v < 6; v += 1) {
      plans.push({ ...healthy(), clip: { fault, variant: v } });
    }
  }
  for (const fault of ['throw', 'malformed'] as const) {
    for (let v = 0; v < 4; v += 1) {
      plans.push({ ...healthy(), clock: { fault, variant: v } });
      plans.push({ ...healthy(), id: { fault, variant: v } });
    }
  }
  plans.push(healthy());
  return plans;
}

/** seed 0 = the deterministic sweep; every other seed = a random plan. */
function plansFor(seed: number): StrokePlan[] {
  if (seed === 0) return sweepPlans();
  const rng = mulberry32(seed);
  const plans: StrokePlan[] = [];
  for (let i = 0; i < STROKES_PER_SEED; i += 1) plans.push(planStroke(rng));
  return plans;
}

async function runSeed(seed: number): Promise<{
  outcome: SeedOutcome;
  records: StrokeRecord[];
}> {
  const perStroke = new Map<
    number,
    { dependency: VisionDependency; mode: FaultMode; variant: number }
  >();
  const plans = plansFor(seed);
  plans.forEach((plan, i) => {
    if (plan.vision) perStroke.set(i, plan.vision);
  });
  const faulty = new FaultyVisionProviderSet(
    createFixtureVisionProviderSet('forehand_drive'),
    { perStroke },
  );
  let idCounter = 0;
  let currentPlan: StrokePlan = plans[0]!;
  const engine = new LiveCourtEngine(faulty.providers(), {
    sessionId: `stress-${seed}`,
    shotType: 'forehand_drive',
    focusCheckpoint: 'contact_position',
    handedness: 'right',
    appVersion: 'stress',
    modelBundleVersion: 'stress',
    makeId: () => {
      if (currentPlan.id.fault === 'throw') {
        throw new Error('INJECTED_THROW:id_generator');
      }
      if (currentPlan.id.fault === 'malformed') {
        const variants: unknown[] = ['', undefined, 42, 'duplicate-id'];
        return variants[currentPlan.id.variant % variants.length] as string;
      }
      idCounter += 1;
      return `analysis-${seed}-${idCounter}`;
    },
  });

  const records: StrokeRecord[] = [];
  const violations: string[] = [];
  const faultsInjected = new Set<string>();
  const seenIds = new Set<string>();
  const holders: Array<{ rep: LiveRep | null }> = [];
  const checkedInWindow = new Set<number>();
  let lateSettledReps = 0;
  let malformedIdsPropagated = 0;

  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i]!;
    currentPlan = plan;
    faulty.arm(i);
    const labels = faultLabels(plan);
    for (const label of labels) faultsInjected.add(label);

    let toISOSpy: jest.SpyInstance | null = null;
    if (plan.clock.fault === 'throw') {
      toISOSpy = jest
        .spyOn(Date.prototype, 'toISOString')
        .mockImplementationOnce(() => {
          throw new RangeError('INJECTED_THROW:clock');
        });
    } else if (plan.clock.fault === 'malformed') {
      const clocks = [0, 8.64e15, -1, 1e14];
      jest.setSystemTime(clocks[plan.clock.variant % clocks.length]!);
    }

    const record: StrokeRecord = {
      stroke: i,
      faults: labels,
      settled: false,
      result: 'pending',
      error: null,
      overallScore: null,
      resultKind: null,
      cueCategory: null,
      violations: [],
    };
    const holder: { rep: LiveRep | null } = { rep: null };
    holders.push(holder);
    const promise = engine
      .onStroke(clipFor(plan, i))
      .then(value => {
        record.settled = true;
        holder.rep = value;
        record.result = value ? 'rep' : 'null';
      })
      .catch((error: unknown) => {
        record.settled = true;
        record.result = 'rejected';
        record.error = error instanceof Error ? error.message : String(error);
      });
    // Never await `promise` directly: never/timeout faults leave it pending
    // by design. 60s of fake time + microtask drain decides `settled`.
    await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
    for (let drain = 0; drain < 25; drain += 1) await Promise.resolve();
    void promise;
    toISOSpy?.mockRestore();
    jest.setSystemTime(1_757_030_400_000);

    if (!record.settled && !expectedToHang(plan)) {
      record.violations.push(
        'I2:hung_after_60s_without_never_or_timeout_fault',
      );
    }
    if (holder.rep) {
      checkedInWindow.add(i);
      const value: LiveRep = holder.rep;
      record.overallScore = Number.isFinite(value.analysis.overallScore ?? 0)
        ? value.analysis.overallScore
        : 'non-finite';
      record.resultKind = value.analysis.resultKind;
      record.cueCategory = value.cue.category;
      checkRep(value, record.violations);
      if (
        plan.vision &&
        (plan.vision.mode === 'throw' || plan.vision.mode === 'reject')
      ) {
        record.violations.push(
          `I1:fake_success_after_${plan.vision.dependency}_${plan.vision.mode}`,
        );
      }
      if (plan.id.fault === 'throw')
        record.violations.push('I1:fake_success_after_id_throw');
      if (plan.clock.fault === 'throw')
        record.violations.push('I1:fake_success_after_clock_throw');
      if (plan.id.fault === 'none') {
        // A healthy id generator must yield unique, non-empty ids; a
        // malformed generator's output is propagated verbatim by the engine
        // (recorded, not judged — the engine cannot validate its own ids).
        if (
          typeof value.analysis.id !== 'string' ||
          value.analysis.id.length === 0
        ) {
          record.violations.push(
            `I3:analysis_id_invalid(${String(value.analysis.id)})`,
          );
        } else if (seenIds.has(value.analysis.id)) {
          record.violations.push(
            `I3:duplicate_analysis_id(${value.analysis.id})`,
          );
        }
        if (typeof value.analysis.id === 'string')
          seenIds.add(value.analysis.id);
      } else {
        malformedIdsPropagated += 1;
      }
    }
    for (const violation of record.violations) {
      violations.push(
        `stroke=${i} ${violation} faults=${labels.join('+') || 'healthy'}`,
      );
    }
    records.push(record);
  }

  // Let `timeout` (90s) faults settle so late reps are accounted for; only
  // `never` faults stay pending forever.
  await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
  for (let drain = 0; drain < 25; drain += 1) await Promise.resolve();
  holders.forEach((holder, i) => {
    const record = records[i]!;
    if (holder.rep && !checkedInWindow.has(i)) {
      // Settled after its own 60s window (timeout fault) — a late rep.
      lateSettledReps += 1;
      record.resultKind = holder.rep.analysis.resultKind;
      record.cueCategory = holder.rep.cue.category;
      checkRep(holder.rep, record.violations);
      for (const violation of record.violations) {
        violations.push(
          `stroke=${i} ${violation} faults=${record.faults.join('+')} (late)`,
        );
      }
    }
  });
  const returnedReps = holders.filter(holder => holder.rep !== null).length;

  // I3 — engine state after the campaign.
  const reps = engine.allReps();
  const summary = engine.summary();
  if (reps.length !== returnedReps) {
    violations.push(
      `I3:allReps_count(${reps.length})!=returned(${returnedReps})`,
    );
  }
  const indices = reps.map(rep => rep.repIndex);
  if (new Set(indices).size !== indices.length) {
    const dupes = indices.filter((value, i) => indices.indexOf(value) !== i);
    violations.push(
      `I3:duplicate_repIndex_in_allReps(${[...new Set(dupes)].join(',')})`,
    );
  }
  const outOfOrder = indices.some(
    (value, i) => i > 0 && value < indices[i - 1]!,
  );
  if (summary.validReps + summary.lowConfidenceReps !== reps.length) {
    violations.push('I3:summary_counts_do_not_add_up');
  }
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      violations.push(`I3:summary_nonfinite(${key})`);
    }
  }
  const scored = reps
    .filter(rep => rep.analysis.resultKind === 'scored')
    .map(rep => rep.analysis.overallScore)
    .filter((score): score is number => typeof score === 'number');
  const expectedBest = scored.length ? Math.max(...scored) : null;
  if (summary.bestScore !== expectedBest) {
    violations.push(
      `I3:bestScore(${String(summary.bestScore)})!=max(${String(expectedBest)})`,
    );
  }
  if (summary.cuesSpoken > reps.length || summary.cuesSpoken < 0) {
    violations.push(`I3:cuesSpoken_out_of_range(${summary.cuesSpoken})`);
  }

  const healthyStrokes = records.filter(r => r.faults.length === 0);
  const healthyRecovered = healthyStrokes.every(r => r.result === 'rep');
  if (!healthyRecovered) {
    violations.push('I3:healthy_stroke_after_fault_did_not_produce_rep');
  }
  for (const forwarded of faulty.forwardedInvalidWindows) {
    violations.push(
      `stroke=${forwarded.stroke} I5:unvalidated_window_forwarded(${forwarded.dependency}:${forwarded.reason})`,
    );
  }

  return {
    records,
    outcome: {
      seed,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      iterations: records.length,
      faultsInjected: [...faultsInjected].sort(),
      violations,
      detail: {
        returnedReps,
        lateSettledReps,
        malformedIdsPropagated,
        rejected: records.filter(r => r.result === 'rejected').length,
        nullReturns: records.filter(r => r.result === 'null').length,
        pendingAfter90s: records.filter(r => !r.settled).length,
        repsAppendedOutOfRepIndexOrder: outOfOrder,
        forwardedInvalidWindows: faulty.forwardedInvalidWindows,
        summary,
      },
    },
  };
}

describe('STRESS · LiveCourtEngine × injected vision/camera/clock/id faults', () => {
  // Seed 0 is the deterministic full sweep (41 vision + 6 camera + 16
  // clock/id injections); the remaining seeds are random campaigns.
  const seeds = [0, ...campaignSeeds(6)];
  const outcomes: SeedOutcome[] = [];
  const allRecords: Record<number, StrokeRecord[]> = {};

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_757_030_400_000);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  afterAll(() => {
    const table = buildTable(SUITE, outcomes);
    writeArtifact(`${SUITE}.json`, table);
    writeArtifact(`${SUITE}.strokes.json`, allRecords);
  });

  it.each(seeds.map(seed => [seed] as const))(
    'seed=%i holds the engine invariants (outside KNOWN_BROKEN)',
    async seed => {
      const { outcome, records } = await runSeed(seed);
      outcomes.push(outcome);
      allRecords[seed] = records;
      assertSeedOutcome(SUITE, outcome, KNOWN_BROKEN);
    },
  );

  it('KNOWN_BROKEN classes still reproduce (delete the entry + close the finding when this fails)', () => {
    assertKnownBrokenStillReproduce(SUITE, outcomes, KNOWN_BROKEN);
  });

  it('is replayable: the same seed yields the same canonical outcome (I4)', async () => {
    const seed = seeds[1]!;
    const a = await runSeed(seed);
    jest.useRealTimers();
    jest.useFakeTimers();
    jest.setSystemTime(1_757_030_400_000);
    const b = await runSeed(seed);
    const strip = (records: StrokeRecord[]) =>
      canonicalJson(records.map(({ error: _error, ...rest }) => rest));
    expect(strip(b.records)).toBe(strip(a.records));
    expect(canonicalJson(b.outcome.detail)).toBe(
      canonicalJson(a.outcome.detail),
    );
  });

  // it.failing: the body asserts the CORRECT behaviour and is expected to
  // throw today (finding LC-1). Jest turns the test red the moment the
  // production defect is fixed, so the pin cannot rot silently.
  it.failing(
    'MINIMIZED (LC-1, expected-fail): a slow pose provider on stroke 1 and a fast stroke 2 must yield distinct repIndex values (I3)',
    async () => {
      // Two strokes in flight at once — realistic on a live court where the
      // next swing lands while the previous analysis is still running.
      const perStroke = new Map<
        number,
        { dependency: VisionDependency; mode: FaultMode; variant: number }
      >([[0, { dependency: 'vision.pose', mode: 'slow', variant: 0 }]]);
      const faulty = new FaultyVisionProviderSet(
        createFixtureVisionProviderSet('forehand_drive'),
        { perStroke },
      );
      let ids = 0;
      const engine = new LiveCourtEngine(faulty.providers(), {
        sessionId: 'minimized-concurrent',
        shotType: 'forehand_drive',
        focusCheckpoint: 'contact_position',
        handedness: 'right',
        appVersion: 'stress',
        modelBundleVersion: 'stress',
        makeId: () => `id-${++ids}`,
      });
      const first = engine.onStroke({ ...HEALTHY_CLIP, uri: strokeClipUri(0) });
      const second = engine.onStroke({
        ...HEALTHY_CLIP,
        uri: strokeClipUri(1),
      });
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
      const [repA, repB] = await Promise.all([first, second]);
      expect(repA).not.toBeNull();
      expect(repB).not.toBeNull();
      const indices = [repA!.repIndex, repB!.repIndex];
      expect(new Set(indices).size).toBe(2);
      expect(engine.allReps().map(rep => rep.repIndex)).toEqual([1, 2]);
    },
  );

  it.failing(
    'MINIMIZED (LC-2, expected-fail): analyzeClip must not forward a non-numeric stroke window to the pose/paddle providers (I5)',
    async () => {
      const perStroke = new Map<
        number,
        { dependency: VisionDependency; mode: FaultMode; variant: number }
      >([[0, { dependency: 'vision.stroke', mode: 'malformed', variant: 7 }]]);
      const faulty = new FaultyVisionProviderSet(
        createFixtureVisionProviderSet('forehand_drive'),
        { perStroke },
      );
      let ids = 0;
      const engine = new LiveCourtEngine(faulty.providers(), {
        sessionId: 'minimized-window',
        shotType: 'forehand_drive',
        focusCheckpoint: 'contact_position',
        handedness: 'right',
        appVersion: 'stress',
        modelBundleVersion: 'stress',
        makeId: () => `id-${++ids}`,
      });
      const rep = await engine.onStroke({
        ...HEALTHY_CLIP,
        uri: strokeClipUri(0),
      });
      // No fake success either way …
      expect(rep).toBeNull();
      // … but the garbage window `{startMs:'a', endMs:'b'}` must be rejected
      // by analyzeClip, never handed to the downstream providers (the repo's
      // own fixture pose provider loops forever on it).
      expect(faulty.forwardedInvalidWindows).toEqual([]);
    },
  );

  it('exercises every vision dependency × every fault mode at least once across the campaign', () => {
    const injected = new Set(outcomes.flatMap(o => o.faultsInjected));
    const missing: string[] = [];
    for (const dependency of VISION_DEPENDENCIES) {
      for (const mode of INJECTED_FAULT_MODES) {
        if (!injected.has(`${dependency}:${mode}`))
          missing.push(`${dependency}:${mode}`);
      }
    }
    for (const extra of [
      'camera.clip:malformed',
      'camera.clip:partial',
      'clock:throw',
      'clock:malformed',
      'id_generator:throw',
      'id_generator:malformed',
    ]) {
      if (!injected.has(extra)) missing.push(extra);
    }
    // 5 vision deps × 7 modes + 6 = 41 distinct fault labels from this suite alone.
    expect(missing).toEqual([]);
    expect(injected.size).toBeGreaterThanOrEqual(41);
  });
});
