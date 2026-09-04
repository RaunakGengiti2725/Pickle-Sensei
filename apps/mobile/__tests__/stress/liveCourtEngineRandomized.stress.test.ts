/**
 * SEEDED RANDOMIZED LONG-RUN — LiveCourtEngine (flow/liveCourt.ts).
 *
 * The engine is driven through its public API only (onStroke / allReps /
 * summary) with the REAL analysis pipeline + REAL scoring + REAL cue engine
 * behind a seeded perturbation of the deterministic fixture providers:
 * measurement values / confidences are scaled, metrics dropped, provider
 * stages fail, provider latency varies (so overlapping onStroke calls can
 * complete out of order), and clips are legal or near-legal (too short,
 * zero / negative / non-finite duration).
 *
 * INVARIANTS (checked after every action):
 *  E1 repIndex is the 1-based count of onStroke() calls at call time
 *     (liveCourt.ts L67, L87) — failed analyses still consume an index.
 *  E2 onStroke() never rejects for any clip shape; a failed analysis is
 *     `null`, never a thrown error (L80).
 *  E3 allReps() is a fresh copy (L109–L111) whose length equals the number
 *     of non-null results, and every stored rep carries source 'fixture'
 *     and a contract-shaped analysis (low_confidence ⇒ overallScore null,
 *     scored ⇒ finite 0..10).
 *  E4 summary() is a pure function of the stored reps (L113–L137):
 *     validReps = #scored, lowConfidenceReps = #stored − #scored,
 *     start/end/best over the numeric overall scores in STORED order,
 *     focusStart/focusEnd over the focus checkpoint scores of scored reps,
 *     cuesSpoken = #reps whose cue is not SILENCE, sessionId/focus echo.
 *  E5 isPersonalBest ⇔ overallScore !== null ∧ previous best !== null ∧
 *     overallScore > previous best (L98–L101), where previous best is the
 *     max numeric score of the reps processed BEFORE this one.
 *  E6 cue policy (audio-coach-core cueEngine.ts): low_confidence reps are
 *     SILENCE except exactly the 3rd consecutive one (setup CORRECTION);
 *     PERSONAL_BEST ⇔ isPersonalBest ∧ repIndex ≥ 3; text is null iff
 *     SILENCE.
 *  E7 chronology — the engine's contract is "every rep → analyze → score →
 *     cue" (L14–L18) and summary start/end are read from stored order, so
 *     allReps() must be ascending by repIndex even when analyses overlap.
 *  DET same seed twice → identical trace.
 */
import type {
  Measurement,
  PoseFrame,
  Result,
  ShotTypeSlug,
} from '@pickle/shared-types';
import type {
  IFeatureExtractor,
  IPoseProvider,
  VisionProviderSet,
} from '@pickle/vision-contracts';
import { fail, failure } from '@pickle/shared-types';
import { createFixtureVisionProviderSet } from '../../../../packages/vision-contracts/test/support/fixtureProvider';
import { LiveCourtEngine, type LiveRep } from '../../src/flow/liveCourt';
import {
  InvariantViolation,
  SeededRng,
  campaignConfig,
  check,
  digest,
  minimizeActions,
  subSeed,
  sumStats,
  writeReport,
  type SequenceOutcome,
} from '../../test-support/stress/seededStress';
import { summarizeBroken } from '../../test-support/stress/knownDefects';

declare const process: { env: Record<string, string | undefined> };
process.env.PICKLE_ENV = 'development';

type ClipShape =
  'legal' | 'short' | 'zero' | 'negative' | 'nan' | 'infinite' | 'huge';

type Perturbation =
  | 'none'
  | 'scale'
  | 'lowConfidence'
  | 'dropMetrics'
  | 'emptyMetrics'
  | 'featuresFail'
  | 'poseFail'
  | 'poseEmpty';

type EngineAction =
  | {
      kind: 'stroke';
      clip: ClipShape;
      perturb: Perturbation;
      latency: number;
    }
  | {
      kind: 'burst';
      strokes: Array<{
        clip: ClipShape;
        perturb: Perturbation;
        latency: number;
      }>;
    }
  | { kind: 'inspect' };

interface EnginePlan {
  seed: number;
  /** Half the plans are strictly serial (await every stroke) so the
   * serial-path invariants stay covered even while overlapping strokes
   * trip LC-3 early. */
  serial: boolean;
  actions: EngineAction[];
}

