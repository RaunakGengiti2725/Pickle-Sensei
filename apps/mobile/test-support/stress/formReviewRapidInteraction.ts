/**
 * Seeded scenario generator for the FormReviewScreen rapid-interaction stress
 * lens (`__tests__/stress/formReviewScreen.rapidInteraction.stress.test.tsx`).
 *
 * Everything an iteration does is a pure function of its seed: the stored
 * evidence it opens (world), the deep-link phase, the I/O latency profile the
 * local store and sidecar reads run with, and the ordered list of interaction
 * bursts. The test file only executes what this module describes, so any row
 * of the results table is replayable with `STRESS_ONLY=<seed>`.
 *
 * The RNG is the same mulberry32 the network×auth matrix harness uses
 * (`test-support/matrix/networkAuthHarness.ts`); it is duplicated here rather
 * than imported because that module pulls the whole sync/auth stack into the
 * render suite.
 */

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    return items[items.length - 1]![0];
  }
}

/** Independent stream for the I/O latency so the interaction script of a
 * seed never shifts when the store answers one query more or less. */
export function latencySeed(seed: number): number {
  return (seed * 2_654_435_761 + 0x9e37_79b9) >>> 0;
}

// ─── Worlds: what the local store holds for the opened analysisId ────────────

/**
 * Every world is real data written through the production repository into a
 * real SQLite database; the screen reads it through the production
 * `loadStrokeResultEvidence` + `loadReviewPoseSequence` path.
 *
 *  ready-full        shot + record + capture row + hash-valid pose sidecar
 *  ready-bad-sidecar shot + record + capture row + sidecar whose sha256 does
 *                    not match the bytes → honest null sequence
 *  ready-read-fails  shot + record + capture row + sidecar whose file read
 *                    rejects → honest null sequence
 *  ready-record-only shot + record, no capture row (legacy rating) → no clip
 *  missing           nothing stored under that id → "Review unavailable"
 */
export const WORLDS = [
  'ready-full',
  'ready-bad-sidecar',
  'ready-read-fails',
  'ready-record-only',
  'missing',
] as const;
export type World = (typeof WORLDS)[number];

export const WORLD_ANALYSIS_ID: Record<World, string> = {
  'ready-full': 'stress-analysis-full',
  'ready-bad-sidecar': 'stress-analysis-bad-sidecar',
  'ready-read-fails': 'stress-analysis-read-fails',
  'ready-record-only': 'stress-analysis-record-only',
  missing: 'stress-analysis-missing',
};

export function worldForAnalysisId(analysisId: string): World | null {
  for (const world of WORLDS) {
    if (WORLD_ANALYSIS_ID[world] === analysisId) return world;
  }
  return null;
}

export function worldIsReady(world: World): boolean {
  return world !== 'missing';
}

/** Deep-link phases: two real stops, the top, and a phase the script does
 * not have (falls back to the first stop). */
export const PHASES = [undefined, 'contact', 'prepare', 'not-a-phase'] as const;
export type Phase = (typeof PHASES)[number];

/** Upper bound of the per-query / per-read latency, ms (fake-timer time). */
export const LATENCY_PROFILES = [0, 8, 60, 400] as const;

// ─── Interaction vocabulary ──────────────────────────────────────────────────

/** Every pressable the screen exposes, by the handle the harness uses. */
export const TARGETS = [
  'stage',
  'play',
  'next',
  'prev',
  'speed',
  'autopause',
  'reanalyze',
  'back',
  'close',
  'retry',
] as const;
export type Target = (typeof TARGETS)[number];

export type Step =
  /** `count` presses of one control inside ONE React batch (two fingers /
   * touch-ups delivered before the next commit). */
  | { kind: 'tap'; target: Target; count: 1 | 2 | 3 }
  /** Two presses of one control in consecutive batches with no time passing
   * (a fast double tap where React committed in between). */
  | { kind: 'tap-sequential'; target: Target }
  /** Two DIFFERENT controls pressed inside one batch. */
  | { kind: 'combo'; targets: [Target, Target] }
  /** Timeline scrub: grant + move at `ratio` of the track, released or not. */
  | { kind: 'scrub'; ratio: number; release: boolean }
  /** Deliver stage / track / label layouts (what the native layout pass
   * does after mount). */
  | { kind: 'layout' }
  /** Let fake time pass (playback ticks, latency timers). */
  | { kind: 'advance'; ms: number }
  /** System back (swipe-back gesture) on whichever route is focused. */
  | { kind: 'sys-back' }
  /** Navigate to FormReview again (same or different analysisId) while it
   * may still be open — "spam navigation". */
  | { kind: 'reopen'; world: World; phase: Phase }
  /** Two navigates to FormReview inside one batch. */
  | { kind: 'open-twice'; world: World }
  /** Drain microtasks only. */
  | { kind: 'flush' };

export interface Scenario {
  seed: number;
  world: World;
  phase: Phase;
  latencyMaxMs: number;
  /** Fake-time gap between the initial navigate and the first burst. */
  openGapMs: number;
  steps: Step[];
  /** Fake-time gap after each step (same length as `steps`). */
  gaps: number[];
}