const CLIP_SHAPES: readonly ClipShape[] = [
  'legal',
  'legal',
  'legal',
  'legal',
  'short',
  'zero',
  'negative',
  'nan',
  'infinite',
  'huge',
];
const PERTURBATIONS: readonly Perturbation[] = [
  'none',
  'none',
  'scale',
  'scale',
  'lowConfidence',
  'dropMetrics',
  'emptyMetrics',
  'featuresFail',
  'poseFail',
  'poseEmpty',
];

function generateEnginePlan(seed: number): EnginePlan {
  const rng = new SeededRng(seed);
  const length = rng.int(5, 60);
  const serial = rng.bool(0.5);
  const actions: EngineAction[] = [];
  const stroke = () => ({
    clip: rng.pick(CLIP_SHAPES),
    perturb: rng.pick(PERTURBATIONS),
    latency: rng.int(0, 3),
  });
  for (let i = 0; i < length; i++) {
    const kind = rng.weighted({ stroke: 70, burst: 15, inspect: 15 });
    if (kind === 'stroke' || (kind === 'burst' && serial)) {
      actions.push({ kind: 'stroke', ...stroke() });
    } else if (kind === 'burst') {
      const count = rng.int(2, 5);
      actions.push({
        kind,
        strokes: Array.from({ length: count }, () => stroke()),
      });
    } else actions.push({ kind });
  }
  return { seed, serial, actions };
}

/**
 * STRESS_AVOID_KNOWN=1: flatten each burst into serial strokes (same clip
 * workload, no overlap) so LC-3 (test-support/stress/knownDefects.ts) cannot stop a
 * sequence at its first burst and every other invariant runs to full depth.
 * In this mode any BROKEN outcome is unexpected.
 */
function avoidKnownTriggers(plan: EnginePlan): EnginePlan {
  const actions = plan.actions.flatMap((action): EngineAction[] =>
    action.kind === 'burst'
      ? action.strokes.map(stroke => ({ kind: 'stroke' as const, ...stroke }))
      : [action],
  );
  return { ...plan, serial: true, actions };
}

const avoidKnown = process.env.STRESS_AVOID_KNOWN === '1';

function planFor(seed: number): EnginePlan {
  const plan = generateEnginePlan(seed);
  return avoidKnown ? avoidKnownTriggers(plan) : plan;
}

function clipFor(shape: ClipShape, index: number) {
  const base = {
    uri: `fixture://stress/${index}`,
    fps: 30,
    width: 720,
    height: 1280,
  };
  switch (shape) {
    case 'legal':
      return { ...base, durationMs: 1800 + (index % 7) * 150 };
    case 'short':
      return { ...base, durationMs: 120 };
    case 'zero':
      return { ...base, durationMs: 0 };
    case 'negative':
      return { ...base, durationMs: -400 };
    case 'nan':
      return { ...base, durationMs: Number.NaN };
    case 'infinite':
      return { ...base, durationMs: Number.POSITIVE_INFINITY };
    case 'huge':
      return { ...base, durationMs: 6 * 60 * 60 * 1000 };
  }
}

/** Per-stroke perturbation script — looked up by clip uri so it is stable
 * regardless of the order the pipeline reaches each stage. */
interface StrokeScript {
  perturb: Perturbation;
  latency: number;
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function delayTicks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await tick();
}

function perturbedProviders(
  seed: number,
  scripts: Map<string, StrokeScript>,
): VisionProviderSet {
  const base = createFixtureVisionProviderSet('forehand_drive');
  const scriptFor = (uri: string): StrokeScript =>
    scripts.get(uri) ?? { perturb: 'none', latency: 0 };
  // analyzeClip hands the SAME pose array to the feature extractor, so the
  // owning clip is recovered by identity — no shared mutable state, which
  // matters when bursts interleave strokes.
  const owner = new WeakMap<PoseFrame[], string>();

  const pose: IPoseProvider = {
    modelVersion: base.pose.modelVersion,
    source: base.pose.source,
    async extractPose(clip, window): Promise<Result<PoseFrame[]>> {
      const script = scriptFor(clip.uri);
      await delayTicks(script.latency);
      if (script.perturb === 'poseFail') {
        return fail(
          failure(
            'low_confidence',
            'vision.pose.stress_fail',
            'stress: pose failed',
          ),
        );
      }
      if (script.perturb === 'poseEmpty') {
        const empty: PoseFrame[] = [];
        owner.set(empty, clip.uri);
        return { ok: true, value: empty };
      }
      const frames = await base.pose.extractPose(clip, window);
      if (frames.ok) owner.set(frames.value, clip.uri);
      return frames;
    },
  };

  const features: IFeatureExtractor = {
    version: base.features.version,
    async extractMeasurements(input): Promise<Result<Measurement[]>> {
      const uri = owner.get(input.poseFrames) ?? '';
      const script = scriptFor(uri);
      const measured = await base.features.extractMeasurements(input);
      if (!measured.ok) return measured;
      const rng = new SeededRng(subSeed(seed, `features:${uri}`));
      switch (script.perturb) {
        case 'featuresFail':
          return fail(
            failure(
              'low_confidence',
              'vision.features.stress_fail',
              'stress: features failed',
            ),
          );
        case 'emptyMetrics':
          return { ok: true, value: [] };
        case 'dropMetrics':
          return {
            ok: true,
            value: measured.value.filter(() => rng.bool(0.5)),
          };
        case 'lowConfidence':
          return {
            ok: true,
            value: measured.value.map(m => ({
              ...m,
              confidence: Number(rng.float(0, 0.6).toFixed(2)),
            })),
          };
        case 'scale':
          return {
            ok: true,
            value: measured.value.map(m => ({
              ...m,
              value: m.value * rng.float(0.3, 2.5),
              confidence: Number(rng.float(0.5, 1).toFixed(2)),
            })),
          };
        default:
          return measured;
      }
    },
  };

  return { ...base, pose, features };
}

const SHOT: ShotTypeSlug = 'forehand_drive';
const FOCUS = 'contact_position' as const;

interface EngineRun {
  violation: InvariantViolation | null;
  crash: string | null;
  failingStep: number | null;
  trace: string[];
  traceDigest: string;
  stats: Record<string, number>;
}