const TARGET_WEIGHTS: readonly (readonly [Target, number])[] = [
  ['stage', 10],
  ['play', 12],
  ['next', 10],
  ['prev', 8],
  ['speed', 6],
  ['autopause', 6],
  ['reanalyze', 14],
  ['back', 12],
  ['close', 8],
  ['retry', 6],
];

function gap(rng: Rng): number {
  return rng.weighted<number>([
    [0, 50],
    [rng.int(1, 16), 25],
    [rng.int(17, 400), 25],
  ]);
}

export function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const world = rng.weighted<World>([
    ['ready-full', 50],
    ['ready-bad-sidecar', 15],
    ['ready-read-fails', 10],
    ['ready-record-only', 10],
    ['missing', 15],
  ]);
  const phase = rng.pick(PHASES);
  const latencyMaxMs = rng.pick(LATENCY_PROFILES);
  const openGapMs = gap(rng);
  const stepCount = rng.int(4, 14);
  const steps: Step[] = [];
  const gaps: number[] = [];
  for (let i = 0; i < stepCount; i++) {
    const kind = rng.weighted<Step['kind']>([
      ['tap', 30],
      ['tap-sequential', 8],
      ['combo', 12],
      ['scrub', 6],
      ['layout', 6],
      ['advance', 14],
      ['sys-back', 6],
      ['reopen', 6],
      ['open-twice', 3],
      ['flush', 3],
    ]);
    switch (kind) {
      case 'tap':
        steps.push({
          kind,
          target: rng.weighted(TARGET_WEIGHTS),
          count: rng.weighted<1 | 2 | 3>([
            [1, 50],
            [2, 35],
            [3, 15],
          ]),
        });
        break;
      case 'tap-sequential':
        steps.push({ kind, target: rng.weighted(TARGET_WEIGHTS) });
        break;
      case 'combo': {
        const first = rng.weighted(TARGET_WEIGHTS);
        let second = rng.weighted(TARGET_WEIGHTS);
        while (second === first) second = rng.weighted(TARGET_WEIGHTS);
        steps.push({ kind, targets: [first, second] });
        break;
      }
      case 'scrub':
        steps.push({
          kind,
          ratio: Math.round(rng.next() * 1000) / 1000,
          release: rng.chance(0.7),
        });
        break;
      case 'layout':
      case 'sys-back':
      case 'flush':
        steps.push({ kind });
        break;
      case 'advance':
        steps.push({
          kind,
          ms: rng.weighted<number>([
            [rng.int(1, 40), 40],
            [rng.int(41, 600), 40],
            [rng.int(601, 4000), 20],
          ]),
        });
        break;
      case 'reopen':
        steps.push({
          kind,
          world: rng.chance(0.5) ? world : rng.pick(WORLDS),
          phase: rng.pick(PHASES),
        });
        break;
      case 'open-twice':
        steps.push({ kind, world: rng.chance(0.5) ? world : rng.pick(WORLDS) });
        break;
    }
    gaps.push(gap(rng));
  }
  return { seed, world, phase, latencyMaxMs, openGapMs, steps, gaps };
}

/** One-line human form of a step for the results table. */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'tap':
      return `tap:${step.target}x${step.count}`;
    case 'tap-sequential':
      return `tapseq:${step.target}`;
    case 'combo':
      return `combo:${step.targets[0]}+${step.targets[1]}`;
    case 'scrub':
      return `scrub:${step.ratio}${step.release ? '' : ':held'}`;
    case 'layout':
      return 'layout';
    case 'advance':
      return `advance:${step.ms}`;
    case 'sys-back':
      return 'sys-back';
    case 'reopen':
      return `reopen:${step.world}${step.phase ? ':' + step.phase : ''}`;
    case 'open-twice':
      return `open-twice:${step.world}`;
    case 'flush':
      return 'flush';
  }
}

// ─── Results table ───────────────────────────────────────────────────────────

export type Outcome = 'held' | 'broken' | 'crashed';

export interface StepRecord {
  step: string;
  /** How many presses actually reached a mounted, enabled, focused control. */
  landed: number;
  /** What the harness saw right after the batch committed. */
  after: string;
}

export interface IterationResult {
  seed: number;
  world: World;
  phase: Phase | null;
  latencyMaxMs: number;
  outcome: Outcome;
  violations: string[];
  consoleErrors: string[];
  consoleWarnings: string[];
  /** Bursts that pressed "Re-analyze" while it was focused and enabled. */
  reanalyzeIntents: number;
  /** Times the Analyze route mounted (one per intent is the contract). */
  analyzeMounts: number;
  /** Handoffs the Analyze route consumed, by declared stroke. */
  handoffsConsumed: (string | null)[];
  /** Bursts that pressed Back / Close / Try again / system back. */
  leaveIntents: number;
  /** Times FormReview was popped off the stack. */
  formReviewPops: number;
  /** Batches after which the replay was still running underneath a focused
   * Analyze route (observation: the player does not pause on blur). */
  playbackWhileUnfocused: number;
  /** React Navigation dev-only "GO_BACK was not handled" errors: the extra
   * presses of a same-batch multi-press on Close / Back / Try again. */
  devUnhandledActions: number;
  finalRoutes: string[];
  steps: StepRecord[];
  elapsedMs: number;
  error?: string;
}