async function runEnginePlan(plan: EnginePlan): Promise<EngineRun> {
  const { seed } = plan;
  const scripts = new Map<string, StrokeScript>();
  const providers = perturbedProviders(seed, scripts);
  let idCounter = 0;
  const engine = new LiveCourtEngine(providers, {
    sessionId: `stress-live-court-${seed}`,
    shotType: SHOT,
    focusCheckpoint: FOCUS,
    handedness: 'right',
    appVersion: '0.0.0-stress',
    modelBundleVersion: 'fixture-1',
    makeId: () =>
      `00000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
  });
  const trace: string[] = [];
  const stats: Record<string, number> = {
    strokes: 0,
    reps: 0,
    scored: 0,
    lowConfidence: 0,
    failed: 0,
    bursts: 0,
    outOfOrderCompletions: 0,
    steps: 0,
  };
  let calls = 0;
  const returned: Array<LiveRep | null> = [];
  const completionOrder: number[] = [];

  const fire = (spec: {
    clip: ClipShape;
    perturb: Perturbation;
    latency: number;
  }) => {
    calls += 1;
    const callIndex = calls;
    const clip = clipFor(spec.clip, callIndex);
    scripts.set(clip.uri, { perturb: spec.perturb, latency: spec.latency });
    stats.strokes = (stats.strokes ?? 0) + 1;
    return engine.onStroke(clip).then(
      rep => {
        completionOrder.push(callIndex);
        return { callIndex, rep, error: null as string | null };
      },
      (error: unknown) => {
        completionOrder.push(callIndex);
        return {
          callIndex,
          rep: null,
          error: error instanceof Error ? error.message : String(error),
        };
      },
    );
  };

  const settle = (
    results: Array<{
      callIndex: number;
      rep: LiveRep | null;
      error: string | null;
    }>,
    step: number,
  ) => {
    for (const result of results) {
      check(
        result.error === null,
        'E2',
        step,
        () => `onStroke #${result.callIndex} rejected: ${result.error}`,
      );
      if (result.rep !== null) {
        check(
          result.rep.repIndex === result.callIndex,
          'E1',
          step,
          () =>
            `rep for call ${result.callIndex} has repIndex ${result.rep!.repIndex}`,
        );
      }
      returned[result.callIndex - 1] = result.rep;
    }
  };

  const checkAll = (step: number) => {
    const reps = engine.allReps();
    const copy = engine.allReps();
    check(
      reps !== copy,
      'E3',
      step,
      () => 'allReps() returned the same array twice',
    );
    const expectedReps = returned.filter((rep): rep is LiveRep => rep !== null);
    check(
      reps.length === expectedReps.length,
      'E3',
      step,
      () =>
        `allReps() has ${reps.length} reps, ${expectedReps.length} non-null results`,
    );
    for (const rep of reps) {
      check(
        rep.analysis.source === 'fixture',
        'E3',
        step,
        () => `rep ${rep.repIndex} source ${rep.analysis.source}`,
      );
      const score = rep.analysis.overallScore;
      if (rep.analysis.resultKind === 'low_confidence') {
        check(
          score === null,
          'E3',
          step,
          () => `low_confidence rep ${rep.repIndex} has score ${score}`,
        );
      } else {
        check(
          rep.analysis.resultKind === 'scored' &&
            score !== null &&
            Number.isFinite(score) &&
            score >= 0 &&
            score <= 10,
          'E3',
          step,
          () => `rep ${rep.repIndex} ${rep.analysis.resultKind} score ${score}`,
        );
      }
      check(
        (rep.cue.text === null) === (rep.cue.category === 'SILENCE'),
        'E6',
        step,
        () =>
          `rep ${rep.repIndex} cue ${rep.cue.category} text ${rep.cue.text}`,
      );
    }
    // E7 chronology.
    for (let i = 1; i < reps.length; i++) {
      check(
        reps[i]!.repIndex > reps[i - 1]!.repIndex,
        'E7',
        step,
        () =>
          `allReps() order ${reps.map(rep => rep.repIndex).join(',')} is not ascending by repIndex`,
      );
    }
    // E5 / E6 replayed over stored order (the order the engine saw them).
    let best: number | null = null;
    let lowStreak = 0;
    for (const rep of reps) {
      const score = rep.analysis.overallScore;
      const expectPersonalBest =
        score !== null && best !== null && score > best;
      check(
        rep.isPersonalBest === expectPersonalBest,
        'E5',
        step,
        () =>
          `rep ${rep.repIndex} isPersonalBest=${rep.isPersonalBest} score ${score} best ${best}`,
      );
      if (rep.analysis.resultKind === 'low_confidence') {
        lowStreak += 1;
        const expectSetup = lowStreak >= 3;
        check(
          rep.cue.category === (expectSetup ? 'CORRECTION' : 'SILENCE'),
          'E6',
          step,
          () => `low_confidence streak ${lowStreak} → ${rep.cue.category}`,
        );
        if (expectSetup) lowStreak = 0;
      } else {
        lowStreak = 0;
        check(
          (rep.cue.category === 'PERSONAL_BEST') ===
            (expectPersonalBest && rep.repIndex >= 3),
          'E6',
          step,
          () =>
            `rep ${rep.repIndex} cue ${rep.cue.category} PB=${expectPersonalBest}`,
        );
      }
      if (score !== null) best = best === null ? score : Math.max(best, score);
    }
    // E4 summary.
    const summary = engine.summary();
    const scored = reps.filter(rep => rep.analysis.resultKind === 'scored');
    const scores = scored
      .map(rep => rep.analysis.overallScore)
      .filter((value): value is number => value !== null);
    const focusScores = scored
      .map(
        rep =>
          rep.analysis.checkpoints.find(c => c.key === FOCUS)?.score ?? null,
      )
      .filter((value): value is number => value !== null);
    const expectedSummary = {
      sessionId: `stress-live-court-${seed}`,
      validReps: scored.length,
      lowConfidenceReps: reps.length - scored.length,
      startScore: scores[0] ?? null,
      endScore: scores[scores.length - 1] ?? null,
      bestScore: scores.length ? Math.max(...scores) : null,
      focusCheckpoint: FOCUS,
      focusStart: focusScores[0] ?? null,
      focusEnd: focusScores[focusScores.length - 1] ?? null,
      cuesSpoken: reps.filter(rep => rep.cue.category !== 'SILENCE').length,
    };
    check(
      JSON.stringify(summary) === JSON.stringify(expectedSummary),
      'E4',
      step,
      () =>
        `summary ${JSON.stringify(summary)} ≠ ${JSON.stringify(expectedSummary)}`,
    );
    stats.reps = reps.length;
    stats.scored = scored.length;
    stats.lowConfidence = reps.length - scored.length;
    stats.failed = returned.filter(rep => rep === null).length;
    trace.push(
      `${step}:${calls}:${reps.map(rep => `${rep.repIndex}${rep.cue.category[0]}${rep.analysis.overallScore ?? 'n'}`).join(',')}:${digest(summary)}`,
    );
  };

  let violation: InvariantViolation | null = null;
  let crash: string | null = null;
  let failingStep: number | null = null;
  try {
    checkAll(0);
    for (let i = 0; i < plan.actions.length; i++) {
      const step = i + 1;
      const action = plan.actions[i]!;
      if (action.kind === 'stroke') {
        settle([await fire(action)], step);
      } else if (action.kind === 'burst') {
        stats.bursts = (stats.bursts ?? 0) + 1;
        const first = calls + 1;
        const results = await Promise.all(
          action.strokes.map(spec => fire(spec)),
        );
        const order = completionOrder.filter(index => index >= first);
        if (
          order.some(
            (index, position) => position > 0 && index < order[position - 1]!,
          )
        ) {
          stats.outOfOrderCompletions = (stats.outOfOrderCompletions ?? 0) + 1;
        }
        settle(results, step);
      }
      checkAll(step);
      stats.steps = step;
    }
  } catch (error) {
    if (error instanceof InvariantViolation) {
      violation = error;
      failingStep = error.step;
    } else {
      crash =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      failingStep = stats.steps ?? 0;
    }
  }
  return {
    violation,
    crash,
    failingStep,
    trace,
    traceDigest: digest(trace),
    stats,
  };
}

const label = (run: EngineRun) =>
  run.violation
    ? run.violation.invariant
    : run.crash
      ? `CRASH:${run.crash}`
      : null;

async function runSeed(seed: number): Promise<SequenceOutcome> {
  const plan = planFor(seed);
  const first = await runEnginePlan(plan);
  const second = await runEnginePlan(plan);
  const failure = label(first);
  let minimized: EngineAction[] | null = null;
  if (failure !== null) {
    minimized = await minimizeActions(plan.actions, async candidate => {
      const run = await runEnginePlan({ ...plan, actions: [...candidate] });
      return label(run) === failure;
    });
  }
  const nondeterministic =
    first.traceDigest !== second.traceDigest || label(second) !== failure;
  return {
    seed,
    length: plan.actions.length,
    status: nondeterministic
      ? 'NONDETERMINISTIC'
      : failure === null
        ? 'HELD'
        : 'BROKEN',
    failure: first.violation?.message ?? first.crash ?? null,
    invariant: first.violation?.invariant ?? (first.crash ? 'CRASH' : null),
    failingStep: first.failingStep,
    minimized,
    minimizedLength: minimized?.length ?? null,
    stats: first.stats,
    traceDigest: first.traceDigest,
  };
}

const config = campaignConfig(40);

describe('LiveCourtEngine — seeded randomized long-run', () => {
  jest.setTimeout(30 * 60 * 1000);

  if (config.replaySeed !== null) {
    it(`replays seed ${config.replaySeed}`, async () => {
      const outcome = await runSeed(config.replaySeed!);
      console.error(
        JSON.stringify({ plan: planFor(config.replaySeed!), outcome }, null, 2),
      );
      expect(outcome.status).toBe('HELD');
    });
    return;
  }

  it(`holds every invariant across ${config.iterations} seeded sequences (base seed ${config.baseSeed})`, async () => {
    const outcomes: SequenceOutcome[] = [];
    for (let i = 0; i < config.iterations; i++) {
      outcomes.push(await runSeed(subSeed(config.baseSeed, `engine:${i}`)));
    }
    const broken = outcomes.filter(outcome => outcome.status === 'BROKEN');
    const nondeterministic = outcomes.filter(
      outcome => outcome.status === 'NONDETERMINISTIC',
    );
    const { known, unexpected } = summarizeBroken(outcomes);
    const totals = sumStats(outcomes);
    for (const [id, count] of Object.entries(known)) {
      totals[`knownDefect.${id}`] = count;
    }
    writeReport(
      {
        suite: 'liveCourtEngineRandomized',
        baseSeed: config.baseSeed,
        iterations: config.iterations,
        executed: outcomes.length,
        held: outcomes.length - broken.length - nondeterministic.length,
        broken: broken.length,
        nondeterministic: nondeterministic.length,
        totals,
        outcomes,
      },
      'liveCourtEngine',
    );
    expect(
      nondeterministic.map(outcome => `seed ${outcome.seed}: trace differs`),
    ).toEqual([]);
    // Known defects (test-support/stress/knownDefects.ts) are pinned individually in
    // liveCourtKnownDefects.stress.test.ts; anything else breaking here is new.
    expect(
      unexpected.map(
        outcome =>
          `seed ${outcome.seed} [${outcome.invariant}] step ${outcome.failingStep} (minimized to ${outcome.minimizedLength} actions): ${outcome.failure}`,
      ),
    ).toEqual([]);
  });
});
